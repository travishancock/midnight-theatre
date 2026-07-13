# The Midnight Theatre (The Majestic) — online multiplayer

A fully playable online version of the circus-themed drafting/collection card
game for 2–5 players. Real players join the same game from different devices
via a 4-letter room code; AI players can fill any empty seat and play a
complete, rules-legal game on their own.

- **Rules engine** — `engine/` — a pure, framework-free state machine
  (`applyAction(state, action)`), deterministic via a seeded RNG. All 139
  cards, all 10 Trainer abilities, Favors, Press Pass re-roll cards, market,
  dice phase, trophies, tomato dice, and refill are implemented here.
- **Server** — `server/index.js` — Express + Socket.IO. Rooms, seats,
  authoritative game state, action validation, and server-driven AI seats.
  Players who disconnect mid-game get 60 seconds to rejoin (same name), then
  an AI takes over so the game never stalls.
- **Client** — `client/` — a Vite single-page app rendering each player's
  8-slot mat, the draft row, the market, dice results, coins/stars/trophies,
  and the actual card art from `assets/cards/`.
- **AI bot** — `engine/bot.js` — produces a legal action for every decision
  point the engine can raise, with the heuristics from the design brief.
  Bot turns run at ~200 ms so games move quickly but stay watchable.

## Requirements

- Node.js 18 or newer (`node --version` to check; install from
  [nodejs.org](https://nodejs.org) if needed).

## Running locally

From this folder (`Midnight Theatre Game/`):

```bash
npm install        # installs server + client dependencies (one-time)
npm run dev        # starts the game server (:3000) and the client dev server (:5173)
```

Open **http://localhost:5173** in a browser. Create a room, share the room
code (other people on your network / other browser tabs can join at the same
address), add AI players for any empty seats, and press Start.

Production mode (what a real host runs — single server, no dev tooling):

```bash
npm install
npm run build      # builds the client into client/dist
npm start          # serves game + client together on http://localhost:3000
```

## Tests

```bash
npm test
```

- `test/rules.test.js` — 32 unit-level engine checks (setup, market, every
  notable Trainer ability, favors, Press Pass/Mesmera re-rolls, rearranging,
  a deterministic dice phase, card conservation).
- `test/fullgame.test.js` — 12 complete AI-only games (2–5 players × 3 seeds
  each) played start to finish, asserting every game reaches a valid win
  state with no illegal moves and all 139 cards accounted for after every
  single action.

## Deploying to a public URL (Render.com)

This repo includes `render.yaml`, so Render can configure everything
automatically. These steps require your own account, so they're manual:

1. **Put this project on GitHub.** Create a repository (e.g.
   `midnight-theatre`) and push the contents of this folder
   (`Midnight Theatre Game/`) as the **repository root** — `package.json` and
   `render.yaml` must sit at the top level of the repo.
   ```bash
   cd "Midnight Theatre Game"
   git init && git add -A && git commit -m "Midnight Theatre"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/midnight-theatre.git
   git push -u origin main
   ```
2. **Create a Render account** at https://render.com (free tier is fine —
   the game holds state in memory and needs no database).
3. In the Render dashboard click **New → Blueprint**, connect your GitHub
   account when prompted, and pick the `midnight-theatre` repository. Render
   reads `render.yaml` and shows a service called `midnight-theatre`.
4. Click **Apply / Deploy**. The first build takes a few minutes (it runs
   `npm install && npm run build`, then `npm start`).
5. When it turns green, your game is live at
   `https://midnight-theatre.onrender.com` (Render shows the exact URL).
   Share that link — players create/join rooms exactly like on localhost.

Notes:
- On the **free plan** the server sleeps after ~15 minutes of inactivity; the
  first visit after that takes ~30–60 s to wake. Games in progress do not
  survive a sleep or redeploy (state is in memory by design for a prototype).
- No environment variables are required. The server honors `PORT`, which
  Render sets automatically.

## Assumptions made — confirm with Travis

The written rules doc left five things open. The build implements the
following interpretations (from the design brief); each is easy to change in
the engine if any is wrong:

1. **Prop/Backdrop mechanical effect** — when a Collection Die makes one of
   your Performers collect, and that Performer's characteristic or type
   matches your equipped Prop/Backdrop's boost, the performer collects **+1
   extra unit** of its printed resource ("+1 collection of resource when
   rolled performer matches prop or background").
2. **"Card" resource cards** — the rules doc only describes Coin/Heart/Star
   resource cards; the "Card" ones (1/2/3 cards, ×2 each) are implemented as:
   **immediately draw that many cards from the deck straight into your
   reserve**, bypassing the draft.
3. **"Starters" scope** — the trophy-winner's "remove 1 heart from each of
   their starters" and the Tomato dice slot hits (1–8) both target **all 8
   mat slots** (5 Performers + Backdrop + Prop + Trainer), since those cards
   are printed with hearts too — not just the 5 Performer slots.
4. **Collection dice count** — **all 5 Collection Dice are rolled once per
   round** (not per player), each die resolved fully for every player before
   the next is rolled.
5. **Re-roll card numbers (1–5)** — superseded by a later, more specific
   ruling: the printed number on each Press Pass identifies **which
   Collection Die of the round** it reacts to (Press Pass 1 → the round's
   1st die, … Press Pass 5 → the 5th), spent from reserve while that one die
   is rolled but not yet locked, granting that many re-rolls of it. The
   Audience/"Tomato" re-roll cards were removed from the game entirely, and
   Mesmera the Veiled's ability now re-rolls the whole Tomato batch once
   instead of adding extra attempts to these cards. The Trophy tie-break was
   also clarified to use each tied player's **total (career) coins**, not
   just coins earned that round.

## Project layout

```
assets/               card art (PNGs), card_database.json (all 139 cards), Rules.pdf
engine/               pure rules engine + AI bot (no I/O — fully testable)
server/index.js       Express + Socket.IO game server
client/               Vite single-page app (built into client/dist)
test/                 rules unit tests + full AI-game simulations
render.yaml           one-click Render.com deploy blueprint
```
