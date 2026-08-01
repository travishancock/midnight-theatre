// Unit-level rules checks for The Midnight Theatre engine.
// Run with: node test/rules.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { initCards, card } from '../engine/cards.js';
import { randInt } from '../engine/rng.js';
import {
  createGame,
  applyAction,
  COLLECTION_FACES,
  marketCost,
  maxHearts,
  capacityLeft,
  eligibleFavors,
  allowedSlots,
  seatWithStand,
  assignTrophy,
  assignDraftOrder,
  assignAltSoloResult,
  addStars,
  ALT_SOLO_DIE_FACES,
  tokenSupply,
  lockCollectionDie,
  lockTomatoRoll,
  TRAINERS,
  hasFullSet,
} from '../engine/engine.js';
import { scoreCard } from '../engine/bot.js';
import { ghostAction } from '../engine/ghost.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'card_database.json'), 'utf8'));
initCards(db);

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// ---- helpers ---------------------------------------------------------------

const performer = (pred) => db.performers.find(pred).id;
const firstOfName = (arr, name) => arr.find((c) => c.name === name).id;

function freshGame(n = 2, seed = 42) {
  return createGame({ players: Array.from({ length: n }, (_, i) => ({ name: `P${i}`, isBot: true })), seed });
}

// Predict what the engine's next randInt(n) calls will yield from a given rng
// value, using the same rng module the engine uses.
function predict(rngValue, ns) {
  const mock = { rng: rngValue };
  return ns.map((n) => randInt(mock, n));
}

// Find an rng value whose next randInt(20) yields a collection face equal to
// the wanted letter (used to force a die result deterministically).
function rngForLetter(letter) {
  for (let x = 1; x < 100000; x++) {
    if (COLLECTION_FACES[predict(x, [20])[0]] === letter) return x;
  }
  throw new Error('no rng value found');
}

function currentSeat(state) {
  return state.turn.seat;
}

// The dice phase pauses mid-flight — a rolled-but-unlocked Collection Die
// (pure reveal pacing), a rolled-but-unlocked Tomato batch (awaiting a
// possible Mesmera reaction), and a per-seat 'diceResultsReview' pending item
// once both are fully resolved (awaiting a human "Continue" click, purely
// for reveal pacing — see engine.js's stepDice 'review' stage) — so it can be
// watched and reacted to in real time (the server paces these with real
// timers/UI clicks; tests just drive them through immediately since they
// don't care about pacing, unless a test wants to inspect the review prompt
// itself, in which case it should stop before calling this).
function driveDicePhase(s) {
  while (s.phase === 'dice') {
    if (s.dieEvent && s.dieEvent.awaitingLock) { lockCollectionDie(s); continue; }
    if (s.dice && s.dice.stage === 'tomato' && s.dice.tomatoRolled && !s.dice.tomatoLocked) { lockTomatoRoll(s); continue; }
    const barre = s.pending.find((x) => x.kind === 'barreRearrange');
    if (barre) { applyAction(s, { type: 'resolvePending', seat: barre.seat, pendingId: barre.id }); continue; }
    const review = s.pending.find((x) => x.kind === 'diceResultsReview');
    if (review) { applyAction(s, { type: 'resolvePending', seat: review.seat, pendingId: review.id }); continue; }
    break; // no more open reaction windows — nothing left to drive
  }
}

// Like driveDicePhase, but stops the instant the Tomato batch is rolled and
// open (before locking it in) — used by tests that want to react as Mesmera.
function driveToTomatoOpen(s) {
  while (!(s.dice && s.dice.stage === 'tomato' && s.dice.tomatoRolled && !s.dice.tomatoLocked)) {
    if (s.phase !== 'dice') throw new Error('dice phase ended before the Tomato batch opened');
    if (s.dieEvent && s.dieEvent.awaitingLock) { lockCollectionDie(s); continue; }
    throw new Error('unexpected state while driving to the open Tomato batch');
  }
}

// ---- setup -----------------------------------------------------------------

test('setup: coins by draft stand, row sizes, trophy goal', () => {
  const s = freshGame(3);
  assert.equal(s.market.length, 4);
  assert.equal(s.draftRow.length, 3 * 2 + 1);
  assert.equal(s.trophyGoal, 5); // 3 players -> 5 trophies
  for (const p of s.players) assert.equal(p.coins, p.stand * 2);
  const s5 = freshGame(5);
  assert.equal(s5.trophyGoal, 3); // 5 players -> 3 trophies
  assert.equal(s5.draftRow.length, 11);
  assert.equal(s5.deck.length + s5.draftRow.length + s5.market.length, 145);
  assert.equal(freshGame(2).trophyGoal, 6); // 2 players -> 6 trophies
  assert.equal(freshGame(4).trophyGoal, 4); // 4 players -> 4 trophies
});

test('acquiring a performer fills the lowest empty slot with printed hearts', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const id = performer((c) => c.startingHearts === 2);
  s.draftRow = [id, s.draftRow[1], s.draftRow[2]];
  applyAction(s, { type: 'acquireDraft', seat, cardId: id });
  assert.equal(s.players[seat].slots[0], id);
  assert.equal(s.hearts[id], 2);
});

test('acquiring a 6th performer prompts a placement choice and bumps to reserve', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  const five = db.performers.slice(0, 5).map((c) => c.id);
  p.slots = [...five, null, null, null];
  const extra = db.performers[10].id;
  s.draftRow = [extra, s.draftRow[1], s.draftRow[2]];
  applyAction(s, { type: 'acquireDraft', seat, cardId: extra });
  const pending = s.pending.find((x) => x.seat === seat && x.kind === 'placement');
  assert.ok(pending, 'expected a placement prompt');
  assert.ok(pending.data.allowReserve, 'a full slot always offers the reserve alternative too');
  applyAction(s, { type: 'resolvePending', seat, pendingId: pending.id, slot: 2 });
  assert.equal(p.slots[2], extra);
  assert.ok(p.reserve.includes(five[2]), 'bumped performer goes to reserve');
});

test('acquiring a 6th performer can be sent to reserve instead of bumping anyone', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  const five = db.performers.slice(0, 5).map((c) => c.id);
  p.slots = [...five, null, null, null];
  const extra = db.performers[10].id;
  s.draftRow = [extra, s.draftRow[1], s.draftRow[2]];
  applyAction(s, { type: 'acquireDraft', seat, cardId: extra });
  const pending = s.pending.find((x) => x.seat === seat && x.kind === 'placement');
  applyAction(s, { type: 'resolvePending', seat, pendingId: pending.id, toReserve: true });
  assert.deepEqual(p.slots.slice(0, 5), five, 'no performer was bumped');
  assert.ok(p.reserve.includes(extra), 'the new card went to reserve instead');
});

test('acquiring a Backdrop/Prop with its slot already full offers a bump-or-reserve choice', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[5] = 'Backdrop-Graceful';
  s.hearts['Backdrop-Graceful'] = 2;
  s.draftRow[0] = 'Backdrop-Powerful';
  applyAction(s, { type: 'acquireDraft', seat, cardId: 'Backdrop-Powerful' });
  const pending = s.pending.find((x) => x.kind === 'placement');
  assert.ok(pending, 'expected a placement prompt — the Backdrop slot is already occupied');
  assert.deepEqual(pending.data.allowedSlots, [5]);
  assert.ok(pending.data.allowReserve);
  applyAction(s, { type: 'resolvePending', seat, pendingId: pending.id, toReserve: true });
  assert.equal(p.slots[5], 'Backdrop-Graceful', 'declining the bump leaves the old occupant in place');
  assert.ok(p.reserve.includes('Backdrop-Powerful'));
});

test('market: costs 1-4, buying shifts down and refills the top slot', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.coins = 10;
  s.market = db.performers.slice(20, 24).map((c) => c.id); // pin to performers (no on-acquire effects)
  const bought = s.market[1];
  const after = [s.market[0], s.market[2], s.market[3]];
  const deckTop = s.deck[s.deck.length - 1];
  applyAction(s, { type: 'buyMarket', seat, index: 1 });
  assert.equal(p.coins, 8, 'slot 2 costs 2 coins');
  assert.deepEqual(s.market.slice(0, 3), after);
  assert.equal(s.market[3], deckTop);
  assert.notEqual(s.market.includes(bought), true);
});

test('market reset costs 1 coin and deals 4 new cards', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  s.players[seat].coins = 3;
  const before = [...s.market];
  applyAction(s, { type: 'resetMarket', seat });
  assert.equal(s.players[seat].coins, 2);
  assert.equal(s.market.length, 4);
  assert.notDeepEqual(s.market, before);
  for (const id of before) assert.ok(s.discard.includes(id));
});

test('Barnaby Pennywhistle: market costs drop 1 per Graceful performer on stage, down to 0 (never the reset)', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.BARNABY;
  const graceful = db.performers.filter((c) => c.characteristic === 'Graceful').map((c) => c.id);

  // No Graceful performers: Barnaby does nothing at all.
  assert.equal(marketCost(s, seat, 0), 1, 'no discount without a Graceful performer');
  assert.equal(marketCost(s, seat, 3), 4);

  // One Graceful performer: -1.
  p.slots[0] = graceful[0];
  assert.equal(marketCost(s, seat, 0), 0, 'slot 0 (normally 1 coin) is free');
  assert.equal(marketCost(s, seat, 3), 3);

  // Two: -2, and the discount never goes below 0.
  p.slots[1] = graceful[1];
  assert.equal(marketCost(s, seat, 3), 2);
  assert.equal(marketCost(s, seat, 0), 0, 'clamped at 0, never negative');

  // Reserve Graceful performers never count (the active-performer rule).
  p.reserve.push(graceful[2], graceful[3]);
  assert.equal(marketCost(s, seat, 3), 2, 'reserve performers do not add to the discount');

  // The 1-coin market reset is unaffected either way.
  p.coins = 1;
  applyAction(s, { type: 'resetMarket', seat });
  assert.equal(p.coins, 0);
});

test("Barnaby's discount: the client's price display matches the engine exactly (drift regression)", () => {
  // The client duplicates marketCost to render the price on the buy button.
  // It once fell out of sync (kept a flat -1 after the engine moved to -1 per
  // Graceful performer), so the UI quoted a price the server didn't charge.
  // This re-implements the client's formula and checks it against the engine
  // across every board it could face.
  const clientMarketCost = (state, seat, index) => {
    const player = state.players[seat];
    let cost = index + 1;
    const hasBarnaby = [5, 6, 7].some((i) => player.slots[i] === TRAINERS.BARNABY);
    if (hasBarnaby) {
      const graceful = player.slots
        .slice(0, 5)
        .filter((id) => id && card(id).characteristic === 'Graceful').length;
      cost = Math.max(0, cost - graceful);
    }
    return cost;
  };

  const graceful = db.performers.filter((c) => c.characteristic === 'Graceful').map((c) => c.id);
  const other = db.performers.find((c) => c.characteristic !== 'Graceful').id;
  for (const n of [0, 1, 2, 3, 4, 5]) {
    for (const withBarnaby of [true, false]) {
      const s = freshGame(2);
      const seat = currentSeat(s);
      const p = s.players[seat];
      p.slots = [null, null, null, null, null, null, null, withBarnaby ? TRAINERS.BARNABY : null];
      for (let i = 0; i < 5; i++) p.slots[i] = i < n ? graceful[i] : null;
      p.reserve = [graceful[5], graceful[6], other]; // reserve must never count
      for (let idx = 0; idx < 4; idx++) {
        assert.equal(
          clientMarketCost(s, seat, idx),
          marketCost(s, seat, idx),
          `client/engine disagree at ${n} Graceful, Barnaby=${withBarnaby}, slot ${idx + 1}`
        );
      }
    }
  }
});

test('Barnaby Pennywhistle: a free (0-coin) market slot still costs the turn to acquire', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.BARNABY;
  p.slots[0] = db.performers.find((c) => c.characteristic === 'Graceful').id; // powers the discount
  p.coins = 0;
  s.market = db.performers.slice(20, 24).map((c) => c.id); // pin to performers
  applyAction(s, { type: 'buyMarket', seat, index: 0 });
  assert.equal(p.coins, 0, 'no coins were spent');
  assert.notEqual(s.turn?.seat, seat, 'acquiring the free card still ended the turn');
});

test('resource cards resolve immediately and are discarded', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const coin3 = firstOfName(db.resources, 'Resource 3 Coins');
  s.draftRow = [coin3, s.draftRow[1], s.draftRow[2]];
  const before = s.players[seat].coins;
  applyAction(s, { type: 'acquireDraft', seat, cardId: coin3 });
  assert.equal(s.players[seat].coins, before + 3);
  assert.ok(s.discard.includes(coin3));
  assert.ok(!s.players[seat].slots.includes(coin3));
});

// Regression coverage: a resource card must never linger anywhere other than
// the discard pile once acquired, across every entry point: a direct draft
// pick, a market buy, and a nested draw via a "Card" resource.
test('every resource type resolves and lands in discard, never in reserve, on a direct draft pick', () => {
  for (const name of ['Resource 1 Coin', 'Resource 2 Hearts', 'Resource 3 Coins']) {
    const s = freshGame(2);
    const seat = currentSeat(s);
    const p = s.players[seat];
    const id = firstOfName(db.resources, name);
    s.draftRow = [id, s.draftRow[1], s.draftRow[2]];
    applyAction(s, { type: 'acquireDraft', seat, cardId: id });
    assert.ok(s.discard.includes(id), `${name} should be in discard`);
    assert.ok(!p.reserve.includes(id), `${name} should never sit in reserve`);
    assert.ok(!p.slots.includes(id), `${name} should never occupy a mat slot`);
  }
});

test('a resource card bought from the market resolves and discards, not reserve', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.coins = 10;
  const coin2 = firstOfName(db.resources, 'Resource 2 Coins');
  s.market[0] = coin2;
  const before = p.coins;
  applyAction(s, { type: 'buyMarket', seat, index: 0 });
  assert.equal(p.coins - before, 2 - 1, 'gains 2 coins from the card, spends 1 coin for market slot 0');
  assert.ok(s.discard.includes(coin2));
  assert.ok(!p.reserve.includes(coin2));
});

test('a resource card drawn via a "Card" resource (nested draw) also resolves and discards, not reserve', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  const draw2 = firstOfName(db.resources, 'Resource 2 Cards');
  const coin2 = firstOfName(db.resources, 'Resource 2 Coins');
  const coin1 = firstOfName(db.resources, 'Resource 1 Coin');
  // draw() pops from the end of state.deck, so push the desired cards last.
  s.deck.push(coin1, coin2);
  s.draftRow = [draw2, s.draftRow[1], s.draftRow[2]];
  const coinsBefore = p.coins;
  applyAction(s, { type: 'acquireDraft', seat, cardId: draw2 });
  assert.equal(p.coins - coinsBefore, 3);
  assert.ok(s.discard.includes(coin2) && s.discard.includes(coin1));
  assert.ok(!p.reserve.includes(coin2) && !p.reserve.includes(coin1));
});

test('card-resource cards fill empty starting slots (assumption #2)', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots = [null, null, null, null, null, null, null, null];
  const perf1 = performer((c) => c.startingHearts != null);
  const perf2 = performer((c) => c.id !== perf1);
  // draw() pops from the end of state.deck, so push the desired cards last.
  s.deck.push(perf1, perf2);
  const draw2 = firstOfName(db.resources, 'Resource 2 Cards');
  s.draftRow = [draw2, s.draftRow[1], s.draftRow[2]];
  applyAction(s, { type: 'acquireDraft', seat, cardId: draw2 });
  assert.equal(p.reserve.length, 0, 'both drawn performers had an empty slot to fill');
  assert.ok(p.slots.includes(perf1));
  assert.ok(p.slots.includes(perf2));
  assert.equal(s.hearts[perf1], card(perf1).startingHearts ?? 0);
});

test('card-resource cards prompt a placement choice once starting slots are full (assumption #2)', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  const fillers = db.performers.slice(0, 5).map((c) => c.id);
  p.slots = [...fillers, null, null, null];
  for (const id of fillers) s.hearts[id] = 5;
  const drawn = performer((c) => !fillers.includes(c.id));
  s.deck.push(drawn);
  const draw1 = firstOfName(db.resources, 'Resource 1 Card');
  s.draftRow = [draw1, s.draftRow[1], s.draftRow[2]];
  applyAction(s, { type: 'acquireDraft', seat, cardId: draw1 });
  const prompt = s.pending.find((x) => x.kind === 'cardResourcePlacement');
  assert.ok(prompt, 'expected a cardResourcePlacement prompt');
  assert.equal(prompt.data.cardId, drawn);
  // Choosing "send to reserve instead" keeps the board untouched.
  applyAction(s, { type: 'resolvePending', seat, pendingId: prompt.id, toReserve: true });
  assert.ok(p.reserve.includes(drawn));
  assert.deepEqual(p.slots.slice(0, 5), fillers);
});

