// =============================================================
// Market Battles — Client
// =============================================================

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let token = localStorage.getItem('mb_token') || null;
let me = null;
let socket = null;
let leaderboardCache = [];
let newsFeedCache = [];
let tradeFeedCache = [];
let currentRange = '1d';
let marketState = { isOpen: false, nasdaqPct: 0 };
let globe = null;
let pickedHQ = null; // { lat, lng, city, country }

// ============ SCREEN MGMT ============
function showScreen(id) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
  // initialise globe lazily
  if (id === 'hq' && !globe) initGlobe();
}

// ============ WELCOME ============
$('#btn-play').addEventListener('click', () => {
  if (token) afterAuth(); else showScreen('auth');
});

// ============ AUTH TABS ============
$$('.tab').forEach(t => {
  t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $$('.auth-form').forEach(f => f.classList.remove('active'));
    $('#form-' + t.dataset.tab).classList.add('active');
  });
});

$('#auth-back').addEventListener('click', () => showScreen('welcome'));

// ============ AUTH FORMS ============
$('#form-signup').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#signup-err').textContent = '';
  const fd = new FormData(e.target);
  const body = {
    username: fd.get('username').trim(),
    password: fd.get('password'),
    email: fd.get('email') || null,
  };
  try {
    const res = await fetch('/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'signup failed');
    token = data.token;
    localStorage.setItem('mb_token', token);
    afterAuth();
  } catch (err) {
    $('#signup-err').textContent = err.message;
  }
});

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-err').textContent = '';
  const fd = new FormData(e.target);
  const body = {
    username: fd.get('username').trim(),
    password: fd.get('password'),
  };
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'login failed');
    token = data.token;
    localStorage.setItem('mb_token', token);
    afterAuth();
  } catch (err) {
    $('#login-err').textContent = err.message;
  }
});

// ============ GOOGLE SIGN-IN (optional) ============
async function setupGoogleSignIn() {
  let cfg;
  try {
    cfg = await fetch('/api/config').then(r => r.json());
  } catch { return; }
  if (!cfg.googleClientId) return;

  $('#google-signin-wrap').style.display = '';

  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true; s.defer = true;
  s.onload = () => {
    if (!window.google || !window.google.accounts) return;
    window.google.accounts.id.initialize({
      client_id: cfg.googleClientId,
      callback: handleGoogleResponse,
    });
    window.google.accounts.id.renderButton(
      $('#google-btn'),
      { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: 280 }
    );
  };
  document.head.appendChild(s);
}

async function handleGoogleResponse(response) {
  try {
    const res = await fetch('/api/google-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Google sign-in failed');
    token = data.token;
    localStorage.setItem('mb_token', token);
    afterAuth();
  } catch (err) {
    $('#login-err').textContent = err.message;
  }
}

// ============ AFTER AUTH — route to right screen ============
async function afterAuth() {
  const data = await fetchState();
  if (!data) {
    token = null;
    localStorage.removeItem('mb_token');
    showScreen('auth');
    return;
  }
  me = data.me;
  marketState = data.market;
  newsFeedCache = data.newsFeed || [];
  tradeFeedCache = data.tradeFeed || [];
  leaderboardCache = data.leaderboard || [];

  if (!me.hq) {
    showScreen('hq');
  } else if (!me.sector || !me.ticker) {
    showScreen('setup');
  } else {
    enterDash();
  }
}

