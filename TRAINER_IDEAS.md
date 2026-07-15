# 30 New Trainer Concepts

Design brainstorm for **The Midnight Theatre**, written with an eye toward a *hypothetical* house rule where a player could equip a **second Trainer** alongside their first (e.g. a new co-Trainer slot, or letting the existing Trainer slot hold two cards — the mechanism itself is a separate future decision). Every ability below is meant to stand on its own as someone's *only* Trainer first — that's how the base game is actually played — and to light up in specific, non-obvious ways when paired with a second one.

None of this has been implemented. It's a menu to pick from, not a patch.

**How to read each entry:**
- **Ability** — printed-card-style text, matching the terse style of the existing 10 Trainers.
- **Category** — which of the engine's existing mechanical "verbs" it reuses (Passive, Proactive click, Discard-a-draft-card to activate, Real yes/no decision prompt, Dice-phase reaction window, Market/economy hook, Draft-order/turn-order hook), or **[NEW PATTERN]** if it would need a new engine hook. New-pattern ideas were kept to a minority (7 of 30) and are each a small, scoped addition — not a new subsystem.
- **Combos** — a specific existing Trainer or one of the other 29 that this pairs with, and why.

Grounded against the live implementation (`engine/engine.js`, `engine/bot.js`, `assets/card_database.json`, `DESIGN_BRIEF.md`) — reuses the same small set of verbs the engine already knows: heart add/remove, coin add/remove, an extra Collection/Tomato die, a card draw, a market-cost tweak, a re-roll, a pending yes/no prompt, an extra turn, or free placement.

---

## Heart / Tomato / Survival cluster

### 1. The Ironclad Impresario
- **Ability:** Once each round, you may ignore every Tomato-die hit against a single one of your eight slots.
- **Category:** Dice-phase reaction window (proactive click during the Tomato batch — a mini-Mesmera scoped to one slot).
- **Combos:** With **Madame Coeur** (existing), a full-hearted Star performer in your shielded slot becomes nearly unkillable, letting you commit hard to one letter all game. With **Mesmera** (existing) you get two bites at the Tomato apple: re-roll a bad batch, then still tank one surviving hit.

### 2. Madame Fantôme
- **Ability:** Your cards are not discarded by reaching 0 hearts from Tomato dice — only a hit taken while already at 0 removes them, and even then you may send the card to your reserve instead of the discard pile.
- **Category:** Passive (extends the existing "survives the hit to 0" rule by one step, plus a reserve-catch).
- **Combos:** With **#3 Doctor Vitalis** you park battered cards at 0, then heal them back up next round instead of losing them — a deliberate "durable veterans" identity.

### 3. Doctor Vitalis
- **Ability:** At the end of each Tomato phase, add 1 heart to any one of your cards (up to its max).
- **Category:** Dice-phase reaction (auto/proactive after hits lock — reuses heart-assign).
- **Combos:** With **#1** or **#25** you out-heal the board and never need to refill from reserve. With **Auric the Alchemist** (existing) the free heart can be immediately transmuted to a coin instead — a heart-to-coin faucet.

### 4. Signora Ombra, the Understudy
- **Ability:** When one of your slots empties, you may refill it immediately from your reserve — even mid-phase — and that replacement enters with 1 bonus heart.
- **Category:** Passive (reuses refill + heart-add; only the "immediate" timing is new).
- **Combos:** With **Professor Stainglass** (existing) or **#19 The Archivist**, your fat reserve becomes a live bench — cards drafted "for later" plug gaps the same round. With **Madame Coeur** (existing) replacements arrive full and the bonus heart caps them out instantly.

