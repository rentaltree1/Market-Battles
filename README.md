# Market Battles

A stock-market game where **bots invest in you**. Pick a ticker, plant your HQ
on the globe, run your company, and survive the market.

## What's in Phase 1.1

- **Welcome card** intro screen
- **Login / sign up** with username + password (Google sign-in optional, see below)
- **3D globe** to pick your company's HQ — click any spot on Earth, name auto-resolved
- Pick a ticker + Tech sector → IPO at $15/share
- Live stock chart (1D / 1M / 1Y / All Time)
- 5 named whale bots trading your stock based on personality
- News feed: global, sector-specific, and per-company rumors
- CEO actions: Buy Server, Hire Engineer, Launch Product, Marketing Campaign
- Operating costs scale up over time → standing still = bankruptcy
- Real Nasdaq Composite influences ~30% of price during market hours
- Public leaderboard of all players
- 24/7 server-side simulation

Health + Energy sectors, retail bot swarm, loans, research tree, and private
rooms with codes are still Phase 2 / 3.

## Local run

```
npm install
npm start
```

Then open http://localhost:3000.

## Deploy to Render

Same as before — same flow as your hide-and-seek game:

1. On GitHub, create / open the `Market-Battles` repo
2. Upload `package.json`, `server.js`, and `README.md` to the root
3. Create `public/index.html`, `public/style.css`, `public/client.js` with the new contents
4. On Render: **New → Web Service** → connect repo → Build: `npm install`, Start: `npm start` → **Deploy**

If you already deployed before, just push the new files — Render auto-redeploys.

## Optional: enable Google Sign-In

If you don't do this, the "Continue with Google" button just stays hidden and username/password works normally.

1. Go to https://console.cloud.google.com/ and create a new project (or use an existing one)
2. **APIs & Services → OAuth consent screen** — set User type to **External**, fill in app name, your email, save
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized JavaScript origins: add your Render URL (e.g. `https://market-battles-xxxx.onrender.com`) and `http://localhost:3000` for local dev
   - Click **Create**
4. Copy the **Client ID** (looks like `xxxxx.apps.googleusercontent.com`)
5. On Render: **Environment → Add Environment Variable**
   - Key: `GOOGLE_CLIENT_ID`
   - Value: paste the Client ID
   - Save (Render will redeploy)

Done. The button will appear automatically.

## Notes

- **Render free tier sleeps** after 15 min of inactivity. When it wakes, game state resumes from the last save.
- **HQ location** is cosmetic only — no gameplay effect, just shows up on your dashboard and (later) the leaderboard.
- **Bankruptcy = game over.** Hit "Start over" to sign up with a new ticker.
- **The globe** uses Three.js + a NASA Blue Marble texture loaded from CDN. No setup needed.
- **Reverse geocoding** uses free OpenStreetMap Nominatim. If it ever fails, the HQ just gets stored as coordinates.

## File map

```
market-battles/
├── package.json
├── server.js          ← Express + Socket.IO + auth + game loop + bots + news
├── README.md
└── public/
    ├── index.html     ← welcome, auth, HQ globe, setup, dashboard screens
    ├── style.css      ← purple/glassmorphic styling
    └── client.js      ← screen routing, globe, sockets, chart, UI
```

## Tweak knobs (in `server.js`)

- Bot personalities: `BOTS` array
- News pool: `GLOBAL_NEWS`, `TECH_NEWS`, `COMPANY_RUMORS`
- Action costs / revenue: `SECTORS.tech.actions`
- Operating cost growth: `STARTING_OP_COST_PER_MIN`, `OP_COST_GROWTH_PER_DAY`
- Tick speed: `TICK_MS` (default 10 s)
- Price formula weights (30/50/20): inside `tick()`
