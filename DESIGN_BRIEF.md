# The Midnight Theatre — Digital Build Brief

You are building a fully playable online version of "The Midnight Theatre" (working title "The Majestic"), a circus-themed drafting/collection board game for 2-5 players. This brief is your ground truth — implement from this document plus `assets/card_database.json` and the card images in `assets/cards/`. The original rules PDF is also included at `assets/Rules.pdf` for reference, but this brief supersedes it wherever they conflict, since it fills in gaps the PDF leaves open.

## Requirements (non-negotiable)

1. **Online multiplayer with real human players**, not just local hotseat. Different people on different devices/browsers need to be able to join the same game via a room code or link.
2. **AI players** that can fill any empty seat and play a complete, rules-legal game start to finish without a human.
3. **Deployable to a public URL.** I (the coding agent) cannot create accounts on hosting platforms on the owner's behalf, so structure the project to deploy with minimal manual steps: a Node.js backend + static frontend that runs with one `npm install && npm run build && npm start`, plus config for a simple one-click host (Render, Railway, or Fly.io — pick one and include the config file). Document the exact manual steps (account creation, connecting the repo, clicking deploy) in `README.md` since those steps require the owner's own account.
4. Also make sure it **runs locally** (`npm run dev` or equivalent) so it can be tested immediately without any deployment step.

## Suggested architecture (you have latitude here — this is a strong default, not a mandate)

- **Backend:** Node.js + Express + Socket.IO (or ws) for real-time game-state sync. Authoritative game state lives server-side; clients send intents (`acquireCard`, `rearrange`, `useFavor`, etc.), server validates against the rules engine and broadcasts the new state.
- **Rules engine:** a pure, framework-free state machine/module (no I/O) that takes `(state, action) -> newState` or throws on illegal moves. Keep this completely separate from networking and UI code — it's the part most likely to need tweaks later, and it's what the AI bots and any future automated tests will call directly.
- **AI bots:** implement as a module that, given the current state and a seat it controls, produces a legal action using reasonable heuristics (see "Rules the written doc left open" below for what "reasonable" should optimize toward). Doesn't need to be a strong player, just legal, non-stalling, and make sensible-looking decisions.
- **Frontend:** a single-page app (React+Vite is a good default) rendering each player's mat (8 slots), the central market/draft row, dice results, coins/hearts/stars/trophies, and the card images from `assets/cards/`. Card art is already fully illustrated and print-ready — just display the PNGs, no need to re-render card faces from scratch.
- **Room/session model:** a host creates a room and gets a shareable code/link; other players (or the host, for empty seats) can assign AI to any unfilled seat. 2-5 total seats per the rules.

## Full rules (verbatim from the "Current Rules" doc, v31)

### Equipment
- 5 Player mats — 8 slots each: slots 1-5 for Performers, slot 6 for Backdrop, slot 7 for Prop, slot 8 for Trainer.
- 1 Central mat — draft cards, resource tokens, and a space indicating how many Tomato dice will be rolled that round.
- 10 dice total:
  - 5x D20 "Collection Dice" — faces: A, B, C, C, D, D, E, E, E, F, F, F, G, G, G, G, H, H, H, H (i.e. letters A-H with increasing frequency A→H, matching the Letter printed on each of the 64 Performer cards).
  - 9x D8 "Heckler"/Tomato dice — faces numbered 1-8 (matching player-mat slot numbers 1-8).
- 140 cards: 64 Performers, 10 Backdrop, 10 Prop, 10 Trainer, 10 Re-roll (5 Press Pass, 5 Audience/"Tomato"), 16 Favor (8x "1st", 8x "2nd+"), 24 Resource (1/2/3, x2 each, of Hearts/Stars/Coins/Cards).
- 163 tokens: 50 stars, 50 hearts, 50 coins, 13 trophies.
- 5 Draft Order stands (numbered 1-5).

### Object
Build the most legendary troupe of performers by earning Trophies. First to the trophy threshold wins (see Winning below).

### Setup
- Give each player a mat (5 Performer slots, 1 Backdrop, 1 Prop, 1 Trainer — all start empty).
- Shuffle the 140-card deck, place it centrally as the draw pile.
- Lay out a market of 4 cards next to the deck.
- Randomly pick a first player, give them Draft Order stand "1" and 0 starting coins. Going clockwise, each next player gets the next stand number and 2 more coins than the previous (stand 2 = 2 coins, stand 3 = 4 coins, stand 4 = 6 coins, stand 5 = 8 coins).

