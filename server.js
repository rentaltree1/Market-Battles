// =============================================================
// Market Battles — Server
// Node.js + Express + Socket.IO
// =============================================================

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =============================================================
// CONFIG
// =============================================================
const PORT = process.env.PORT || 3000;
const TICK_MS = 10 * 1000;                  // 10-second game tick
const NASDAQ_FETCH_MS = 60 * 1000;          // refresh Nasdaq once per minute
const SAVE_MS = 30 * 1000;                  // save to disk every 30s
const DATA_FILE = path.join(__dirname, 'data.json');

const STARTING_CASH = 10000;
const STARTING_PRICE = 15.00;
const STARTING_SHARES = 1_000_000;
const STARTING_OP_COST_PER_MIN = 100;       // operating costs at minute 0
const OP_COST_GROWTH_PER_DAY = 0.02;        // costs scale +2% per real day
const MAX_HISTORY_POINTS = 50000;           // hard cap on price history per player

// =============================================================
// GAME STATE (in memory; persisted to data.json)
// =============================================================
let state = {
  users: {},          // username -> { passwordHash, ticker, sector, cash, stockPrice, shares,
                      //                priceHistory: [{t, p}], assets, sentimentMod, bankrupt,
                      //                createdAt, lastNewsAt }
  sessions: {},       // token -> username
  nasdaq: { lastPercent: 0, lastFetched: 0, isOpen: false },
  newsFeed: [],       // [{ id, t, text, type, sector, ticker, sentiment }]
  tradeFeed: [],      // [{ id, t, bot, action, ticker, shares, price }]
  startedAt: Date.now(),
};

// Try load existing state from disk
try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const loaded = JSON.parse(raw);
    state = { ...state, ...loaded, sessions: {} }; // wipe sessions on restart
    console.log('[boot] loaded saved state');
  }
} catch (e) {
  console.error('[boot] failed to load saved state:', e.message);
}

function save() {
  try {
    const toSave = { ...state, sessions: undefined };
    fs.writeFileSync(DATA_FILE, JSON.stringify(toSave));
  } catch (e) {
    console.error('[save] failed:', e.message);
  }
}

// =============================================================
// BOTS — 5 named whales with distinct personalities
// =============================================================
const BOTS = [
  { id: 'brad',    name: 'Bullish Brad',    type: 'bull' },     // mostly buys
  { id: 'barbara', name: 'Bearish Barbara', type: 'bear' },     // mostly sells
  { id: 'nick',    name: 'News Chaser Nick', type: 'news' },    // reacts to news
  { id: 'wendy',   name: 'Whale Wendy',     type: 'whale' },    // rare but huge
  { id: 'eddie',   name: 'Steady Eddie',    type: 'contrarian' } // counter-trades
];

// =============================================================
// NEWS TEMPLATES
// =============================================================
const GLOBAL_NEWS = [
  { text: 'Fed signals interest rate cut next quarter',           sentiment: +0.4, weight: 0.7 },
  { text: 'Surprise jobs report beats expectations',              sentiment: +0.3, weight: 0.8 },
  { text: 'Inflation reading comes in hotter than expected',      sentiment: -0.4, weight: 0.7 },
  { text: 'Global trade tensions escalate overnight',             sentiment: -0.5, weight: 0.5 },
  { text: 'Consumer confidence index hits 10-year high',          sentiment: +0.3, weight: 0.6 },
  { text: 'Major hedge fund collapse rattles markets',            sentiment: -0.6, weight: 0.3 },
  { text: 'Trillion-dollar infrastructure bill passes',           sentiment: +0.4, weight: 0.4 },
  { text: 'Geopolitical crisis sparks safe-haven rush',           sentiment: -0.5, weight: 0.4 },
];