async function fetchState() {
  try {
    const res = await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ============ HQ GLOBE ============
function initGlobe() {
  if (typeof Globe === 'undefined') {
    console.warn('Globe library not loaded');
    return;
  }
  const el = $('#globeViz');
  globe = Globe()(el)
    .globeImageUrl('//unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
    .bumpImageUrl('//unpkg.com/three-globe/example/img/earth-topology.png')
    .backgroundColor('rgba(0,0,0,0)')
    .pointsData([])
    .pointAltitude(0.02)
    .pointRadius(0.5)
    .pointColor(() => '#a855f7')
    .pointsMerge(true)
    .onGlobeClick(onGlobePick);

  // Subtle auto-rotate
  if (globe.controls) {
    const ctrl = globe.controls();
    ctrl.autoRotate = true;
    ctrl.autoRotateSpeed = 0.4;
    ctrl.enablePan = false;
    ctrl.minDistance = 200;
    ctrl.maxDistance = 400;
  }

  // Resize handler
  function resize() {
    globe.width(el.clientWidth);
    globe.height(el.clientHeight);
  }
  resize();
  window.addEventListener('resize', resize);
}

async function onGlobePick({ lat, lng }) {
  $('#hq-label').textContent = 'Locating…';
  pickedHQ = { lat, lng, city: null, country: null };
  $('#btn-confirm-hq').disabled = true;

  // Plant a marker
  globe.pointsData([{ lat, lng }]);
  // Disable auto-rotate after first pick so the user can read the label
  if (globe.controls) globe.controls().autoRotate = false;

  // Reverse geocode via Nominatim (free, no key)
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10&accept-language=en`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const a = data.address || {};
      const city = a.city || a.town || a.village || a.county || a.state || null;
      const country = a.country || null;
      pickedHQ.city = city;
      pickedHQ.country = country;
      if (city || country) {
        $('#hq-label').textContent = [city, country].filter(Boolean).join(', ');
      } else if (data.display_name) {
        $('#hq-label').textContent = data.display_name.split(',').slice(0, 2).join(',');
      } else {
        $('#hq-label').textContent = `${lat.toFixed(2)}°, ${lng.toFixed(2)}°`;
      }
    } else {
      $('#hq-label').textContent = `${lat.toFixed(2)}°, ${lng.toFixed(2)}°`;
    }
  } catch {
    $('#hq-label').textContent = `${lat.toFixed(2)}°, ${lng.toFixed(2)}°`;
  }
  $('#btn-confirm-hq').disabled = false;
}

$('#btn-confirm-hq').addEventListener('click', async () => {
  if (!pickedHQ) return;
  const btn = $('#btn-confirm-hq');
  btn.disabled = true;
  try {
    const res = await fetch('/api/sethq', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ...pickedHQ })
    });
    if (!res.ok) throw new Error('failed');
    await afterAuth();
  } catch {
    btn.disabled = false;
    alert('Could not save HQ — try again');
  }
});

// ============ SETUP ============
$('#form-setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#setup-err').textContent = '';
  const fd = new FormData(e.target);
  const body = {
    token,
    ticker: fd.get('ticker').trim().toUpperCase(),
    sector: fd.get('sector'),
  };
  try {
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'setup failed');
    await afterAuth();
  } catch (err) {
    $('#setup-err').textContent = err.message;
  }
});

// ============ DASHBOARD ============
function enterDash() {
  showScreen('dash');
  $('#my-ticker').textContent = me.ticker;
  $('#my-sector').textContent = me.sector;
  $('#my-hq').textContent = me.hq ? ([me.hq.city, me.hq.country].filter(Boolean).join(', ') || `${me.hq.lat.toFixed(1)}°, ${me.hq.lng.toFixed(1)}°`) : '—';
  renderActions();
  connectSocket();
  render();
}

function connectSocket() {
  if (socket) return;
  socket = io();
  socket.on('connect', () => socket.emit('subscribe', { token }));
  socket.on('me', (data) => {
    me = data;
    if (me.bankrupt) showBankrupt();
    render();
  });
  socket.on('tick', (data) => {
    marketState = data.market;
    leaderboardCache = data.leaderboard;
    renderMarketState();
    renderLeaderboard();
    $('#stat-nas').textContent = (marketState.nasdaqPct >= 0 ? '+' : '') + marketState.nasdaqPct.toFixed(2) + '%';
    $('#stat-nas').className = 'stat-val ' + (marketState.nasdaqPct >= 0 ? 'up' : 'down');
  });
  socket.on('news', (item) => {
    newsFeedCache.push(item);
    if (newsFeedCache.length > 50) newsFeedCache.shift();
    renderNews();
  });
  socket.on('trade', (item) => {
    tradeFeedCache.push(item);
    if (tradeFeedCache.length > 50) tradeFeedCache.shift();
    renderTrades();
  });
}

// ============ RENDER ============
function render() {
  if (!me) return;
  renderPrice();
  renderChart();
  renderStats();
  renderActions();
  renderBoosts();
  renderMarketState();
  renderNews();
  renderTrades();
  renderLeaderboard();
}

function renderPrice() {
  $('#my-price').textContent = '$' + me.stockPrice.toFixed(2);
  const history = filteredHistory(currentRange);
  if (history.length >= 2) {
    const first = history[0].p;
    const last = history[history.length - 1].p;
    const delta = last - first;
    const pct = (delta / first) * 100;
    const sign = delta >= 0 ? '+' : '';
    $('#my-change').textContent = `${sign}$${delta.toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
    $('#my-change').className = 'price-change ' + (delta >= 0 ? 'up' : 'down');
  } else {
    $('#my-change').textContent = '+$0.00 (0.00%)';
    $('#my-change').className = 'price-change up';
  }
}

function renderStats() {
  $('#stat-cash').textContent = fmtMoney(me.cash);
  $('#stat-cash').className = 'stat-val ' + (me.cash >= 0 ? '' : 'down');
  $('#stat-mcap').textContent = fmtMoneyShort(me.marketCap);
  $('#stat-rev').textContent = fmtMoney(me.revenue) + '/m';
  $('#stat-cost').textContent = fmtMoney(me.upkeep + me.opCost) + '/m';
  const net = me.netPerMin;
  $('#stat-net').textContent = (net >= 0 ? '+' : '') + fmtMoney(net) + '/m';
  $('#stat-net').className = 'stat-val ' + (net >= 0 ? 'up' : 'down');
  $('#stat-nas').textContent = (marketState.nasdaqPct >= 0 ? '+' : '') + marketState.nasdaqPct.toFixed(2) + '%';
  $('#stat-nas').className = 'stat-val ' + (marketState.nasdaqPct >= 0 ? 'up' : 'down');
}

function renderMarketState() {
  $('#market-dot').className = 'dot' + (marketState.isOpen ? ' open' : '');
  $('#market-text').textContent = marketState.isOpen ? 'Market open' : 'After hours';
}

// ---------- Actions ----------
const ACTION_DEFS = {
  tech: [
    { key: 'server',    label: 'Buy Server',         cost: 500,  meta: '+$50 rev / -$5 upkeep per min' },
    { key: 'engineer',  label: 'Hire Engineer',      cost: 1500, meta: '+$200 rev / -$30 upkeep per min' },
    { key: 'product',   label: 'Launch Product',     cost: 5000, meta: 'one-time sentiment boost (8 min)' },
    { key: 'marketing', label: 'Marketing Campaign', cost: 2000, meta: 'one-time sentiment boost (5 min)' },
  ]
};

function renderActions() {
  if (!me || !me.sector) return;
  const list = $('#actions-list');
  list.innerHTML = '';
  const defs = ACTION_DEFS[me.sector] || [];
  defs.forEach(def => {
    const count = (me.assets || {})[def.key] || 0;
    const afford = me.cash >= def.cost;
    const btn = document.createElement('button');
    btn.className = 'action-btn' + (afford ? '' : ' afford-no');
    btn.disabled = !afford || me.bankrupt;
    btn.innerHTML = `
      <div>
        <div class="a-label">${def.label}${count ? `<span class="a-count">×${count}</span>` : ''}</div>
        <div class="a-meta">${def.meta}</div>
      </div>
      <div class="a-cost">$${def.cost.toLocaleString()}</div>
    `;
    btn.addEventListener('click', () => doAction(def.key));
    list.appendChild(btn);
  });
}

async function doAction(key) {
  try {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, action: key })
    });
    const data = await res.json();
    if (!res.ok) { console.warn(data.error); return; }
    socket.emit('refreshMe', { token });
  } catch (e) { console.error(e); }
}