### Round structure
1. **Lay out the draft:** place face-up cards in the center equal to `(number of players x 2) + 1`.
2. **Draft phase:** players take turns strictly in current draft-order (stand 1 first, etc). On your turn you must do exactly one of:
   - **Acquire 1 card**, either:
     - free, from the face-up draft row, OR
     - from the 4-card market by paying its coin cost (market slots cost 1/2/3/4 coins left-to-right). Buying from the market shifts remaining market cards down and refills the empty top (4-coin) slot from the deck.
     - Before deciding to acquire (or not), a player may reset the market by paying 1 coin — discard the 4 current market cards, deal 4 new ones. This can be repeated any number of times (1 coin each) before the player's actual acquire decision.
   - **Or, rearrange** your own board/reserve cards in any way (no new card gained) — this consumes the turn.
   - When a card is acquired: if it's a Performer/Backdrop/Prop/Trainer, place hearts on it up to its printed starting-heart value (pull heart tokens from the central supply). If its home slot on your mat is already occupied, the old occupant moves to your reserve (unlimited size, includes draft picks you're holding). If the newly acquired card is a Resource or Favor card, see their special handling below instead of placing it on your mat.
   - Play continues around the draft-order stands, looping, until only 1 card remains face-up in the draft row — discard that last card, and the draft phase ends. (Players usually get ~2 turns/round, but can get more by spending Favor cards for extra turns, or fewer if they spent turns buying/rearranging instead of drafting.)
3. **Dice phase:**
   - **Roll all 5 Collection Dice, one at a time.** For each die result (a letter A-H), every player who has a Performer on their mat with that Letter collects: if that performer's printed resource is Star or Coin, place the token on the player's central token pool (not on the card); if it's a Heart, immediately assign it to any of that player's starter or reserve cards up to that card's max heart capacity.
   - **Assign the Trophy:** whoever earned the most Stars this round takes a Trophy token. Tie → most Coins among the tied wins it. Still tied → all tied players take a Trophy. The trophy winner(s) must then remove 1 heart from each of their "starters" (their 8 mat-slot cards — Performers, Backdrop, Prop, and Trainer — see "Rules the written doc left open" for why this includes non-Performer slots). Do not refill empty slots yet.
   - **Assign new Draft Order:** fewest Stars this round → stand "1" (goes first next round). Next fewest → stand "2", etc. Tie → fewer Coins gets the better (lower) stand. Still tied → fewer total Trophies gets the better stand. Still tied → roll-off.
   - **Roll Tomato dice:** roll a number of D8 Tomato dice equal to the current round number (round 1 = 1 die, round 2 = 2 dice, etc). For every rolled number 1-8, every player removes 1 heart from whatever currently occupies that slot number on their own mat. If a card hits 0 hearts this way, discard it from the mat entirely.
   - **Refill:** any now-empty mat slots (from tomato hits or trophy heart removal that emptied a card) are refilled from that player's reserve, if they have a suitable card there.
4. **Next round:** lay out `(players x 2) + 1` new draft cards, add 1 more Tomato die to next round's roll, and repeat from step 2.

### Winning
First to reach the Trophy threshold wins: 4-5 players → 3 Trophies. 2-3 players → 4 Trophies. Simultaneous qualifiers win together.