const TECH_NEWS = [
  { text: 'AI breakthrough fuels sector-wide rally',              sentiment: +0.5, weight: 0.6 },
  { text: 'Major chip shortage worsens supply chains',            sentiment: -0.4, weight: 0.6 },
  { text: 'New EU tech regulation under review',                  sentiment: -0.3, weight: 0.5 },
  { text: 'Tech earnings season exceeds Wall Street estimates',   sentiment: +0.4, weight: 0.6 },
  { text: 'Cloud computing demand surges 40% YoY',                sentiment: +0.3, weight: 0.7 },
  { text: 'Cybersecurity scare hits multiple tech firms',         sentiment: -0.3, weight: 0.5 },
];

const COMPANY_RUMORS = [
  { text: '{TICKER} reportedly missing earnings target',          sentiment: -0.5 },
  { text: 'Insiders accumulating {TICKER} ahead of announcement', sentiment: +0.5 },
  { text: '{TICKER} CEO spotted at competitor headquarters',      sentiment: -0.3 },
  { text: '{TICKER} rumored to announce major acquisition',       sentiment: +0.4 },
  { text: 'Whistleblower complaint filed against {TICKER}',       sentiment: -0.6 },
  { text: '{TICKER} secures landmark contract — leaked memo',     sentiment: +0.5 },
  { text: 'Analysts downgrade {TICKER} on growth concerns',       sentiment: -0.4 },
  { text: 'Activist investor takes 5% stake in {TICKER}',         sentiment: +0.3 },
  { text: '{TICKER} product launch reportedly delayed again',     sentiment: -0.3 },
  { text: 'Viral post sends {TICKER} trending on social media',   sentiment: +0.4 },
];

// =============================================================
// SECTOR DEFS — Phase 1 has Tech only with stub assets
// =============================================================
const SECTORS = {
  tech: {
    name: 'Tech',
    actions: {
      server:    { label: 'Buy Server',         cost: 500,  revenue: 50,  upkeep: 5 },
      engineer:  { label: 'Hire Engineer',      cost: 1500, revenue: 200, upkeep: 30 },
      product:   { label: 'Launch Product',     cost: 5000, revenue: 0,   upkeep: 0,
                   oneTime: true, sentimentBoost: 0.6, durationMin: 8 },
      marketing: { label: 'Marketing Campaign', cost: 2000, revenue: 0,   upkeep: 0,
                   oneTime: true, sentimentBoost: 0.4, durationMin: 5 },
    }
  },
  // Health & Energy will be added in Phase 2
};

// =============================================================
// AUTH HELPERS
// =============================================================
function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function userFromToken(token) {
  const username = state.sessions[token];
  return username ? state.users[username] : null;
}

// =============================================================
// API ROUTES
// =============================================================
app.post('/api/signup', async (req, res) => {
  const { username, password, email } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username + password required' });
  if (username.length < 3 || username.length > 20) return res.status(400).json({ error: 'username must be 3-20 chars' });
  if (state.users[username]) return res.status(400).json({ error: 'username taken' });

  const passwordHash = await bcrypt.hash(password, 8);
  state.users[username] = {
    username,
    email: email || null,
    passwordHash,
    ticker: null,
    sector: null,
    cash: STARTING_CASH,
    shares: STARTING_SHARES,
    stockPrice: STARTING_PRICE,
    priceHistory: [{ t: Date.now(), p: STARTING_PRICE }],
    assets: {},                  // assetId -> count
    activeBoosts: [],            // [{ key, sentiment, expiresAt }]
    sentimentMod: 0,             // current company-self sentiment, decays
    bankrupt: false,
    createdAt: Date.now(),
  };

  const token = makeToken();
  state.sessions[token] = username;
  res.json({ token, username });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const u = state.users[username];
  if (!u) return res.status(401).json({ error: 'no such user' });
  const ok = await bcrypt.compare(password, u.passwordHash);
  if (!ok) return res.status(401).json({ error: 'wrong password' });

  const token = makeToken();
  state.sessions[token] = username;
  res.json({ token, username });
});

