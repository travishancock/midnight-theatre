// ---------------------------------------------------------------------------
// The Midnight Theatre — pure rules engine.
//
// No I/O, no timers, no network. The whole game is a state object plus
// applyAction(state, action) which either mutates the state to the next legal
// state (and returns it) or throws on an illegal move. Randomness is a seeded
// PRNG stored inside the state, so games are deterministic and replayable.
//
// Decision points that need player input are represented as "pending" items
// (state.pending). The internal advance() loop runs every automatic step of
// the game until it needs input from someone.
// ---------------------------------------------------------------------------

import { card, allCardIds, SLOTTABLE } from './cards.js';
import { makeSeed, randInt, shuffle } from './rng.js';

// D20 Collection die faces: A,B x1 — C,D x2 — E,F x3 — G,H x4.
export const COLLECTION_FACES = [
  'A', 'B', 'C', 'C', 'D', 'D', 'E', 'E', 'E', 'F',
  'F', 'F', 'G', 'G', 'G', 'G', 'H', 'H', 'H', 'H',
];
export const LETTER_FREQ = { A: 1, B: 1, C: 2, D: 2, E: 3, F: 3, G: 4, H: 4 };

// Mat slots: indices 0-4 Performers, 5 Backdrop, 6 Prop, 7 Trainer.
export const SLOT_NAMES = [
  'Performer 1', 'Performer 2', 'Performer 3', 'Performer 4', 'Performer 5',
  'Backdrop', 'Prop', 'Trainer',
];
export const SLOTS_FOR_TYPE = {
  performer: [0, 1, 2, 3, 4],
  backdrop: [5],
  prop: [6],
  trainer: [7],
};

export const TRAINERS = {
  COEUR: 'Madame-Coeur',
  TOMASSO: 'Tomasso-the-Terrible',
  CURIO: 'Madame-Curio',
  STAINGLASS: 'Professor-Stainglass',
  AURIC: 'Auric-the-Alchemist',
  BARNABY: 'Barnaby-Pennywhistle',
  BARRE: 'Madame-Barre',
  MAXIMILLIAN: 'Maximillian-the-Magnate',
  MESMERA: 'Mesmera-the-Veiled',
  VALENTINO: 'The-Vanishing-Valentino',
};

const MAX_TOMATO_DICE = 9; // the physical game has 9 tomato dice

// ---------------------------------------------------------------------------
// Game creation
// ---------------------------------------------------------------------------

export function createGame({ players, seed }) {
  if (!players || players.length < 2 || players.length > 5) {
    throw new Error('The Midnight Theatre supports 2-5 players.');
  }
  const state = {
    version: 0,
    rng: (seed ?? makeSeed()) >>> 0,
    phase: 'draft', // 'draft' | 'dice' | 'gameOver'
    round: 1,
    trophyGoal: players.length >= 4 ? 3 : 4,
    deck: [],
    discard: [],
    market: [],
    draftRow: [],
    hearts: {}, // cardId -> current hearts on that card
    players: players.map((p, i) => ({
      seat: i,
      name: p.name || `Player ${i + 1}`,
      isBot: !!p.isBot,
      coins: 0,
      stars: 0,
      trophies: 0,
      roundStars: 0,
      roundCoins: 0,
      turns: 0, // turns completed this round
      stand: 0, // draft-order stand 1..n
      slots: [null, null, null, null, null, null, null, null],
      reserve: [],
      valentinoAvailable: true,
    })),
    turn: null, // { seat, mainDone, done, open, buys, trainerDiscardUsed, isBonus, bonusTiming }
    dice: null, // dice-phase progress
    dieEvent: null, // an in-flight die roll open to re-roll reactions
    pending: [], // decision prompts awaiting player input
    nextPendingId: 1,
    winners: null,
    log: [],
  };

  state.deck = shuffle(state, allCardIds().slice());

  // Randomly pick the first player; stands go clockwise from them.
  // Stand 1 starts with 0 coins, each later stand starts with 2 more.
  const first = randInt(state, players.length);
  for (let i = 0; i < players.length; i++) {
    const p = state.players[(first + i) % players.length];
    p.stand = i + 1;
    p.coins = i * 2;
  }

  state.market = draw(state, 4);
  state.draftRow = draw(state, players.length * 2 + 1);
  state.turn = newTurn(seatWithStand(state, 1));
  log(state, `Curtain up! ${state.players.length} players, first trophy-holder to ${state.trophyGoal} trophies wins.`);
  log(state, `${nameOf(state, state.turn.seat)} holds Draft Stand 1 and goes first.`);
  return state;
}