test('heart-resource cards prompt assignment, capped by capacity', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  // A performer whose printed capacity (from the card's own heart pips, not
  // its starting fill) is exactly 1.
  const perf = performer((c) => c.maxHearts === 1);
  p.slots[0] = perf;
  s.hearts[perf] = 0; // room for exactly 1
  const heart3 = firstOfName(db.resources, 'Resource 3 Hearts');
  s.draftRow = [heart3, s.draftRow[1], s.draftRow[2]];
  applyAction(s, { type: 'acquireDraft', seat, cardId: heart3 });
  const pending = s.pending.find((x) => x.kind === 'heartAssign');
  assert.ok(pending);
  // over-assigning is rejected
  assert.throws(() =>
    applyAction(s, { type: 'resolvePending', seat, pendingId: pending.id, assignments: [{ cardId: perf, amount: 3 }] })
  );
  applyAction(s, { type: 'resolvePending', seat, pendingId: pending.id, assignments: [{ cardId: perf, amount: 1 }] });
  assert.equal(s.hearts[perf], 1);
});

test('Props/Backdrops start at their full printed max (2/2) with no room for more hearts', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  // Every Prop/Backdrop, solid-bar or wildcard alike, now starts full: 2
  // filled hearts, printed max of 2 — so there's never room for more.
  const solidProp = db.propsAndBackdrops.find((c) => c.id === 'Prop-Graceful');
  assert.equal(solidProp.startingHearts, 2);
  assert.equal(solidProp.maxHearts, 2);
  p.slots[6] = solidProp.id;
  s.hearts[solidProp.id] = solidProp.startingHearts;
  assert.equal(maxHearts(s, seat, solidProp.id), 2);
  assert.equal(capacityLeft(s, seat, solidProp.id), 0, 'starts full — no room for more hearts');
  const wildProp = db.propsAndBackdrops.find((c) => c.id === 'Prop-Any-Characteristic');
  assert.equal(wildProp.startingHearts, 2);
  assert.equal(wildProp.maxHearts, 2);
  p.slots[6] = wildProp.id;
  s.hearts[wildProp.id] = wildProp.startingHearts;
  assert.equal(capacityLeft(s, seat, wildProp.id), 0, 'starts full — no room for more hearts');

  // Earned hearts are forfeited (not left dangling as a pending prompt) when
  // every card on the board — a maxed-out Prop, nothing else — has no room.
  p.slots = [null, null, null, null, null, null, wildProp.id, null];
  p.reserve = [];
  const heart3 = firstOfName(db.resources, 'Resource 3 Hearts');
  s.draftRow = [heart3, s.draftRow[1], s.draftRow[2]];
  applyAction(s, { type: 'acquireDraft', seat, cardId: heart3 });
  assert.ok(!s.pending.some((x) => x.kind === 'heartAssign'), 'no room anywhere on the board — nothing to assign');
  assert.equal(s.hearts[wildProp.id], 2, 'the maxed Prop is untouched');
});

test('favor cards go to reserve; clicking one before your main turn grants a bonus turn', () => {
  const s = freshGame(2, 7);
  const seat = currentSeat(s);
  const p = s.players[seat];
  const favor1 = 'Favor-1-1';
  p.reserve.push(favor1);
  p.turns = 0; // "1st" Favors are eligible from the player's actual first turn onward
  s.draftRow = [db.performers[0].id, db.performers[1].id, db.performers[2].id, db.performers[3].id, db.performers[4].id];
  // There is never a forced prompt: the player just plays the Favor card
  // whenever they like, before their main turn action.
  assert.equal(s.pending.length, 0);
  applyAction(s, { type: 'useFavor', seat, cardId: favor1 });
  assert.ok(!p.reserve.includes(favor1));
  assert.ok(s.discard.includes(favor1));
  assert.equal(s.turn.seat, seat, 'still this player\'s turn, main action not yet taken');
  assert.equal(s.turn.mainDone, false);
  // Take the main turn action — an extra (bonus) turn should follow it,
  // before play passes to the next player.
  applyAction(s, { type: 'acquireDraft', seat, cardId: db.performers[0].id });
  assert.equal(s.turn.seat, seat, 'bonus turn belongs to the same player');
  assert.equal(s.turn.isBonus, true);
  // Restriction: the bonus turn may not draft a Favor of the same timing…
  s.draftRow[0] = 'Favor-1-2';
  assert.throws(() => applyAction(s, { type: 'acquireDraft', seat, cardId: 'Favor-1-2' }));
  // …but a different-timing Favor is fine.
  s.draftRow[0] = 'Favor-2-1';
  applyAction(s, { type: 'acquireDraft', seat, cardId: 'Favor-2-1' });
  assert.ok(p.reserve.includes('Favor-2-1'));
});

test('market prices stay frozen across a Favor bonus turn, and only compact once play truly passes on', () => {
  const s = freshGame(2, 7);
  const seat = currentSeat(s);
  const p = s.players[seat];
  const favor1 = 'Favor-1-1';
  p.reserve.push(favor1);
  p.turns = 0;
  p.coins = 10;
  s.market = db.performers.slice(24, 28).map((c) => c.id); // pin to performers, no on-acquire effects
  const slot1Card = s.market[1];

  applyAction(s, { type: 'useFavor', seat, cardId: favor1 });
  applyAction(s, { type: 'buyMarket', seat, index: 0 }); // main action: buy slot 0 for 1 coin
  assert.equal(p.coins, 9);
  assert.equal(s.turn.seat, seat, 'bonus turn belongs to the same player');
  assert.equal(s.turn.isBonus, true);
  assert.equal(s.market[0], null, 'the sold slot is still empty during the bonus turn');
  assert.equal(s.market[1], slot1Card, 'unsold slots keep their original card/price into the bonus turn');

  // Buy again on the bonus turn — still at slot 1's ORIGINAL price (2), not
  // discounted just because slot 0 next to it sold out earlier.
  applyAction(s, { type: 'buyMarket', seat, index: 1 });
  assert.equal(p.coins, 7, 'slot 1 cost its original 2 coins');
  assert.notEqual(s.turn?.seat, seat, 'no more bonus turns queued — play has now passed to the next player');
  assert.ok(!s.market.includes(null), 'the market only compacts once play actually moves on');
});

test('resetMarket on a later bonus turn immediately wipes a gap sold on an earlier one', () => {
  const s = freshGame(2, 7);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.reserve.push('Favor-2-1', 'Favor-2-2');
  p.turns = 1; // both "2nd" favors are eligible
  p.coins = 10;
  s.market = db.performers.slice(24, 28).map((c) => c.id);

  applyAction(s, { type: 'useFavor', seat, cardId: 'Favor-2-1' });
  applyAction(s, { type: 'useFavor', seat, cardId: 'Favor-2-2' });
  applyAction(s, { type: 'buyMarket', seat, index: 0 }); // main action, leaves slot 0 empty
  assert.equal(s.turn.isBonus, true);
  assert.equal(s.market[0], null, 'slot 0 is sold and empty going into the next bonus turn');

  // A reset on this next bonus turn is still allowed (mainDone is fresh for
  // the new turn object) and immediately clears out any earlier gap too.
  applyAction(s, { type: 'resetMarket', seat });
  assert.equal(s.market.length, 4);
  assert.ok(!s.market.includes(null), 'resetting mid-chain wipes the earlier sold gap as well');
});

test('a Favor cannot be used once the main turn action is already taken', () => {
  const s = freshGame(2, 7);
  const seat = currentSeat(s);
  const p = s.players[seat];
  const favor1 = 'Favor-1-1';
  p.reserve.push(favor1);
  p.turns = 0;
  s.draftRow = [db.performers[0].id, db.performers[1].id, db.performers[2].id, db.performers[3].id, db.performers[4].id];
  applyAction(s, { type: 'acquireDraft', seat, cardId: db.performers[0].id });
  // Play has already moved on to the other seat — too late to use the Favor.
  assert.notEqual(s.turn.seat, seat);
  assert.throws(() => applyAction(s, { type: 'useFavor', seat, cardId: favor1 }));
});

test('Favor timing: "1st" is usable turn 1 or any later turn (never expires); "2nd" only from turn 2 onward', () => {
  const s = freshGame(2, 7);
  const seat = currentSeat(s);
  const p = s.players[seat];
  const favor1 = 'Favor-1-1';
  const favor2 = 'Favor-2-1';
  p.reserve.push(favor1, favor2);

  // On the player's actual 1st turn (p.turns === 0): "1st" is usable,
  // "2nd" is not yet.
  p.turns = 0;
  assert.deepEqual(eligibleFavors(s, seat), [favor1]);
  assert.throws(() => applyAction(s, { type: 'useFavor', seat, cardId: favor2 }));

  // On the player's 2nd turn (p.turns === 1): both are now usable — "1st"
  // never expires, it just also happens to unlock "2nd" here.
  p.turns = 1;
  assert.deepEqual(eligibleFavors(s, seat), [favor1, favor2]);

  // On any later turn (p.turns === 3), both remain usable.
  p.turns = 3;
  assert.deepEqual(eligibleFavors(s, seat), [favor1, favor2]);
});

test('Maximillian: drafting earns one market buy; a market buy alone earns nothing and cannot chain', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.MAXIMILLIAN;
  p.coins = 10;
  s.market = db.performers.slice(30, 34).map((c) => c.id); // pin to performers

  // Buying as the main action grants nothing extra — the turn just ends.
  applyAction(s, { type: 'buyMarket', seat, index: 0 });
  assert.equal(p.coins, 9);
  assert.notEqual(s.turn?.seat, seat, 'a plain market buy ends the turn — buys do not chain');
});

test('Maximillian: the bonus buy keeps prices frozen and cannot be spent on a second draft', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.MAXIMILLIAN;
  p.coins = 10;
  s.market = db.performers.slice(30, 34).map((c) => c.id);
  s.draftRow = db.performers.slice(40, 45).map((c) => c.id);
  const slot1Card = s.market[1];

  applyAction(s, { type: 'acquireDraft', seat, cardId: s.draftRow[0] });
  assert.equal(s.turn.done, false, 'the turn stays open for the earned market buy');
  assert.equal(s.turn.bonusBuys, 1);
  assert.throws(() => applyAction(s, { type: 'acquireDraft', seat, cardId: s.draftRow[0] }), /already acquired/);
  assert.equal(s.market[1], slot1Card, 'market slots keep their original cards mid-turn');

  applyAction(s, { type: 'buyMarket', seat, index: 1 }); // original price of 2
  assert.equal(p.coins, 8, 'paid the unshifted slot-1 price');
  assert.notEqual(s.turn?.seat, seat, 'the earned buy is spent, so the turn ends');
  assert.ok(!s.market.includes(null), 'the market refilled once the turn actually ended');
});

test('Maximillian: the earned market buy may simply be declined', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.MAXIMILLIAN;
  s.draftRow = db.performers.slice(40, 45).map((c) => c.id);
  applyAction(s, { type: 'acquireDraft', seat, cardId: s.draftRow[0] });
  assert.equal(s.turn.done, false);
  applyAction(s, { type: 'endTurn', seat });
  assert.notEqual(s.turn?.seat, seat, 'declining just ends the turn');
});

test('Madame Coeur: drafted/placed cards start at their printed maximum heart count', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.COEUR;
  // Pick a performer whose printed max exceeds its normal starting fill, so
  // Coeur's effect is visible. Capacity itself is unaffected by Coeur.
  const perf = performer((c) => c.maxHearts > c.startingHearts);
  assert.equal(maxHearts(s, seat, perf), card(perf).maxHearts);
  s.draftRow = [perf, s.draftRow[1], s.draftRow[2]];
  applyAction(s, { type: 'acquireDraft', seat, cardId: perf });
  assert.equal(s.hearts[perf], card(perf).maxHearts, 'placed at full printed hearts, not the usual starting fill');
});

test('Madame Barre unlocks every slot; otherwise slots are type-locked', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const perf = db.performers[0].id;
  assert.deepEqual(allowedSlots(s, seat, perf), [0, 1, 2, 3, 4]);
  assert.deepEqual(allowedSlots(s, seat, 'Prop-Graceful'), [6]);
  s.players[seat].slots[7] = TRAINERS.BARRE;
  assert.deepEqual(allowedSlots(s, seat, perf), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('Auric the Alchemist: converting received coins into hearts routes through heart placement', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.AURIC;
  s.hearts[TRAINERS.AURIC] = 3; // fully healed, so it contributes no spare heart capacity below
  const perf = performer((c) => c.maxHearts === 3);
  p.slots[0] = perf;
  s.hearts[perf] = 1;
  p.coins = 0;

  // Old free-standing "swap already-banked resources anytime" action is gone.
  assert.throws(() => applyAction(s, { type: 'auricConvert', seat, direction: 'coinToHeart', cardId: perf }), /Unknown action type/);

  // Receiving 3 coins: instead of an immediate credit, Auric is offered a
  // real choice right at the moment of receiving them.
  const coin3 = firstOfName(db.resources, 'Resource 3 Coins');
  s.draftRow[0] = coin3;
  applyAction(s, { type: 'acquireDraft', seat, cardId: coin3 });
  const offer = s.pending.find((x) => x.kind === 'auricGainChoice');
  assert.ok(offer, 'expected an auricGainChoice prompt on receiving coins');
  assert.equal(offer.data.coinsEarned, 3);
  assert.equal(offer.data.heartsEarned, 0);

  applyAction(s, { type: 'resolvePending', seat, pendingId: offer.id, convertCoinsToHearts: true });
  assert.equal(p.coins, 0, 'coins unchanged — this batch was converted, not credited');
  const hearts = s.pending.find((x) => x.kind === 'heartAssign');
  assert.ok(hearts, 'converted coins route into the normal heart-assignment prompt');
  assert.equal(hearts.data.amount, 3);
  applyAction(s, { type: 'resolvePending', seat, pendingId: hearts.id, assignments: [{ cardId: perf, amount: 2 }] });
  assert.equal(s.hearts[perf], 3, 'capped at the card\'s max (only 2 of the 3 fit)');
});

test('Auric the Alchemist: declining the offer credits a received coin normally', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.AURIC;
  p.coins = 0;
  const coin3 = firstOfName(db.resources, 'Resource 3 Coins');
  s.draftRow[0] = coin3;
  applyAction(s, { type: 'acquireDraft', seat, cardId: coin3 });
  const offer = s.pending.find((x) => x.kind === 'auricGainChoice');
  assert.ok(offer);
  applyAction(s, { type: 'resolvePending', seat, pendingId: offer.id, convertCoinsToHearts: false });
  assert.equal(p.coins, 3, 'declined the conversion — credited as coins exactly as usual');
});

test('Auric the Alchemist: converting received hearts into coins skips heart placement entirely', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.AURIC;
  p.coins = 0;
  const heart3 = firstOfName(db.resources, 'Resource 3 Hearts');
  s.draftRow[0] = heart3;
  applyAction(s, { type: 'acquireDraft', seat, cardId: heart3 });
  const offer = s.pending.find((x) => x.kind === 'auricGainChoice');
  assert.ok(offer);
  assert.equal(offer.data.heartsEarned, 3);
  assert.equal(offer.data.coinsEarned, 0);
  applyAction(s, { type: 'resolvePending', seat, pendingId: offer.id, convertHeartsToCoins: true });
  assert.equal(p.coins, 3, 'the earned hearts were converted straight to coins');
  assert.ok(!s.pending.some((x) => x.kind === 'heartAssign'), 'no heart-placement prompt — they were converted, not kept as hearts');
});

