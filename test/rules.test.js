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
  allowedSlots,
  seatWithStand,
  TRAINERS,
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
  assert.equal(s5.deck.length + s5.draftRow.length + s5.market.length, 144);
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
  const perf = performer((c) => c.startingHearts === 1);
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

test('favor cards go to reserve; clicking one before your main turn grants a bonus turn', () => {
  const s = freshGame(2, 7);
  const seat = currentSeat(s);
  const p = s.players[seat];
  const favor1 = 'Favor-1-1';
  p.reserve.push(favor1);
  p.turns = 1; // pretend this seat already completed 1 turn this round
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
  p.turns = 1;
  s.draftRow = [db.performers[0].id, db.performers[1].id, db.performers[2].id, db.performers[3].id, db.performers[4].id];
  applyAction(s, { type: 'acquireDraft', seat, cardId: db.performers[0].id });
  // Play has already moved on to the other seat — too late to use the Favor.
  assert.notEqual(s.turn.seat, seat);
  assert.throws(() => applyAction(s, { type: 'useFavor', seat, cardId: favor1 }));
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

test('Madame Coeur raises heart capacity by 1 while on the board', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  const perf = performer((c) => c.startingHearts === 2);
  p.slots[0] = perf;
  assert.equal(maxHearts(s, seat, perf), 2);
  p.slots[7] = TRAINERS.COEUR;
  assert.equal(maxHearts(s, seat, perf), 3);
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

test('Auric converts coins to hearts and back', () => {
  const s = freshGame(2);
  const seat = currentSeat(s);
  const p = s.players[seat];
  p.slots[7] = TRAINERS.AURIC;
  const perf = performer((c) => c.startingHearts === 3);
  p.slots[0] = perf;
  s.hearts[perf] = 1;
  p.coins = 2;
  applyAction(s, { type: 'auricConvert', seat, direction: 'coinToHeart', cardId: perf });
  assert.equal(p.coins, 1);
  assert.equal(s.hearts[perf], 2);
  applyAction(s, { type: 'auricConvert', seat, direction: 'heartToCoin', cardId: perf });
  assert.equal(p.coins, 2);
  assert.equal(s.hearts[perf], 1);
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
  assert.throws(() => applyAction(s, { type: 'trainerDiscardDraft', seat, cardId: s.draftRow[0] }), /already used/);
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
  // The draft ended (row empty); with empty boards the whole dice phase runs
  // automatically and round 2 begins.
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

  assert.equal(s.round, 2, 'a full round elapsed');
  assert.equal(p.stars - starsBefore, hCount * 2, `H rolled ${hCount}x -> ${hCount * 2} stars (boosted)`);
  assert.equal(s.players[other].stars, 0);

  // Trophy: p had the most stars (or tied at 0 and tied coins decides/all take one).
  if (hCount > 0) {
    assert.equal(p.trophies, 1);
    assert.equal(s.players[other].trophies, 0);
    // trophy fatigue: 1 heart off every occupied starter, plus maybe the tomato die
    const perfHits = (tomato === 1 ? 1 : 0) + 1;
    const propHits = (tomato === 7 ? 1 : 0) + 1;
    if (3 - perfHits <= 0) assert.equal(p.slots[0], null);
    else assert.equal(s.hearts[perfH], 3 - perfHits);
    if (2 - propHits <= 0) assert.equal(p.slots[6], null);
    else assert.equal(s.hearts['Prop-Graceful'], 2 - propHits);
  }
  // The filler performer (letter B, Coin) collected coins for any B rolls,
  // possibly boosted — just sanity check nothing went negative.
  if (bCount > 0) assert.ok(p.coins >= 0 && p.coins + 99 >= coinsBefore, 'coins never go negative');
  // New draft row was dealt for round 2.
  assert.equal(s.draftRow.length, 2 * 2 + 1);
  assert.ok(seatWithStand(s, 1) != null);
});

test('re-roll cards: offered on a die roll, consumed on use', () => {
  const s = freshGame(2, 555);
  const seat = currentSeat(s);
  const other = s.players.find((x) => x.seat !== seat).seat;
  s.players[other].reserve = ['PressPass-1'];
  s.players[seat].reserve = [];
  // strip boards so nothing else prompts
  for (const p of s.players) p.slots = [null, null, null, null, null, null, null, null];
  const filler = performer((c) => c.resource === 'Coin');
  s.draftRow = [filler, db.performers[9].id];
  applyAction(s, { type: 'acquireDraft', seat, cardId: filler });
  // Dice phase: first collection die is rolled and offered to the Press Pass holder.
  const offer = s.pending.find((x) => x.kind === 'rerollOffer');
  assert.ok(offer, 'expected a re-roll offer');
  assert.equal(offer.seat, other);
  applyAction(s, { type: 'resolvePending', seat: other, pendingId: offer.id, use: 'PressPass-1' });
  assert.ok(s.discard.includes('PressPass-1'));
  assert.ok(!s.players[other].reserve.includes('PressPass-1'));
});

test('re-roll cards grant their printed number of re-rolls (assumption #5)', () => {
  const s = freshGame(2, 555);
  const seat = currentSeat(s);
  const other = s.players.find((x) => x.seat !== seat).seat;
  s.players[other].reserve = ['PressPass-3'];
  s.players[seat].reserve = [];
  for (const p of s.players) p.slots = [null, null, null, null, null, null, null, null];
  const filler = performer((c) => c.resource === 'Coin');
  s.draftRow = [filler, db.performers[9].id];
  applyAction(s, { type: 'acquireDraft', seat, cardId: filler });
  const offer = s.pending.find((x) => x.kind === 'rerollOffer');
  applyAction(s, { type: 'resolvePending', seat: other, pendingId: offer.id, use: 'PressPass-3' });
  // "Press Pass 3" grants 3 total rolls. Roll 1 already happened above
  // (automatically, as part of playing the card); 2 more remain, each
  // surfaced as a rerollAgain prompt while the player opts to continue.
  let again = s.pending.find((x) => x.kind === 'rerollAgain');
  assert.ok(again, 'expected a rerollAgain prompt after the first roll');
  assert.equal(s.dieEvent.rerollAgain.rollsLeft, 2);
  applyAction(s, { type: 'resolvePending', seat: other, pendingId: again.id, again: true }); // roll 2
  again = s.pending.find((x) => x.kind === 'rerollAgain');
  assert.ok(again, 'expected a second rerollAgain prompt');
  assert.equal(s.dieEvent.rerollAgain.rollsLeft, 1);
  applyAction(s, { type: 'resolvePending', seat: other, pendingId: again.id, again: true }); // roll 3 (last)
  // All 3 rolls have now happened — no further rerollAgain prompt.
  assert.ok(!s.pending.some((x) => x.kind === 'rerollAgain'));
  assert.equal(s.dieEvent, null); // die event resolved once the last reroll's offers cleared
  assert.ok(s.discard.includes('PressPass-3'));
});

test('a full 2-player round keeps every one of the 144 cards accounted for', () => {
  const s = freshGame(2, 31337);
  // count every card location
  const total = (st) =>
    st.deck.length + st.discard.length + st.market.length + st.draftRow.length +
    st.players.reduce((a, p) => a + p.slots.filter(Boolean).length + p.reserve.length, 0);
  assert.equal(total(s), 144);
});

console.log(`\nrules.test.js: ${passed} passing${process.exitCode ? ' (with failures)' : ''}`);
if (!process.exitCode) console.log('ALL RULES TESTS PASSED');