function newTurn(seat, isBonus = false, bonusTiming = null) {
  return { seat, mainDone: false, done: false, open: false, buys: 0, trainerDiscardUsed: false, isBonus, bonusTiming };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log(state, msg) {
  state.log.push(msg);
  if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
}

function nameOf(state, seat) {
  return state.players[seat].name;
}

export function seatWithStand(state, stand) {
  return state.players.find((p) => p.stand === stand).seat;
}

export function seatOrderByStand(state) {
  return [...state.players].sort((a, b) => a.stand - b.stand).map((p) => p.seat);
}

// Draw n cards from the deck, reshuffling the discard pile in when needed.
function draw(state, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (state.deck.length === 0 && state.discard.length > 0) {
      state.deck = shuffle(state, state.discard);
      state.discard = [];
      log(state, 'The discard pile is reshuffled into a fresh deck.');
    }
    if (state.deck.length === 0) break;
    out.push(state.deck.pop());
  }
  return out;
}

export function trainerActive(state, seat, trainerId) {
  const id = state.players[seat].slots[7];
  return id != null && id === trainerId;
}

function isOnBoard(state, seat, cardId) {
  return state.players[seat].slots.includes(cardId);
}

// Max hearts a card can hold: its printed startingHearts, +1 if it is on the
// board of a player whose active Trainer is Madame Coeur.
export function maxHearts(state, seat, cardId) {
  const c = card(cardId);
  if (!SLOTTABLE.has(c.cardType)) return 0;
  let cap = c.startingHearts ?? 0;
  if (isOnBoard(state, seat, cardId) && trainerActive(state, seat, TRAINERS.COEUR)) cap += 1;
  return cap;
}

export function capacityLeft(state, seat, cardId) {
  return Math.max(0, maxHearts(state, seat, cardId) - (state.hearts[cardId] || 0));
}

// All of a player's cards (mat + reserve) that could still take hearts.
export function heartTargets(state, seat) {
  const p = state.players[seat];
  const ids = [...p.slots.filter(Boolean), ...p.reserve];
  return ids.filter((id) => capacityLeft(state, seat, id) > 0);
}

export function totalCapacityLeft(state, seat) {
  return heartTargets(state, seat).reduce((s, id) => s + capacityLeft(state, seat, id), 0);
}

export function marketCost(state, seat, index) {
  let cost = index + 1;
  if (trainerActive(state, seat, TRAINERS.BARNABY)) cost = Math.max(1, cost - 1);
  return cost;
}

// Which mat slots a card may legally be placed into by this player.
export function allowedSlots(state, seat, cardId) {
  const c = card(cardId);
  if (!SLOTTABLE.has(c.cardType)) return [];
  if (trainerActive(state, seat, TRAINERS.BARRE)) return [0, 1, 2, 3, 4, 5, 6, 7];
  return SLOTS_FOR_TYPE[c.cardType];
}

export function eligibleFavors(state, seat) {
  const p = state.players[seat];
  return p.reserve.filter((id) => {
    const c = card(id);
    if (c.cardType !== 'favor') return false;
    return c.triggerAfterTurn === 1 ? p.turns === 1 : p.turns >= 2;
  });
}

function pushPending(state, kind, seat, data = {}) {
  const item = { id: state.nextPendingId++, kind, seat, data };
  state.pending.push(item);
  return item;
}

function removePending(state, id) {
  state.pending = state.pending.filter((p) => p.id !== id);
}

// ---------------------------------------------------------------------------
// Heart loss (tomato dice / trophy-winner removal)
// ---------------------------------------------------------------------------

// Remove 1 heart from the card in a given slot. A card that "hits 0 hearts
// this way" is discarded from the mat. A card that is *already* at 0 hearts
// (possible: 16 performers have printed hearts of 0) is likewise discarded
// when hit.
function heartHit(state, seat, slotIdx, why) {
  const p = state.players[seat];
  const id = p.slots[slotIdx];
  if (!id) return;
  const h = state.hearts[id] || 0;
  if (h <= 1) {
    state.hearts[id] = 0;
    p.slots[slotIdx] = null;
    state.discard.push(id);
    log(state, `${p.name}'s ${card(id).name} (${SLOT_NAMES[slotIdx]}) loses its last heart and leaves the stage! (${why})`);
  } else {
    state.hearts[id] = h - 1;
    log(state, `${p.name}'s ${card(id).name} loses a heart (${why}) — ${h - 1} left.`);
  }
}

// ---------------------------------------------------------------------------
// Die events (a rolled die that is open to re-roll card reactions)
// ---------------------------------------------------------------------------

function rollDie(state, kind) {
  return kind === 'collection'
    ? COLLECTION_FACES[randInt(state, 20)]
    : randInt(state, 8) + 1;
}

function rerollCardType(kind) {
  return kind === 'collection' ? 'collection' : 'tomato';
}

// Seats holding an applicable re-roll card for this die event.
function rerollEligibleSeats(state, ev) {
  const want = rerollCardType(ev.kind);
  return seatOrderByStand(state).filter((seat) => {
    if (ev.onlySeat != null && seat !== ev.onlySeat) return false; // Curio dice: owner only
    return state.players[seat].reserve.some(
      (id) => card(id).cardType === 'reroll' && card(id).rerollTarget === want
    );
  });
}