function renderBoosts() {
  const el = $('#active-boosts');
  el.innerHTML = '';
  const now = Date.now();
  (me.activeBoosts || []).forEach(b => {
    const min = Math.max(0, Math.round((b.expiresAt - now) / 60000));
    const sec = Math.max(0, Math.round((b.expiresAt - now) / 1000));
    const tl = min > 0 ? `${min}m` : `${sec}s`;
    const pill = document.createElement('span');
    pill.className = 'boost-pill';
    pill.textContent = `${b.key} +${(b.sentiment*100).toFixed(0)}% • ${tl}`;
    el.appendChild(pill);
  });
}

// ---------- News feed ----------
function renderNews() {
  const ul = $('#news-feed');
  ul.innerHTML = '';
  const items = [...newsFeedCache].reverse();
  for (const n of items.slice(0, 20)) {
    const li = document.createElement('li');
    const tag = `<span class="feed-tag ${n.type}">${n.type}</span>`;
    const time = `<span class="feed-time">${fmtTime(n.t)}</span>`;
    const sent = n.sentiment > 0 ? `<span class="feed-sentiment up"> +${(n.sentiment*100).toFixed(0)}%</span>`
              : n.sentiment < 0 ? `<span class="feed-sentiment down"> ${(n.sentiment*100).toFixed(0)}%</span>`
              : '';
    li.innerHTML = `${time}${tag}${n.text}${sent}`;
    ul.appendChild(li);
  }
}

// ---------- Trade feed ----------
function renderTrades() {
  const ul = $('#trade-feed');
  ul.innerHTML = '';
  const items = [...tradeFeedCache].reverse();
  for (const t of items.slice(0, 20)) {
    const li = document.createElement('li');
    li.className = 'feed-trade';
    const left = `<span><span class="trade-action ${t.action}">${t.action}</span> <strong>${t.ticker}</strong> <span class="trade-bot">— ${t.bot}</span></span>`;
    const right = `<span>${t.shares.toLocaleString()} @ $${t.price.toFixed(2)}</span>`;
    li.innerHTML = `${left}${right}`;
    ul.appendChild(li);
  }
}