app.post('/api/setup', (req, res) => {
  const { token, ticker, sector } = req.body || {};
  const u = userFromToken(token);
  if (!u) return res.status(401).json({ error: 'not logged in' });
  if (!ticker || !sector) return res.status(400).json({ error: 'ticker + sector required' });
  if (!SECTORS[sector]) return res.status(400).json({ error: 'invalid sector (only "tech" available in Phase 1)' });

  const cleanTicker = String(ticker).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
  if (!cleanTicker || cleanTicker.length < 2) return res.status(400).json({ error: 'ticker must be 2-5 letters' });

  // ensure ticker unique
  for (const [name, other] of Object.entries(state.users)) {
    if (name !== u.username && other.ticker === cleanTicker) {
      return res.status(400).json({ error: 'ticker already in use' });
    }
  }
  u.ticker = cleanTicker;
  u.sector = sector;
  res.json({ ok: true, ticker: cleanTicker, sector });
});

app.post('/api/action', (req, res) => {
  const { token, action } = req.body || {};
  const u = userFromToken(token);
  if (!u) return res.status(401).json({ error: 'not logged in' });
  if (u.bankrupt) return res.status(400).json({ error: 'you are bankrupt' });
  if (!u.sector) return res.status(400).json({ error: 'must complete setup first' });

  const def = SECTORS[u.sector].actions[action];
  if (!def) return res.status(400).json({ error: 'unknown action' });
  if (u.cash < def.cost) return res.status(400).json({ error: 'not enough cash' });

  u.cash -= def.cost;

  if (def.oneTime) {
    // Marketing / product launch: time-limited sentiment boost
    u.activeBoosts.push({
      key: action,
      sentiment: def.sentimentBoost,
      expiresAt: Date.now() + def.durationMin * 60 * 1000,
    });
    // Product launch also publishes a positive rumor
    if (action === 'product') {
      publishNews({
        text: `${u.ticker} announces major product launch`,
        sentiment: 0.5,
        type: 'company',
        ticker: u.ticker,
      });
    }
  } else {
    u.assets[action] = (u.assets[action] || 0) + 1;
  }

  res.json({ ok: true, cash: u.cash, assets: u.assets, activeBoosts: u.activeBoosts });
});

app.post('/api/state', (req, res) => {
  const { token } = req.body || {};
  const u = userFromToken(token);
  if (!u) return res.status(401).json({ error: 'not logged in' });
  res.json({ me: publicUser(u), leaderboard: leaderboard(), newsFeed: state.newsFeed.slice(-20), tradeFeed: state.tradeFeed.slice(-20), market: { isOpen: state.nasdaq.isOpen, nasdaqPct: state.nasdaq.lastPercent } });
});

// =============================================================
// PUBLIC SHAPES (what we send to clients — no password hashes etc)
// =============================================================
function publicUser(u) {
  const revenue = computeRevenue(u);
  const upkeep = computeUpkeep(u);
  const opCost = computeOpCost();
  return {
    username: u.username,
    ticker: u.ticker,
    sector: u.sector,
    cash: u.cash,
    shares: u.shares,
    stockPrice: u.stockPrice,
    marketCap: u.shares * u.stockPrice,
    assets: u.assets,
    activeBoosts: u.activeBoosts,
    bankrupt: u.bankrupt,
    revenue,
    upkeep,
    opCost,
    netPerMin: revenue - upkeep - opCost,
    priceHistory: u.priceHistory,
    createdAt: u.createdAt,
  };
}

function leaderboard() {
  return Object.values(state.users)
    .filter(u => u.ticker)
    .map(u => ({
      ticker: u.ticker,
      username: u.username,
      sector: u.sector,
      stockPrice: u.stockPrice,
      marketCap: u.shares * u.stockPrice,
      bankrupt: u.bankrupt,
      change24h: compute24hChange(u),
    }))
    .sort((a, b) => b.marketCap - a.marketCap);
}