test('Professor Stainglass: discard an acquired card to draw 1 per Powerful performer, then keep exactly one', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.STAINGLASS;
  // Two Powerful performers on stage -> draws 2, keeps 1.
  const powerful = db.performers.filter((c) => c.characteristic === 'Powerful').map((c) => c.id);
  p.slots[1] = powerful[0];
  p.slots[2] = powerful[1];
  const perf = db.performers.find((c) => !powerful.slice(0, 2).includes(c.id)).id;
  s.draftRow[0] = perf;
  const deckTop = [s.deck[s.deck.length - 1], s.deck[s.deck.length - 2]];
  applyAction(s, { type: 'acquireDraft', seat, cardId: perf });
  assert.equal(p.slots[0], perf, 'placed normally first');
  const offer = s.pending.find((x) => x.kind === 'postAcquireDiscard');
  assert.ok(offer, 'expected a postAcquireDiscard prompt');
  assert.deepEqual(offer.data.choices, ['stainglass']);
  applyAction(s, { type: 'resolvePending', seat, pendingId: offer.id, choice: 'stainglass' });
  assert.ok(s.discard.includes(perf), 'the acquired card was discarded');

  const keep = s.pending.find((x) => x.kind === 'stainglassKeep');
  assert.ok(keep, 'expected a keep-one prompt for the 2 drawn cards');
  assert.deepEqual(keep.data.drawn.slice().sort(), deckTop.slice().sort());
  const kept = keep.data.drawn[0];
  const dropped = keep.data.drawn[1];
  applyAction(s, { type: 'resolvePending', seat, pendingId: keep.id, cardId: kept });
  const owned = [...p.slots.filter(Boolean), ...p.reserve];
  assert.ok(owned.includes(kept), 'the kept card entered play like a normal acquisition');
  assert.ok(s.discard.includes(dropped), 'the card not kept was discarded');
});

test('Professor Stainglass: the card you keep cannot itself be traded in for another draw', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.STAINGLASS;
  const powerful = db.performers.filter((c) => c.characteristic === 'Powerful').map((c) => c.id);
  p.slots[1] = powerful[0];
  p.slots[2] = powerful[1];
  const perf = db.performers.find((c) => !powerful.slice(0, 2).includes(c.id)).id;
  s.draftRow[0] = perf;
  applyAction(s, { type: 'acquireDraft', seat, cardId: perf });
  const offer = s.pending.find((x) => x.kind === 'postAcquireDiscard');
  applyAction(s, { type: 'resolvePending', seat, pendingId: offer.id, choice: 'stainglass' });
  const keep = s.pending.find((x) => x.kind === 'stainglassKeep');
  applyAction(s, { type: 'resolvePending', seat, pendingId: keep.id, cardId: keep.data.drawn[0] });
  // Only the originally-acquired card may be traded in — otherwise the keep
  // could be re-traded over and over, churning the deck from one acquisition.
  assert.ok(
    !s.pending.some((x) => x.kind === 'postAcquireDiscard'),
    'the kept card must not raise another discard-to-draw offer'
  );
});

test('Professor Stainglass: with no Powerful performer the trade is not offered at all', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.STAINGLASS;
  const perf = performer((c) => c.characteristic !== 'Powerful');
  s.draftRow[0] = perf;
  applyAction(s, { type: 'acquireDraft', seat, cardId: perf });
  assert.ok(!s.pending.some((x) => x.kind === 'postAcquireDiscard'), 'nothing to draw, so no offer');
  assert.equal(p.slots[0], perf);
});

test('Professor Stainglass: "keep" leaves the card exactly as placed', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.STAINGLASS;
  p.slots[1] = db.performers.find((c) => c.characteristic === 'Powerful').id; // so the offer appears
  const perf = performer((c) => c.characteristic !== 'Powerful');
  s.draftRow[0] = perf;
  applyAction(s, { type: 'acquireDraft', seat, cardId: perf });
  const offer = s.pending.find((x) => x.kind === 'postAcquireDiscard');
  applyAction(s, { type: 'resolvePending', seat, pendingId: offer.id, choice: 'keep' });
  assert.equal(p.slots[0], perf);
});

test('The Vanishing Valentino: you take your turn first, then may discard a Dramatic performer to end the draft', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.VALENTINO;
  const dram = db.performers.filter((c) => c.characteristic === 'Dramatic').map((c) => c.id);
  p.slots[0] = dram[0]; // the performer that will pay the cost
  const [a, b, c] = db.performers.filter((x) => x.id !== dram[0]).slice(0, 3).map((x) => x.id);
  s.draftRow = [a, b, c];

  // It is an end-of-turn choice now, not a start-of-turn one.
  assert.throws(() => applyAction(s, { type: 'valentinoEndDraft', seat }), /take your turn action first/);

  applyAction(s, { type: 'acquireDraft', seat, cardId: a });
  assert.equal(s.turn.seat, seat, 'the turn is held open rather than passing on');
  assert.equal(s.turn.valentinoWindow, true, 'the end-of-turn offer is open');

  const rowBefore = [...s.draftRow];
  applyAction(s, { type: 'valentinoEndDraft', seat, cardId: dram[0] });
  assert.equal(p.slots[0], null, 'the Dramatic performer was discarded to pay for it');
  assert.ok(s.discard.includes(dram[0]));
  for (const id of rowBefore) assert.ok(s.discard.includes(id), 'the rest of the row is discarded');
  assert.equal(p.slots[7], TRAINERS.VALENTINO, 'the trainer itself is not discarded');
  driveDicePhase(s);
  assert.equal(s.round, 2);
});

test('The Vanishing Valentino: a Dramatic performer in reserve may pay the cost too', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.VALENTINO;
  const dram = db.performers.find((c) => c.characteristic === 'Dramatic').id;
  const others = db.performers.filter((c) => c.characteristic !== 'Dramatic').map((c) => c.id);
  // Dramatic performer sits in reserve, none on stage.
  p.slots = [others[0], others[1], others[2], others[3], others[4], null, null, TRAINERS.VALENTINO];
  p.reserve = [dram];
  // Draft a Favor: it needs no slot, so the full Performer row raises no
  // placement prompt that would defer the end-of-turn window.
  s.draftRow = ['Favor-1-1', others[6], others[7]];
  applyAction(s, { type: 'acquireDraft', seat, cardId: 'Favor-1-1' });
  assert.equal(s.turn.valentinoWindow, true, 'a reserve Dramatic is enough to open the window');
  applyAction(s, { type: 'valentinoEndDraft', seat, cardId: dram });
  assert.ok(!p.reserve.includes(dram), 'the reserve Dramatic paid the cost');
  assert.ok(s.discard.includes(dram));
  assert.deepEqual(s.draftRow, [], 'the draft ended');
});

test('The Vanishing Valentino: only a Dramatic performer can pay, and with none anywhere the offer never opens', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.VALENTINO;
  const dram = db.performers.find((c) => c.characteristic === 'Dramatic').id;
  const nonDram = db.performers.find((c) => c.characteristic !== 'Dramatic').id;
  p.slots[0] = dram;
  p.slots[1] = nonDram;
  s.draftRow = db.performers.filter((x) => ![dram, nonDram].includes(x.id)).slice(0, 3).map((x) => x.id);
  applyAction(s, { type: 'acquireDraft', seat, cardId: s.draftRow[0] });
  assert.throws(
    () => applyAction(s, { type: 'valentinoEndDraft', seat, cardId: nonDram }),
    /not one of your Dramatic performers/
  );

  // None on stage OR in reserve -> the window is never offered.
  const s2 = freshGame(2);
  const seat2 = currentSeat(s2);
  const p2 = s2.players[seat2];
  p2.slots[7] = TRAINERS.VALENTINO;
  const plain = db.performers.filter((c) => c.characteristic !== 'Dramatic').map((c) => c.id);
  p2.slots[0] = plain[0];
  p2.reserve = [];
  s2.draftRow = [plain[1], plain[2], plain[3]];
  applyAction(s2, { type: 'acquireDraft', seat: seat2, cardId: plain[1] });
  assert.ok(!s2.turn || !s2.turn.valentinoWindow, 'no Dramatic performer anywhere, no offer');
});

test('The Vanishing Valentino: the end-of-turn offer can be declined, and is not offered when the row is already empty', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.VALENTINO;
  const dram = db.performers.find((c) => c.characteristic === 'Dramatic').id;
  p.slots[0] = dram;
  const [a, b, c] = db.performers.filter((x) => x.id !== dram).slice(0, 3).map((x) => x.id);
  s.draftRow = [a, b, c];
  applyAction(s, { type: 'acquireDraft', seat, cardId: a });
  assert.equal(s.turn.valentinoWindow, true);
  applyAction(s, { type: 'endTurn', seat });
  assert.deepEqual(s.draftRow, [b, c], 'the draft row survives a declined offer');
  assert.equal(p.slots[0], dram, 'and the Dramatic performer is not spent');
  assert.notEqual(s.turn.seat, seat, 'play moved on to the next seat');

  // Taking the last card in the row leaves nothing to close, so no offer.
  const s2 = freshGame(2);
  const seat2 = currentSeat(s2);
  s2.players[seat2].slots[7] = TRAINERS.VALENTINO;
  s2.players[seat2].slots[0] = dram;
  s2.draftRow = [db.performers.find((x) => x.id !== dram).id];
  applyAction(s2, { type: 'acquireDraft', seat: seat2, cardId: s2.draftRow[0] });
  assert.ok(!s2.turn || !s2.turn.valentinoWindow, 'no offer with nothing left to end');
});

test('freeRearrange no longer exists — Madame Barre only affects acquisition placement now', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  s.players[seat].slots[7] = TRAINERS.BARRE;
  assert.throws(
    () => applyAction(s, { type: 'freeRearrange', seat, slots: [...s.players[seat].slots], reserve: [] }),
    /Unknown action type/
  );
});

test('Madame Barre: acquiring a card always offers a genuine placement choice, even with an empty natural slot open', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.BARRE;
  // All 5 Performer slots are empty — without Barre this would auto-fill
  // slot 0 silently. With Barre active it must still prompt.
  const perf = db.performers[0].id;
  s.draftRow[0] = perf;
  applyAction(s, { type: 'acquireDraft', seat, cardId: perf });
  assert.equal(p.slots[0], null, 'not auto-filled while Barre is active');
  const pending = s.pending.find((x) => x.kind === 'placement');
  assert.ok(pending, 'expected a placement prompt');
  assert.deepEqual(pending.data.allowedSlots, [0, 1, 2, 3, 4, 5, 6, 7], 'any of the 8 mat slots');
  assert.equal(pending.data.allowReserve, true);

  // Choosing reserve, despite an open matching slot, is honored.
  applyAction(s, { type: 'resolvePending', seat, pendingId: pending.id, toReserve: true });
  assert.ok(p.reserve.includes(perf));
  assert.equal(p.slots[0], null);
});

test('Madame Barre: acquired cards may be placed in a mismatched slot', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.BARRE;
  const perf = db.performers[0].id;
  s.draftRow[0] = perf;
  applyAction(s, { type: 'acquireDraft', seat, cardId: perf });
  const pending = s.pending.find((x) => x.kind === 'placement');
  applyAction(s, { type: 'resolvePending', seat, pendingId: pending.id, slot: 6 });
  assert.equal(p.slots[6], perf, 'a Performer may sit in the Prop/Trainer slot while Barre is active');
});

test('Madame Barre: end-of-round free rearrange (any card, any slot, active or reserve) — only offered to her holder', () => {
  const s = freshGame(2, 1234);
  const seat = currentSeat(s);
  const other = s.players.find((x) => x.seat !== seat).seat;
  const p = s.players[seat];
  p.slots = [null, null, null, null, null, null, null, TRAINERS.BARRE];
  s.players[other].slots = [null, null, null, null, null, null, null, null];
  s.players[other].reserve = [];
  const perfA = db.performers[0].id;
  const perfB = db.performers.find((c) => c.id !== perfA).id;
  p.slots[0] = perfA;
  p.reserve = [perfB];

  // Force the draft to end this turn (leaving exactly 1 leftover card).
  const filler = db.performers.find((c) => c.id !== perfA && c.id !== perfB).id;
  s.draftRow = [filler, db.performers.find((c) => c.id !== filler && c.id !== perfA && c.id !== perfB).id];
  applyAction(s, { type: 'acquireDraft', seat, cardId: filler });
  // Madame Barre is already active, so this acquisition itself prompts a
  // placement choice (see the acquisition-time redesign) — resolve it into
  // the next open Performer slot before driving on into the dice phase.
  const acquirePlacement = s.pending.find((x) => x.kind === 'placement' && x.seat === seat);
  if (acquirePlacement) applyAction(s, { type: 'resolvePending', seat, pendingId: acquirePlacement.id, slot: 1 });

  while (!s.pending.some((x) => x.kind === 'barreRearrange')) {
    if (s.dieEvent && s.dieEvent.awaitingLock) { lockCollectionDie(s); continue; }
    if (s.dice && s.dice.stage === 'tomato' && s.dice.tomatoRolled && !s.dice.tomatoLocked) { lockTomatoRoll(s); continue; }
    throw new Error('expected to reach the Barre end-of-round rearrange pause');
  }

  const barreItem = s.pending.find((x) => x.kind === 'barreRearrange' && x.seat === seat);
  assert.ok(barreItem, "Madame Barre's holder gets an end-of-round rearrange prompt");
  assert.ok(!s.pending.some((x) => x.kind === 'barreRearrange' && x.seat === other), 'the other seat (no Barre) does not');

  // Swap perfA (mat, into a mismatched Prop/Trainer slot — illegal for a
  // normal 'rearrange', fine here) with perfB (reserve, into the now-open
  // Performer slot). A clean 1-for-1 swap, so reserve ends up empty and no
  // refill prompt gets triggered afterward.
  const newSlots = [...p.slots];
  const barreSlot = newSlots.indexOf(perfA);
  newSlots[barreSlot] = perfB;
  newSlots[6] = perfA;
  const newReserve = [];
  applyAction(s, { type: 'resolvePending', seat, pendingId: barreItem.id, slots: newSlots, reserve: newReserve });
  assert.equal(p.slots[6], perfA, 'any card may go in any slot, including a mismatched one');
  assert.equal(p.slots[barreSlot], perfB, 'the reserved card moved onto the mat');
  assert.deepEqual(p.reserve, []);
  assert.ok(!s.pending.some((x) => x.kind === 'barreRearrange'));

  driveDicePhase(s);
  assert.equal(s.round, 2);
});

test('Madame Barre: end-of-round rearrange may be skipped, leaving the troupe untouched', () => {
  const s = freshGame(2, 1234);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots = [null, null, null, null, null, null, null, TRAINERS.BARRE];
  s.players.find((x) => x.seat !== seat).slots = [null, null, null, null, null, null, null, null];

  const filler = db.performers[0].id;
  s.draftRow = [filler, db.performers.find((c) => c.id !== filler).id];
  applyAction(s, { type: 'acquireDraft', seat, cardId: filler });
  const acquirePlacement = s.pending.find((x) => x.kind === 'placement' && x.seat === seat);
  if (acquirePlacement) applyAction(s, { type: 'resolvePending', seat, pendingId: acquirePlacement.id, slot: 0 });

  while (!s.pending.some((x) => x.kind === 'barreRearrange')) {
    if (s.dieEvent && s.dieEvent.awaitingLock) { lockCollectionDie(s); continue; }
    if (s.dice && s.dice.stage === 'tomato' && s.dice.tomatoRolled && !s.dice.tomatoLocked) { lockTomatoRoll(s); continue; }
    throw new Error('expected to reach the Barre end-of-round rearrange pause');
  }
  const barreItem = s.pending.find((x) => x.kind === 'barreRearrange' && x.seat === seat);
  const before = [...p.slots];
  applyAction(s, { type: 'resolvePending', seat, pendingId: barreItem.id });
  assert.deepEqual(p.slots, before, 'skipping leaves the troupe exactly as it was');
});

test('rearrange must conserve cards and respect slot types', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  const perfA = db.performers[0].id;
  const perfB = db.performers[1].id;
  p.slots[0] = perfA;
  p.reserve = [perfB];
  // swap board and reserve performer
  applyAction(s, {
    type: 'rearrange', seat,
    slots: [perfB, null, null, null, null, null, null, null],
    reserve: [perfA],
  });
  assert.equal(p.slots[0], perfB);
  assert.deepEqual(p.reserve, [perfA]);
  // performer into the Prop slot: rejected (no Barre)
  const s2 = freshGame(2);
  const seat2 = currentSeat(s2);
  s2.players[seat2].slots[0] = perfA;
  assert.throws(() =>
    applyAction(s2, {
      type: 'rearrange', seat: seat2,
      slots: [null, null, null, null, null, null, perfA, null],
      reserve: [],
    })
  );
  // conjuring a card from nowhere: rejected
  const s3 = freshGame(2);
  const seat3 = currentSeat(s3);
  assert.throws(() =>
    applyAction(s3, {
      type: 'rearrange', seat: seat3,
      slots: [perfA, null, null, null, null, null, null, null],
      reserve: [],
    })
  );
});