// ---------- Leaderboard ----------
function renderLeaderboard() {
  const tbody = $('#leaderboard tbody');
  tbody.innerHTML = '';
  for (const row of leaderboardCache) {
    const tr = document.createElement('tr');
    if (row.username === me?.username) tr.className = 'me';
    if (row.bankrupt) tr.classList.add('bankrupt');
    const chgCls = row.change24h >= 0 ? 'up' : 'down';
    const chgSign = row.change24h >= 0 ? '+' : '';
    tr.innerHTML = `
      <td class="tk">${row.ticker}</td>
      <td class="price">$${row.stockPrice.toFixed(2)}</td>
      <td class="chg ${chgCls}">${chgSign}${row.change24h.toFixed(2)}%</td>
      <td class="price">${fmtMoneyShort(row.marketCap)}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ---------- Chart ----------
$$('.rtab').forEach(t => {
  t.addEventListener('click', () => {
    $$('.rtab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    currentRange = t.dataset.range;
    renderChart();
    renderPrice();
  });
});

function filteredHistory(range) {
  if (!me || !me.priceHistory) return [];
  const now = Date.now();
  let cutoff;
  switch (range) {
    case '1d': cutoff = now - 24 * 60 * 60 * 1000; break;
    case '1m': cutoff = now - 30 * 24 * 60 * 60 * 1000; break;
    case '1y': cutoff = now - 365 * 24 * 60 * 60 * 1000; break;
    case 'all': cutoff = 0; break;
  }
  return me.priceHistory.filter(p => p.t >= cutoff);
}

function renderChart() {
  const svg = $('#chart');
  svg.innerHTML = '';
  const data = filteredHistory(currentRange);
  if (data.length < 2) return;

  let points = data;
  if (points.length > 500) {
    const step = Math.ceil(points.length / 500);
    points = points.filter((_, i) => i % step === 0);
    if (points[points.length - 1] !== data[data.length - 1]) points.push(data[data.length - 1]);
  }

  const W = 800, H = 240, padY = 20;
  const minP = Math.min(...points.map(p => p.p));
  const maxP = Math.max(...points.map(p => p.p));
  const range = Math.max(0.01, maxP - minP);
  const minT = points[0].t;
  const maxT = points[points.length - 1].t;
  const spanT = Math.max(1, maxT - minT);

  const first = points[0].p;
  const last = points[points.length - 1].p;
  const isDown = last < first;

  const xy = (pt) => {
    const x = ((pt.t - minT) / spanT) * W;
    const y = padY + (1 - (pt.p - minP) / range) * (H - 2 * padY);
    return [x, y];
  };

  let d = '';
  for (let i = 0; i < points.length; i++) {
    const [x, y] = xy(points[i]);
    d += (i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)} ` : `L ${x.toFixed(2)} ${y.toFixed(2)} `);
  }

  const [lastX] = xy(points[points.length - 1]);
  const [firstX] = xy(points[0]);
  const dArea = d + `L ${lastX.toFixed(2)} ${H} L ${firstX.toFixed(2)} ${H} Z`;

  const ns = 'http://www.w3.org/2000/svg';
  const areaPath = document.createElementNS(ns, 'path');
  areaPath.setAttribute('d', dArea);
  areaPath.setAttribute('class', 'area' + (isDown ? ' down' : ''));
  svg.appendChild(areaPath);

  const [, firstY] = xy(points[0]);
  const baseline = document.createElementNS(ns, 'line');
  baseline.setAttribute('x1', 0); baseline.setAttribute('x2', W);
  baseline.setAttribute('y1', firstY); baseline.setAttribute('y2', firstY);
  baseline.setAttribute('class', 'baseline');
  svg.appendChild(baseline);

  const linePath = document.createElementNS(ns, 'path');
  linePath.setAttribute('d', d);
  linePath.setAttribute('class', 'line' + (isDown ? ' down' : ''));
  svg.appendChild(linePath);
}

// ============ BANKRUPT ============
function showBankrupt() { $('#bankrupt-modal').classList.remove('hidden'); }
$('#btn-restart').addEventListener('click', () => {
  localStorage.removeItem('mb_token');
  token = null;
  location.reload();
});

// ============ LOGOUT ============
$('#btn-logout').addEventListener('click', () => {
  localStorage.removeItem('mb_token');
  token = null;
  location.reload();
});

// ============ UTILS ============
function fmtMoney(n) {
  if (typeof n !== 'number') return '$0';
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(Math.round(n)).toLocaleString();
}
function fmtMoneyShort(n) {
  if (typeof n !== 'number') return '$0';
  const abs = Math.abs(n);
  if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}
function fmtTime(t) {
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ============ BOOT ============
(async function boot() {
  setupGoogleSignIn();
  if (token) {
    await afterAuth();
  } else {
    showScreen('welcome');
  }
})();