function compute24hChange(u) {
  if (!u.priceHistory || u.priceHistory.length < 2) return 0;
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  // Find earliest point >= dayAgo
  let oldPrice = u.priceHistory[0].p;
  for (const point of u.priceHistory) {
    if (point.t >= dayAgo) { oldPrice = point.p; break; }
  }
  return ((u.stockPrice - oldPrice) / oldPrice) * 100;
}

// =============================================================
// FINANCIALS
// =============================================================
function computeRevenue(u) {
  let r = 0;
  for (const [id, count] of Object.entries(u.assets || {})) {
    const def = SECTORS[u.sector]?.actions[id];
    if (def && def.revenue) r += def.revenue * count;
  }
  return r;
}

function computeUpkeep(u) {
  let up = 0;
  for (const [id, count] of Object.entries(u.assets || {})) {
    const def = SECTORS[u.sector]?.actions[id];
    if (def && def.upkeep) up += def.upkeep * count;
  }
  return up;
}

function computeOpCost() {
  const daysElapsed = (Date.now() - state.startedAt) / (24 * 60 * 60 * 1000);
  return Math.round(STARTING_OP_COST_PER_MIN * Math.pow(1 + OP_COST_GROWTH_PER_DAY, daysElapsed));
}

// =============================================================
// NASDAQ FETCH (Yahoo Finance ^IXIC)
// =============================================================
async function fetchNasdaq() {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EIXIC?interval=1m&range=1d';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('no result');
    const meta = result.meta;
    const prev = meta.previousClose || meta.chartPreviousClose;
    const cur = meta.regularMarketPrice;
    const pct = ((cur - prev) / prev) * 100;
    state.nasdaq.lastPercent = pct;
    state.nasdaq.lastFetched = Date.now();
    state.nasdaq.isOpen = (meta.marketState === 'REGULAR');
    // console.log(`[nasdaq] ${pct.toFixed(2)}% (open=${state.nasdaq.isOpen})`);
  } catch (e) {
    console.error('[nasdaq] fetch failed:', e.message);
  }
}

// =============================================================
// NEWS GENERATION
// =============================================================
function publishNews({ text, sentiment, type, sector, ticker }) {
  const item = {
    id: crypto.randomBytes(4).toString('hex'),
    t: Date.now(),
    text,
    type,
    sector: sector || null,
    ticker: ticker || null,
    sentiment,
  };
  state.newsFeed.push(item);
  if (state.newsFeed.length > 200) state.newsFeed.shift();

  // Apply to affected players
  for (const u of Object.values(state.users)) {
    if (u.bankrupt || !u.ticker) continue;
    let applies = false;
    if (type === 'global') applies = true;
    else if (type === 'sector' && u.sector === sector) applies = true;
    else if (type === 'company' && u.ticker === ticker) applies = true;
    if (applies) {
      u.sentimentMod = (u.sentimentMod || 0) + sentiment;
    }
  }
  io.emit('news', item);
}

function maybeGenerateNews() {
  // ~1 news event every few minutes; weight by type
  if (Math.random() > 0.04) return; // ~4% per tick → roughly 1 per 4 minutes
  const r = Math.random();
  if (r < 0.4) {
    // global
    const candidate = pickWeighted(GLOBAL_NEWS);
    publishNews({ text: candidate.text, sentiment: candidate.sentiment, type: 'global' });
  } else if (r < 0.7) {
    // sector (currently only tech)
    const candidate = pickWeighted(TECH_NEWS);
    publishNews({ text: candidate.text, sentiment: candidate.sentiment, type: 'sector', sector: 'tech' });
  } else {
    // company-specific rumor — pick random non-bankrupt player
    const players = Object.values(state.users).filter(u => u.ticker && !u.bankrupt);
    if (!players.length) return;
    const target = players[Math.floor(Math.random() * players.length)];
    const tmpl = COMPANY_RUMORS[Math.floor(Math.random() * COMPANY_RUMORS.length)];
    publishNews({
      text: tmpl.text.replace('{TICKER}', target.ticker),
      sentiment: tmpl.sentiment,
      type: 'company',
      ticker: target.ticker,
    });
  }
}