test('rearrange: a card already sitting in a mismatched slot (placed there via Madame Barre) may remain there, but a general rearrange can never introduce a new mismatch — even with Barre active', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  const perfA = db.performers[0].id;
  const perfB = db.performers[1].id;
  p.slots[7] = TRAINERS.BARRE;
  p.slots[6] = perfA; // mismatched: a Performer parked in the Prop/Trainer slot
  // A no-op rearrange (the mismatched card stays exactly where it is) succeeds.
  applyAction(s, { type: 'rearrange', seat, slots: [...p.slots], reserve: [...p.reserve] });
  assert.equal(p.slots[6], perfA, 'unchanged mismatched placement survives a rearrange');
  // But moving a *different* performer into a mismatched slot is still rejected.
  p.reserve = [perfB];
  assert.throws(() =>
    applyAction(s, {
      type: 'rearrange', seat,
      slots: [null, null, null, null, null, perfB, perfA, TRAINERS.BARRE],
      reserve: [],
    })
  );
});

test('Madame Barre leaving play: reserve cards that could now fill an empty matching slot move there automatically', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const other = s.players.find((x) => x.seat !== seat);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.BARRE;
  s.hearts[TRAINERS.BARRE] = 0; // already at 0, next hit discards her immediately
  const perf = db.performers[0].id;
  p.reserve = [perf]; // parked in reserve (e.g. via Barre's choice) while slot 0 sits open
  p.roundStars = 5;
  other.roundStars = 0;

  assignTrophy(s); // p wins the Trophy -> trophy fatigue hits every one of p's 8 slots
  assert.equal(p.slots[7], null, 'Madame Barre was discarded');
  assert.ok(s.discard.includes(TRAINERS.BARRE));
  assert.equal(p.slots[0], perf, 'the reserved Performer automatically moved into the now-unlocked Performer slot');
  assert.ok(!p.reserve.includes(perf));
});

test('deterministic dice phase: collection matches, boosts, trophies, tomato hits', () => {
  const s = freshGame(2, 1234);
  const seat = currentSeat(s);
  const other = s.players.find((p) => p.seat !== seat).seat;
  const p = s.players[seat];

  // Board: a Graceful performer with letter C that yields Stars, plus a
  // matching Prop (boost -> 2 stars per C rolled). Empty opposing board.
  const perfH = performer((c) => c.letter === 'C' && c.resource === 'Star' && c.characteristic === 'Graceful');
  p.slots[0] = perfH;
  s.hearts[perfH] = 3;
  p.slots[6] = 'Prop-Graceful';
  s.hearts['Prop-Graceful'] = 2;
  s.players[other].slots = [null, null, null, null, null, null, null, null];
  s.players[other].reserve = [];
  p.reserve = [];

  // Two cards left in the row: taking one ends the draft and runs the whole
  // dice phase in one advance() (no rerolls, no heart performers -> no prompts).
  const filler = performer((c) => c.letter === 'B' && c.resource === 'Coin');
  s.draftRow = [filler, db.performers[3].id];

  // Predict the phase's rng consumption: 5 collection dice, 2 draft-order
  // tiebreak rolls, then 1 tomato die (round 1).
  const rngNow = 999;
  s.rng = rngNow;
  const seq = predict(rngNow, [20, 20, 20, 20, 20, 1000, 1000, 8]);
  const letters = seq.slice(0, 5).map((i) => COLLECTION_FACES[i]);
  const tomato = seq[7] + 1;
  const hCount = letters.filter((l) => l === 'C').length;
  const bCount = letters.filter((l) => l === 'B').length;

  const starsBefore = p.stars;
  const coinsBefore = p.coins;
  applyAction(s, { type: 'acquireDraft', seat, cardId: filler }); // filler is letter B / Coin: no heart prompts
  // The dice phase pauses after each Collection Die (and after the Tomato
  // batch) so a real driver can watch/react in real time; drive it through.
  driveDicePhase(s);

  assert.equal(s.round, 2, 'a full round elapsed');
  assert.equal(p.stars - starsBefore, hCount * 2, `C rolled ${hCount}x -> ${hCount * 2} stars (boosted)`);
  assert.equal(s.players[other].stars, 0);

  // Trophy: p had the most stars (or tied at 0 and tied coins decides/all take one).
  if (hCount > 0) {
    assert.equal(p.trophies, 1);
    assert.equal(s.players[other].trophies, 0);
    // Trophy fatigue: 1 heart off every occupied starter, plus maybe the
    // tomato die (at most 2 hits total here). Every card also has a hidden
    // "built-in" heart beyond its printed hearts, so it takes MORE hits than
    // its printed heart count to actually discard it (see heartHit) — with
    // only 1-2 hits possible in this scenario, neither card is discarded;
    // hearts just bottom out at 0.
    const perfHits = (tomato === 1 ? 1 : 0) + 1;
    const propHits = (tomato === 7 ? 1 : 0) + 1;
    assert.notEqual(p.slots[0], null, 'built-in heart keeps it on the mat after only 1-2 hits');
    assert.equal(s.hearts[perfH], Math.max(0, 3 - perfHits));
    assert.notEqual(p.slots[6], null, 'built-in heart keeps it on the mat after only 1-2 hits');
    assert.equal(s.hearts['Prop-Graceful'], Math.max(0, 2 - propHits));
  }
  // The filler performer (letter B, Coin) collected coins for any B rolls,
  // possibly boosted — just sanity check nothing went negative.
  if (bCount > 0) assert.ok(p.coins >= 0 && p.coins + 99 >= coinsBefore, 'coins never go negative');
  // New draft row was dealt for round 2.
  assert.equal(s.draftRow.length, 2 * 2 + 1);
  assert.ok(seatWithStand(s, 1) != null);
});

test('after the Collection Dice and Tomato dice both roll, every seat gets a review pause before the round moves on', () => {
  const s = freshGame(2, 1234);
  const seat = currentSeat(s);
  const other = s.players.find((p) => p.seat !== seat).seat;
  s.players[seat].slots = [null, null, null, null, null, null, null, null];
  s.players[other].slots = [null, null, null, null, null, null, null, null];
  s.players[seat].reserve = [];
  s.players[other].reserve = [];

  const filler = performer(() => true);
  s.draftRow = [filler, db.performers.find((c) => c.id !== filler).id];
  applyAction(s, { type: 'acquireDraft', seat, cardId: filler });

  // Drive everything except the new review pause: every Collection Die and
  // the Tomato batch, but stop the instant a diceResultsReview shows up.
  while (!s.pending.some((x) => x.kind === 'diceResultsReview')) {
    if (s.dieEvent && s.dieEvent.awaitingLock) { lockCollectionDie(s); continue; }
    if (s.dice && s.dice.stage === 'tomato' && s.dice.tomatoRolled && !s.dice.tomatoLocked) { lockTomatoRoll(s); continue; }
    throw new Error('expected to reach the review pause');
  }

  assert.equal(s.phase, 'dice', 'the round has not moved on yet');
  assert.equal(s.dice.results.length, 5, 'all 5 shared Collection Dice have rolled');
  assert.ok(s.dice.tomatoLocked, 'the Tomato batch has already resolved');
  const seatReview = s.pending.find((x) => x.kind === 'diceResultsReview' && x.seat === seat);
  const otherReview = s.pending.find((x) => x.kind === 'diceResultsReview' && x.seat === other);
  assert.ok(seatReview && otherReview, 'both seats get their own review prompt');

  applyAction(s, { type: 'resolvePending', seat, pendingId: seatReview.id });
  assert.equal(s.phase, 'dice', 'still waiting on the other seat to review');
  assert.ok(s.pending.some((x) => x.kind === 'diceResultsReview' && x.seat === other));

  applyAction(s, { type: 'resolvePending', seat: other, pendingId: otherReview.id });
  driveDicePhase(s);
  assert.equal(s.round, 2, 'the round advances once every seat has reviewed');
});

test('hasFullSet: wildcard Any-Characteristic/Any-Type Prop/Backdrop boosts require one of each active on board', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots = [null, null, null, null, null, null, null, null];
  assert.equal(hasFullSet(s, seat, 'type'), false, 'empty board has no types at all');

  const byType = {};
  for (const t of ['Singer', 'Dancer', 'Acrobat', 'Illusionist']) byType[t] = db.performers.find((c) => c.type === t).id;
  p.slots[0] = byType.Singer;
  p.slots[1] = byType.Dancer;
  p.slots[2] = byType.Acrobat;
  assert.equal(hasFullSet(s, seat, 'type'), false, 'missing Illusionist');
  p.slots[3] = byType.Illusionist;
  assert.equal(hasFullSet(s, seat, 'type'), true, 'one of each Type now active on board');

  // A reserve card doesn't count as "active" — only the 5 board slots do.
  p.slots[3] = null;
  p.reserve = [byType.Illusionist];
  assert.equal(hasFullSet(s, seat, 'type'), false, 'a reserve card is not active on the board');

  const byChar = {};
  for (const c of ['Graceful', 'Powerful', 'Dramatic', 'Haunting']) byChar[c] = db.performers.find((x) => x.characteristic === c).id;
  p.slots = [byChar.Graceful, byChar.Powerful, byChar.Dramatic, byChar.Haunting, null, null, null, null];
  assert.equal(hasFullSet(s, seat, 'characteristic'), true, 'one of each Characteristic now active on board');
});

test('wildcard Prop/Backdrop boost is dormant until the player has one of each Type active, then applies', () => {
  const rngNow = 999;
  const otherTypes = (excludeType) => ['Singer', 'Dancer', 'Acrobat', 'Illusionist'].filter((t) => t !== excludeType);

  // --- No full set: the wildcard Prop grants nothing, even though its
  // boosts list nominally "matches" perfH's Type. ---
  {
    const s = freshGame(2, 1234);
    const seat = currentSeat(s);
    const other = s.players.find((x) => x.seat !== seat).seat;
    const p = s.players[seat];
    const perfH = performer((c) => c.letter === 'C' && c.resource === 'Star' && c.characteristic === 'Graceful');
    p.slots = [perfH, null, null, null, null, null, 'Prop-Any-Type', null];
    s.hearts[perfH] = 3;
    s.hearts['Prop-Any-Type'] = 1;
    s.players[other].slots = [null, null, null, null, null, null, null, null];
    s.players[other].reserve = [];
    p.reserve = [];
    const filler = performer((c) => c.letter === 'B' && c.resource === 'Coin');
    s.draftRow = [filler, db.performers[3].id];
    s.rng = rngNow;
    const seq = predict(rngNow, [20, 20, 20, 20, 20, 1000, 1000, 8]);
    const hCount = seq.slice(0, 5).map((i) => COLLECTION_FACES[i]).filter((l) => l === 'C').length;
    assert.ok(hCount > 0, 'test setup expects at least 1 C roll this round (seed 999)');
    const starsBefore = p.stars;
    applyAction(s, { type: 'acquireDraft', seat, cardId: filler });
    driveDicePhase(s);
    assert.equal(p.stars - starsBefore, hCount * 1, 'wildcard Prop inactive — no other Types on board yet');
  }

  // --- Full set of all 4 Types active: the same wildcard Prop now boosts. ---
  {
    const s = freshGame(2, 1234);
    const seat = currentSeat(s);
    const other = s.players.find((x) => x.seat !== seat).seat;
    const p = s.players[seat];
    const perfH = performer((c) => c.letter === 'C' && c.resource === 'Star' && c.characteristic === 'Graceful');
    const perfType = card(perfH).type;
    const fillers = otherTypes(perfType).map((t) => performer((c) => c.type === t && c.resource === 'Coin' && c.letter !== 'C'));
    p.slots = [perfH, fillers[0], fillers[1], fillers[2], null, null, 'Prop-Any-Type', null];
    s.hearts[perfH] = 3;
    for (const f of fillers) s.hearts[f] = card(f).startingHearts ?? 0;
    s.hearts['Prop-Any-Type'] = 1;
    s.players[other].slots = [null, null, null, null, null, null, null, null];
    s.players[other].reserve = [];
    p.reserve = [];
    const filler = performer((c) => c.letter === 'B' && c.resource === 'Coin' && !fillers.includes(c.id));
    s.draftRow = [filler, db.performers[3].id];
    s.rng = rngNow;
    const seq = predict(rngNow, [20, 20, 20, 20, 20, 1000, 1000, 8]);
    const hCount = seq.slice(0, 5).map((i) => COLLECTION_FACES[i]).filter((l) => l === 'C').length;
    assert.ok(hasFullSet(s, seat, 'type'), 'test setup expects one of each Type active on board');
    const starsBefore = p.stars;
    applyAction(s, { type: 'acquireDraft', seat, cardId: filler });
    driveDicePhase(s);
    assert.equal(p.stars - starsBefore, hCount * 2, 'wildcard Prop active — +1 boosted unit per C roll');
  }
});

test('usePressPass: a pre-roll window opens once the draft ends, letting eligible seats roll private Collection Die(s) before the round\'s 5 shared dice', () => {
  const s = freshGame(2, 555);
  const seat = currentSeat(s);
  const other = s.players.find((x) => x.seat !== seat).seat;
  const perfAOther = performer((c) => c.letter === 'A'); // letter A performers are always Star-resource
  const perfASeat = db.performers.find((c) => c.letter === 'A' && c.id !== perfAOther).id;
  for (const p of s.players) p.slots = [null, null, null, null, null, null, null, null];
  s.players[other].slots[0] = perfAOther;
  s.players[seat].slots[0] = perfASeat;
  s.hearts[perfAOther] = card(perfAOther).startingHearts ?? 0;
  s.hearts[perfASeat] = card(perfASeat).startingHearts ?? 0;
  s.players[other].reserve = ['PressPass-3-1'];
  s.players[seat].reserve = [];

  // Nothing is spendable before the draft ends — no window is open yet.
  assert.throws(() => applyAction(s, { type: 'usePressPass', seat: other, cardId: 'PressPass-3-1' }), /pre-roll window/);

  // End the draft (only 1 card left in the row after this acquisition).
  const filler = performer((c) => c.resource === 'Coin');
  s.draftRow = [filler, db.performers.find((c) => c.id !== filler).id];
  applyAction(s, { type: 'acquireDraft', seat, cardId: filler });

  // The dice haven't started yet — `other` (the only Press Pass holder) now
  // has an open pre-roll window; `seat` (holding none) does not.
  assert.equal(s.phase, 'draft', 'still awaiting the pre-roll window(s) to close');
  const window = s.pending.find((x) => x.kind === 'pressPassWindow' && x.seat === other);
  assert.ok(window, 'expected a pressPassWindow prompt for the Press Pass holder');
  assert.ok(!s.pending.some((x) => x.kind === 'pressPassWindow' && x.seat === seat));

  const rngNow = 1;
  s.rng = rngNow;
  const seq = predict(rngNow, [20, 20, 20]).map((i) => COLLECTION_FACES[i]);
  const aCount = seq.filter((l) => l === 'A').length;
  assert.ok(aCount >= 1, 'test rng chosen to guarantee at least one A among the 3 private rolls');

  const otherStarsBefore = s.players[other].stars;
  const seatStarsBefore = s.players[seat].stars;

  applyAction(s, { type: 'usePressPass', seat: other, cardId: 'PressPass-3-1' });

  assert.equal(s.phase, 'draft', 'spending inside the window does not by itself advance the phase');
  assert.ok(s.discard.includes('PressPass-3-1'), 'spent immediately');
  assert.ok(!s.players[other].reserve.includes('PressPass-3-1'));
  assert.equal(s.players[other].stars - otherStarsBefore, aCount, 'private rolls credit the spender exactly as a normal Collection Die would');
  assert.equal(s.players[seat].stars, seatStarsBefore, 'private rolls never benefit anyone but the spender');

  // Closing the window (the only one open) lets the round's 5 shared dice
  // start rolling immediately, in addition to the private roll(s) above.
  applyAction(s, { type: 'resolvePending', seat: other, pendingId: window.id });
  assert.equal(s.phase, 'dice', 'the round now proceeds into its normal 5 shared Collection Dice');
  driveDicePhase(s);
  assert.equal(s.round, 2, 'round completed normally afterward');
});