// Start a die event: roll, announce, then open re-roll reactions.
// source: 'phase' (normal dice-phase die), 'tomasso', 'curio'.
function startDieEvent(state, { kind, source, onlySeat = null, excludeSeat = null }) {
  const value = rollDie(state, kind);
  state.dieEvent = { kind, source, onlySeat, excludeSeat, value, passed: [], mesmera: null };
  const label = kind === 'collection' ? 'Collection Die' : 'Tomato Die';
  log(state, `${label} rolled: ${value}${source !== 'phase' ? ` (${source === 'tomasso' ? 'Tomasso the Terrible' : 'Madame Curio'})` : ''}`);
  queueRerollOffers(state);
}

// Offer the current die result to eligible re-roll-card holders, one at a
// time in stand order. When everyone passes, the die resolves.
function queueRerollOffers(state) {
  const ev = state.dieEvent;
  const remaining = rerollEligibleSeats(state, ev).filter((s) => !ev.passed.includes(s));
  if (remaining.length === 0) {
    resolveDieEvent(state);
    return;
  }
  pushPending(state, 'rerollOffer', remaining[0], { kind: ev.kind, value: ev.value });
}

function applyRerollUse(state, seat, cardId) {
  const ev = state.dieEvent;
  const p = state.players[seat];
  const idx = p.reserve.indexOf(cardId);
  if (idx === -1) throw new Error('That re-roll card is not in your reserve.');
  const c = card(cardId);
  if (c.cardType !== 'reroll' || c.rerollTarget !== rerollCardType(ev.kind)) {
    throw new Error('That card cannot re-roll this die.');
  }
  p.reserve.splice(idx, 1);
  state.discard.push(cardId);
  ev.value = rollDie(state, ev.kind);
  ev.passed = []; // a new result: everyone may react again
  log(state, `${p.name} plays ${c.name} — the die is re-rolled: ${ev.value}`);
  if (trainerActive(state, seat, TRAINERS.MESMERA)) {
    // Mesmera the Veiled: up to 3 total rolls per re-roll card, keep the last.
    ev.mesmera = { seat, rollsLeft: 2 };
    pushPending(state, 'mesmera', seat, { kind: ev.kind });
  } else {
    queueRerollOffers(state);
  }
}

// Apply the final die result to the game.
function resolveDieEvent(state) {
  const ev = state.dieEvent;
  state.dieEvent = null;
  if (ev.kind === 'collection') {
    resolveCollectionDie(state, ev.value, ev.onlySeat);
    if (ev.source === 'phase') {
      state.dice.results.push(ev.value);
      state.dice.rolled++;
    }
  } else {
    resolveTomatoDie(state, ev.value, ev.excludeSeat);
    if (ev.source === 'phase') {
      state.dice.tomatoResults.push(ev.value);
      state.dice.tRolled++;
    }
  }
}

// ---------------------------------------------------------------------------
// Collection / Tomato resolution
// ---------------------------------------------------------------------------

// +1 per equipped Backdrop/Prop whose boost list matches the performer
// (assumption #1 in the design brief).
function boostCount(state, seat, performer) {
  let n = 0;
  for (const slotIdx of [5, 6]) {
    const id = state.players[seat].slots[slotIdx];
    if (!id) continue;
    const b = card(id);
    if (!b.boosts) continue;
    const key = b.boostKind === 'characteristic' ? performer.characteristic : performer.type;
    if (b.boosts.includes(key)) n++;
  }
  return n;
}

function resolveCollectionDie(state, letter, onlySeat = null) {
  for (const p of state.players) {
    if (onlySeat != null && p.seat !== onlySeat) continue;
    let heartsEarned = 0;
    const gains = [];
    for (let i = 0; i < 5; i++) {
      const id = p.slots[i];
      if (!id) continue;
      const c = card(id);
      if (c.cardType !== 'performer' || c.letter !== letter) continue;
      const units = 1 + boostCount(state, p.seat, c);
      if (c.resource === 'Star') {
        p.stars += units;
        p.roundStars += units;
        gains.push(`${units} star${units > 1 ? 's' : ''}`);
      } else if (c.resource === 'Coin') {
        p.coins += units;
        p.roundCoins += units;
        gains.push(`${units} coin${units > 1 ? 's' : ''}`);
      } else {
        heartsEarned += units;
        gains.push(`${units} heart${units > 1 ? 's' : ''}`);
      }
    }
    if (gains.length) log(state, `${p.name} collects ${gains.join(', ')} for letter ${letter}.`);
    if (heartsEarned > 0) {
      if (totalCapacityLeft(state, p.seat) > 0) {
        pushPending(state, 'heartAssign', p.seat, { amount: heartsEarned, reason: `Collection Die ${letter}` });
      } else {
        log(state, `${p.name} has no room for ${heartsEarned} earned heart(s) — they are forfeited.`);
      }
    }
  }
}