function pickWeighted(arr) {
  const total = arr.reduce((s, x) => s + (x.weight || 1), 0);
  let r = Math.random() * total;
  for (const x of arr) {
    r -= (x.weight || 1);
    if (r <= 0) return x;
  }
  return arr[arr.length - 1];
}

// =============================================================
// BOT TRADING — returns net signal per player (positive=buying pressure)
// =============================================================
function runBots() {
  const signals = {}; // username -> signal accumulator
  const players = Object.values(state.users).filter(u => u.ticker && !u.bankrupt);
  if (!players.length) return signals;

  for (const player of players) signals[player.username] = 0;

  for (const bot of BOTS) {
    // Each bot decides per player
    for (const player of players) {
      let action = null;
      let size = 0;

      switch (bot.type) {
        case 'bull': {
          if (Math.random() < 0.35) {
            action = Math.random() < 0.75 ? 'BUY' : 'SELL';
            size = randInt(50, 500);
          }
          break;
        }
        case 'bear': {
          if (Math.random() < 0.35) {
            action = Math.random() < 0.75 ? 'SELL' : 'BUY';
            size = randInt(50, 500);
          }
          break;
        }
        case 'news': {
          // React to player's recent sentimentMod
          if (Math.abs(player.sentimentMod) > 0.1 && Math.random() < 0.6) {
            action = player.sentimentMod > 0 ? 'BUY' : 'SELL';
            size = randInt(100, 1500);
          }
          break;
        }
        case 'whale': {
          // Rare but huge
          if (Math.random() < 0.04) {
            action = Math.random() < 0.5 ? 'BUY' : 'SELL';
            size = randInt(2000, 8000);
          }
          break;
        }
        case 'contrarian': {
          // Look at last 5 price points; trade opposite the trend
          const h = player.priceHistory;
          if (h.length >= 5) {
            const recent = h.slice(-5);
            const trend = recent[recent.length - 1].p - recent[0].p;
            if (Math.abs(trend) > 0.05 && Math.random() < 0.4) {
              action = trend > 0 ? 'SELL' : 'BUY';
              size = randInt(100, 800);
            }
          }
          break;
        }
      }

      if (action && size) {
        const signed = (action === 'BUY' ? 1 : -1) * size;
        signals[player.username] += signed;

        // Add to trade feed
        const trade = {
          id: crypto.randomBytes(4).toString('hex'),
          t: Date.now(),
          bot: bot.name,
          action,
          ticker: player.ticker,
          shares: size,
          price: player.stockPrice,
        };
        state.tradeFeed.push(trade);
        if (state.tradeFeed.length > 200) state.tradeFeed.shift();
        io.emit('trade', trade);
      }
    }
  }
  return signals;
}

function randInt(a, b) { return Math.floor(a + Math.random() * (b - a)); }