### 5. The Nightwatch (Constable Grimsby)
- **Ability:** Once per game, before the Tomato batch locks, cancel every hit against your own board this round.
- **Category:** Dice-phase reaction window (once-per-game, like Valentino's charge).
- **Combos:** With **Mesmera** (existing) you have a full defensive suite — re-roll most rounds, hard-cancel the one catastrophic late-game batch (round 5–6 rolls 5–6 dice). Save it for the round you're one Trophy from winning.

---

## Trophy / endgame-race cluster

### 6. The Gilded Ringmaster
- **Ability:** When you win a Trophy, remove only half your cards' hearts (round down) instead of one from each.
- **Category:** Passive (modifies the trophy-winner heart-removal loop).
- **Combos:** The natural enabler for an aggressive Star build, especially with **#23 The Tally Master** — win Trophies repeatedly without your troupe collapsing. With **Madame Coeur** (existing) you can win back-to-back rounds because your board re-tops-up on every acquire.

### 7. Ringmistress Céleste
- **Ability:** You win Star ties for the Trophy outright, and count as having the fewest Stars for next round's seating ties.
- **Category:** Passive (reads the existing tie-break logic).
- **Combos:** Turns near-misses into Trophies in tight 4–5 player games where ties are common. With **#16 Silas Sixpence** the coin tiebreak also tilts your way — you win Star ties two different ways.

### 8. Madame Mirabel
- **Ability:** Your best performer's Power Dots count as bonus Stars toward this round's Trophy total.
- **Category:** Passive — gives Power Dots a real payoff (currently unused/flavor-only field).
- **Combos:** Rewards drafting high-Power-Dot performers (the 4-dot G/H letters) that are otherwise chosen only for letter frequency. Deliberate tension with **#28 The Contortionist Coach** below, which wants the same stat for a different payoff.

### 9. The Grand Finale (Signor Fortissimo)
- **Ability:** Once any player reaches half the Trophy threshold, each Collection Die that matches one of your performers also earns you +1 Star.
- **Category:** [NEW PATTERN] — needs a "the race is on" flag exposed to the collection resolver. Small, scoped hook.
- **Combos:** A pure closer. With **#17 Lord Fenwick** or a **Press Pass**, re-roll a late-game dead die into a match that now pays double toward the win.

---

## Collection-die / resource cluster

### 10. Professor Kaleido
- **Ability:** Once per round, before a Collection Die locks, treat one of your performers as though its Letter matched the rolled die.
- **Category:** Dice-phase reaction window (proactive click).
- **Combos:** With **Madame Curio** (existing) you can force her bonus die to hit; with a **Press Pass**, re-roll toward a letter you have, then Kaleido a near-miss into a hit. Effectively guarantees one collect per round regardless of luck.

### 11. Madame Écho
- **Ability:** Once per round, when a Collection Die causes you to collect, collect from it a second time.
- **Category:** Dice-phase reaction (proactive click; reuses the collect resolver).
- **Combos:** A **Backdrop/Prop** match gets doubled too — a Graceful Backdrop plus Écho on a Graceful Star performer collects the base amount twice. With **#12 Professor Voltaic** the echoed collect also re-triggers its Power-Dot payout.

### 12. Professor Voltaic
- **Ability:** A performer of yours with 3 or more Power Dots collects +1 extra unit of its resource whenever it collects.
- **Category:** Passive — Power Dots effect (mirrors the Backdrop/Prop boost verb).
- **Combos:** Stacks additively with a matching **Backdrop/Prop** and with **Madame Écho (#11)** — a 3-dot performer under a matching prop collects base + prop + Voltaic. Pushes you to draft the high-letter, high-dot performers.

### 13. The Twin Mimic (Mademoiselle Gemini)
- **Ability:** Discard 1 card from the draft row to repeat the last Collection Die already rolled this round — everyone with a matching Letter collects again.
- **Category:** Discard-a-draft-card to activate (reuses the extra-die verb, but repeats a known result instead of rolling fresh).
- **Combos:** A "guarantee a repeat of a good letter" tool rather than a second **Madame Curio** (existing) — deliberately differentiated. Strong when you saw a die land on your best letter and want to bank it twice.

### 14. Madame Sang-Froid
- **Ability:** Once per round, convert 2 collected Coins into 1 Star for this round's Trophy count, or 1 Star into 2 Coins.
- **Category:** Proactive click (Auric-style conversion, retargeted to the Star pool).
- **Combos:** The Coin→Star pipe **Auric** (existing) can't do — pair the two and you have Coins↔Hearts↔Stars, a full economy that can buy a Trophy outright in a close round. Feeds nicely off **#16 Silas Sixpence**'s coin income.

### 15. The Menagerie Keeper
- **Ability:** Each of your performers whose Letter is A, B, C, or D collects +1 extra unit of its resource.
- **Category:** Passive (Backdrop-style boost keyed to Letter instead of Characteristic/Type).
- **Combos:** A–D are the rarer half of the Collection Die (each appears 1–2 times, vs. 3–4 times for E–H), so this rewards a contrarian board and pairs with **Press Passes** or **#17 Lord Fenwick** to fish for those rarer letters — a distinct archetype from the natural pull toward G/H performers.

---

## Market / economy cluster

### 16. Silas Sixpence
- **Ability:** At the start of each of your draft turns, take 1 coin from the supply.
- **Category:** Passive / market-economy hook.
- **Combos:** The economic engine behind every "spend coins" trainer here — feeds **#14 Sang-Froid**, **Auric** (existing), and market-buy plans. With **Maximillian** (existing) the steady drip funds multi-buy turns.

### 17. Mordecai Pinch, the Pawnbroker
- **Ability:** On your turn, discard a card from your reserve to gain coins equal to 1 + its Power Dots (Performers) or 2 (any other card).
- **Category:** Proactive click / market-economy hook — another Power Dots payoff.
- **Combos:** Turns **Professor Stainglass** (existing) draws and dead draft picks into cash. With **#16 Silas Sixpence** + **Barnaby** (existing) you can out-buy the whole table. Nice tension with **#4 The Understudy** — bench the reserve card, or pawn it?

### 18. Madame Fortuna
- **Ability:** Before your acquire decision, look at and reorder the top 3 cards of the deck. Your market resets cost 0.
- **Category:** Market-economy hook + light scry. [NEW PATTERN] (deck-peek/reorder) — modest addition.
- **Combos:** Free resets make **Barnaby** (existing) and **Maximillian** (existing) far stronger — churn the market cheaply until the card you want appears. Also feeds **#19 The Archivist**'s appetite for deck manipulation.

### 19. The Archivist (Brother Cassius)
- **Ability:** Discard 1 card from the draft row to draw the top 2 cards of the deck to your reserve, then discard one of them.
- **Category:** Discard-a-draft-card to activate (Stainglass-plus; reuses draw + discard).
- **Combos:** A stronger **Professor Stainglass** (existing). Pairs with **#4 The Understudy** (immediate refill from the reserve you just stocked) and **Madame Coeur** (existing) — cards you later slot in arrive full.

### 20. Barnaba Brasswork, the Auctioneer
- **Ability:** Whenever another player buys from or resets the market, take 1 coin from the supply.
- **Category:** [NEW PATTERN] — needs an "on opponent market action" trigger.
- **Combos:** Punishes tables full of buyers (weaker at a draft-only table — a deliberate meta-dependence, softened by also paying out on resets). With **Barnaby** (existing) you undercut and out-earn simultaneously — you buy cheap while opponents pay you to buy.

---

## Draft-order / tempo cluster

### 21. Maestro Allegretto
- **Ability:** Once per round, your acquire action does not end your turn — take one more action immediately afterward, then your turn ends.
- **Category:** [NEW PATTERN] — a built-in extra action (action-shaped, not a full extra turn).
- **Combos:** Functions like a permanent one-shot **Favor** every round — stacks with real Favor cards for explosive turns, and with **Maximillian** (existing) the second action can be another market spree.

### 22. The Turnkey (Mr. Locke)
- **Ability:** During the draft-order step, you may move yourself up or down exactly one stand from where you'd normally be seated.
- **Category:** Draft-order/turn-order hook (reads/edits the seating assignment).
- **Combos:** Grab stand 1 for a key draft, or drop back for a coin-heavy stand. With **Ringmistress Céleste (#7)** and **#16 Silas Sixpence** you control both seating and its tiebreaks — subtle but strong for a tempo player.

### 23. The Tally Master (Percival Quill)
- **Ability:** Once per round, name a Collection Die before it locks; every Star you collect from that die is doubled.
- **Category:** Dice-phase reaction window (proactive click).
- **Combos:** The Trophy-race payoff card. With **Madame Écho (#11)** or a matching Prop/Backdrop on a Star performer, a single die can swing the Trophy. With **The Gilded Ringmaster (#6)** you can chase Trophies aggressively without your board rotting.

### 24. The Benefactor (Dame Prudence)
- **Ability:** Once per round, take an extra turn as if you'd spent a Favor — but you may not draft a card on it (buy, rearrange, or use an ability only).
- **Category:** [NEW PATTERN] — built-in Favor-style extra turn with a draft restriction (reuses the bonus-turn queue).
- **Combos:** With **Maximillian** (existing) or **#16 Silas Sixpence** the "no draft" clause barely bites — spend the free turn buying. Stacks on top of real Favor cards for 4+ turn rounds.

---

## Favor / Press-Pass synergy cluster

### 25. Madame Papillon
- **Ability:** Once per round, when you spend a Favor card, return it to the bottom of the deck after the extra turn resolves instead of discarding it.
- **Category:** Passive (Favor recursion; a capped version to keep it from being a turn-bloat engine — see the version note below).
- **Combos:** With **#24 The Benefactor** or **Maestro Allegretto (#21)** you chain multiple actions a round without the Favor being gone for good. *(Originally drafted as an uncapped "returns to reserve" effect — capped to once/round and to the bottom of the deck after review; see balance notes.)*

### 26. The Concierge (Monsieur Devereux)
- **Ability:** At the start of the draft phase, if you hold no Favor card, draw the top card of the deck; keep it if it's a Favor, otherwise discard it.
- **Category:** [NEW PATTERN] — a start-of-phase conditional draw/filter. Modest.
- **Combos:** Reliable Favor supply to fuel **Madame Papillon (#25)** and **The Benefactor (#24)**. On its own, a soft tempo trainer that keeps you from ever being turn-starved.

### 27. Lord Fenwick, the Correspondent
- **Ability:** Once per round, re-roll one Collection Die after it's rolled, before it locks — even if you hold no Press Pass.
- **Category:** Dice-phase reaction window (a built-in 1-use Press Pass).
- **Combos:** With an actual accepted Press Pass you get its pool *plus* Fenwick's extra re-roll on top. With **Professor Kaleido (#10)** re-roll toward a letter, then bend a near-miss into a hit.

### 28. The Herald (Miss Aurelia Vaughn)
- **Ability:** When a Press Pass is offered this round, if it's yours, you may spend a coin to raise its re-roll pool by 1.
- **Category:** Real yes/no decision prompt (rides the existing Press Pass offer window). [NEW PATTERN] — small coin-for-pool tweak.
- **Combos:** Turns **#16 Silas Sixpence**'s coins into extra re-rolls; with a high-numbered Press Pass (4–5) and coins to spare, re-roll almost every die in the round.

---

## Props / Backdrops / Characteristics cluster

### 29. Countess Verrière
- **Ability:** Your Trainer slot also counts as a second Backdrop: name one Characteristic when you equip her; matching performers collect +1 extra unit of their resource.
- **Category:** Passive (Backdrop boost verb, hosted on the Trainer slot).
- **Combos:** Stack her named Characteristic with an actual Backdrop of the same Characteristic for +2, or spread across two Characteristics for coverage. With **#12 Professor Voltaic** and **Madame Écho (#11)** you build a resource-doubling performer.

### 30. The Property Master (Mr. Cobbler)
- **Ability:** Your equipped Prop and Backdrop also apply their boost to performers you slot in from reserve this round (not just ones already on your board).
- **Category:** Passive (extends when the existing Prop/Backdrop boost applies).
- **Combos:** The dedicated Prop/Backdrop payoff — pairs with **Countess Verrière (#29)** for a third boost source, and with **Signora Ombra, the Understudy (#4)**, whose mid-round refills now immediately benefit from your boosts too.

---

## Signature Combos

**1. Madame Coeur (existing) + The Ironclad Impresario (#1).**
Every card you take enters at full hearts, and one slot per round shrugs off all Tomato hits. Plant your best Star performer, shield that slot, and let opponents' boards erode while yours stays static — enables a single-letter Star-spam plan that normally can't survive the late-round Tomato flood.

**2. Auric the Alchemist (existing) + Madame Sang-Froid (#14).**
Auric moves Coins↔Hearts; Sang-Froid moves Coins↔Stars. Together you have a closed loop between all three resources. One Star short of the Trophy? Liquidate hearts to coins, then coins to Stars — the board becomes a currency exchange in the final rounds.

**3. Madame Papillon (#25) + The Concierge (#26).**
The Concierge keeps feeding you Favor cards; Papillon lets one come back each round instead of vanishing for good. A round becomes a chain of extra turns limited only by the normal 1st/2nd timing rule — "the show never stops" tempo.

**4. Countess Verrière (#29) + a matching Backdrop + The Property Master (#30).**
Two or three boost sources stack on one Characteristic. A single Graceful Star performer collecting off one die can pick up its base amount plus two separate +1 boosts. Add **Madame Écho (#11)** to collect it twice over. The degenerate-but-fun "resource cathedral" build.

**5. Professor Kaleido (#10) + Lord Fenwick (#27) (or any Press Pass).**
Fenwick/Press Pass re-rolls a dead die toward a letter you own; Kaleido then bends a still-missed die into a match. Between the two you convert essentially any Collection Die into a collect every round — the most consistent resource income in the game, with almost no variance.

**6. The Gilded Ringmaster (#6) + The Tally Master (#23).**
Tally Master doubles Stars off a named die to win Trophies aggressively; Ringmaster halves the heart penalty so winning doesn't gut your troupe. Name the die most of your Star performers match, double it, take the Trophy, lose only half the usual hearts — repeatable next round instead of rebuilding.

**7. Silas Sixpence (#16) + Maximillian the Magnate (existing) [or + Barnaby Pennywhistle (existing)].**
(Pick either pairing under a two-trainer rule.) Passive coin every turn plus unlimited buys is a market monopoly — drip coins, dump them into multi-buy turns, and out-buy the table for the best market cards before anyone else can afford one.

**8. Madame Fantôme (#2) + Doctor Vitalis (#3).**
Your cards refuse to die at 0 hearts (Fantôme catches them into reserve) and Vitalis heals one back up every Tomato phase. A slow, grinding "old troupe that never leaves the stage" identity that outlasts opponents into the late game where boards normally attrite.

---

## Balance / Feasibility Notes

- **#25 Madame Papillon — flagged, revised.** An uncapped "Favor returns to your reserve" is a near-infinite turn engine, especially stacked with #24/#26. Capped above to once per round, and the Favor returns to the *bottom of the deck* rather than straight back to hand.
- **#5 The Nightwatch — scoped down.** A full-table batch-cancel on the deciding round can feel unfair to the rest of the table. Limited above to cancelling hits on *your own* board only.
- **#3 Doctor Vitalis + #2 Madame Fantôme — watch for stalling.** Near-unkillable boards can slow the Trophy race to a crawl if the table leans into both. If it plays too grindy, restrict Vitalis's heal to "only on a card currently at 0 hearts" (a revive, not a top-up).
- **#21 Maestro Allegretto & #24 The Benefactor — overlapping identity.** Both are "extra action/turn" engines; shipping both plus real Favor cards risks turn bloat. Suggest keeping one, or forbidding them from being a legal same-player pair under the two-trainer rule.
- **#9 The Grand Finale — was narrow, broadened.** Originally "final round only," which is a fiddly, rarely-live condition. Broadened above to "once any player reaches half the Trophy threshold," so the new hook actually justifies itself by being live more than once per game.
- **#20 Barnaba the Auctioneer — was meta-dependent, softened.** Originally paid out only on opponent purchases, which is dead against a draft-only table. Added a market-reset trigger above so it's rarely fully dead.
- **#8 Madame Mirabel & #28 The Herald — intentionally lower-impact.** Mirabel and Herald are the situational end of the pool (Mirabel needs a good Power-Dot performer in play; Herald needs both a Press Pass and spare coins). Fine as-is for a design that wants some low-key, build-around options rather than 30 uniformly build-defining cards.
- **#15 The Menagerie Keeper — was too narrow, widened.** Originally "A, B, C" (the rarest 2 of 20 faces); widened above to "A–D," the rarer half of the die (10 of 20 faces vs. 10 for E–H), so the archetype triggers often enough to be worth building around.
- **#13 The Twin Mimic — redesigned to avoid overlap.** Originally too close to Madame Curio (existing) — both "discard a draft card → extra Collection Die." Redesigned above to repeat the *last already-rolled* die's result rather than roll fresh, making it a distinct "bank a good letter twice" tool.
- **#30 The Property Master — watch the stack with #29.** Individually fine; if a table runs both Property Master and Countess Verrière, consider capping total boost bonus per single collect (e.g. +3) so one die can't spiral into an ever-growing haul.

**Category spread across the 30:** Passive ×8, Dice-phase reaction ×6, Proactive click ×3, Discard-a-draft-card ×2, Market/economy ×3, Draft-order ×1, Real yes/no prompt ×1, New-pattern ×7 (flagged: #9, #18, #20, #21, #24, #26, #28). The new-pattern ideas are each small, scoped hooks — not new subsystems — so all 30 should be buildable on top of the existing engine architecture without a rewrite.