function resolveTomatoDie(state, n, excludeSeat = null) {
  for (const p of state.players) {
    if (excludeSeat != null && p.seat === excludeSeat) continue;
    heartHit(state, p.seat, n - 1, `Tomato die ${n}`);
  }
}

// ---------------------------------------------------------------------------
// Acquisition & placement
// ---------------------------------------------------------------------------

function acquireCard(state, seat, cardId, chosenSlot) {
  const p = state.players[seat];
  const c = card(cardId);
  switch (c.cardType) {
    case 'resource': {
      state.discard.push(cardId);
      if (c.resourceType === 'Coin') {
        p.coins += c.amount;
        p.roundCoins += c.amount;
        log(state, `${p.name} resolves ${c.name}: +${c.amount} coins.`);
      } else if (c.resourceType === 'Star') {
        p.stars += c.amount;
        p.roundStars += c.amount;
        log(state, `${p.name} resolves ${c.name}: +${c.amount} stars.`);
      } else if (c.resourceType === 'Card') {
        const drawn = draw(state, c.amount);
        p.reserve.push(...drawn);
        log(state, `${p.name} resolves ${c.name}: draws ${drawn.length} card(s) to reserve.`);
      } else {
        // Hearts
        if (totalCapacityLeft(state, seat) > 0) {
          pushPending(state, 'heartAssign', seat, { amount: c.amount, reason: c.name });
        } else {
          log(state, `${p.name} resolves ${c.name} but has no room for hearts — forfeited.`);
        }
        log(state, `${p.name} resolves ${c.name}.`);
      }
      return;
    }
    case 'favor':
    case 'reroll':
      p.reserve.push(cardId);
      log(state, `${p.name} takes ${c.name} into reserve.`);
      return;
    default: {
      // Slottable card: find its home slot.
      const allowed = allowedSlots(state, seat, cardId);
      let slot = chosenSlot;
      if (slot != null) {
        if (!allowed.includes(slot)) throw new Error('That card cannot go in that slot.');
      } else if (c.cardType === 'performer') {
        // Default fill order: lowest empty Performer slot; if the row is full
        // the player must choose which performer to bump to reserve.
        slot = [0, 1, 2, 3, 4].find((i) => p.slots[i] == null);
        if (slot == null) {
          pushPending(state, 'placement', seat, { cardId, allowedSlots: allowed.filter((i) => i <= 4 || trainerActive(state, seat, TRAINERS.BARRE)) });
          return;
        }
      } else {
        slot = SLOTS_FOR_TYPE[c.cardType][0];
      }
      placeInSlot(state, seat, cardId, slot);
      return;
    }
  }
}

function placeInSlot(state, seat, cardId, slot) {
  const p = state.players[seat];
  const old = p.slots[slot];
  if (old) {
    p.reserve.push(old);
    log(state, `${p.name}'s ${card(old).name} moves to reserve.`);
  }
  p.slots[slot] = cardId;
  state.hearts[cardId] = card(cardId).startingHearts ?? 0;
  log(state, `${p.name} places ${card(cardId).name} in ${SLOT_NAMES[slot]}.`);
}

// ---------------------------------------------------------------------------
// Turn / phase flow
// ---------------------------------------------------------------------------

function finishTurn(state) {
  const seat = state.turn.seat;
  const p = state.players[seat];
  p.turns++;
  state.turn = null;

  // Draft ends the moment only 1 (or 0) face-up cards remain in the row.
  if (state.draftRow.length <= 1) {
    if (state.draftRow.length === 1) {
      const last = state.draftRow.pop();
      state.discard.push(last);
      log(state, `Only ${card(last).name} remains in the draft row — it is discarded. The draft ends.`);
    } else {
      log(state, 'The draft row is empty — the draft ends.');
    }
    startDicePhase(state);
    return;
  }

  // Favor window: after your 1st turn (Favor 1st) or 2nd+ turn (Favor 2nd+),
  // you may discard an eligible Favor for an immediate extra turn.
  if (eligibleFavors(state, seat).length > 0) {
    pushPending(state, 'favorWindow', seat, { afterSeat: seat });
    return;
  }
  nextSeat(state, seat);
}

function nextSeat(state, afterSeat) {
  const order = seatOrderByStand(state);
  const idx = order.indexOf(afterSeat);
  const seat = order[(idx + 1) % order.length];
  state.turn = newTurn(seat);
  log(state, `It is ${nameOf(state, seat)}'s turn.`);
}

function startDicePhase(state) {
  state.phase = 'dice';
  state.turn = null;
  state.dice = {
    stage: 'collection',
    rolled: 0,
    results: [],
    tRolled: 0,
    tomatoResults: [],
    tomatoTotal: Math.min(state.round, MAX_TOMATO_DICE),
  };
  log(state, `— Dice phase, round ${state.round} —`);
}

