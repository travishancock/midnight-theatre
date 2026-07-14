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
    hearts: {}, // cardId -> current (printed) hearts on that card
    players: players.map((p, i) => ({
      seat: i,
      name: p.name || `Player ${i + 1}`,
      isBot: !!p.isBot,
      coins: 0,
      stars: 0,
      trophies: 0,
      roundStars: 0,
      roundCoins: 0,
      roundHearts: 0,
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
    turnsCompleted: 0, // incremented once per finished turn — lets a driver (e.g. the server's bot loop) detect "a turn just ended" without re-deriving it from seat/phase changes
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

// Max hearts a card can hold. This is its printed capacity — which is NOT
// always the same as how many hearts it starts with. Props/Backdrops, for
// instance, start at 2 (solid) or 1 (wildcard) filled hearts but can hold up
// to 3 total (their card_database.json `maxHearts` field carries this;
// falls back to `startingHearts` for card types where capacity and starting
// fill are the same, e.g. Trainers always start full and Performers have no
// separate printed max).
export function maxHearts(state, seat, cardId) {
  const c = card(cardId);
  if (!SLOTTABLE.has(c.cardType)) return 0;
  return c.maxHearts ?? c.startingHearts ?? 0;
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

// p.turns is how many turns this seat has already completed this round, so
// it also identifies which turn is coming up next (0 = about to take their
// 1st turn, 1 = about to take their 2nd, etc). A "1st" Favor is only usable
// on the player's actual first turn of the round; a "2nd" Favor is usable
// on their second turn or any later turn that round.
export function favorEligibleNow(triggerAfterTurn, turnsSoFar) {
  return triggerAfterTurn === 1 ? turnsSoFar === 0 : turnsSoFar >= 1;
}

export function eligibleFavors(state, seat) {
  const p = state.players[seat];
  return p.reserve.filter((id) => {
    const c = card(id);
    if (c.cardType !== 'favor') return false;
    return favorEligibleNow(c.triggerAfterTurn, p.turns);
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

// Remove 1 heart from the card in a given slot. Reaching 0 printed hearts
// doesn't discard a card by itself — the hit that brings it to 0 is
// survived (that hit spent its last printed heart). Only the NEXT hit taken
// while it is already at 0 hearts actually discards it. So a card with 1
// printed heart takes exactly 2 hits total to leave the stage: the first
// brings it to 0 and it survives, the second (taken while already at 0)
// discards it. A card that starts at 0 printed hearts discards on its very
// first hit, since it's already in the "already at 0" state.
function heartHit(state, seat, slotIdx, why) {
  const p = state.players[seat];
  const id = p.slots[slotIdx];
  if (!id) return;
  const h = state.hearts[id] || 0;
  if (h > 0) {
    state.hearts[id] = h - 1;
    log(state, `${p.name}'s ${card(id).name} loses a heart (${why}) — ${h - 1} left.`);
    return;
  }
  p.slots[slotIdx] = null;
  state.discard.push(id);
  log(state, `${p.name}'s ${card(id).name} (${SLOT_NAMES[slotIdx]}) loses its last heart and leaves the stage! (${why})`);
}

// ---------------------------------------------------------------------------
// Die events (a rolled die that is open to re-roll card reactions)
// ---------------------------------------------------------------------------

function rollDie(state, kind) {
  return kind === 'collection'
    ? COLLECTION_FACES[randInt(state, 20)]
    : randInt(state, 8) + 1;
}

// Start a die event: roll and announce it. `position` (1-5) identifies which
// of the round's 5 Collection Dice this is, for Press Pass targeting.
// source: 'phase' (normal dice-phase die), 'tomasso', 'curio'. Only
// phase-sourced Collection Dice pause (awaitingLock) for a possible Press
// Pass reaction — the caller (the server, paced for spectators; a test
// driver, immediately) must call lockCollectionDie() to let it resolve.
// Everything else resolves the instant advance() sees it, same as before.
function startDieEvent(state, { kind, source, position = null, onlySeat = null, excludeSeat = null }) {
  const value = rollDie(state, kind);
  const awaitingLock = source === 'phase' && kind === 'collection';
  state.dieEvent = { kind, source, position, onlySeat, excludeSeat, value, awaitingLock, rerollHistory: null };
  const label = kind === 'collection' ? 'Collection Die' : 'Tomato Die';
  const posLabel = position ? ` (die #${position} this round)` : '';
  log(state, `${label} rolled: ${value}${posLabel}${source !== 'phase' ? ` (${source === 'tomasso' ? 'Tomasso the Terrible' : 'Madame Curio'})` : ''}`);
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
  }
}

// Let a paused phase-sourced Collection Die (see startDieEvent) actually
// resolve. Called by a driver (the server, after a short paced reveal
// window; a test, immediately) once any Press Pass reaction window has
// closed. A no-op if there's nothing open to lock.
export function lockCollectionDie(state) {
  if (state.dieEvent && state.dieEvent.awaitingLock) {
    state.dieEvent.awaitingLock = false;
    state.version++;
    advance(state);
  }
  return state;
}

// Let a paused Tomato-dice batch (see stepDice's 'tomato' case) actually
// apply its hits, once any Mesmera reroll window has closed.
export function lockTomatoRoll(state) {
  const d = state.dice;
  if (d && d.stage === 'tomato' && d.tomatoRolled && !d.tomatoLocked) {
    d.tomatoLocked = true;
    state.version++;
    advance(state);
  }
  return state;
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
        p.roundHearts += units;
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
        log(state, `${p.name} resolves ${c.name}: draws ${drawn.length} card(s).`);
        for (const id of drawn) intakeDrawnCard(state, seat, id);
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
  // Madame Coeur: newly placed/drafted cards start at their printed maximum
  // heart count instead of their normal starting-heart value.
  const startFull = trainerActive(state, seat, TRAINERS.COEUR);
  state.hearts[cardId] = startFull ? maxHearts(state, seat, cardId) : (card(cardId).startingHearts ?? 0);
  log(state, `${p.name} places ${card(cardId).name} in ${SLOT_NAMES[slot]}${startFull ? ' at full hearts (Madame Coeur)' : ''}.`);
}

// A card drawn straight from the deck (currently only via the "Card"
// resource effect): resource/favor/reroll cards resolve or reserve exactly
// as they would from a normal acquisition. Slottable cards (performer/
// backdrop/prop/trainer) go into an empty starting slot automatically; if
// every natural slot for that card's type is already occupied, the player
// chooses whether to place it anyway (bumping the current occupant to
// reserve) or send the drawn card straight to reserve instead.
function intakeDrawnCard(state, seat, cardId) {
  const p = state.players[seat];
  const c = card(cardId);
  if (c.cardType === 'resource' || c.cardType === 'favor' || c.cardType === 'reroll') {
    acquireCard(state, seat, cardId, null);
    return;
  }
  const natural = SLOTS_FOR_TYPE[c.cardType];
  const emptySlot = natural.find((i) => p.slots[i] == null);
  if (emptySlot != null) {
    placeInSlot(state, seat, cardId, emptySlot);
    return;
  }
  const allowed = allowedSlots(state, seat, cardId);
  pushPending(state, 'cardResourcePlacement', seat, { cardId, allowedSlots: allowed });
}

// ---------------------------------------------------------------------------
// Turn / phase flow
// ---------------------------------------------------------------------------

function finishTurn(state) {
  const seat = state.turn.seat;
  const p = state.players[seat];
  const bonusQueue = state.turn.bonusQueue || [];
  p.turns++;
  state.turn = null;
  state.turnsCompleted++;

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

  // A Favor spent before this turn's main action (see the 'useFavor' action)
  // queues an extra turn for the same seat, taken immediately — before play
  // passes to the next stand.
  if (bonusQueue.length > 0) {
    const [timing, ...rest] = bonusQueue;
    state.turn = newTurn(seat, true, timing);
    state.turn.bonusQueue = rest;
    log(state, `${nameOf(state, seat)} takes an extra turn (Favor).`);
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

// Every Press Pass sitting in any player's reserve, ordered highest-numbered
// card first (ties broken by seat order) — the priority order in which
// players are offered the chance to spend one before the dice start rolling.
// Only one Press Pass may be spent per round (see stepDice's 'pressPassOffer'
// stage), so this queue is consumed one candidate at a time.
function pressPassCandidates(state) {
  const out = [];
  for (const p of state.players) {
    for (const id of p.reserve) {
      const c = card(id);
      if (c.cardType === 'reroll') out.push({ seat: p.seat, cardId: id, count: c.count });
    }
  }
  out.sort((a, b) => b.count - a.count || a.seat - b.seat);
  return out;
}

function startDicePhase(state) {
  state.phase = 'dice';
  state.turn = null;
  const queue = pressPassCandidates(state);
  state.dice = {
    stage: queue.length ? 'pressPassOffer' : 'collection',
    pressPassQueue: queue,
    pressPass: null, // { seat, cardId, count, usesLeft } once a player accepts the offer
    rolled: 0,
    results: [],
    tomatoResults: [],
    tomatoRolled: false, // the round's whole Tomato batch has been rolled (values in tomatoResults)
    tomatoLocked: false, // the batch is finalized — hits may now be applied
    mesmeraRerollUsed: false,
    tomatoTotal: Math.min(state.round, MAX_TOMATO_DICE),
  };
  log(state, `— Dice phase, round ${state.round} —`);
}

// One automatic step of the dice phase. Only called when nothing is pending.
function stepDice(state) {
  const d = state.dice;
  switch (d.stage) {
    // Before any Collection Die rolls, offer the round's highest-numbered
    // Press Pass holder the chance to spend it (see pressPassCandidates).
    // A real pending prompt (not a proactive click) since it's a genuine
    // yes/no decision with a clear resolution either way. If declined, the
    // next-highest candidate is offered in turn; only one Press Pass total
    // may be spent per round, so acceptance ends the queue immediately.
    case 'pressPassOffer': {
      if (d.pressPassQueue.length === 0) {
        d.stage = 'collection';
        return;
      }
      const next = d.pressPassQueue[0];
      pushPending(state, 'pressPassOffer', next.seat, { cardId: next.cardId, count: next.count });
      return;
    }
    case 'collection': {
      if (d.rolled >= 5) {
        d.stage = 'trophy';
        return;
      }
      startDieEvent(state, { kind: 'collection', source: 'phase', position: d.rolled + 1 });
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
    // The round's whole Tomato batch rolls at once (not resolved yet), so
    // Mesmera the Veiled's owner can choose to re-roll the entire batch one
    // time before any hits are actually applied. advance() pauses here
    // (tomatoRolled && !tomatoLocked) until a driver calls lockTomatoRoll().
    case 'tomato': {
      if (!d.tomatoRolled) {
        d.tomatoResults = Array.from({ length: d.tomatoTotal }, () => rollDie(state, 'tomato'));
        d.tomatoRolled = true;
        log(state, `Tomato dice rolled: ${d.tomatoResults.join(', ')}.`);
        return;
      }
      if (!d.tomatoLocked) return;
      for (const n of d.tomatoResults) resolveTomatoDie(state, n);
      d.stage = 'refill';
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
export function assignTrophy(state) {
  const maxStars = Math.max(...state.players.map((p) => p.roundStars));
  let cands = state.players.filter((p) => p.roundStars === maxStars);
  if (cands.length > 1) {
    // Tie-break on TOTAL (career) coins, not just coins earned this round.
    const maxCoins = Math.max(...cands.map((p) => p.coins));
    const byCoins = cands.filter((p) => p.coins === maxCoins);
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
    p.roundHearts = 0;
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
      // A phase-sourced Collection Die pauses (awaiting a possible Press
      // Pass reaction) until a driver calls lockCollectionDie(). Anything
      // else (Tomasso/Curio's ad-hoc dice) resolves immediately, as before.
      if (state.dieEvent.awaitingLock) return;
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
      // A rolled Tomato batch pauses (awaiting a possible Mesmera reroll)
      // until a driver calls lockTomatoRoll().
      if (state.dice.stage === 'tomato' && state.dice.tomatoRolled && !state.dice.tomatoLocked) return;
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
    // Spend an eligible Favor card from reserve, right before your main
    // turn action, for an extra turn. Never a forced prompt — the player
    // simply clicks the Favor card if (and when) they want to use it.
    case 'useFavor': {
      requireTurn(state, seat);
      if (state.turn.mainDone) throw new Error('Favors must be spent before your main turn action.');
      const p = state.players[seat];
      const idx = p.reserve.indexOf(action.cardId);
      if (idx === -1) throw new Error('That Favor is not in your reserve.');
      const c = card(action.cardId);
      if (c.cardType !== 'favor') throw new Error('That is not a Favor card.');
      if (!favorEligibleNow(c.triggerAfterTurn, p.turns)) throw new Error('That Favor cannot be used yet.');
      p.reserve.splice(idx, 1);
      state.discard.push(action.cardId);
      log(state, `${p.name} spends ${c.name} for an extra turn!`);
      state.turn.bonusQueue = [...(state.turn.bonusQueue || []), c.triggerAfterTurn];
      break;
    }
    // ----- trainer abilities --------------------------------------------
    case 'trainerDiscardDraft': {
      requireTurn(state, seat);
      if (state.turn.mainDone) throw new Error('You have already acted this turn.');
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
      log(state, `${p.name} discards ${card(action.cardId).name} from the draft row (${card(which).name}) — this uses their turn.`);
      if (which === TRAINERS.STAINGLASS) {
        const drawn = draw(state, 1);
        p.reserve.push(...drawn);
        if (drawn.length) log(state, `${p.name} draws ${card(drawn[0]).name} into reserve.`);
      } else if (which === TRAINERS.TOMASSO) {
        startDieEvent(state, { kind: 'tomato', source: 'tomasso', excludeSeat: seat });
      } else {
        startDieEvent(state, { kind: 'collection', source: 'curio', onlySeat: seat });
      }
      // Using this ability is the player's whole turn — same as rearranging
      // or any other main action, per the owner's ruling.
      state.turn.mainDone = true;
      state.turn.done = true;
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
    // ----- dice-phase proactive resources --------------------------------
    // Spend one use from the round's active Press Pass pool (see the
    // 'pressPassOffer' pending resolution below) to re-roll whichever
    // Collection Die is currently open (rolled, not yet locked). Never a
    // forced prompt — the option is just available while relevant. Only the
    // seat that accepted the pre-roll offer may use it, and only while they
    // still have uses left; they may spend more than one use on the same
    // die in a row, or spread them across different dice.
    case 'usePressPass': {
      const ev = state.dieEvent;
      if (!ev || ev.kind !== 'collection' || ev.source !== 'phase' || !ev.awaitingLock) {
        throw new Error('No Collection Die is open for a Press Pass right now.');
      }
      const d = state.dice;
      if (!d.pressPass || d.pressPass.seat !== seat) throw new Error('You have no active Press Pass this round.');
      if (d.pressPass.usesLeft <= 0) throw new Error('No Press Pass re-rolls left this round.');
      d.pressPass.usesLeft--;
      ev.value = rollDie(state, 'collection');
      ev.rerollHistory = [...(ev.rerollHistory || []), ev.value];
      const p = state.players[seat];
      log(state, `${p.name} spends a Press Pass re-roll on Die #${ev.position}: ${ev.value} (${d.pressPass.usesLeft} re-roll${d.pressPass.usesLeft === 1 ? '' : 's'} left this round).`);
      break;
    }
    // Explicit "I'm done deciding" from the round's active Press Pass holder:
    // keep the die's current result and let it lock immediately, instead of
    // waiting out the server's reveal timer. Only meaningful for a human —
    // bots decide synchronously — but legal any time the die is open, even
    // with 0 uses left, so the client's "keep this result" button always works.
    case 'lockPressPassDie': {
      const ev = state.dieEvent;
      if (!ev || ev.kind !== 'collection' || ev.source !== 'phase' || !ev.awaitingLock) {
        throw new Error('No Collection Die is open right now.');
      }
      const d = state.dice;
      if (!d.pressPass || d.pressPass.seat !== seat) throw new Error('You have no active Press Pass this round.');
      ev.awaitingLock = false; // applyAction's own advance() call (below) resolves it from here
      break;
    }
    // Mesmera the Veiled: once the round's whole Tomato batch is rolled but
    // not yet locked in, her owner may choose to re-roll the entire batch
    // one time. Proactive, once per round.
    case 'mesmeraRerollTomato': {
      const d = state.dice;
      if (state.phase !== 'dice' || !d || d.stage !== 'tomato' || !d.tomatoRolled || d.tomatoLocked) {
        throw new Error('There is no Tomato roll open to re-roll right now.');
      }
      if (!trainerActive(state, seat, TRAINERS.MESMERA)) throw new Error('Mesmera the Veiled is not your active Trainer.');
      if (d.mesmeraRerollUsed) throw new Error('Mesmera has already been used this round.');
      d.tomatoResults = Array.from({ length: d.tomatoTotal }, () => rollDie(state, 'tomato'));
      d.mesmeraRerollUsed = true;
      log(state, `${nameOf(state, seat)} invokes Mesmera the Veiled — all Tomato dice are re-rolled: ${d.tomatoResults.join(', ')}.`);
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
    // Offered before the round's Collection Dice start rolling, to the
    // highest-numbered Press Pass holder first (see pressPassCandidates /
    // stepDice's 'pressPassOffer' stage). Declining moves on to the next
    // candidate in priority order; accepting spends the card immediately and
    // ends the offer queue for the round (only one Press Pass may be active
    // per round).
    case 'pressPassOffer': {
      const d = state.dice;
      removePending(state, item.id);
      if (!action.use) {
        d.pressPassQueue.shift();
        log(state, `${p.name} declines to spend ${card(item.data.cardId).name} this round.`);
        break;
      }
      const idx = p.reserve.indexOf(item.data.cardId);
      if (idx === -1) throw new Error('That card is no longer in your reserve.');
      p.reserve.splice(idx, 1);
      state.discard.push(item.data.cardId);
      d.pressPass = { seat, cardId: item.data.cardId, count: item.data.count, usesLeft: item.data.count };
      d.pressPassQueue = [];
      d.stage = 'collection';
      log(state, `${p.name} spends ${card(item.data.cardId).name} — up to ${item.data.count} Collection Die re-roll${item.data.count > 1 ? 's' : ''} available this round.`);
      break;
    }
    case 'placement': {
      const slot = action.slot;
      if (!item.data.allowedSlots.includes(slot)) throw new Error('Invalid slot for that card.');
      removePending(state, item.id);
      placeInSlot(state, seat, item.data.cardId, slot);
      break;
    }
    case 'cardResourcePlacement': {
      const it = item.data;
      if (action.toReserve) {
        removePending(state, item.id);
        p.reserve.push(it.cardId);
        log(state, `${p.name} sends ${card(it.cardId).name} to reserve instead of placing it.`);
        break;
      }
      const slot = action.slot;
      if (!Number.isInteger(slot) || !it.allowedSlots.includes(slot)) throw new Error('Invalid slot for that card.');
      removePending(state, item.id);
      placeInSlot(state, seat, it.cardId, slot);
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