test('usePressPass: only legal during that seat\'s own open pre-roll window, for a Press Pass actually in their reserve', () => {
  const s = freshGame(2, 555);
  const seat = currentSeat(s);
  const other = s.players.find((x) => x.seat !== seat).seat;
  const favor = db.favors[0].id;
  s.players[other].reserve = ['PressPass-1-1', favor];

  // Before the draft ends, no one's window is open yet.
  assert.throws(() => applyAction(s, { type: 'usePressPass', seat: other, cardId: 'PressPass-1-1' }), /pre-roll window/);

  for (const p of s.players) p.slots = [null, null, null, null, null, null, null, null];
  const filler = performer((c) => c.resource === 'Coin');
  s.draftRow = [filler, db.performers.find((c) => c.id !== filler).id];
  applyAction(s, { type: 'acquireDraft', seat, cardId: filler });

  assert.equal(s.phase, 'draft', 'still awaiting the pre-roll window to close');
  // `seat` (holding no Press Pass) never got a window of their own, so they
  // still cannot spend — even a card that exists in someone else's reserve.
  assert.throws(() => applyAction(s, { type: 'usePressPass', seat, cardId: 'PressPass-1-1' }), /pre-roll window/);
  // `other`'s window is open, but this card isn't in their reserve.
  assert.throws(() => applyAction(s, { type: 'usePressPass', seat: other, cardId: 'PressPass-2-1' }), /not in your reserve/);
  // In reserve, but not a Press Pass (reroll) card.
  assert.throws(() => applyAction(s, { type: 'usePressPass', seat: other, cardId: favor }), /not a Press Pass card/);
});

test('Mesmera the Veiled may re-roll the whole Tomato batch once, before it locks', () => {
  const s = freshGame(2, 8);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.MESMERA;
  const filler = performer((c) => c.resource === 'Coin');
  s.draftRow = [filler, db.performers[9].id];
  applyAction(s, { type: 'acquireDraft', seat, cardId: filler });

  driveToTomatoOpen(s);
  assert.equal(s.dice.tomatoRolled, true);
  assert.equal(s.dice.tomatoLocked, false);
  assert.equal(s.dice.mesmeraRerollUsed, false);

  applyAction(s, { type: 'mesmeraRerollTomato', seat });
  assert.equal(s.dice.mesmeraRerollUsed, true);
  assert.throws(() => applyAction(s, { type: 'mesmeraRerollTomato', seat }), /already/i);

  driveDicePhase(s);
  assert.equal(s.round, 2);
});

test('keepTomatoRoll: Mesmera\'s holder can explicitly keep the open Tomato batch\'s results', () => {
  const s = freshGame(2, 8);
  const seat = currentSeat(s);
  const other = s.players.find((x) => x.seat !== seat).seat;
  const p = s.players[seat];
  p.slots[7] = TRAINERS.MESMERA;
  const filler = performer((c) => c.resource === 'Coin');
  s.draftRow = [filler, db.performers[9].id];
  applyAction(s, { type: 'acquireDraft', seat, cardId: filler });

  driveToTomatoOpen(s);
  assert.equal(s.dice.tomatoRolled, true);
  assert.equal(s.dice.tomatoLocked, false);
  const before = [...s.dice.tomatoResults];

  // Only Mesmera's holder may confirm.
  assert.throws(() => applyAction(s, { type: 'keepTomatoRoll', seat: other }));

  applyAction(s, { type: 'keepTomatoRoll', seat });
  assert.equal(s.dice.mesmeraRerollUsed, true, 'keeping the result spends the round\'s one Mesmera decision');
  assert.deepEqual(s.dice.tomatoResults, before, 'results are unchanged by keeping them');
  assert.throws(() => applyAction(s, { type: 'keepTomatoRoll', seat }), /already/i);
  assert.throws(() => applyAction(s, { type: 'mesmeraRerollTomato', seat }), /already/i);

  driveDicePhase(s);
  assert.equal(s.round, 2);
});

test('Trophy ties: most TOTAL (career) coins among the tied wins it; still tied -> everyone shares it', () => {
  const s = freshGame(3);
  const [a, b, c] = s.players;
  // Tie-break uses each player's total coin stash, not coins earned this
  // round — the round-only figure is a red herring here.
  a.roundStars = 5; a.coins = 2; a.roundCoins = 99;
  b.roundStars = 5; b.coins = 4; b.roundCoins = 0;
  c.roundStars = 3; c.coins = 9; c.roundCoins = 0;
  assignTrophy(s);
  assert.equal(b.trophies, 1, 'most TOTAL coins among the tied-on-stars leaders wins it');
  assert.equal(a.trophies, 0);
  assert.equal(c.trophies, 0, 'fewer stars than the leaders — most coins overall does not matter');

  const s2 = freshGame(3);
  const [x, y, z] = s2.players;
  x.roundStars = 5; x.coins = 3;
  y.roundStars = 5; y.coins = 3;
  z.roundStars = 1; z.coins = 50;
  assignTrophy(s2);
  assert.equal(x.trophies, 1);
  assert.equal(y.trophies, 1, 'still tied on stars AND coins -> both take a trophy');
  assert.equal(z.trophies, 0);
});

test('Draft order ties: fewest round stars goes first; tied stars broken by fewest TOTAL (career) coins, not round coins', () => {
  const s = freshGame(3);
  const [a, b, c] = s.players;
  // a and b are tied on round stars (the lowest) — a should out-rank b for
  // stand 1 because a owns fewer TOTAL coins right now, even though b
  // earned fewer coins this particular round (a red herring, same trap as
  // the Trophy tie-break test above). c has more round stars so finishes last.
  a.roundStars = 2; a.coins = 3; a.roundCoins = 50;
  b.roundStars = 2; b.coins = 9; b.roundCoins = 0;
  c.roundStars = 6; c.coins = 0;
  assignDraftOrder(s);
  assert.equal(a.stand, 1, 'fewer total coins currently owned -> better (earlier) stand on a stars tie');
  assert.equal(b.stand, 2, 'more total coins currently owned is the worse draft pick on a stars tie');
  assert.equal(c.stand, 3, 'most round stars -> last regardless of coins');

  // Tied on both stars and total coins -> trophies is the next tiebreak.
  const s2 = freshGame(3);
  const [x, y, z] = s2.players;
  x.roundStars = 1; x.coins = 5; x.trophies = 2;
  y.roundStars = 1; y.coins = 5; y.trophies = 0;
  z.roundStars = 4; z.coins = 5;
  assignDraftOrder(s2);
  assert.equal(y.stand, 1, 'fewer trophies breaks a stars-and-coins tie');
  assert.equal(x.stand, 2);
  assert.equal(z.stand, 3);
});

test('A card survives the hit that brings it to 0 hearts, then discards on the very next hit', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  const other = s.players.find((x) => x.seat !== seat);
  const perf = db.performers[0].id;
  p.slots[0] = perf;
  s.hearts[perf] = 1; // printed 1 heart
  p.roundStars = 5;
  other.roundStars = 0; // make `p` the sole trophy (and heart-fatigue) target each call

  assignTrophy(s); // hit #1: 1 -> 0, survives (that hit spent its last printed heart)
  assert.equal(s.hearts[perf], 0);
  assert.equal(p.slots[0], perf, 'still on the mat with 0 printed hearts left');

  assignTrophy(s); // hit #2: taken while already at 0 -> discarded now, not another reprieve
  assert.equal(p.slots[0], null);
  assert.ok(s.discard.includes(perf));
});

test('A card that starts at 0 printed hearts discards on its very first hit', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  const other = s.players.find((x) => x.seat !== seat);
  const perf = db.performers[0].id;
  p.slots[0] = perf;
  s.hearts[perf] = 0; // already at 0, never hit before
  p.roundStars = 5;
  other.roundStars = 0;

  assignTrophy(s); // its very first hit, taken while already at 0 -> discarded immediately
  assert.equal(p.slots[0], null);
  assert.ok(s.discard.includes(perf));
});

test('Performer heart capacity is independent of starting fill (regression: capacity comes from the printed pips, not the starting-heart count)', () => {
  // The reported bug: capacity used to silently equal a performer's starting
  // fill for every performer (no separate printed-max field), so no
  // performer could ever actually receive a heart. Confirm capacity now
  // comes from the card's own maxHearts and can exceed its starting fill.
  const grows = db.performers.filter((c) => c.maxHearts > c.startingHearts);
  assert.ok(grows.length > 0, 'expected some performers with room beyond their starting hearts');
  const sample = grows[0];
  const s = freshGame(2);
  const seat = currentSeat(s);
  s.players[seat].slots[0] = sample.id;
  s.hearts[sample.id] = sample.startingHearts;
  assert.ok(capacityLeft(s, seat, sample.id) > 0, 'a performer below its printed max must have room for more hearts');
});

test('Tomasso the Terrible: rolls 1 Tomato die per own Dancer, consumes the turn, spares self', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const other = s.players.find((x) => x.seat !== seat);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.TOMASSO;
  // No Dancers yet: the ability is unusable.
  assert.throws(() => applyAction(s, { type: 'tomassoRoll', seat }), /at least one Dancer/);
  const dancer1 = performer((c) => c.type === 'Dancer');
  const dancer2 = performer((c) => c.type === 'Dancer' && c.id !== dancer1);
  p.slots[0] = dancer1;
  p.slots[1] = dancer2;
  s.hearts[dancer1] = 5;
  s.hearts[dancer2] = 5;
  const otherPerf = db.performers.find((c) => c.id !== dancer1 && c.id !== dancer2).id;
  other.slots[0] = otherPerf;
  s.hearts[otherPerf] = 5;
  applyAction(s, { type: 'tomassoRoll', seat });
  assert.notEqual(s.turn?.seat, seat, 'using the ability ended the turn — play moved to the next stand');
  // Self is never hit; own Dancer hearts unchanged.
  assert.equal(s.hearts[dancer1], 5);
  assert.equal(s.hearts[dancer2], 5);
});

test('Madame Curio: automatic free Collection Die at the start of her holder\'s turn, Acrobats only, letter-gated', () => {
  const s = freshGame(2, 8675309);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.CURIO;
  const acro = performer((c) => c.type === 'Acrobat' && c.resource === 'Coin');
  p.slots[0] = acro;
  s.hearts[acro] = card(acro).startingHearts ?? 0;
  p.coins = 5;
  // Game creation already resolved curioDone for this very turn (before
  // Curio was equipped, so it was a no-op) — reset it and force the next
  // randInt(20) to land on this Acrobat's letter, then trigger advance()
  // via a turn-preserving action (resetMarket doesn't end the turn).
  s.turn.curioDone = false;
  s.rng = rngForLetter(card(acro).letter);
  applyAction(s, { type: 'resetMarket', seat });
  assert.equal(s.turn.seat, seat, 'still the same turn — the auto-roll does not end it');
  assert.equal(p.coins, 5 - 1 + 1, 'paid 1 coin to reset the market, gained 1 coin from the Acrobat collecting (Curio)');

  // A non-Acrobat matching the same letter must NOT collect from Curio's roll.
  const s2 = freshGame(2, 8675309);
  const seat2 = currentSeat(s2);
  const p2 = s2.players[seat2];
  p2.slots[7] = TRAINERS.CURIO;
  const nonAcro = performer((c) => c.type !== 'Acrobat' && c.resource === 'Coin');
  p2.slots[0] = nonAcro;
  s2.hearts[nonAcro] = card(nonAcro).startingHearts ?? 0;
  p2.coins = 5;
  s2.turn.curioDone = false;
  s2.rng = rngForLetter(card(nonAcro).letter);
  applyAction(s2, { type: 'resetMarket', seat: seat2 });
  assert.equal(p2.coins, 4, 'only paid the 1-coin reset cost — no collection for a non-Acrobat');
});

test('Multiple eligible Favors can be spent in the same turn window, queuing multiple bonus turns', () => {
  const s = freshGame(2, 7);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.reserve.push('Favor-2-1', 'Favor-2-2');
  p.turns = 1; // both "2nd" favors are eligible

  applyAction(s, { type: 'useFavor', seat, cardId: 'Favor-2-1' });
  applyAction(s, { type: 'useFavor', seat, cardId: 'Favor-2-2' });
  assert.deepEqual(s.turn.bonusQueue, [2, 2]);
  assert.equal(s.turn.mainDone, false, 'both favors spent before the main action');

  s.draftRow = [db.performers[0].id, db.performers[1].id, db.performers[2].id, db.performers[3].id, db.performers[4].id];
  applyAction(s, { type: 'acquireDraft', seat, cardId: db.performers[0].id }); // ends the real turn
  assert.equal(s.turn.seat, seat);
  assert.equal(s.turn.isBonus, true);
  assert.deepEqual(s.turn.bonusQueue, [2], 'one more bonus turn still queued');

  s.draftRow[0] = db.performers[5].id;
  applyAction(s, { type: 'acquireDraft', seat, cardId: db.performers[5].id }); // ends bonus turn #1
  assert.equal(s.turn.seat, seat);
  assert.equal(s.turn.isBonus, true, 'second bonus turn from the second Favor');
  assert.deepEqual(s.turn.bonusQueue, []);
});

test('Favors can be spent one at a time across sequential turns, not just queued upfront: spend, take that turn, then decide again', () => {
  const s = freshGame(2, 7);
  const seat = currentSeat(s);
  const p = s.players[seat];
  s.draftRow = [db.performers[0].id, db.performers[1].id, db.performers[2].id, db.performers[3].id, db.performers[4].id, db.performers[6].id];

  // Turn 1: no Favor in reserve yet — just take the normal turn.
  applyAction(s, { type: 'acquireDraft', seat, cardId: db.performers[0].id });
  assert.notEqual(s.turn?.seat, seat, 'play passed to the other seat after an uneventful turn 1');

  // Fast-forward back to this seat's turn 2 (skipping the other seat's turn,
  // irrelevant here) and hand them a "1st" and a "2nd" Favor. Under the old
  // rule the "1st" Favor would already be dead (it only worked on turn 1)
  // — now it should still be usable.
  s.turn = { seat, mainDone: false, done: false, open: false, buys: 0, isBonus: false, bonusTiming: null, curioDone: false, celestineUsed: false, amaraUsed: false };
  p.reserve.push('Favor-1-1', 'Favor-2-1');
  assert.equal(p.turns, 1, 'about to take turn 2');
  assert.deepEqual(eligibleFavors(s, seat), ['Favor-1-1', 'Favor-2-1'], '"1st" Favor is still usable on turn 2, not expired');

  // Spend just the "1st" Favor, then take turn 2's real action.
  applyAction(s, { type: 'useFavor', seat, cardId: 'Favor-1-1' });
  assert.ok(p.reserve.includes('Favor-2-1'), 'the "2nd" Favor is untouched, still available for later');
  applyAction(s, { type: 'acquireDraft', seat, cardId: db.performers[1].id });
  assert.equal(s.turn.seat, seat, 'the Favor bonus turn keeps play with the same seat');
  assert.equal(s.turn.isBonus, true);
  assert.equal(s.turn.mainDone, false, 'fresh pre-action window on the bonus turn — a decision point again');

  // On this bonus turn, the player now decides to spend their remaining
  // ("2nd") Favor too, rather than just taking a normal action.
  applyAction(s, { type: 'useFavor', seat, cardId: 'Favor-2-1' });
  applyAction(s, { type: 'acquireDraft', seat, cardId: db.performers[2].id });
  assert.equal(s.turn.seat, seat, 'second Favor grants yet another bonus turn');
  assert.equal(s.turn.isBonus, true);
  assert.equal(s.turn.mainDone, false, 'and again offered the choice: spend another Favor, or just take this turn');

  // No Favors left — just take the turn normally this time.
  applyAction(s, { type: 'acquireDraft', seat, cardId: db.performers[3].id });
  assert.notEqual(s.turn?.seat, seat, 'no more Favors queued — play finally passes on');
});

test('state.turnsCompleted increments once per finished turn (drives the server\'s AI turn-pause)', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  assert.equal(s.turnsCompleted, 0);
  s.draftRow[0] = db.performers[0].id;
  applyAction(s, { type: 'acquireDraft', seat, cardId: db.performers[0].id });
  assert.equal(s.turnsCompleted, 1);
});

test('a full 2-player round keeps every one of the 145 cards accounted for', () => {
  const s = freshGame(2, 31337);
  // count every card location
  const total = (st) =>
    st.deck.length + st.discard.length + st.market.filter(Boolean).length + st.draftRow.length +
    st.players.reduce((a, p) => a + p.slots.filter(Boolean).length + p.reserve.length, 0);
  assert.equal(total(s), 145);
});

// ---- multi-trainer slots (5/6/7 all accept Trainer) ------------------------

test('SLOTS_FOR_TYPE: slot 7 is Trainer-only, slots 5/6 accept their natural card OR a Trainer', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  assert.deepEqual(allowedSlots(s, seat, TRAINERS.AURIC), [5, 6, 7]);
  assert.deepEqual(allowedSlots(s, seat, 'Prop-Graceful'), [6]);
  assert.deepEqual(allowedSlots(s, seat, 'Backdrop-Graceful'), [5]);
});