// One automatic step of the dice phase. Only called when nothing is pending.
function stepDice(state) {
  const d = state.dice;
  switch (d.stage) {
    case 'collection': {
      if (d.rolled >= 5) {
        d.stage = 'trophy';
        return;
      }
      startDieEvent(state, { kind: 'collection', source: 'phase' });
      return;
    }
    case 'trophy': {
      assignTrophy(state);
      if (state.phase === 'gameOver') return;
      d.stage = 'order';
      return;
    }
    case 'order': {
      assignDraftOrder(state);
      d.stage = 'tomato';
      return;
    }
    case 'tomato': {
      if (d.tRolled >= d.tomatoTotal) {
        d.stage = 'refill';
        return;
      }
      startDieEvent(state, { kind: 'tomato', source: 'phase' });
      return;
    }
    case 'refill': {
      for (const p of state.players) {
        if (refillIsNeeded(state, p.seat)) pushPending(state, 'refill', p.seat, {});
      }
      d.stage = 'nextRound';
      return;
    }
    case 'nextRound': {
      startNextRound(state);
      return;
    }
  }
}

// Most stars this round takes a Trophy; tie -> most coins this round; still
// tied -> all tied players take one. Winner(s) then lose 1 heart from each of
// their starters — all 8 mat slots (assumption #3 in the design brief).
function assignTrophy(state) {
  const maxStars = Math.max(...state.players.map((p) => p.roundStars));
  let cands = state.players.filter((p) => p.roundStars === maxStars);
  if (cands.length > 1) {
    const maxCoins = Math.max(...cands.map((p) => p.roundCoins));
    const byCoins = cands.filter((p) => p.roundCoins === maxCoins);
    cands = byCoins;
  }
  for (const w of cands) {
    w.trophies++;
    log(state, `${w.name} earned the most stars (${w.roundStars}) and takes a Trophy! (${w.trophies}/${state.trophyGoal})`);
    for (let i = 0; i < 8; i++) heartHit(state, w.seat, i, 'trophy fatigue');
  }
  const champions = state.players.filter((p) => p.trophies >= state.trophyGoal);
  if (champions.length > 0) {
    state.phase = 'gameOver';
    state.winners = champions.map((p) => p.seat);
    log(state, `The crowd roars — ${champions.map((p) => p.name).join(' and ')} win${champions.length === 1 ? 's' : ''} the game!`);
  }
}

// Fewest stars this round gets stand 1 (goes first next round). Ties: fewer
// coins this round -> better stand; then fewer trophies; then a roll-off.
function assignDraftOrder(state) {
  const tiebreak = new Map(state.players.map((p) => [p.seat, randInt(state, 1000)]));
  const ranked = [...state.players].sort(
    (a, b) =>
      a.roundStars - b.roundStars ||
      a.roundCoins - b.roundCoins ||
      a.trophies - b.trophies ||
      tiebreak.get(a.seat) - tiebreak.get(b.seat)
  );
  ranked.forEach((p, i) => (p.stand = i + 1));
  log(state, `New draft order: ${ranked.map((p) => p.name).join(' → ')}.`);
}

function suitableReserveCards(state, seat, slotIdx) {
  const p = state.players[seat];
  const wantType = slotIdx <= 4 ? 'performer' : slotIdx === 5 ? 'backdrop' : slotIdx === 6 ? 'prop' : 'trainer';
  return p.reserve.filter((id) => card(id).cardType === wantType);
}

function refillIsNeeded(state, seat) {
  const p = state.players[seat];
  for (let i = 0; i < 8; i++) {
    if (p.slots[i] == null && suitableReserveCards(state, seat, i).length > 0) return true;
  }
  return false;
}

function startNextRound(state) {
  state.round++;
  state.dice = null;
  for (const p of state.players) {
    p.roundStars = 0;
    p.roundCoins = 0;
    p.turns = 0;
  }
  state.draftRow = draw(state, state.players.length * 2 + 1);
  state.phase = 'draft';
  state.turn = newTurn(seatWithStand(state, 1));
  log(state, `— Round ${state.round} — ${Math.min(state.round, MAX_TOMATO_DICE)} tomato dice loom this round. ${nameOf(state, state.turn.seat)} drafts first.`);
}

// Run every automatic step until the game needs input (or is over).
function advance(state) {
  let guard = 0;
  while (guard++ < 10000) {
    if (state.phase === 'gameOver') return;
    if (state.pending.length > 0) return;
    if (state.dieEvent) {
      // Defensive: a die event with no pending reactions resolves.
      resolveDieEvent(state);
      continue;
    }
    if (state.phase === 'draft') {
      if (!state.turn) return;
      if (state.turn.done) {
        finishTurn(state);
        continue;
      }
      return; // waiting for the current player's turn action
    }
    if (state.phase === 'dice') {
      stepDice(state);
      continue;
    }
    return;
  }
  throw new Error('Engine advance loop did not settle (bug).');
}