// =============================================================
// MAIN GAME TICK
// =============================================================
function tick() {
  const now = Date.now();
  const ticksPerMinute = 60_000 / TICK_MS;
  const minutesPerTick = TICK_MS / 60_000;

  // 1) Expire active boosts
  for (const u of Object.values(state.users)) {
    if (!u.activeBoosts) u.activeBoosts = [];
    u.activeBoosts = u.activeBoosts.filter(b => b.expiresAt > now);
  }

  // 2) Run bots, get sentiment signals
  maybeGenerateNews();
  const botSignals = runBots();

  // 3) Per-player updates
  const opCost = computeOpCost();
  for (const u of Object.values(state.users)) {
    if (!u.ticker || u.bankrupt) continue;

    // Financials per tick
    const revenue = computeRevenue(u);
    const upkeep = computeUpkeep(u);
    const netPerMin = revenue - upkeep - opCost;
    const cashDelta = netPerMin * minutesPerTick;
    u.cash += cashDelta;

    // Bankruptcy check
    if (u.cash < -5000) {
      u.bankrupt = true;
      publishNews({
        text: `${u.ticker} delisted — bankruptcy filing`,
        sentiment: -1,
        type: 'company',
        ticker: u.ticker,
      });
      continue;
    }

    // Compute price change for this tick
    // 30% Nasdaq, 50% company, 20% bots
    let nasdaqDelta = 0;
    if (state.nasdaq.isOpen) {
      // spread Nasdaq's daily change across the trading minutes
      // Nasdaq pct is daily; divide by remaining minutes-ish: rough share per tick
      nasdaqDelta = (state.nasdaq.lastPercent / 100) * (1 / (390 * ticksPerMinute)) * 30;
      // Add small random walk component for realism
      nasdaqDelta += (Math.random() - 0.5) * 0.001 * 0.3;
    }

    // Company performance — based on net profit, asset growth, active boosts
    const boostSentiment = u.activeBoosts.reduce((s, b) => s + b.sentiment, 0);
    const profitScore = netPerMin / 5000;   // normalized; large profit moves price
    let companyScore = profitScore + boostSentiment * 0.3 + (u.sentimentMod || 0) * 0.1;
    // Decay sentiment mod
    u.sentimentMod = (u.sentimentMod || 0) * 0.95;

    // small random walk
    companyScore += (Math.random() - 0.5) * 0.002;
    const companyDelta = companyScore * minutesPerTick * 0.5;

    // Bot influence
    const sig = botSignals[u.username] || 0;
    const botDelta = (sig / 50_000) * 0.2; // tune: 10k net signal = ~4% per tick? scale down

    const totalDelta = nasdaqDelta + companyDelta + botDelta;
    u.stockPrice = Math.max(0.01, u.stockPrice * (1 + totalDelta));

    // Record price history (1 sample per tick)
    u.priceHistory.push({ t: now, p: +u.stockPrice.toFixed(4) });
    if (u.priceHistory.length > MAX_HISTORY_POINTS) {
      // Downsample: keep every 2nd point in the older half
      const half = Math.floor(MAX_HISTORY_POINTS / 2);
      const older = u.priceHistory.slice(0, half).filter((_, i) => i % 2 === 0);
      u.priceHistory = older.concat(u.priceHistory.slice(half));
    }

    // Stock price floor → bankrupt
    if (u.stockPrice < 0.10) {
      u.bankrupt = true;
      publishNews({
        text: `${u.ticker} delisted — stock crashed below $0.10`,
        sentiment: -1,
        type: 'company',
        ticker: u.ticker,
      });
    }
  }

  // 4) Broadcast a lightweight market update
  io.emit('tick', {
    t: now,
    leaderboard: leaderboard(),
    market: { isOpen: state.nasdaq.isOpen, nasdaqPct: state.nasdaq.lastPercent },
  });
}

// =============================================================
// SOCKETS — clients connect and listen
// =============================================================
io.on('connection', (socket) => {
  socket.on('subscribe', ({ token }) => {
    const u = userFromToken(token);
    if (u) {
      socket.data.username = u.username;
      socket.emit('me', publicUser(u));
    }
  });

  socket.on('refreshMe', ({ token }) => {
    const u = userFromToken(token);
    if (u) socket.emit('me', publicUser(u));
  });
});

// push per-user state every few seconds
setInterval(() => {
  for (const [id, s] of io.sockets.sockets) {
    const username = s.data.username;
    if (!username) continue;
    const u = state.users[username];
    if (u) s.emit('me', publicUser(u));
  }
}, 5000);

// =============================================================
// BOOT
// =============================================================
fetchNasdaq();
setInterval(fetchNasdaq, NASDAQ_FETCH_MS);
setInterval(tick, TICK_MS);
setInterval(save, SAVE_MS);

server.listen(PORT, () => {
  console.log(`Market Battles listening on :${PORT}`);
});
