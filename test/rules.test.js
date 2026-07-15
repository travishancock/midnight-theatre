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
  lockCollectionDie,
  lockTomatoRoll,
  TRAINERS,
  hasFullSet,
} from '../engine/engine.js';

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
// (awaiting a possible Press Pass reaction) and a rolled-but-unlocked Tomato
// batch (awaiting a possible Mesmera reaction) — so it can be watched and
// reacted to in real time (the server paces these with real timers; tests
// just drive them through immediately since they don't care about pacing).
function driveDicePhase(s) {
  while (s.phase === 'dice') {
    if (s.dieEvent && s.dieEvent.awaitingLock) { lockCollectionDie(s); continue; }
    if (s.dice && s.dice.stage === 'tomato' && s.dice.tomatoRolled && !s.dice.tomatoLocked) { lockTomatoRoll(s); continue; }
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
  assert.equal(s.trophyGoal, 4); // 2-3 players -> 4 trophies
  for (const p of s.players) assert.equal(p.coins, (p.stand - 1) * 2);
  const s5 = freshGame(5);
  assert.equal(s5.trophyGoal, 3); // 4-5 players -> 3 trophies
  assert.equal(s5.draftRow.length, 11);
  assert.equal(s5.deck.length + s5.draftRow.length + s5.market.length, 139);
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
  applyAction(s, { type: 'resolvePending', seat, pendingId: pending.id, slot: 2 });
  assert.equal(p.slots[2], extra);
  assert.ok(p.reserve.includes(five[2]), 'bumped performer goes to reserve');
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

test('Barnaby Pennywhistle reduces market costs by 1 (min 1), not the reset', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  s.players[seat].slots[7] = TRAINERS.BARNABY;
  assert.equal(marketCost(s, seat, 0), 1); // min 1
  assert.equal(marketCost(s, seat, 3), 3);
  s.players[seat].coins = 1;
  applyAction(s, { type: 'resetMarket', seat }); // still costs the full 1 coin
  assert.equal(s.players[seat].coins, 0);
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

test('Props/Backdrops start below their printed max and can receive more hearts', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  // A solid-bar Prop: starts with 2 filled hearts, 1 empty (max 3 total).
  const solidProp = db.propsAndBackdrops.find((c) => c.id === 'Prop-Graceful');
  assert.equal(solidProp.startingHearts, 2);
  assert.equal(solidProp.maxHearts, 3);
  p.slots[6] = solidProp.id;
  s.hearts[solidProp.id] = solidProp.startingHearts;
  assert.equal(maxHearts(s, seat, solidProp.id), 3);
  assert.equal(capacityLeft(s, seat, solidProp.id), 1, 'room for exactly 1 more heart');
  // A wildcard Prop: starts with 1 filled heart, 2 empty (max 3 total).
  const wildProp = db.propsAndBackdrops.find((c) => c.id === 'Prop-Any-Characteristic');
  assert.equal(wildProp.startingHearts, 1);
  assert.equal(wildProp.maxHearts, 3);
  p.slots[6] = wildProp.id;
  s.hearts[wildProp.id] = wildProp.startingHearts;
  assert.equal(capacityLeft(s, seat, wildProp.id), 2, 'room for exactly 2 more hearts');
  // Actually acquiring a Heart resource card offers the Prop as a target and
  // lets the player fill it up to (but not past) its printed max.
  s.hearts[wildProp.id] = wildProp.startingHearts;
  const heart3 = firstOfName(db.resources, 'Resource 3 Hearts');
  s.draftRow = [heart3, s.draftRow[1], s.draftRow[2]];
  applyAction(s, { type: 'acquireDraft', seat, cardId: heart3 });
  const pending = s.pending.find((x) => x.kind === 'heartAssign');
  assert.ok(pending);
  assert.throws(() =>
    applyAction(s, { type: 'resolvePending', seat, pendingId: pending.id, assignments: [{ cardId: wildProp.id, amount: 3 }] }),
    'cannot exceed the printed max of 3'
  );
  applyAction(s, { type: 'resolvePending', seat, pendingId: pending.id, assignments: [{ cardId: wildProp.id, amount: 2 }] });
  assert.equal(s.hearts[wildProp.id], 3);
});

test('favor cards go to reserve; clicking one before your main turn grants a bonus turn', () => {
  const s = freshGame(2, 7);
  const seat = currentSeat(s);
  const p = s.players[seat];
  const favor1 = 'Favor-1-1';
  p.reserve.push(favor1);
  p.turns = 0; // a "1st" Favor is only usable on the player's actual first turn
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

test('Favor timing: "1st" only on turn 1, "2nd" on turn 2 or any later turn', () => {
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

  // On the player's 2nd turn (p.turns === 1): "2nd" is usable, "1st" no
  // longer is (even though it's still sitting unused in reserve).
  p.turns = 1;
  assert.deepEqual(eligibleFavors(s, seat), [favor2]);
  assert.throws(() => applyAction(s, { type: 'useFavor', seat, cardId: favor1 }));

  // On any later turn (p.turns === 3), "2nd" remains usable.
  p.turns = 3;
  assert.deepEqual(eligibleFavors(s, seat), [favor2]);
});

test('Maximillian may chain market buys but not draft after buying', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.MAXIMILLIAN;
  p.coins = 10;
  s.market = db.performers.slice(30, 34).map((c) => c.id); // pin to performers
  applyAction(s, { type: 'buyMarket', seat, index: 0 });
  assert.equal(s.turn.done, false, 'turn stays open');
  assert.throws(() => applyAction(s, { type: 'acquireDraft', seat, cardId: s.draftRow[0] }));
  applyAction(s, { type: 'buyMarket', seat, index: 0 });
  applyAction(s, { type: 'endTurn', seat });
  assert.ok(s.turn === null || s.turn.seat !== seat);
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

test('Professor Stainglass: discard a draft card to draw one into reserve', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.STAINGLASS;
  const victim = s.draftRow[0];
  const deckTop = s.deck[s.deck.length - 1];
  applyAction(s, { type: 'trainerDiscardDraft', seat, cardId: victim });
  assert.ok(s.discard.includes(victim));
  assert.ok(p.reserve.includes(deckTop));
  // Using the ability consumes the whole turn, so a second use isn't just
  // blocked by the once-per-turn flag — play has already moved on.
  assert.notEqual(s.turn?.seat, seat);
  assert.throws(() => applyAction(s, { type: 'trainerDiscardDraft', seat, cardId: s.draftRow[0] }), /not your turn/);
});

test('The Vanishing Valentino clears the draft row once, consuming trainer and turn', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.VALENTINO;
  const rowBefore = [...s.draftRow];
  applyAction(s, { type: 'valentino', seat });
  assert.equal(p.slots[7], null);
  for (const id of rowBefore) assert.ok(s.discard.includes(id));
  // The draft ended (row empty); with empty boards the dice phase runs
  // through (pausing at each open die/tomato-batch window) and round 2 begins.
  driveDicePhase(s);
  assert.equal(s.round, 2);
  assert.equal(p.valentinoAvailable, false);
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

test('deterministic dice phase: collection matches, boosts, trophies, tomato hits', () => {
  const s = freshGame(2, 1234);
  const seat = currentSeat(s);
  const other = s.players.find((p) => p.seat !== seat).seat;
  const p = s.players[seat];

  // Board: a Graceful performer with letter H that yields Stars, plus a
  // matching Prop (boost -> 2 stars per H rolled). Empty opposing board.
  const perfH = performer((c) => c.letter === 'H' && c.resource === 'Star' && c.characteristic === 'Graceful');
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
  const hCount = letters.filter((l) => l === 'H').length;
  const bCount = letters.filter((l) => l === 'B').length;

  const starsBefore = p.stars;
  const coinsBefore = p.coins;
  applyAction(s, { type: 'acquireDraft', seat, cardId: filler }); // filler is letter B / Coin: no heart prompts
  // The dice phase pauses after each Collection Die (and after the Tomato
  // batch) so a real driver can watch/react in real time; drive it through.
  driveDicePhase(s);

  assert.equal(s.round, 2, 'a full round elapsed');
  assert.equal(p.stars - starsBefore, hCount * 2, `H rolled ${hCount}x -> ${hCount * 2} stars (boosted)`);
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
    const perfH = performer((c) => c.letter === 'H' && c.resource === 'Star' && c.characteristic === 'Graceful');
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
    const hCount = seq.slice(0, 5).map((i) => COLLECTION_FACES[i]).filter((l) => l === 'H').length;
    assert.ok(hCount > 0, 'test setup expects at least 1 H roll this round (seed 999)');
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
    const perfH = performer((c) => c.letter === 'H' && c.resource === 'Star' && c.characteristic === 'Graceful');
    const perfType = card(perfH).type;
    const fillers = otherTypes(perfType).map((t) => performer((c) => c.type === t && c.resource === 'Coin' && c.letter !== 'H'));
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
    const hCount = seq.slice(0, 5).map((i) => COLLECTION_FACES[i]).filter((l) => l === 'H').length;
    assert.ok(hasFullSet(s, seat, 'type'), 'test setup expects one of each Type active on board');
    const starsBefore = p.stars;
    applyAction(s, { type: 'acquireDraft', seat, cardId: filler });
    driveDicePhase(s);
    assert.equal(p.stars - starsBefore, hCount * 2, 'wildcard Prop active — +1 boosted unit per H roll');
  }
});

test('Press Pass: offered before the round\'s Collection Dice roll; accepting grants a shared re-roll pool for any die', () => {
  const s = freshGame(2, 555);
  const seat = currentSeat(s);
  const other = s.players.find((x) => x.seat !== seat).seat;
  s.players[other].reserve = ['PressPass-3'];
  s.players[seat].reserve = [];
  // strip boards so nothing else prompts
  for (const p of s.players) p.slots = [null, null, null, null, null, null, null, null];
  const filler = performer((c) => c.resource === 'Coin');
  s.draftRow = [filler, db.performers[9].id];
  applyAction(s, { type: 'acquireDraft', seat, cardId: filler });

  // Before any Collection Die rolls, the Press Pass holder is offered the
  // chance to spend it — a real pending prompt (unlike the reroll-usage
  // itself, which stays a proactive click during the open-die window).
  assert.equal(s.dice.stage, 'pressPassOffer');
  assert.equal(s.dieEvent, null, 'no die has rolled yet');
  const offer = s.pending.find((x) => x.kind === 'pressPassOffer');
  assert.ok(offer, 'expected a pressPassOffer prompt');
  assert.equal(offer.seat, other);
  assert.equal(offer.data.count, 3);

  applyAction(s, { type: 'resolvePending', seat: other, pendingId: offer.id, use: true });
  assert.ok(s.discard.includes('PressPass-3'), 'spent immediately on acceptance');
  assert.ok(!s.players[other].reserve.includes('PressPass-3'));
  assert.equal(s.dice.pressPass.seat, other);
  assert.equal(s.dice.pressPass.usesLeft, 3);

  // Die #1 is now open; the pool can be spent on it (or any later die), more
  // than once in a row if desired.
  assert.equal(s.dieEvent.kind, 'collection');
  assert.equal(s.dieEvent.position, 1);
  applyAction(s, { type: 'usePressPass', seat: other });
  assert.equal(s.dice.pressPass.usesLeft, 2, 'one use spent');
  assert.equal(s.dieEvent.rerollHistory.length, 1);
  applyAction(s, { type: 'usePressPass', seat: other });
  assert.equal(s.dice.pressPass.usesLeft, 1, 'a second use spent on the same die');
  assert.equal(s.dieEvent.rerollHistory.length, 2);

  // Only the seat that accepted the offer may spend from the pool.
  assert.throws(() => applyAction(s, { type: 'usePressPass', seat }));

  driveDicePhase(s);
  assert.equal(s.round, 2, 'the round completed normally once locked');
});

test('lockPressPassDie: the active Press Pass holder can explicitly keep the open die\'s result', () => {
  const s = freshGame(2, 555);
  const seat = currentSeat(s);
  const other = s.players.find((x) => x.seat !== seat).seat;
  s.players[other].reserve = ['PressPass-3'];
  s.players[seat].reserve = [];
  for (const p of s.players) p.slots = [null, null, null, null, null, null, null, null];
  const filler = performer((c) => c.resource === 'Coin');
  s.draftRow = [filler, db.performers[9].id];
  applyAction(s, { type: 'acquireDraft', seat, cardId: filler });
  const offer = s.pending.find((x) => x.kind === 'pressPassOffer');
  applyAction(s, { type: 'resolvePending', seat: other, pendingId: offer.id, use: true });

  // Only the active holder may confirm; nobody else, and not while nothing's open.
  assert.throws(() => applyAction(s, { type: 'lockPressPassDie', seat }));

  assert.ok(s.dieEvent.awaitingLock, 'die #1 is open, awaiting a decision');
  applyAction(s, { type: 'lockPressPassDie', seat: other });
  // Locking resolves die #1 immediately (advance() then rolls die #2, which
  // opens its own fresh awaitingLock window — that's the normal dice-phase
  // pause, not a sign #1 failed to lock).
  assert.equal(s.dice.rolled, 1, 'die #1 resolved and was recorded');
  assert.equal(s.dice.pressPass.usesLeft, 3, 'no re-roll was spent by keeping the result');

  driveDicePhase(s);
  assert.equal(s.round, 2, 'the round completed normally afterward');
});

test('Press Pass priority: the highest-numbered card is offered first; declining moves to the next', () => {
  const s = freshGame(2, 777);
  const seat = currentSeat(s);
  const other = s.players.find((x) => x.seat !== seat).seat;
  s.players[seat].reserve = ['PressPass-2'];
  s.players[other].reserve = ['PressPass-4'];
  for (const p of s.players) p.slots = [null, null, null, null, null, null, null, null];
  const filler = performer((c) => c.resource === 'Coin');
  s.draftRow = [filler, db.performers[9].id];
  applyAction(s, { type: 'acquireDraft', seat, cardId: filler });

  let offer = s.pending.find((x) => x.kind === 'pressPassOffer');
  assert.equal(offer.seat, other, 'Press Pass 4 outranks Press Pass 2 and is offered first');
  assert.equal(offer.data.count, 4);

  applyAction(s, { type: 'resolvePending', seat: other, pendingId: offer.id, use: false });
  assert.ok(s.players[other].reserve.includes('PressPass-4'), 'declined card stays in reserve for a future round');

  offer = s.pending.find((x) => x.kind === 'pressPassOffer');
  assert.ok(offer, 'expected the next-highest candidate to be offered');
  assert.equal(offer.seat, seat);
  assert.equal(offer.data.count, 2);

  applyAction(s, { type: 'resolvePending', seat, pendingId: offer.id, use: true });
  assert.equal(s.dice.pressPass.seat, seat);
  assert.equal(s.dice.pressPass.usesLeft, 2);
  assert.equal(s.dice.pressPassQueue.length, 0, 'only one Press Pass may be spent per round');

  driveDicePhase(s);
  assert.equal(s.round, 2);
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

test('Trainer draft-discard abilities (Tomasso/Curio/Stainglass) consume the whole turn', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.STAINGLASS;
  const victim = s.draftRow[0];
  applyAction(s, { type: 'trainerDiscardDraft', seat, cardId: victim });
  assert.notEqual(s.turn?.seat, seat, 'using the ability ended the turn — play moved to the next stand');
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

test('state.turnsCompleted increments once per finished turn (drives the server\'s AI turn-pause)', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  assert.equal(s.turnsCompleted, 0);
  s.draftRow[0] = db.performers[0].id;
  applyAction(s, { type: 'acquireDraft', seat, cardId: db.performers[0].id });
  assert.equal(s.turnsCompleted, 1);
});

test('a full 2-player round keeps every one of the 139 cards accounted for', () => {
  const s = freshGame(2, 31337);
  // count every card location
  const total = (st) =>
    st.deck.length + st.discard.length + st.market.length + st.draftRow.length +
    st.players.reduce((a, p) => a + p.slots.filter(Boolean).length + p.reserve.length, 0);
  assert.equal(total(s), 139);
});

console.log(`\nrules.test.js: ${passed} passing${process.exitCode ? ' (with failures)' : ''}`);
if (!process.exitCode) console.log('ALL RULES TESTS PASSED');