// ---------------------------------------------------------------------------
// Action application (the public API)
// ---------------------------------------------------------------------------

function requireTurn(state, seat, { allowWithPending = false } = {}) {
  if (state.phase !== 'draft') throw new Error('Not the draft phase.');
  if (!state.turn || state.turn.seat !== seat) throw new Error('It is not your turn.');
  if (!allowWithPending && state.pending.length > 0) throw new Error('Resolve the current prompt first.');
  if (state.turn.done) throw new Error('Your turn is already over.');
}

export function applyAction(state, action) {
  if (!action || typeof action.type !== 'string') throw new Error('Malformed action.');
  const seat = action.seat;
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) throw new Error('Invalid seat.');
  if (state.phase === 'gameOver') throw new Error('The game is over.');

  switch (action.type) {
    // ----- draft-turn main actions -------------------------------------
    case 'acquireDraft': {
      requireTurn(state, seat);
      if (state.turn.mainDone) throw new Error('You have already acquired this turn (extra Maximillian acquires are market-only).');
      const idx = state.draftRow.indexOf(action.cardId);
      if (idx === -1) throw new Error('That card is not in the draft row.');
      const c = card(action.cardId);
      // A bonus turn from a Favor may not draft another Favor of the same timing.
      if (state.turn.isBonus && c.cardType === 'favor' && c.triggerAfterTurn === state.turn.bonusTiming) {
        throw new Error('You cannot use a Favor bonus turn to draft a Favor of the same timing.');
      }
      state.draftRow.splice(idx, 1);
      log(state, `${nameOf(state, seat)} drafts ${c.name} for free.`);
      acquireCard(state, seat, action.cardId, action.slot ?? null);
      state.turn.mainDone = true;
      state.turn.done = true;
      break;
    }
    case 'buyMarket': {
      requireTurn(state, seat);
      const i = action.index;
      if (!Number.isInteger(i) || i < 0 || i >= state.market.length) throw new Error('Invalid market slot.');
      if (state.turn.mainDone && !state.turn.open) throw new Error('You have already acted this turn.');
      const cost = marketCost(state, seat, i);
      const p = state.players[seat];
      if (p.coins < cost) throw new Error(`You need ${cost} coins for that market slot.`);
      p.coins -= cost;
      const cardId = state.market.splice(i, 1)[0];
      state.market.push(...draw(state, 1)); // remaining cards shift down, refill the 4-coin slot
      log(state, `${p.name} buys ${card(cardId).name} from the market for ${cost} coins.`);
      acquireCard(state, seat, cardId, action.slot ?? null);
      state.turn.mainDone = true;
      state.turn.buys++;
      if (trainerActive(state, seat, TRAINERS.MAXIMILLIAN)) {
        state.turn.open = true; // Maximillian: may keep buying, must end turn explicitly
      } else {
        state.turn.done = true;
      }
      break;
    }
    case 'resetMarket': {
      requireTurn(state, seat);
      if (state.turn.mainDone) throw new Error('You can only reset the market before your acquire decision.');
      const p = state.players[seat];
      if (p.coins < 1) throw new Error('Resetting the market costs 1 coin.');
      p.coins -= 1;
      state.discard.push(...state.market);
      state.market = draw(state, 4);
      log(state, `${p.name} pays 1 coin to reset the market.`);
      break;
    }
    case 'rearrange': {
      requireTurn(state, seat);
      if (state.turn.mainDone) throw new Error('Rearranging is your whole turn — you have already acted.');
      applyRearrange(state, seat, action.slots, action.reserve);
      log(state, `${nameOf(state, seat)} spends the turn rearranging their troupe.`);
      state.turn.mainDone = true;
      state.turn.done = true;
      break;
    }
    case 'endTurn': {
      requireTurn(state, seat);
      if (!state.turn.open) throw new Error('You cannot end your turn without acting.');
      state.turn.done = true;
      break;
    }
    // ----- trainer abilities --------------------------------------------
    case 'trainerDiscardDraft': {
      requireTurn(state, seat);
      const which = [TRAINERS.TOMASSO, TRAINERS.CURIO, TRAINERS.STAINGLASS].find((t) => trainerActive(state, seat, t));
      if (!which) throw new Error('Your Trainer has no draft-discard ability.');
      if (state.turn.trainerDiscardUsed) throw new Error('You already used that ability this turn.');
      if (state.draftRow.length < 2) throw new Error('Not enough cards left in the draft row.');
      const idx = state.draftRow.indexOf(action.cardId);
      if (idx === -1) throw new Error('That card is not in the draft row.');
      state.draftRow.splice(idx, 1);
      state.discard.push(action.cardId);
      state.turn.trainerDiscardUsed = true;
      const p = state.players[seat];
      log(state, `${p.name} discards ${card(action.cardId).name} from the draft row (${card(which).name}).`);
      if (which === TRAINERS.STAINGLASS) {
        const drawn = draw(state, 1);
        p.reserve.push(...drawn);
        if (drawn.length) log(state, `${p.name} draws ${card(drawn[0]).name} into reserve.`);
      } else if (which === TRAINERS.TOMASSO) {
        startDieEvent(state, { kind: 'tomato', source: 'tomasso', excludeSeat: seat });
      } else {
        startDieEvent(state, { kind: 'collection', source: 'curio', onlySeat: seat });
      }
      break;
    }
    case 'valentino': {
      requireTurn(state, seat);
      if (state.turn.mainDone) throw new Error('The Vanishing Valentino consumes your whole turn.');
      if (!trainerActive(state, seat, TRAINERS.VALENTINO)) throw new Error('The Vanishing Valentino is not your active Trainer.');
      if (!state.players[seat].valentinoAvailable) throw new Error('The Vanishing Valentino may only be used once per game.');
      const p = state.players[seat];
      const id = p.slots[7];
      p.slots[7] = null;
      state.hearts[id] = 0;
      state.discard.push(id);
      state.discard.push(...state.draftRow);
      state.draftRow = [];
      p.valentinoAvailable = false;
      log(state, `${p.name} plays The Vanishing Valentino — the Trainer and the entire draft row vanish!`);
      state.turn.mainDone = true;
      state.turn.done = true;
      break;
    }
    case 'auricConvert': {
      // "At any time": legal whenever the game is live and Auric is active.
      if (!trainerActive(state, seat, TRAINERS.AURIC)) throw new Error('Auric the Alchemist is not your active Trainer.');
      const p = state.players[seat];
      if (action.direction === 'coinToHeart') {
        if (p.coins < 1) throw new Error('You have no coins to convert.');
        if (!action.cardId || capacityLeft(state, seat, action.cardId) < 1) throw new Error('That card cannot take another heart.');
        const owns = p.slots.includes(action.cardId) || p.reserve.includes(action.cardId);
        if (!owns) throw new Error('That is not your card.');
        p.coins -= 1;
        state.hearts[action.cardId] = (state.hearts[action.cardId] || 0) + 1;
        log(state, `${p.name} transmutes 1 coin into a heart on ${card(action.cardId).name} (Auric).`);
      } else if (action.direction === 'heartToCoin') {
        const owns = p.slots.includes(action.cardId) || p.reserve.includes(action.cardId);
        if (!owns || (state.hearts[action.cardId] || 0) < 1) throw new Error('That card has no heart to convert.');
        state.hearts[action.cardId] -= 1;
        p.coins += 1;
        log(state, `${p.name} transmutes a heart from ${card(action.cardId).name} into 1 coin (Auric).`);
      } else {
        throw new Error('Unknown conversion direction.');
      }
      break;
    }
    // ----- pending-prompt resolutions ------------------------------------
    case 'resolvePending': {
      const item = state.pending.find((x) => x.id === action.pendingId);
      if (!item) throw new Error('That prompt is no longer active.');
      if (item.seat !== seat) throw new Error('That prompt is not yours.');
      resolvePendingItem(state, item, action);
      break;
    }
    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }

  state.version++;
  advance(state);
  return state;
}