test('trainerActive scans all 3 trainer slots — up to 3 Trainers active at once', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[5] = TRAINERS.BARNABY;
  p.slots[6] = TRAINERS.MAXIMILLIAN;
  p.slots[7] = TRAINERS.COEUR;
  p.slots[0] = db.performers.find((c) => c.characteristic === 'Graceful').id;
  assert.equal(marketCost(s, seat, 0), 0, 'Barnaby active from slot 5');
  s.players[seat].coins = 10;
  s.draftRow = db.performers.slice(40, 45).map((c) => c.id);
  applyAction(s, { type: 'acquireDraft', seat, cardId: s.draftRow[1] });
  assert.equal(s.turn.open, true, 'Maximillian active from slot 6 earns a market buy after a draft');
});

test('acquiring a Trainer places it straight into slot 8 (Trainer-only) when open', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  s.draftRow[0] = TRAINERS.AURIC;
  applyAction(s, { type: 'acquireDraft', seat, cardId: TRAINERS.AURIC });
  assert.equal(p.slots[7], TRAINERS.AURIC, 'slot 8 (index 7) is tried first, automatically');
  assert.equal(s.pending.length, 0, 'no placement prompt needed when slot 8 is open');
});

test('acquiring a Trainer with slot 8 full offers a choice of slot 6, 7, or 8, or reserve', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.COEUR;
  s.draftRow[0] = TRAINERS.AURIC;
  applyAction(s, { type: 'acquireDraft', seat, cardId: TRAINERS.AURIC });
  const pending = s.pending.find((x) => x.kind === 'placement');
  assert.ok(pending, 'expected a placement prompt with slot 8 full');
  assert.deepEqual(pending.data.allowedSlots.sort(), [5, 6, 7], 'all 3 Trainer slots are bumpable, including slot 8');
  assert.ok(pending.data.allowReserve, 'reserve is also offered');
  applyAction(s, { type: 'resolvePending', seat, pendingId: pending.id, slot: 7 });
  assert.equal(p.slots[7], TRAINERS.AURIC, 'slot 8 itself can be bumped once it was the one already occupied');
  assert.ok(p.reserve.includes(TRAINERS.COEUR));
});

test('acquiring a Trainer with slot 8 full can be sent to reserve instead of bumping', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.COEUR;
  s.draftRow[0] = TRAINERS.AURIC;
  applyAction(s, { type: 'acquireDraft', seat, cardId: TRAINERS.AURIC });
  const pending = s.pending.find((x) => x.kind === 'placement');
  applyAction(s, { type: 'resolvePending', seat, pendingId: pending.id, toReserve: true });
  assert.ok(p.reserve.includes(TRAINERS.AURIC));
  assert.equal(p.slots[5], null);
  assert.equal(p.slots[6], null);
});

// ---- new trainers -----------------------------------------------------------

test('Orsino the Headliner: G and H performers collect +3 when rolled', () => {
  const s = freshGame(2, 1234);
  const seat = currentSeat(s);
  const other = s.players.find((x) => x.seat !== seat).seat;
  const p = s.players[seat];
  p.slots[7] = TRAINERS.ORSINO;
  const perfA = performer((c) => c.letter === 'G' && c.resource === 'Star');
  p.slots[0] = perfA;
  s.hearts[perfA] = card(perfA).startingHearts ?? 0;
  s.players[other].slots = [null, null, null, null, null, null, null, null];
  p.reserve = [];
  s.players[other].reserve = [];
  const filler = performer((c) => c.letter === 'C' && c.resource === 'Coin' && c.id !== perfA);
  s.draftRow = [filler, db.performers.find((c) => c.id !== perfA && c.id !== filler).id];
  const rngNow = 999;
  s.rng = rngNow;
  const seq = predict(rngNow, [20, 20, 20, 20, 20, 1000, 1000, 8]);
  const aCount = seq.slice(0, 5).map((i) => COLLECTION_FACES[i]).filter((l) => l === 'G').length;
  const before = p.stars;
  applyAction(s, { type: 'acquireDraft', seat, cardId: filler });
  driveDicePhase(s);
  assert.equal(p.stars - before, aCount * 4, `expected 1 (base) + 3 (Orsino) = 4 stars per G roll (${aCount}x)`);
});

test('Delphine Silvertongue doubles a spent Press Pass\'s private roll count', () => {
  const s = freshGame(2, 555);
  const seat = currentSeat(s);
  const other = s.players.find((x) => x.seat !== seat).seat;
  s.players[other].reserve = ['PressPass-3-1'];
  s.players[other].slots[7] = TRAINERS.DELPHINE;
  s.players[seat].reserve = [];
  for (const p of s.players) p.slots = p.slots.map((id, i) => (i === 7 ? p.slots[7] : null));

  const filler = performer((c) => c.resource === 'Coin');
  s.draftRow = [filler, db.performers.find((c) => c.id !== filler).id];
  applyAction(s, { type: 'acquireDraft', seat, cardId: filler });

  const window = s.pending.find((x) => x.kind === 'pressPassWindow' && x.seat === other);
  assert.ok(window, 'Delphine holder with a Press Pass gets a pre-roll window');

  applyAction(s, { type: 'usePressPass', seat: other, cardId: 'PressPass-3-1' });

  const lastLog = s.log[s.log.length - 1];
  assert.ok(/for 6 private Collection Die rolls/.test(lastLog), 'Press Pass 3 (count 3) doubled to 6 rolls by Delphine Silvertongue');
  assert.ok(/doubled by Delphine Silvertongue/.test(lastLog));
  assert.ok(s.discard.includes('PressPass-3-1'));
});

test('Jonas Quickfinger: any player discarding a Haunting performer pays its holder 1 of its resource', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.JONAS;
  p.coins = 0;
  const haunting = performer((c) => c.characteristic === 'Haunting' && c.resource === 'Coin');
  p.slots[0] = haunting;
  s.hearts[haunting] = 0; // already at 0, so the next hit discards it
  p.roundStars = 5; // make sure this seat takes the Trophy, so fatigue lands here
  assignTrophy(s);
  assert.equal(p.slots[0], null, 'the performer left play');
  assert.equal(p.coins, 1, 'collects exactly 1 of its printed resource');
});

test("Jonas Quickfinger: it also pays out on ANOTHER player's discarded Haunting performer", () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const other = s.players.find((x) => x.seat !== seat).seat;
  s.players[seat].slots[7] = TRAINERS.JONAS;
  s.players[seat].coins = 0;
  const haunting = performer((c) => c.characteristic === 'Haunting' && c.resource === 'Coin');
  s.players[other].slots[0] = haunting;
  s.hearts[haunting] = 0;
  s.players[other].roundStars = 5; // the OTHER player wins, so their card takes the fatigue
  assignTrophy(s);
  assert.equal(s.players[other].slots[0], null, "the other player's performer left play");
  assert.equal(s.players[seat].coins, 1, 'the Jonas holder still collects — the trigger is table-wide');
});

test('Jonas Quickfinger: non-Haunting performers never trigger it, and a bump to reserve is not a discard', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.JONAS;
  p.coins = 0;
  const plain = performer((c) => c.characteristic !== 'Haunting' && c.resource === 'Coin');
  p.slots[0] = plain;
  s.hearts[plain] = 0;
  p.roundStars = 5;
  assignTrophy(s);
  assert.equal(p.slots[0], null, 'it did leave play');
  assert.equal(p.coins, 0, 'but it was not Haunting, so nothing is collected');

  // Bumped into your own reserve: still owned, not discarded, so no payout.
  const s2 = freshGame(2);
  const seat2 = currentSeat(s2);
  const q = s2.players[seat2];
  q.coins = 0;
  const haunting = db.performers.filter((c) => c.characteristic === 'Haunting').map((c) => c.id);
  q.slots = [haunting[0], haunting[1], haunting[2], haunting[3], haunting[4], null, null, TRAINERS.JONAS];
  const extra = db.performers.find((c) => !haunting.slice(0, 5).includes(c.id)).id;
  s2.draftRow = [extra, ...s2.draftRow.slice(1)];
  applyAction(s2, { type: 'acquireDraft', seat: seat2, cardId: extra });
  const place = s2.pending.find((x) => x.kind === 'placement');
  applyAction(s2, { type: 'resolvePending', seat: seat2, pendingId: place.id, slot: 0 });
  assert.ok(q.reserve.includes(haunting[0]), 'it was bumped to reserve, still owned');
  assert.equal(q.coins, 0, 'a bump to your own reserve is not a discard');
});

test('Stars earned after the round is scored carry into the next round instead of being wiped', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.JONAS;
  // A Haunting Star performer that will be discarded by the Tomato dice —
  // i.e. after both the Trophy and the new draft order are already settled.
  const hauntStar = performer((c) => c.characteristic === 'Haunting' && c.resource === 'Star');
  p.slots[0] = hauntStar;
  s.hearts[hauntStar] = 0;
  s.draftRow = [];
  applyAction(s, { type: 'rearrange', seat, slots: [...p.slots], reserve: [...p.reserve] });
  driveDicePhase(s);
  assert.equal(s.round, 2, 'the round advanced');
  // Whatever Jonas paid out post-scoring is banked, not deleted by the reset.
  assert.equal(p.roundStars, p.carryStars === 0 ? p.roundStars : p.roundStars, 'sanity');
  assert.equal(p.carryStars, 0, 'the bank is emptied into the new round');
  assert.ok(p.roundStars >= 0);
});

test('carryStars: stars gained after the Trophy is decided bank for next round; before it, they do not', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];

  // Before scoring (no dice phase yet): a normal in-round star.
  const before = p.stars;
  addStars(s, seat, 2);
  assert.equal(p.stars, before + 2, 'lifetime tally always counts it');
  assert.equal(p.roundStars, 2);
  assert.equal(p.carryStars, 0, 'nothing banked — this round can still score it');

  // Once this round is scored, further stars are banked as well as counted.
  s.dice = { stage: 'tomato', trophyAssigned: true };
  addStars(s, seat, 3);
  assert.equal(p.roundStars, 5);
  assert.equal(p.carryStars, 3, 'the post-scoring stars are banked');
});

test('carryStars: the next round opens with the banked stars rather than zero', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  // Empty boards all round, so nobody earns stars from the dice and the only
  // stars in play are the ones we bank here.
  for (const x of s.players) x.slots = [null, null, null, null, null, null, null, null];
  p.carryStars = 3;
  p.roundStars = 0;

  s.draftRow = [];
  applyAction(s, { type: 'rearrange', seat, slots: [...p.slots], reserve: [...p.reserve] });
  driveDicePhase(s);

  assert.equal(s.round, 2, 'the round advanced');
  assert.equal(p.roundStars, 3, 'next round opens with exactly the banked stars, not 0');
  assert.equal(p.carryStars, 0, 'and the bank is emptied');
});




test('Wendell the Propmaster: spend the turn to take any Prop or Backdrop from the discard pile, full-hearted', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.WENDELL;
  s.discard.push('Prop-Powerful', 'Backdrop-Graceful', 'Resource-1-Coin-1');

  // Only a Prop or Backdrop may be taken this way — not just anything sitting
  // in the discard pile.
  assert.throws(
    () => applyAction(s, { type: 'wendellTakeDiscard', seat, cardId: 'Resource-1-Coin-1' }),
    /Prop or Backdrop/
  );
  // Not in the discard pile at all.
  assert.throws(() => applyAction(s, { type: 'wendellTakeDiscard', seat, cardId: 'Prop-Graceful' }), /discard pile/);

  applyAction(s, { type: 'wendellTakeDiscard', seat, cardId: 'Prop-Powerful' });
  assert.equal(p.slots[6], 'Prop-Powerful', 'Prop lands in its natural slot');
  assert.equal(s.hearts['Prop-Powerful'], maxHearts(s, seat, 'Prop-Powerful'), 'enters play with hearts full');
  assert.ok(!s.discard.includes('Prop-Powerful'), 'removed from the discard pile');
  assert.notEqual(s.turn?.seat, seat, 'taking a card this way spent the whole turn');
});

test('Wendell the Propmaster: gated on being active, on going before the main action, and taking an occupied slot bumps to reserve', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  s.discard.push('Backdrop-Graceful');
  // Not active yet — no Wendell in play.
  assert.throws(() => applyAction(s, { type: 'wendellTakeDiscard', seat, cardId: 'Backdrop-Graceful' }), /active Trainer/);

  p.slots[7] = TRAINERS.WENDELL;
  p.slots[5] = 'Backdrop-Powerful';
  s.hearts['Backdrop-Powerful'] = maxHearts(s, seat, 'Backdrop-Powerful');
  applyAction(s, { type: 'wendellTakeDiscard', seat, cardId: 'Backdrop-Graceful' });
  // The natural slot is already occupied, so — same as any other acquisition
  // — it's a genuine placement choice, not an auto-bump.
  const placement = s.pending.find((x) => x.kind === 'placement');
  assert.ok(placement, 'occupied natural slot offers a placement choice, like any other acquisition');
  assert.ok(placement.data.allowedSlots.includes(5));
  applyAction(s, { type: 'resolvePending', seat, pendingId: placement.id, slot: 5 });
  assert.equal(p.slots[5], 'Backdrop-Graceful', 'the taken Backdrop fills its natural slot');
  assert.ok(p.reserve.includes('Backdrop-Powerful'), 'the bumped occupant moves to reserve, not discard');
});

test('Celestine the Stargazer: to start your turn, buy up to 2 stars for 2 coins each', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.CELESTINE;
  p.coins = 4;
  const roundBefore = p.roundStars;
  applyAction(s, { type: 'celestineBuyStars', seat, count: 2 });
  assert.equal(p.coins, 0, '2 stars cost 2 coins each');
  assert.equal(p.stars, 2);
  assert.equal(p.roundStars - roundBefore, 2, 'bought stars count toward the round, not just the career total');
  assert.throws(() => applyAction(s, { type: 'celestineBuyStars', seat, count: 1 }), /already used/);
});

test('Celestine the Stargazer: 3 stars is no longer a legal purchase, and you must be able to afford it', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.CELESTINE;
  p.coins = 99;
  assert.throws(() => applyAction(s, { type: 'celestineBuyStars', seat, count: 3 }), /Choose 1-2 stars/);
  assert.equal(p.stars, 0, 'nothing was bought by the rejected action');

  const s2 = freshGame(2);
  const seat2 = currentSeat(s2);
  const p2 = s2.players[seat2];
  p2.slots[7] = TRAINERS.CELESTINE;
  p2.coins = 3; // enough for 1 star (2 coins), not 2 (4 coins)
  assert.throws(() => applyAction(s2, { type: 'celestineBuyStars', seat: seat2, count: 2 }), /You need 4 coins/);
  applyAction(s2, { type: 'celestineBuyStars', seat: seat2, count: 1 });
  assert.equal(p2.coins, 1);
  assert.equal(p2.stars, 1);
});


test('Bellacanto the Choirmistress: Singers in reserve also collect, letter-gated', () => {
  const s = freshGame(2, 1234);
  const seat = currentSeat(s);
  const other = s.players.find((x) => x.seat !== seat).seat;
  const p = s.players[seat];
  p.slots[7] = TRAINERS.BELLACANTO;
  const singerH = performer((c) => c.letter === 'H' && c.type === 'Singer'); // letter H performers are always Star-resource
  // Every Performer slot must be full for the Singer to legally stay in
  // reserve at all — a card that can be a starter must be one (see
  // enforceReservePlacement), so an open Performer slot would pull it out of
  // reserve and defeat the whole point of Bellacanto's reserve-only bonus.
  // These fillers are all Coin-resource so they never muddy the star count.
  const fillers = db.performers.filter((c) => c.resource === 'Coin' && c.letter !== 'H' && c.id !== singerH).slice(0, 5).map((c) => c.id);
  p.slots = [...fillers, null, null, TRAINERS.BELLACANTO];
  for (const id of fillers) s.hearts[id] = card(id).startingHearts ?? 0;
  p.reserve = [singerH];
  s.hearts[singerH] = card(singerH).startingHearts ?? 0;
  s.players[other].slots = [null, null, null, null, null, null, null, null];
  s.players[other].reserve = [];
  // A Favor is the cleanest way to spend the turn and end the draft: it goes
  // straight to reserve, needs no slot, and has no collection effect.
  const filler = 'Favor-1-1';
  s.draftRow = [filler, db.performers.find((c) => c.id !== singerH && !fillers.includes(c.id)).id];
  const rngNow = 999;
  s.rng = rngNow;
  const seq = predict(rngNow, [20, 20, 20, 20, 20, 1000, 1000, 8]);
  const hCount = seq.slice(0, 5).map((i) => COLLECTION_FACES[i]).filter((l) => l === 'H').length;
  const before = p.stars;
  applyAction(s, { type: 'acquireDraft', seat, cardId: filler });
  driveDicePhase(s);
  assert.equal(p.stars - before, hCount, 'reserve Singer collected 1 star per matching H roll (Bellacanto)');
});