### Card-type handling
- **Performers** (64): the core troupe cards — Characteristic (Graceful/Powerful/Dramatic/Haunting), Type (Singer/Dancer/Acrobat/Illusionist), Gender, Letter (A-H, drives Collection Die matches), Resource (Star/Heart/Coin), starting Hearts (0-3, see `card_database.json` — use these values for game logic, NOT anything visually printed on the physical card sheet), and Power Dots (1-4, currently flavor/unused by any written rule — surface it in the UI but it has no mechanical effect unless you find one implied elsewhere).
- **Backdrop/Prop** (10 unique effects each, one copy of each = 20 cards): occupy the Backdrop or Prop mat slot. See `card_database.json` for each card's `boostKind` (characteristic or type), `boosts` (which value(s) it matches — the 2 wildcard cards per set match all 4 characteristics or all 4 types), and `startingHearts` (2 for the 8 single-match cards, 1 for the 2 wildcard cards). Effect (see "Rules the written doc left open" below for sourcing): when a Collection Die causes a Performer on the same player's board to collect, and that Performer's characteristic/type matches the player's equipped Backdrop or Prop, that performer collects +1 extra unit of their printed resource.
- **Trainer** (10 unique, 1 copy each): occupy the Trainer mat slot, 3 starting hearts, grants a unique passive/activatable ability — see the table below.
- **Resource cards** (24 = 12 unique x2): never occupy a mat slot. On acquire, immediately resolve per `card_database.json`'s `effect` field (take coins / assign hearts / gain stars / draw cards — see assumptions below for the "Cards" resource) and discard the card.
- **Favor cards** (16 = 2 unique x8): go to reserve on acquire. On any future round, may be discarded from reserve immediately after your 1st or 2nd turn of that round (per the card's printed timing) to take an additional turn right away. Rule: you can't spend a Favor draft pick to draft another Favor of the exact same timing (1st-for-1st or 2nd-for-2nd) — i.e. when a Favor card is in the draft/market, a player may not acquire it via a "spend a favor for an extra turn" action if it's the same timing as the favor being spent; normal acquisition (paying coins or drafting on a normal turn) is unaffected. Implement this restriction narrowly — it only blocks using a same-type Favor's bonus turn to acquire another same-type Favor.
- **Re-roll cards** (10 = Press Pass x5, Audience/"Tomato" x5): go to reserve on acquire. Discard from reserve at any time to re-roll one Collection Die result (Press Pass) or one Tomato Die result (Audience). The printed number 1-5 on each is flavor/unique-art only — all 5 of a given type function identically.

### Trainer abilities (implement each as an isolated, clearly-named rule module)

| Trainer | Ability |
|---|---|
| Madame Coeur | All cards on your board have max heart capacity +1 versus their printed value. |
| Tomasso the Terrible | Discard 1 card from the draft row (your turn) to trigger an extra Tomato die roll immediately; the resulting heart loss applies to every OTHER player's board, not yours. |
| Madame Curio | Discard 1 card from the draft row (your turn) to trigger an extra Collection Die roll immediately; only you collect from it, other players' matching performers do not. |
| Professor Stainglass | Discard 1 card from the draft row (your turn) to draw the top card of the deck directly into your reserve. |
| Auric the Alchemist | At any time, you may convert your own collected Coins to Hearts or Hearts to Coins 1-for-1 (assign the converted heart to any eligible card of yours; the reverse returns a heart token to the supply for a coin). |
| Barnaby Pennywhistle | All market purchase costs are reduced by 1 coin (minimum 1); does not reduce the 1-coin market-reset cost. |
| Madame Barre | When placing an acquired card, you may put it in any mat slot regardless of normal type restrictions (e.g. a Performer could occupy... — use judgment: at minimum, this should let the player freely choose which of their 5 Performer slots a new Performer goes into, and freely reorder existing board cards, rather than being locked to a fixed slot-fill order). |
| Maximillian the Magnate | You may acquire any number of cards from the market in a single turn (normally 1 acquire = 1 turn). |
| Mesmera the Veiled | Your Press Pass and Audience re-roll cards each grant 3 re-roll attempts instead of 1 when used (you may re-roll the re-roll, up to 3 total rolls, keeping the final result). |
| The Vanishing Valentino | Once per game, you may spend your turn to discard this Trainer card from your own board, which discards every card currently in the draft row (they're replaced next round as normal). You permanently lose your Trainer slot's benefit for the rest of the game after doing this. |

## Rules the written doc left open — documented assumptions

The source rules document is a work-in-progress design doc, not a complete spec, and is silent on a few things this build needs. Here's what to implement, and why, so the owner can quickly correct anything that's off:

1. **Prop/Backdrop mechanical effect** — the owner specified directly: *"+1 collection of resource when rolled performer matches prop or background."* Implemented as: when a Collection Die causes one of your Performers to collect, and that Performer's characteristic or type matches your equipped Prop/Backdrop's boost, you collect one extra unit of that performer's resource.
2. **"Card" resource cards' effect** — the rules doc's Resource Cards section only describes Coin/Heart/Star; it's silent on the "Card" resource type that exists in the physical deck (1/2/3 cards, x2). Implemented as: immediately draw that many cards from the deck straight into your reserve, bypassing the draft. This is the most natural fit alongside the other three (all four are "immediately gain N of X").
3. **"Starters" scope for trophy-winner heart removal and tomato-die targeting** — the doc says "remove 1 heart from each of their starters" and "remove hearts from the indicated slots" (slot numbers 1-8). Since Backdrop/Prop/Trainer cards are printed with hearts too, this build treats all 8 mat slots (5 Performers + Backdrop + Prop + Trainer) as valid "starter" targets for both the trophy-winner heart removal and Tomato die slot-hits, not just the 5 Performer slots.
4. **How many Collection Dice are rolled per round** — the doc says "roll collection dice one at a time" without stating a count. Implemented as: all 5 Collection Dice are rolled once per round (not per player), each resolved fully (every player checks for a match) before moving to the next die.
5. **Re-roll card card numbers (1-5)** — treated as cosmetic/unique-art only, not mechanically distinct.

Please flag any of these 5 in the README as "assumptions made — confirm with Travis" so they're easy to find and correct later.

## Card data

`assets/card_database.json` has six top-level arrays: `performers` (64), `propsAndBackdrops` (20), `trainers` (10), `resources` (24), `favors` (16), `rerolls` (10). Every card object has an `image` field with a path relative to `assets/` — every path has been verified to resolve to a real file, so load directly, no name-guessing needed.

## AI bot behavior guidance

Doesn't need to be optimal, just legal and coherent. Reasonable heuristics: prefer free draft picks that fill an empty mat slot over ones that would bump a card to reserve; weight Performers by matching resource type to whichever resource the bot is behind on; use Favor cards for extra turns when available rather than hoarding; spend re-roll cards defensively when a Tomato die would hit a nearly-empty-hearts card the bot cares about; otherwise acquire the highest-value card available for free before considering a market purchase. Make the AI's turn-taking fast (no long "thinking" delays) so games don't stall.

## Deliverable location

Build the project in this folder (`Midnight Theatre Game/`). Keep `assets/` as-is (card images + database + rules PDF). Everything else (backend, frontend, config, README) is yours to structure.