// ---------------------------------------------------------------------------
// Pending resolutions
// ---------------------------------------------------------------------------

function resolvePendingItem(state, item, action) {
  const seat = item.seat;
  const p = state.players[seat];
  switch (item.kind) {
    case 'placement': {
      const slot = action.slot;
      if (!item.data.allowedSlots.includes(slot)) throw new Error('Invalid slot for that card.');
      removePending(state, item.id);
      placeInSlot(state, seat, item.data.cardId, slot);
      break;
    }
    case 'heartAssign': {
      const assignments = action.assignments || [];
      const capNow = totalCapacityLeft(state, seat);
      const mustAssign = Math.min(item.data.amount, capNow);
      let total = 0;
      const perCard = new Map();
      for (const a of assignments) {
        if (!a || !Number.isInteger(a.amount) || a.amount < 1) throw new Error('Bad heart assignment.');
        const owns = p.slots.includes(a.cardId) || p.reserve.includes(a.cardId);
        if (!owns) throw new Error('You can only assign hearts to your own cards.');
        perCard.set(a.cardId, (perCard.get(a.cardId) || 0) + a.amount);
        total += a.amount;
      }
      for (const [cardId, amt] of perCard) {
        if (amt > capacityLeft(state, seat, cardId)) throw new Error(`${card(cardId).name} cannot hold that many more hearts.`);
      }
      if (total !== mustAssign) throw new Error(`You must assign exactly ${mustAssign} heart(s).`);
      removePending(state, item.id);
      for (const [cardId, amt] of perCard) {
        state.hearts[cardId] = (state.hearts[cardId] || 0) + amt;
      }
      if (mustAssign < item.data.amount) {
        log(state, `${p.name} forfeits ${item.data.amount - mustAssign} heart(s) — no room.`);
      }
      if (total > 0) log(state, `${p.name} assigns ${total} heart(s) (${item.data.reason}).`);
      break;
    }
    case 'favorWindow': {
      removePending(state, item.id);
      if (action.use) {
        const idx = p.reserve.indexOf(action.use);
        if (idx === -1) throw new Error('That Favor is not in your reserve.');
        const c = card(action.use);
        if (c.cardType !== 'favor') throw new Error('That is not a Favor card.');
        const eligible = c.triggerAfterTurn === 1 ? p.turns === 1 : p.turns >= 2;
        if (!eligible) throw new Error('That Favor cannot be used after this turn.');
        p.reserve.splice(idx, 1);
        state.discard.push(action.use);
        log(state, `${p.name} spends ${c.name} for an extra turn!`);
        state.turn = newTurn(seat, true, c.triggerAfterTurn);
      } else {
        nextSeat(state, item.data.afterSeat);
      }
      break;
    }
    case 'rerollOffer': {
      if (!state.dieEvent) throw new Error('No die to re-roll.');
      removePending(state, item.id);
      if (action.use) {
        applyRerollUse(state, seat, action.use);
      } else {
        state.dieEvent.passed.push(seat);
        queueRerollOffers(state);
      }
      break;
    }
    case 'mesmera': {
      const ev = state.dieEvent;
      if (!ev || !ev.mesmera || ev.mesmera.seat !== seat) throw new Error('No Mesmera re-roll available.');
      removePending(state, item.id);
      if (action.again && ev.mesmera.rollsLeft > 0) {
        ev.value = rollDie(state, ev.kind);
        ev.mesmera.rollsLeft--;
        ev.passed = [];
        log(state, `${p.name} re-rolls again (Mesmera): ${ev.value}`);
        if (ev.mesmera.rollsLeft > 0) {
          pushPending(state, 'mesmera', seat, { kind: ev.kind });
          break;
        }
      }
      ev.mesmera = null;
      queueRerollOffers(state);
      break;
    }
    case 'refill': {
      const assignments = action.assignments || [];
      const seen = new Set();
      // validate first
      for (const a of assignments) {
        if (!a || !Number.isInteger(a.slot) || a.slot < 0 || a.slot > 7) throw new Error('Bad refill assignment.');
        if (seen.has(a.slot) || p.slots[a.slot] != null) throw new Error('That slot is not empty.');
        if (!p.reserve.includes(a.cardId)) throw new Error('That card is not in your reserve.');
        if (!suitableReserveCards(state, seat, a.slot).includes(a.cardId)) throw new Error(`${card(a.cardId).name} cannot refill ${SLOT_NAMES[a.slot]}.`);
        if (assignments.filter((x) => x.cardId === a.cardId).length > 1) throw new Error('Card assigned twice.');
        seen.add(a.slot);
      }
      removePending(state, item.id);
      for (const a of assignments) {
        p.reserve.splice(p.reserve.indexOf(a.cardId), 1);
        p.slots[a.slot] = a.cardId; // keeps its current hearts
        log(state, `${p.name} refills ${SLOT_NAMES[a.slot]} with ${card(a.cardId).name} from reserve.`);
      }
      // Refill is mandatory where possible: no empty slot may remain if a
      // suitable reserve card is still available.
      if (refillIsNeeded(state, seat)) {
        // put everything back and reject
        for (const a of assignments) {
          p.slots[a.slot] = null;
          p.reserve.push(a.cardId);
        }
        pushPending(state, 'refill', seat, {});
        throw new Error('You must refill every empty slot you have a suitable reserve card for.');
      }
      break;
    }
    default:
      throw new Error(`Unknown pending kind: ${item.kind}`);
  }
}

// ---------------------------------------------------------------------------
// Rearrange
// ---------------------------------------------------------------------------

function applyRearrange(state, seat, slots, reserve) {
  const p = state.players[seat];
  if (!Array.isArray(slots) || slots.length !== 8 || !Array.isArray(reserve)) throw new Error('Malformed arrangement.');
  const before = [...p.slots.filter(Boolean), ...p.reserve].sort();
  const after = [...slots.filter(Boolean), ...reserve].sort();
  if (before.length !== after.length || before.some((id, i) => id !== after[i])) {
    throw new Error('Rearranging cannot add or remove cards.');
  }
  const barre = trainerActive(state, seat, TRAINERS.BARRE) || slots[7] === TRAINERS.BARRE;
  for (let i = 0; i < 8; i++) {
    const id = slots[i];
    if (!id) continue;
    const c = card(id);
    if (!SLOTTABLE.has(c.cardType)) throw new Error(`${c.name} cannot occupy a mat slot.`);
    if (!barre && !SLOTS_FOR_TYPE[c.cardType].includes(i)) {
      throw new Error(`${c.name} cannot go in ${SLOT_NAMES[i]}.`);
    }
  }
  p.slots = [...slots.map((x) => x ?? null)];
  p.reserve = [...reserve];
}