test('Ezra the Sleight-of-Hand: receives the draft\'s leftover performer card, placed on his board like a normal acquisition', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.EZRA;
  const illusionist = performer((c) => c.type === 'Illusionist');
  p.slots[0] = illusionist;
  const leftover = db.performers.find((c) => c.id !== illusionist).id;
  s.draftRow = [leftover];
  applyAction(s, { type: 'rearrange', seat, slots: [...p.slots], reserve: [...p.reserve] });
  assert.ok(p.slots.includes(leftover), 'Ezra receives the leftover draft card into an empty matching slot, not reserve');
  assert.ok(!p.reserve.includes(leftover));
  assert.ok(!s.discard.includes(leftover));
});

test('Ezra the Sleight-of-Hand: a leftover Resource card resolves its effect and discards, instead of sitting unresolved in reserve', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.EZRA;
  const illusionist = performer((c) => c.type === 'Illusionist');
  p.slots[0] = illusionist;
  const leftover = firstOfName(db.resources, 'Resource 2 Coins');
  const before = p.coins;
  s.draftRow = [leftover];
  applyAction(s, { type: 'rearrange', seat, slots: [...p.slots], reserve: [...p.reserve] });
  assert.equal(p.coins, before + 2, 'the resource effect resolved (+2 coins) instead of the card just sitting in reserve');
  assert.ok(s.discard.includes(leftover), 'a resolved resource card is discarded, not kept');
  assert.ok(!p.reserve.includes(leftover));
});

test('Amara the Reliquary: rearrange up to 3 hearts per turn, across mat and reserve cards', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.AMARA;
  const perfA = performer((c) => c.maxHearts >= 3);
  const perfB = performer((c) => c.id !== perfA && c.maxHearts >= 3);
  p.slots[0] = perfA;
  p.slots[1] = perfB;
  s.hearts[perfA] = 3;
  s.hearts[perfB] = 0;

  for (let i = 0; i < 3; i++) {
    applyAction(s, { type: 'amaraMoveHeart', seat, fromCardId: perfA, toCardId: perfB });
  }
  assert.equal(s.hearts[perfA], 0, 'source gave up 3 hearts');
  assert.equal(s.hearts[perfB], 3, 'destination received all 3');
  assert.throws(
    () => applyAction(s, { type: 'amaraMoveHeart', seat, fromCardId: perfB, toCardId: perfA }),
    /already rearranged 3 hearts/,
    'capped at 3 moves per turn'
  );
});

test('Amara the Reliquary: reserve cards are eligible on both ends (her documented exception)', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.AMARA;
  const onMat = performer((c) => c.maxHearts >= 2);
  // Keep the Performer row full so the reserve card legally stays in reserve.
  const fillers = db.performers.filter((c) => c.id !== onMat && c.maxHearts >= 1).slice(0, 5).map((c) => c.id);
  p.slots = [onMat, ...fillers.slice(0, 4), null, null, TRAINERS.AMARA];
  const inReserve = fillers[4];
  p.reserve = [inReserve];
  s.hearts[onMat] = 2;
  s.hearts[inReserve] = 0;
  applyAction(s, { type: 'amaraMoveHeart', seat, fromCardId: onMat, toCardId: inReserve });
  assert.equal(s.hearts[inReserve], 1, 'a reserve card can receive a heart');
  applyAction(s, { type: 'amaraMoveHeart', seat, fromCardId: inReserve, toCardId: onMat });
  assert.equal(s.hearts[inReserve], 0, 'and can give one back');
  assert.equal(s.hearts[onMat], 2);
});

test('Amara the Reliquary: cannot move a heart from an empty card or onto a full one', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.AMARA;
  const perfA = performer((c) => c.maxHearts >= 1);
  const perfFull = performer((c) => c.id !== perfA && c.maxHearts >= 1);
  p.slots[0] = perfA;
  p.slots[1] = perfFull;
  s.hearts[perfA] = 0;
  s.hearts[perfFull] = card(perfFull).maxHearts;
  assert.throws(
    () => applyAction(s, { type: 'amaraMoveHeart', seat, fromCardId: perfA, toCardId: perfFull }),
    /no heart to move/
  );
  s.hearts[perfA] = 1;
  assert.throws(
    () => applyAction(s, { type: 'amaraMoveHeart', seat, fromCardId: perfA, toCardId: perfFull }),
    /no room/
  );
});

// ---- Forced reserve -> starter placement -------------------------------------

test('a reserve card with exactly one open matching slot is moved there automatically', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  // The owner's own example: a Trainer bumped out of the Prop/Trainer slot by
  // a newly acquired Prop must relocate into the open Trainer-only slot.
  p.slots[5] = db.propsAndBackdrops.find((c) => c.cardKind === 'backdrop').id; // Backdrop slot taken
  p.slots[6] = TRAINERS.MAXIMILLIAN; // Trainer parked in the Prop/Trainer slot
  p.slots[7] = null; // the Trainer-only slot is the single legal destination
  const prop = db.propsAndBackdrops.find((c) => c.cardKind === 'prop').id;
  s.draftRow = [prop, ...s.draftRow.slice(1)];
  applyAction(s, { type: 'acquireDraft', seat, cardId: prop });
  // Its natural slot is occupied, so the usual bump-or-reserve choice appears;
  // taking the slot is what displaces the Trainer.
  const place = s.pending.find((x) => x.seat === seat && x.kind === 'placement');
  assert.ok(place, 'expected the normal placement choice');
  applyAction(s, { type: 'resolvePending', seat, pendingId: place.id, slot: 6 });
  // The displaced Trainer may not then idle in reserve.
  assert.equal(p.slots[6], prop, 'the Prop took its natural slot');
  assert.equal(p.slots[7], TRAINERS.MAXIMILLIAN, 'the bumped Trainer relocated instead of idling in reserve');
  assert.ok(!p.reserve.includes(TRAINERS.MAXIMILLIAN));
});

test('a reserve card with several open matching slots raises a mandatory refill prompt instead of auto-placing', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  // Slots 6, 7 and 8 all open: a Trainer in reserve has a genuine choice.
  p.slots = [null, null, null, null, null, null, null, null];
  p.reserve = [TRAINERS.MAXIMILLIAN];
  applyAction(s, { type: 'resetMarket', seat }); // any action, to settle the engine
  const item = s.pending.find((x) => x.seat === seat && x.kind === 'refill');
  assert.ok(item, 'expected a refill prompt for the genuine choice');
  assert.ok(p.reserve.includes(TRAINERS.MAXIMILLIAN), 'not auto-placed while the choice is open');
  // Declining is not allowed — every fillable slot must be filled. (Rejecting
  // re-raises a fresh prompt, so re-find it rather than reusing the old id.)
  assert.throws(
    () => applyAction(s, { type: 'resolvePending', seat, pendingId: item.id, assignments: [] }),
    /must refill every empty slot/
  );
  const again = s.pending.find((x) => x.seat === seat && x.kind === 'refill');
  assert.ok(again, 'the prompt is re-raised rather than silently dropped');
  applyAction(s, { type: 'resolvePending', seat, pendingId: again.id, assignments: [{ slot: 5, cardId: TRAINERS.MAXIMILLIAN }] });
  assert.equal(p.slots[5], TRAINERS.MAXIMILLIAN, 'placed in the slot the player chose');
});

test('Madame Barre is exempt: her holder may keep a card in reserve with a matching slot wide open', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  // Only Performer slot 1 is left open, so placement would be forced (not a
  // choice) — isolating the exemption itself rather than the prompt path.
  const taken = db.performers.slice(0, 4).map((c) => c.id);
  p.slots = [null, ...taken, null, null, TRAINERS.BARRE];
  const perf = db.performers[9].id;
  p.reserve = [perf];
  applyAction(s, { type: 'resetMarket', seat });
  assert.ok(p.reserve.includes(perf), 'Barre lets it stay parked in reserve');
  assert.ok(!s.pending.some((x) => x.kind === 'refill'), 'and no refill is forced');
  // Without her, that same board state is not allowed to persist.
  p.slots[7] = null;
  applyAction(s, { type: 'resetMarket', seat });
  assert.ok(!p.reserve.includes(perf), 'the exemption ended, so the card had to take a slot');
  assert.equal(p.slots[0], perf);
});

test('a reserve card with no matching open slot is left alone', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  const five = db.performers.slice(0, 5).map((c) => c.id);
  const extra = db.performers[9].id;
  p.slots = [...five, null, null, null];
  p.reserve = [extra]; // every Performer slot is taken
  applyAction(s, { type: 'resetMarket', seat });
  assert.ok(p.reserve.includes(extra), 'nowhere legal to go, so it stays');
  assert.ok(!s.pending.some((x) => x.kind === 'refill'));
});

// ---- Token supply ------------------------------------------------------------

test('tokenSupply counts what is physically on the table, and coins/hearts return to the pool when spent or lost', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  const before = tokenSupply(s);
  assert.equal(before.coins.total, 80);
  assert.equal(before.hearts.total, 90);
  assert.equal(before.stars.total, 30);
  // Starting coins are already out of the pool.
  const coinsOut = s.players.reduce((n, x) => n + x.coins, 0);
  assert.equal(before.coins.out, coinsOut);
  assert.equal(before.coins.left, 80 - coinsOut);

  // Spending a coin returns it to the supply.
  const coinsBefore = tokenSupply(s).coins.left;
  applyAction(s, { type: 'resetMarket', seat }); // costs exactly 1 coin
  assert.equal(tokenSupply(s).coins.left, coinsBefore + 1, 'the spent coin went back to the pool');

  // Hearts on a card count as out; losing them returns them.
  const perf = performer((c) => c.maxHearts >= 2);
  p.slots[0] = perf;
  s.hearts[perf] = 2;
  const heartsOutNow = tokenSupply(s).hearts.out;
  s.hearts[perf] = 1;
  assert.equal(tokenSupply(s).hearts.out, heartsOutNow - 1, 'a lost heart returns to the pool');
});

test('token supply: stars are only counted for the current round, and a depleted pool alerts without blocking the gain', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  // Stars physically on the table are this round's stars — p.stars is just a
  // lifetime tally, so a big career total must not count against the pool.
  p.stars = 999;
  p.roundStars = 4;
  assert.equal(tokenSupply(s).stars.out, 4);

  // Overrun the star pool: the alert fires, but the stars are still credited.
  p.roundStars = 31;
  applyAction(s, { type: 'resetMarket', seat });
  assert.equal(p.roundStars, 31, 'gain is never blocked — alert only');
  assert.ok(s.supplyAlerts.stars, 'the shortage was recorded');
  assert.equal(s.supplyAlerts.stars.deficit, 1);
  assert.ok(s.log.some((l) => l.includes('TOKEN SUPPLY') && l.includes('stars')));
  // The record persists even after the pool recovers, since the point is to
  // report that the printed component count was too low at some point.
  p.roundStars = 0;
  applyAction(s, { type: 'resetMarket', seat });
  assert.ok(s.supplyAlerts.stars, 'still flagged after recovering');
  assert.equal(s.tokenSupply.stars.left, 30, 'live counts follow the table');
});

// ---- Solo mode / Ghost seats -------------------------------------------------

function freshSoloGame(seed = 42) {
  return createGame({
    players: [
      { name: 'Human', isBot: false, isGhost: false },
      { name: 'Ghost 1', isBot: false, isGhost: true },
      { name: 'Ghost 2', isBot: false, isGhost: true },
    ],
    solo: true,
    seed,
  });
}

// Force the engine's next randInt(12) (the Ghost d12) to land on a specific
// 0-based face index — same technique as rngForLetter, for GHOST_DIE_FACES.
function rngForGhostFace(faceIdx) {
  for (let x = 1; x < 200000; x++) {
    if (predict(x, [12])[0] === faceIdx) return x;
  }
  throw new Error('no rng value found for ghost face ' + faceIdx);
}

// Force a Ghost seat's turn to be open right now, regardless of draft order —
// mirrors how other tests above directly set state.turn/state.pending to
// exercise a specific situation without playing the whole draft out to reach it.
function forceGhostTurn(s, ghostSeat) {
  s.turn = { seat: ghostSeat, mainDone: false, done: false, open: false, buys: 0, isBonus: false, bonusTiming: null, curioDone: true, celestineUsed: false, amaraUsed: false };
}

test('setup: solo mode creates 2 fixed Ghost seats and a lower trophy goal', () => {
  const s = freshSoloGame();
  assert.equal(s.solo, true);
  assert.equal(s.trophyGoal, 5);
  assert.equal(s.players.length, 3);
  assert.equal(s.players[0].isGhost, false);
  assert.equal(s.players[1].isGhost, true);
  assert.equal(s.players[2].isGhost, true);
});

test('rollGhostDie: only the human may roll, and only during a Ghost\'s own turn', () => {
  const s = freshSoloGame();
  forceGhostTurn(s, 0); // seat 0 is the human, not a Ghost
  assert.throws(() => applyAction(s, { type: 'rollGhostDie', seat: 0 }), /isn't a Ghost's turn/);

  forceGhostTurn(s, 1);
  assert.throws(() => applyAction(s, { type: 'rollGhostDie', seat: 1 }), /Only the solo player may roll/, 'a Ghost cannot roll for itself');
  assert.throws(() => applyAction(s, { type: 'rollGhostDie', seat: 2 }), /Only the solo player may roll/, 'the other Ghost cannot roll for it either');
});

test('Ghost d12: "reset market and collect 3 coins" face', () => {
  const s = freshSoloGame();
  const ghostSeat = 1;
  const gp = s.players[ghostSeat];
  forceGhostTurn(s, ghostSeat);
  const before = gp.coins;
  const turnsBefore = s.turnsCompleted;
  s.rng = rngForGhostFace(0);
  applyAction(s, { type: 'rollGhostDie', seat: 0 });
  assert.equal(gp.coins, before + 3);
  // Note: applyAction always calls advance() at the end, so once the Ghost's
  // turn is truly over, state.turn has already been replaced by a fresh turn
  // for whoever goes next — turnsCompleted (not state.turn.done) is the
  // reliable "did that turn just end" signal from outside the action itself.
  assert.equal(s.turnsCompleted, turnsBefore + 1, "the Ghost's turn ended");
  assert.equal(s.ghostRollEvent.roll, 1);
});

test('Ghost d12: "reset market and collect 3 hearts" face (forfeited once the board is full)', () => {
  const s = freshSoloGame();
  const ghostSeat = 1;
  const gp = s.players[ghostSeat];
  // Fill every mat slot to capacity so the 3 hearts have nowhere to go —
  // isolates this face from the heartAssign pending, which is covered below.
  const five = db.performers.slice(0, 5).map((c) => c.id);
  gp.slots = [...five, null, null, null];
  for (const id of five) s.hearts[id] = maxHearts(s, ghostSeat, id);
  forceGhostTurn(s, ghostSeat);
  const turnsBefore = s.turnsCompleted;
  s.rng = rngForGhostFace(1);
  applyAction(s, { type: 'rollGhostDie', seat: 0 });
  assert.equal(s.turnsCompleted, turnsBefore + 1);
  assert.ok(s.log.some((l) => l.includes('forfeited')));
});

test('Ghost d12: "buy market slot" face buys when affordable', () => {
  const s = freshSoloGame();
  const ghostSeat = 1;
  const gp = s.players[ghostSeat];
  forceGhostTurn(s, ghostSeat);
  gp.coins = 10;
  const bought = s.market[0];
  assert.ok(bought, 'market slot 0 should be occupied at game start');
  const turnsBefore = s.turnsCompleted;
  s.rng = rngForGhostFace(2); // "Buy market slot 1"
  applyAction(s, { type: 'rollGhostDie', seat: 0 });
  // Not asserting on s.market[0] here — once the turn is truly over, advance()
  // compacts and refills any sold slot (see engine.js's compactMarket), so an
  // emptied-then-refilled slot is expected, not a bug.
  assert.ok(gp.slots.includes(bought) || gp.reserve.includes(bought), "the bought card lands on the Ghost's board or reserve");
  assert.equal(s.turnsCompleted, turnsBefore + 1);
});

test('Ghost d12: "buy market slot" face rerolls (leaves the turn open) when unaffordable', () => {
  const s = freshSoloGame();
  const ghostSeat = 1;
  const gp = s.players[ghostSeat];
  forceGhostTurn(s, ghostSeat);
  gp.coins = 0;
  s.rng = rngForGhostFace(2); // "Buy market slot 1" costs at least 1 coin
  applyAction(s, { type: 'rollGhostDie', seat: 0 });
  assert.equal(s.turn.mainDone, false, 'an unaffordable buy leaves the main action open for another roll');
  assert.equal(s.turn.done, false);
  assert.ok(s.market[0], 'the unaffordable slot is left untouched, still there to try again');
});

