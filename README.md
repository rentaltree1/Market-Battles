# Market Battles

A stock-market game where **bots invest in you**. Pick a ticker, pick a sector,
run your business, and survive the market.

## Phase 1 — what's built

- Sign up / log in (username + password, optional email)
- Pick a ticker + Tech sector → IPO at $15/share
- Live stock chart (1D / 1M / 1Y / All Time)
- 5 named whale bots trading your stock based on their personalities
- News feed: global, sector-specific, and per-company rumors
- CEO actions: Buy Server, Hire Engineer, Launch Product, Marketing Campaign
- Operating costs scale up over time → standing still = bankruptcy
- Real Nasdaq Composite influences ~30% of price during market hours
- Public leaderboard of all players
- 24/7 server-side simulation (your stock moves even when you're offline)

Health + Energy sectors, the swarm of retail bots, loans, research tree, and
private rooms with codes will land in Phase 2 / 3.

## Local run

```
npm install
npm start
```

Then open http://localhost:3000.

## Deploy to Render (same flow as your hide-and-seek game)

1. On GitHub, create a new repo (e.g. `Market-Battles`) or use an existing one.
2. Click **Add file → Upload files**. Drag in `package.json`, `server.js`, and `README.md` from this folder.
3. Scroll down → **Commit changes**.
4. Click into the `public` folder you just created (or use **Add file → Create new file** with path `public/index.html` first). Then upload `index.html`, `style.css`, and `client.js` into `public/`.
5. **Commit changes**.

On Render:
- **New → Web Service** → connect the GitHub repo.
- **Runtime**: Node
- **Build command**: `npm install`
- **Start command**: `npm start`
- Hit **Deploy**. First boot takes 2–4 minutes.

That's it. Render auto-deploys on every push to GitHub from now on.

## Notes

- **Render free tier sleeps** after 15 min of inactivity. When it wakes, game state resumes from the last save. The Nasdaq feed reconnects automatically.
- **No real money.** All trading is simulated. The Nasdaq pull is just a `% change` signal — no individual stocks involved.
- **Bankruptcy = game over.** Click "Start over" to sign up with a new ticker.

## File map

```
market-battles/
├── package.json
├── server.js          ← Express + Socket.IO + game loop + bots + news
├── README.md
└── public/
    ├── index.html     ← auth, setup, dashboard screens
    ├── style.css      ← Robinhood-inspired styling
    └── client.js      ← socket handling, chart, UI updates
```

## What to tweak

- **Bot personalities and counts**: `BOTS` array in `server.js`
- **News events**: `GLOBAL_NEWS`, `TECH_NEWS`, `COMPANY_RUMORS` in `server.js`
- **Action costs / revenue**: `SECTORS.tech.actions` in `server.js`
- **Operating cost scaling**: `STARTING_OP_COST_PER_MIN` and `OP_COST_GROWTH_PER_DAY` in `server.js`
- **Tick speed**: `TICK_MS` in `server.js` (default 10s; lower = more wiggle)
- **Price formula weights** (30/50/20): inside the `tick()` function in `server.js`