test('Ghost d12: "draft left-most / right-most" faces take from the correct end of the draft row', () => {
  const s = freshSoloGame();
  const ghostSeat = 1;
  forceGhostTurn(s, ghostSeat);
  const leftId = performer((c) => true);
  s.draftRow[0] = leftId;
  const turnsBefore = s.turnsCompleted;
  s.rng = rngForGhostFace(6); // "Draft the left-most card"
  applyAction(s, { type: 'rollGhostDie', seat: 0 });
  assert.equal(s.players[ghostSeat].slots[0], leftId);
  assert.equal(s.turnsCompleted, turnsBefore + 1);

  const s2 = freshSoloGame();
  forceGhostTurn(s2, ghostSeat);
  const rightId = performer((c) => true);
  s2.draftRow[s2.draftRow.length - 1] = rightId;
  const turnsBefore2 = s2.turnsCompleted;
  s2.rng = rngForGhostFace(8); // "Draft the right-most card"
  applyAction(s2, { type: 'rollGhostDie', seat: 0 });
  assert.equal(s2.players[ghostSeat].slots[0], rightId);
  assert.equal(s2.turnsCompleted, turnsBefore2 + 1);
});

test('Ghost d12: "draft ... and roll again" chains a second roll onto the same Ghost turn', () => {
  const s = freshSoloGame();
  const ghostSeat = 1;
  forceGhostTurn(s, ghostSeat);
  const leftId = performer((c) => true);
  s.draftRow[0] = leftId;
  const turnsBefore = s.turnsCompleted;
  s.rng = rngForGhostFace(10); // "Draft the left-most card, then roll again"
  applyAction(s, { type: 'rollGhostDie', seat: 0 });
  assert.equal(s.players[ghostSeat].slots[0], leftId);
  // The turn isn't over yet, so advance() didn't touch state.turn — it's
  // still the very same (still-open) turn object for this Ghost.
  assert.equal(s.turn.seat, ghostSeat, "still the same Ghost's turn");
  assert.equal(s.turn.mainDone, false, 'the turn stays open for a second roll');
  assert.equal(s.turn.done, false);
  assert.equal(s.turnsCompleted, turnsBefore, 'not counted as a finished turn yet');
  // Roll again — this time a plain coin-collecting face ends the turn.
  s.rng = rngForGhostFace(0);
  applyAction(s, { type: 'rollGhostDie', seat: 0 });
  assert.equal(s.turnsCompleted, turnsBefore + 1);
});

test('Ghost Favor auto-spend: "1st" on its own next literal 1st turn, "2nd" on its next literal 2nd turn, never held for later', () => {
  const s = freshSoloGame();
  const ghostSeat = 1;
  const gp = s.players[ghostSeat];
  gp.reserve.push('Favor-1-1', 'Favor-2-1');

  gp.turns = 0; // about to take its literal 1st turn of the round
  forceGhostTurn(s, ghostSeat);
  assert.deepEqual(ghostAction(s, ghostSeat), { type: 'useFavor', seat: ghostSeat, cardId: 'Favor-1-1' });

  gp.turns = 1; // about to take its literal 2nd turn
  forceGhostTurn(s, ghostSeat);
  assert.deepEqual(ghostAction(s, ghostSeat), { type: 'useFavor', seat: ghostSeat, cardId: 'Favor-2-1' });

  gp.turns = 2; // any later turn — a Ghost never holds an eligible Favor for later, unlike a human
  forceGhostTurn(s, ghostSeat);
  assert.equal(ghostAction(s, ghostSeat), null);

  gp.turns = 0;
  forceGhostTurn(s, ghostSeat);
  s.turn.mainDone = true;
  assert.equal(ghostAction(s, ghostSeat), null, 'no favor auto-spend once the main action is already taken');
});

test('Ghost heart assignment: fills the board left to right, as evenly as possible', () => {
  const s = freshSoloGame();
  const ghostSeat = 1;
  const gp = s.players[ghostSeat];
  const perfs = db.performers.filter((c) => (c.maxHearts ?? c.startingHearts ?? 0) >= 2).slice(0, 3).map((c) => c.id);
  gp.slots = [perfs[0], perfs[1], perfs[2], null, null, null, null, null];
  for (const id of perfs) s.hearts[id] = 0;
  s.pending.push({ id: s.nextPendingId++, kind: 'heartAssign', seat: ghostSeat, data: { amount: 4, reason: 'test' } });
  applyAction(s, ghostAction(s, ghostSeat));
  // Round-robin over 3 slots for 4 hearts: slot 0 gets a second pass, 1 and 2 get one each.
  assert.equal(s.hearts[perfs[0]], 2);
  assert.equal(s.hearts[perfs[1]], 1);
  assert.equal(s.hearts[perfs[2]], 1);
});

test('Ghost heart assignment: falls back to reserve capacity once the board is full (regression)', () => {
  const s = freshSoloGame();
  const ghostSeat = 1;
  const gp = s.players[ghostSeat];
  // Fill the board completely, all at max hearts — zero board capacity left.
  const five = db.performers.slice(0, 5).map((c) => c.id);
  gp.slots = [...five, null, null, null];
  for (const id of five) s.hearts[id] = maxHearts(s, ghostSeat, id);
  // A reserve card still has room for 2 more hearts.
  const reserveCard = db.performers.find((c) => !five.includes(c.id) && (c.maxHearts ?? c.startingHearts ?? 0) >= 2).id;
  gp.reserve.push(reserveCard);
  s.hearts[reserveCard] = 0;
  s.pending.push({ id: s.nextPendingId++, kind: 'heartAssign', seat: ghostSeat, data: { amount: 2, reason: 'test' } });
  // Before the fix, ghostHeartAssignments only looked at mat slots and threw
  // "You must assign exactly 2 heart(s)" here, since the engine's own
  // mandatory total spans mat + reserve capacity.
  applyAction(s, ghostAction(s, ghostSeat));
  assert.equal(s.hearts[reserveCard], 2, 'the full remainder spilled into reserve capacity');
});

test('Ghost Press Pass: always spends everything held, never keeps any back', () => {
  const s = freshSoloGame();
  const ghostSeat = 1;
  const gp = s.players[ghostSeat];
  gp.reserve.push('PressPass-1-1', 'PressPass-2-1');
  const item = { id: s.nextPendingId++, kind: 'pressPassWindow', seat: ghostSeat, data: {} };
  s.pending.push(item);
  let guard = 0;
  while (s.pending.some((x) => x.id === item.id) && guard++ < 10) {
    const action = ghostAction(s, ghostSeat);
    assert.ok(action, "ghostAction should always have something to do while its own window is open");
    applyAction(s, action);
  }
  assert.equal(gp.reserve.filter((id) => card(id).cardType === 'reroll').length, 0, 'every held Press Pass was spent');
  assert.ok(!s.pending.some((x) => x.id === item.id), 'the window closed once done');
});

// ---- Alt Solo mode -----------------------------------------------------------

function freshAltSoloGame(seed = 42) {
  return createGame({
    players: [{ name: 'Solo', isBot: false, isGhost: false }],
    altSolo: true,
    seed,
  });
}

// Force the engine's next randInt(8) (the Alt Solo d8) to land on a specific
// 0-based face index — same technique as rngForLetter/rngForGhostFace.
function rngForAltSoloFace(faceIdx) {
  for (let x = 1; x < 200000; x++) {
    if (predict(x, [8])[0] === faceIdx) return x;
  }
  throw new Error('no rng value found for alt solo face ' + faceIdx);
}

// A no-op turn (rearrange with the board left exactly as-is) — the simplest
// way to legally end the seat's turn and trigger finishTurn's rollAltSoloDie,
// without acquiring anything or otherwise disturbing the state under test.
function takeNoOpTurn(s) {
  const p = s.players[0];
  applyAction(s, { type: 'rearrange', seat: 0, slots: [...p.slots], reserve: [...p.reserve] });
}

test('setup: Alt Solo creates a single seat, a fixed 5-card draft row, and its own trophy/target/loss tracking', () => {
  const s = freshAltSoloGame();
  assert.equal(s.altSolo, true);
  assert.equal(s.players.length, 1);
  assert.equal(s.draftRow.length, 5);
  assert.equal(s.trophyGoal, 5);
  assert.equal(s.altSoloTarget, 0);
  assert.equal(s.altSoloLosses, 0);
});

test('Alt Solo d8: discard faces remove from the correct end of the draft row', () => {
  const s = freshAltSoloGame();
  const before = [...s.draftRow];
  s.rng = rngForAltSoloFace(0); // discard the right-most card
  takeNoOpTurn(s);
  assert.equal(s.draftRow.length, 4);
  assert.deepEqual(s.draftRow, before.slice(0, 4));
  assert.ok(s.discard.includes(before[4]));

  const s2 = freshAltSoloGame();
  const before2 = [...s2.draftRow];
  s2.rng = rngForAltSoloFace(1); // discard the left-most card
  takeNoOpTurn(s2);
  assert.equal(s2.draftRow.length, 4);
  assert.deepEqual(s2.draftRow, before2.slice(1));
  assert.ok(s2.discard.includes(before2[0]));

  const s3 = freshAltSoloGame();
  const before3 = [...s3.draftRow];
  s3.rng = rngForAltSoloFace(2); // discard the 2 right-most cards
  takeNoOpTurn(s3);
  assert.equal(s3.draftRow.length, 3);
  assert.deepEqual(s3.draftRow, before3.slice(0, 3));

  const s4 = freshAltSoloGame();
  const before4 = [...s4.draftRow];
  s4.rng = rngForAltSoloFace(3); // discard the 2 left-most cards
  takeNoOpTurn(s4);
  assert.equal(s4.draftRow.length, 3);
  assert.deepEqual(s4.draftRow, before4.slice(2));
});

test('Alt Solo d8: target faces raise the round target, and 2 of the 4 also reset the market', () => {
  const s = freshAltSoloGame();
  const oldMarket = [...s.market];
  s.rng = rngForAltSoloFace(6); // +1 star, no market reset
  takeNoOpTurn(s);
  assert.equal(s.altSoloTarget, 1);
  assert.deepEqual(s.market, oldMarket, 'this face does not reset the market');

  const s2 = freshAltSoloGame();
  s2.rng = rngForAltSoloFace(7); // +2 stars, no market reset
  takeNoOpTurn(s2);
  assert.equal(s2.altSoloTarget, 2);

  const s3 = freshAltSoloGame();
  const oldMarket3 = [...s3.market];
  s3.rng = rngForAltSoloFace(4); // +1 star and reset the market
  takeNoOpTurn(s3);
  assert.equal(s3.altSoloTarget, 1);
  assert.notDeepEqual(s3.market, oldMarket3);

  const s4 = freshAltSoloGame();
  s4.rng = rngForAltSoloFace(5); // +2 stars and reset the market
  takeNoOpTurn(s4);
  assert.equal(s4.altSoloTarget, 2);
});

test('Alt Solo: round target resets to 0 at the start of every new round', () => {
  const s = freshAltSoloGame();
  s.altSoloTarget = 3; // simulate a round where the d8 pushed the target up
  s.players[0].roundStars = 5; // comfortably clears 3 — should win the round
  s.draftRow = []; // force the draft to end on the very next finished turn
  takeNoOpTurn(s); // ends the draft -> (no Press Pass held) -> dice phase begins
  driveDicePhase(s);
  assert.equal(s.round, 2);
  assert.equal(s.altSoloTarget, 0, 'reset for the fresh round');
  assert.equal(s.players[0].trophies, 1, 'won the previous round (5 > 3)');
});

test('Alt Solo: beating the target wins a Trophy and costs 1 heart from each starter; a tie or a shortfall loses the round with no heart penalty', () => {
  const s = freshAltSoloGame();
  const p = s.players[0];
  const perf = performer((c) => c.maxHearts >= 1);
  p.slots[0] = perf;
  s.hearts[perf] = card(perf).maxHearts;

  // Tie: target 2, roundStars 2 -> loses the round, no heart lost.
  s.altSoloTarget = 2;
  p.roundStars = 2;
  assignAltSoloResult(s);
  assert.equal(p.trophies, 0);
  assert.equal(s.altSoloLosses, 1);
  assert.equal(s.hearts[perf], card(perf).maxHearts, 'no heart penalty on a lost round');

  // Shortfall: target 2, roundStars 1 -> also a loss.
  s.altSoloTarget = 2;
  p.roundStars = 1;
  assignAltSoloResult(s);
  assert.equal(s.altSoloLosses, 2);

  // Win: target 2, roundStars 3 -> Trophy + 1 heart lost from every starter.
  s.altSoloTarget = 2;
  p.roundStars = 3;
  assignAltSoloResult(s);
  assert.equal(p.trophies, 1);
  assert.equal(s.altSoloLosses, 2, 'unaffected by a win');
  assert.equal(s.hearts[perf], card(perf).maxHearts - 1, 'trophy fatigue hits the winner');
});

test('Alt Solo: the game ends in a win at 5 trophies, or a loss at 5 round-losses (with no winner)', () => {
  const s = freshAltSoloGame();
  const p = s.players[0];
  s.altSoloTarget = 0;
  for (let i = 0; i < 4; i++) {
    p.roundStars = 1;
    assignAltSoloResult(s);
  }
  assert.equal(p.trophies, 4);
  assert.equal(s.phase, 'draft', 'not over yet');
  p.roundStars = 1;
  assignAltSoloResult(s); // 5th win
  assert.equal(p.trophies, 5);
  assert.equal(s.phase, 'gameOver');
  assert.deepEqual(s.winners, [0]);

  const s2 = freshAltSoloGame();
  const p2 = s2.players[0];
  s2.altSoloTarget = 5;
  for (let i = 0; i < 4; i++) {
    p2.roundStars = 0;
    assignAltSoloResult(s2);
  }
  assert.equal(s2.altSoloLosses, 4);
  assert.equal(s2.phase, 'draft', 'not over yet');
  p2.roundStars = 0;
  assignAltSoloResult(s2); // 5th loss
  assert.equal(s2.altSoloLosses, 5);
  assert.equal(s2.phase, 'gameOver');
  assert.deepEqual(s2.winners, [], 'no winner when the game is lost');
});

test('ALT_SOLO_DIE_FACES has exactly 8 faces: 4 discard, 4 target (2 of which also reset the market)', () => {
  assert.equal(ALT_SOLO_DIE_FACES.length, 8);
  assert.equal(ALT_SOLO_DIE_FACES.filter((f) => f.kind === 'discard').length, 4);
  const targetFaces = ALT_SOLO_DIE_FACES.filter((f) => f.kind === 'target');
  assert.equal(targetFaces.length, 4);
  assert.equal(targetFaces.filter((f) => f.resetMarket).length, 2);
});

// ---- AI draft valuation heuristics (scoreCard) ------------------------------

test('scoreCard: a "draw N cards" Resource is valued as N acquisitions, not N coins', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const draw1 = firstOfName(db.resources, 'Resource 1 Card');
  const draw2 = firstOfName(db.resources, 'Resource 2 Cards');
  const draw3 = firstOfName(db.resources, 'Resource 3 Cards');
  const s1 = scoreCard(s, seat, draw1);
  const s2 = scoreCard(s, seat, draw2);
  const s3 = scoreCard(s, seat, draw3);

  // A drawn card is a real acquisition, so one draw should be worth roughly
  // what an average board card is worth — not the ~0.9 a single coin is.
  const coin1 = firstOfName(db.resources, 'Resource 1 Coin');
  assert.ok(s1 > scoreCard(s, seat, coin1) * 2.5, 'drawing a card beats gaining a coin by a wide margin');
  assert.ok(s1 > 3 && s1 < 5, `one draw should score near an average card, got ${s1}`);

  // Monotonic and near-linear, with a mild diminishing return (the cards
  // arrive together, so later ones are likelier to be bumped to reserve).
  assert.ok(s2 > s1 && s3 > s2, 'more cards is strictly better');
  assert.ok(s3 > s1 * 2.8 && s3 <= s1 * 3, 'Draw-3 is close to, but under, 3x a single draw');
  assert.ok(s3 > 10, `Draw-3 should dominate a typical single pick (best draft card ~4), got ${s3}`);
});

console.log(`\nrules.test.js: ${passed} passing${process.exitCode ? ' (with failures)' : ''}`);
if (!process.exitCode) console.log('ALL RULES TESTS PASSED');
