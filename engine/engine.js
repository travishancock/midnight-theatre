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

// Mat slots: indices 0-4 Performers, 5 Backdrop/Trainer, 6 Prop/Trainer, 7 Trainer.
// Slots 5 and 6 can each hold either their natural card (Backdrop/Prop) or a
// Trainer instead; slot 7 is Trainer-only. Up to 3 Trainers can be active on
// a board at once as a result.
export const SLOT_NAMES = [
  'Performer 1', 'Performer 2', 'Performer 3', 'Performer 4', 'Performer 5',
  'Backdrop / Trainer', 'Prop / Trainer', 'Trainer',
];
export const SLOTS_FOR_TYPE = {
  performer: [0, 1, 2, 3, 4],
  backdrop: [5],
  prop: [6],
  trainer: [5, 6, 7],
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
  ORSINO: 'Orsino-the-Headliner',
  CASSIUS: 'Cassius-the-Second-Act',
  DELPHINE: 'Delphine-Silvertongue',
  HIGGINS: 'Higgins-the-Pawnbroker',
  JONAS: 'Jonas-Quickfinger',
  WENDELL: 'Wendell-the-Propmaster',
  CELESTINE: 'Celestine-the-Stargazer',
  ATLAS: 'Atlas-the-Steadfast',
  BELLACANTO: 'Bellacanto-the-Choirmistress',
  EZRA: 'Ezra-the-Sleight-of-Hand',
};

const MAX_TOMATO_DICE = 7; // rolled dice cap at 7 from round 7 onward (physical set has 9 tomato dice)

// First trophy-holder to this many Trophies wins. Fewer players means fewer
// people splitting the round-by-round trophies, so the threshold rises as
// the table shrinks (and drops as it grows) to keep game length comparable.
const TROPHY_GOAL_BY_PLAYERS = { 2: 6, 3: 5, 4: 4, 5: 3 };

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
    trophyGoal: TROPHY_GOAL_BY_PLAYERS[players.length],
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
    })),
    turn: null, // { seat, mainDone, done, open, buys, isBonus, bonusTiming, curioDone, celestineUsed, atlasUsed }
    dice: null, // dice-phase progress
    dieEvent: null, // an in-flight die roll open to re-roll reactions
    pending: [], // decision prompts awaiting player input
    nextPendingId: 1,
    winners: null,
    log: [],
    turnsCompleted: 0, // incremented once per finished turn — lets a driver (e.g. the server's bot loop) detect "a turn just ended" without re-deriving it from seat/phase changes
    tilted: {}, // cardId -> true, Atlas the Steadfast: immune to collecting/losing hearts this round; cleared each round
    pressPassWindowActive: false, // true while waiting on one or more seats' 'pressPassWindow' pending items to close — see openPressPassWindow
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
  // No one can hold a Trainer yet at true game start, but this still needs to
  // run so the very first turn's curioDone flag gets resolved the same way
  // every later turn's does (via finishTurn's continue-loop inside advance) —
  // otherwise Madame Curio's auto-roll would silently never fire on whatever
  // seat happens to hold Draft Stand 1 the very first time a Curio-holding
  // player reaches this exact seat/turn slot after a reshuffle of stands.
  advance(state);
  return state;
}

function newTurn(seat, isBonus = false, bonusTiming = null) {
  return {
    seat, mainDone: false, done: false, open: false, buys: 0, isBonus, bonusTiming,
    curioDone: false, celestineUsed: false, atlasUsed: false,
  };
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
  const slots = state.players[seat].slots;
  return slots[5] === trainerId || slots[6] === trainerId || slots[7] === trainerId;
}

// All Trainer ids currently active on this seat's board (0-3 of them, since
// slots 5/6/7 can each independently hold a Trainer).
export function activeTrainers(state, seat) {
  const slots = state.players[seat].slots;
  return [slots[5], slots[6], slots[7]].filter((id) => id && card(id).cardType === 'trainer');
}

// Max hearts a card can hold. This is its printed capacity — which is NOT
// always the same as how many hearts it starts with. Props/Backdrops, for
// instance, start at 2 filled hearts and cap at 2 total — i.e. they start
// full (their card_database.json `maxHearts` field carries this; falls back
// to `startingHearts` for card types where capacity and starting fill are
// the same, e.g. Trainers always start full and Performers have no separate
// printed max).
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

// Is there an open pre-roll Press Pass window pending for this seat right
// now? Opened once the draft phase ends, before the round's 5 shared
// Collection Dice roll — see openPressPassWindow — and closed when the seat
// resolves their 'pressPassWindow' pending item.
function pressPassWindowOpenFor(state, seat) {
  return state.pending.some((x) => x.kind === 'pressPassWindow' && x.seat === seat);
}

function hasPressPassCards(state, seat) {
  return state.players[seat].reserve.some((id) => card(id).cardType === 'reroll');
}

// Press Pass cards held in this seat's reserve, spendable right now: only
// during that seat's open pre-roll window (see pressPassWindowOpenFor) —
// not turn-gated within that window (not a forced choice, just clickable,
// like a Favor), but not usable at any other time either.
export function eligiblePressPasses(state, seat) {
  if (!pressPassWindowOpenFor(state, seat)) return [];
  const p = state.players[seat];
  return p.reserve.filter((id) => card(id).cardType === 'reroll');
}

// Opens the instant the draft phase ends, before the round's 5 shared
// Collection Dice roll: every seat holding at least one Press Pass card gets
// a pending 'pressPassWindow' item, offering the option (never forced) to
// spend any number of their Press Pass cards for private rolls first. The
// round's shared dice don't actually start rolling until every such seat has
// closed their window (see advance()'s pressPassWindowActive branch). If no
// one holds a Press Pass, the dice phase starts immediately, same as before.
function openPressPassWindow(state) {
  const eligible = state.players.filter((p) => hasPressPassCards(state, p.seat));
  if (eligible.length === 0) {
    startDicePhase(state);
    return;
  }
  log(state, "Before this round's Collection Dice roll, players holding a Press Pass may spend it for private rolls.");
  state.pressPassWindowActive = true;
  for (const p of eligible) pushPending(state, 'pressPassWindow', p.seat, {});
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
  if (state.tilted && state.tilted[id]) {
    log(state, `${p.name}'s ${card(id).name} is tilted (Atlas the Steadfast) — protected from losing a heart (${why}).`);
    return;
  }
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
// of the round's 5 shared Collection Dice this is.
// source: 'phase' (normal dice-phase die), 'tomasso', 'curio'. Only
// phase-sourced Collection Dice pause (awaitingLock) — purely for reveal
// pacing, so spectators can watch each die land — the caller (the server,
// paced for spectators; a test driver, immediately) must call
// lockCollectionDie() to let it resolve. Everything else resolves the
// instant advance() sees it, same as before.
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

// Does this player currently have at least one active Performer (one of
// their 5 Performer slots) of every value of the given boostKind — all 4
// Characteristics (Graceful/Powerful/Dramatic/Haunting) or all 4 Types
// (Singer/Dancer/Acrobat/Illusionist)? Only relevant for the wildcard
// "Any Characteristic"/"Any Type" Prop/Backdrop cards — see boostCount.
export function hasFullSet(state, seat, boostKind) {
  const seen = new Set();
  const p = state.players[seat];
  for (let i = 0; i < 5; i++) {
    const id = p.slots[i];
    if (!id) continue;
    const c = card(id);
    seen.add(boostKind === 'characteristic' ? c.characteristic : c.type);
  }
  return seen.size >= 4;
}

// +1 per equipped Backdrop/Prop whose boost list matches the performer
// (assumption #1 in the design brief). The 2 wildcard cards per set (their
// `boosts` list covers all 4 Characteristics or all 4 Types, rather than
// just 1) only activate at all once the player has at least one active
// Performer of every one of those 4 values — otherwise they're dormant and
// grant no boost to anyone, even a performer that would otherwise match.
// Single-match cards (a `boosts` list of length 1) have no such gate.
function boostCount(state, seat, performer) {
  let n = 0;
  for (const slotIdx of [5, 6]) {
    const id = state.players[seat].slots[slotIdx];
    if (!id) continue;
    const b = card(id);
    if (!b.boosts) continue;
    const key = b.boostKind === 'characteristic' ? performer.characteristic : performer.type;
    if (!b.boosts.includes(key)) continue;
    if (b.boosts.length >= 4 && !hasFullSet(state, seat, b.boostKind)) continue;
    n++;
  }
  return n;
}

// typeFilterFn, if given, further restricts which performers can collect
// (e.g. Madame Curio's automatic start-of-turn roll only benefits Acrobats).
function resolveCollectionDie(state, letter, onlySeat = null, typeFilterFn = null, reasonLabel = null) {
  for (const p of state.players) {
    if (onlySeat != null && p.seat !== onlySeat) continue;
    let heartsEarned = 0;
    let coinsEarned = 0;
    const gains = [];
    // Board performers, plus (Bellacanto the Choirmistress) any Singer
    // performers sitting in reserve.
    const sources = [...p.slots.slice(0, 5)];
    if (trainerActive(state, p.seat, TRAINERS.BELLACANTO)) {
      for (const id of p.reserve) {
        const c = card(id);
        if (c.cardType === 'performer' && c.type === 'Singer') sources.push(id);
      }
    }
    for (const id of sources) {
      if (!id) continue;
      if (state.tilted && state.tilted[id]) continue;
      const c = card(id);
      if (c.cardType !== 'performer' || c.letter !== letter) continue;
      if (typeFilterFn && !typeFilterFn(c)) continue;
      let units = 1 + boostCount(state, p.seat, c);
      if ((letter === 'A' || letter === 'B') && trainerActive(state, p.seat, TRAINERS.ORSINO)) units += 2;
      if ((letter === 'C' || letter === 'D') && trainerActive(state, p.seat, TRAINERS.CASSIUS)) units += 1;
      if (c.resource === 'Star') {
        p.stars += units;
        p.roundStars += units;
        gains.push(`${units} star${units > 1 ? 's' : ''}`);
      } else if (c.resource === 'Coin') {
        coinsEarned += units;
        gains.push(`${units} coin${units > 1 ? 's' : ''}`);
      } else {
        heartsEarned += units;
        gains.push(`${units} heart${units > 1 ? 's' : ''}`);
      }
    }
    if (gains.length) log(state, `${p.name} collects ${gains.join(', ')} for letter ${letter}${reasonLabel ? ` (${reasonLabel})` : ''}.`);
    grantCoinsAndHearts(state, p.seat, coinsEarned, heartsEarned, reasonLabel || `Collection Die ${letter}`);
  }
}

// Route a batch of Coin/Heart gains (from a Collection Die or an acquired
// Coin/Heart resource card) to the player. If Auric the Alchemist is their
// active Trainer, this is the one moment his ability applies (per the
// owner's ruling: he may only choose to receive a coin as a heart, or a
// heart as a coin, at the moment he actually receives one — not as a
// free-standing swap of resources already banked) — offer a real choice
// right now instead of crediting immediately. Everyone else, and anything
// already decided, resolves exactly as before via creditCoinsAndHearts.
function grantCoinsAndHearts(state, seat, coinsEarned, heartsEarned, reason) {
  if (coinsEarned <= 0 && heartsEarned <= 0) return;
  if (trainerActive(state, seat, TRAINERS.AURIC)) {
    pushPending(state, 'auricGainChoice', seat, { coinsEarned, heartsEarned, reason });
    return;
  }
  creditCoinsAndHearts(state, seat, coinsEarned, heartsEarned, reason);
}

function creditCoinsAndHearts(state, seat, coins, hearts, reason) {
  const p = state.players[seat];
  if (coins > 0) {
    p.coins += coins;
    p.roundCoins += coins;
  }
  if (hearts > 0) {
    p.roundHearts += hearts;
    if (totalCapacityLeft(state, seat) > 0) {
      pushPending(state, 'heartAssign', seat, { amount: hearts, reason });
    } else {
      log(state, `${p.name} has no room for ${hearts} earned heart(s) — they are forfeited.`);
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
        log(state, `${p.name} resolves ${c.name}: +${c.amount} coins.`);
        grantCoinsAndHearts(state, seat, c.amount, 0, c.name);
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
        log(state, `${p.name} resolves ${c.name}.`);
        grantCoinsAndHearts(state, seat, 0, c.amount, c.name);
      }
      return;
    }
    case 'favor':
    case 'reroll':
      p.reserve.push(cardId);
      log(state, `${p.name} takes ${c.name} into reserve.`);
      return;
    default: {
      // Slottable card: find its home slot. Whenever the natural home is
      // already occupied, the player is offered a genuine choice — place it
      // in the active lineup (bumping the current occupant to reserve) or
      // send the newly acquired card to reserve instead — rather than either
      // silently auto-bumping or forcing a bump with no reserve option.
      const allowed = allowedSlots(state, seat, cardId);
      let slot = chosenSlot;
      if (slot != null) {
        if (!allowed.includes(slot)) throw new Error('That card cannot go in that slot.');
      } else if (c.cardType === 'performer') {
        // Default fill order: lowest empty Performer slot; if the row is
        // full, offer the bump-or-reserve choice above.
        slot = [0, 1, 2, 3, 4].find((i) => p.slots[i] == null);
        if (slot == null) {
          pushPending(state, 'placement', seat, {
            cardId,
            allowedSlots: allowed.filter((i) => i <= 4 || trainerActive(state, seat, TRAINERS.BARRE)),
            allowReserve: true,
          });
          return;
        }
      } else if (c.cardType === 'trainer') {
        // Slot 8 (Trainer-only) is always tried first, automatically. Once
        // it's taken, the player chooses which of all 3 Trainer slots (6, 7,
        // or 8) to bump — or sends the newly acquired Trainer to reserve
        // instead. (Madame Barre's passive still widens this to any of the
        // 8 mat slots, same as every other acquisition while she's active.)
        if (p.slots[7] == null) {
          slot = 7;
        } else {
          const trainerAllowed = trainerActive(state, seat, TRAINERS.BARRE) ? allowed : [5, 6, 7];
          pushPending(state, 'placement', seat, { cardId, allowedSlots: trainerAllowed, allowReserve: true });
          return;
        }
      } else {
        // Backdrop/Prop: a single natural slot. If it's already occupied,
        // offer the same bump-or-reserve choice as everything else above.
        slot = SLOTS_FOR_TYPE[c.cardType][0];
        if (p.slots[slot] != null) {
          pushPending(state, 'placement', seat, { cardId, allowedSlots: allowed, allowReserve: true });
          return;
        }
      }
      placeAcquiredCard(state, seat, cardId, slot);
      return;
    }
  }
}

// Place a freshly-acquired (drafted/bought/drawn) card, then offer any
// "acquired cards may be immediately discarded to..." Trainer reactions that
// apply to it (Professor Stainglass / Jonas Quickfinger / Wendell the
// Propmaster). Not used for refills or rearranges — only genuine new
// acquisitions.
function placeAcquiredCard(state, seat, cardId, slot) {
  placeInSlot(state, seat, cardId, slot);
  offerPostAcquireDiscard(state, seat, cardId);
}

function offerPostAcquireDiscard(state, seat, cardId) {
  const c = card(cardId);
  const choices = [];
  if (trainerActive(state, seat, TRAINERS.STAINGLASS)) choices.push('stainglass');
  if (c.cardType === 'performer' && trainerActive(state, seat, TRAINERS.JONAS)) choices.push('jonas');
  if ((c.cardType === 'backdrop' || c.cardType === 'prop') && trainerActive(state, seat, TRAINERS.WENDELL)) {
    const altAvailable = state.discard.some((id) => id !== cardId && card(id).cardType === c.cardType);
    if (altAvailable) choices.push('wendell');
  }
  if (choices.length === 0) return;
  pushPending(state, 'postAcquireDiscard', seat, { cardId, cardName: c.name, cardType: c.cardType, choices });
}

// Remove a card the player currently owns (mat slot or reserve) and send it
// to the discard pile, resetting its printed hearts.
function discardOwnedCard(state, seat, cardId) {
  const p = state.players[seat];
  const slotIdx = p.slots.indexOf(cardId);
  if (slotIdx !== -1) p.slots[slotIdx] = null;
  else {
    const ri = p.reserve.indexOf(cardId);
    if (ri !== -1) p.reserve.splice(ri, 1);
  }
  state.hearts[cardId] = 0;
  state.discard.push(cardId);
}

// Jonas Quickfinger: collect exactly 1 unit of a card's printed resource
// (no boosts — this isn't a Collection Die roll, just a straight cash-in).
function collectResourceUnit(state, seat, c, reason) {
  const p = state.players[seat];
  if (c.resource === 'Star') {
    p.stars += 1;
    p.roundStars += 1;
    log(state, `${p.name} collects 1 star (${reason}).`);
  } else if (c.resource === 'Coin') {
    grantCoinsAndHearts(state, seat, 1, 0, reason);
  } else {
    grantCoinsAndHearts(state, seat, 0, 1, reason);
  }
}

// Tomasso the Terrible: how many Dancer performers this seat has on board —
// determines how many Tomato dice they may roll (at least 1 required).
function dancerCount(state, seat) {
  const p = state.players[seat];
  let n = 0;
  for (let i = 0; i < 5; i++) {
    const id = p.slots[i];
    if (id && card(id).type === 'Dancer') n++;
  }
  return n;
}

// Ezra the Sleight-of-Hand: does this seat have at least one Illusionist on
// their board?
function hasIllusionist(state, seat) {
  const p = state.players[seat];
  for (let i = 0; i < 5; i++) {
    const id = p.slots[i];
    if (id && card(id).type === 'Illusionist') return true;
  }
  return false;
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
    placeAcquiredCard(state, seat, cardId, emptySlot);
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
      // Ezra the Sleight-of-Hand: if its (unique) owner has at least one
      // Illusionist on their board, the leftover card goes to them instead
      // of the discard pile.
      const ezraOwner = state.players.find((pl) => trainerActive(state, pl.seat, TRAINERS.EZRA) && hasIllusionist(state, pl.seat));
      if (ezraOwner) {
        ezraOwner.reserve.push(last);
        log(state, `${card(last).name} remains in the draft row — ${ezraOwner.name} receives it into reserve (Ezra the Sleight-of-Hand). The draft ends.`);
      } else {
        state.discard.push(last);
        log(state, `Only ${card(last).name} remains in the draft row — it is discarded. The draft ends.`);
      }
    } else {
      log(state, 'The draft row is empty — the draft ends.');
    }
    openPressPassWindow(state);
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

function startDicePhase(state) {
  state.phase = 'dice';
  state.turn = null;
  state.dice = {
    stage: 'collection',
    rolled: 0,
    results: [],
    tomatoResults: [],
    tomatoRolled: false, // the round's whole Tomato batch has been rolled (values in tomatoResults)
    tomatoLocked: false, // the batch is finalized — hits may now be applied
    mesmeraRerollUsed: false,
    tomatoTotal: Math.min(state.round, MAX_TOMATO_DICE),
    reviewOpened: false, // true once this round's post-dice diceResultsReview prompts have been pushed — see stepDice's 'review' stage
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
      d.stage = 'review';
      return;
    }
    // Both the round's 5 shared Collection Dice and its Tomato batch have
    // now fully resolved. Give every player a moment to actually look at the
    // results (the earned-resources table, hearts lost, etc.) before the
    // round moves on — a blocking 'diceResultsReview' pending item per seat,
    // same pattern as the pre-roll Press Pass window. Bots close theirs
    // immediately (see bot.js); a human clicks "Continue" in the client. The
    // round doesn't advance to refill until every seat has closed theirs.
    case 'review': {
      if (!d.reviewOpened) {
        d.reviewOpened = true;
        for (const pl of state.players) pushPending(state, 'diceResultsReview', pl.seat, {});
        return;
      }
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

function wantTypesForSlot(slotIdx) {
  if (slotIdx <= 4) return ['performer'];
  if (slotIdx === 5) return ['backdrop', 'trainer'];
  if (slotIdx === 6) return ['prop', 'trainer'];
  return ['trainer'];
}

function suitableReserveCards(state, seat, slotIdx) {
  const p = state.players[seat];
  const wantTypes = wantTypesForSlot(slotIdx);
  return p.reserve.filter((id) => wantTypes.includes(card(id).cardType));
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
  state.tilted = {}; // Atlas the Steadfast's protection only lasts the round it was used
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
      if (!state.turn) {
        // The draft just ended and the pre-roll Press Pass window (see
        // openPressPassWindow) has now fully closed — every eligible seat's
        // 'pressPassWindow' pending item resolved (we only get here once
        // state.pending is empty, per the check above). Start the round's 5
        // shared Collection Dice.
        if (state.pressPassWindowActive) {
          state.pressPassWindowActive = false;
          startDicePhase(state);
          continue;
        }
        return;
      }
      if (state.turn.done) {
        finishTurn(state);
        continue;
      }
      // Madame Curio: an automatic, free Collection Die roll at the very
      // start of this seat's turn (before they can act) — only Acrobats of
      // theirs collect on it, and only if the rolled letter matches, same as
      // a normal Collection Die.
      if (!state.turn.curioDone) {
        state.turn.curioDone = true;
        if (trainerActive(state, state.turn.seat, TRAINERS.CURIO)) {
          const v = rollDie(state, 'collection');
          log(state, `Madame Curio rolls automatically for ${nameOf(state, state.turn.seat)}: ${v}.`);
          resolveCollectionDie(state, v, state.turn.seat, (c) => c.type === 'Acrobat', 'Madame Curio');
        }
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
      // Higgins the Pawnbroker: every OTHER player who has him active draws
      // 1 coin whenever anyone resets the market.
      for (const other of state.players) {
        if (other.seat === seat) continue;
        if (trainerActive(state, other.seat, TRAINERS.HIGGINS)) {
          grantCoinsAndHearts(state, other.seat, 1, 0, 'Higgins the Pawnbroker');
          log(state, `${other.name} draws 1 coin (Higgins the Pawnbroker).`);
        }
      }
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
    // Tomasso the Terrible: spend your whole turn to roll 1 Tomato die per
    // Dancer performer you have on board (at least 1 required); only other
    // players are affected.
    case 'tomassoRoll': {
      requireTurn(state, seat);
      if (state.turn.mainDone) throw new Error('You have already acted this turn.');
      if (!trainerActive(state, seat, TRAINERS.TOMASSO)) throw new Error('Tomasso the Terrible is not your active Trainer.');
      const n = dancerCount(state, seat);
      if (n < 1) throw new Error('You need at least one Dancer on your board to use Tomasso the Terrible.');
      const p = state.players[seat];
      const results = Array.from({ length: n }, () => rollDie(state, 'tomato'));
      log(state, `${p.name} spends the turn with Tomasso the Terrible — rolling ${n} Tomato ${n === 1 ? 'die' : 'dice'}: ${results.join(', ')} (only other players are affected).`);
      for (const v of results) resolveTomatoDie(state, v, seat);
      state.turn.mainDone = true;
      state.turn.done = true;
      break;
    }
    // Madame Barre: to start your turn, freely rearrange your board (any
    // card in any slot) without spending your turn. Her passive "place
    // anywhere" effect for normal acquisitions still applies separately
    // (see allowedSlots) — this is an additional, explicit free action.
    case 'freeRearrange': {
      requireTurn(state, seat);
      if (state.turn.mainDone) throw new Error('This must be used before your main turn action.');
      if (!trainerActive(state, seat, TRAINERS.BARRE)) throw new Error('Madame Barre is not your active Trainer.');
      applyRearrange(state, seat, action.slots, action.reserve);
      log(state, `${nameOf(state, seat)} freely rearranges their troupe (Madame Barre) without using their turn.`);
      break;
    }
    // The Vanishing Valentino: to start your turn, you may end the draft
    // immediately (discarding whatever remains in the draft row) without
    // spending your turn. Unlimited uses while active.
    case 'valentinoEndDraft': {
      requireTurn(state, seat);
      if (state.turn.mainDone) throw new Error('This must be used before your main turn action.');
      if (!trainerActive(state, seat, TRAINERS.VALENTINO)) throw new Error('The Vanishing Valentino is not your active Trainer.');
      const p = state.players[seat];
      log(state, `${p.name} plays The Vanishing Valentino — the draft ends immediately!`);
      state.discard.push(...state.draftRow);
      state.draftRow = [];
      state.turn.mainDone = true;
      state.turn.done = true;
      break;
    }
    // Celestine the Stargazer: to start your turn, you may buy up to 3
    // stars for 2 coins each.
    case 'celestineBuyStars': {
      requireTurn(state, seat);
      if (state.turn.mainDone) throw new Error('This must be used before your main turn action.');
      if (!trainerActive(state, seat, TRAINERS.CELESTINE)) throw new Error('Celestine the Stargazer is not your active Trainer.');
      if (state.turn.celestineUsed) throw new Error('You have already used that this turn.');
      const n = action.count;
      if (!Number.isInteger(n) || n < 1 || n > 3) throw new Error('Choose 1-3 stars.');
      const p = state.players[seat];
      const cost = n * 2;
      if (p.coins < cost) throw new Error(`You need ${cost} coins for that.`);
      p.coins -= cost;
      p.stars += n;
      p.roundStars += n;
      state.turn.celestineUsed = true;
      log(state, `${p.name} spends ${cost} coins to buy ${n} star${n > 1 ? 's' : ''} (Celestine the Stargazer).`);
      break;
    }
    // Atlas the Steadfast: to start your turn, you may tilt one of your
    // board cards — it cannot collect or lose hearts for the rest of the
    // round.
    case 'atlasTilt': {
      requireTurn(state, seat);
      if (state.turn.mainDone) throw new Error('This must be used before your main turn action.');
      if (!trainerActive(state, seat, TRAINERS.ATLAS)) throw new Error('Atlas the Steadfast is not your active Trainer.');
      if (state.turn.atlasUsed) throw new Error('You have already used that this turn.');
      const p = state.players[seat];
      const slot = action.slot;
      if (!Number.isInteger(slot) || slot < 0 || slot > 7 || !p.slots[slot]) throw new Error('Choose one of your occupied slots.');
      state.tilted[p.slots[slot]] = true;
      state.turn.atlasUsed = true;
      log(state, `${p.name} tilts ${card(p.slots[slot]).name} (Atlas the Steadfast) — it cannot collect or lose hearts for the rest of the round.`);
      break;
    }
    // ----- pre-roll Press Pass window ------------------------------------
    // Press Pass: discard from reserve, during this seat's open pre-roll
    // window (see openPressPassWindow — opened once the draft ends, before
    // the round's 5 shared Collection Dice roll), for N private Collection
    // Die rolls (N = the card's printed number) that only this seat
    // benefits from. Never a forced choice — just a clickable reserve card,
    // like a Favor — but only legal while that seat's window is open.
    case 'usePressPass': {
      if (!pressPassWindowOpenFor(state, seat)) {
        throw new Error("Press Pass cards can only be spent during the pre-roll window, just before the round's Collection Dice roll.");
      }
      const p = state.players[seat];
      const idx = p.reserve.indexOf(action.cardId);
      if (idx === -1) throw new Error('That card is not in your reserve.');
      const c = card(action.cardId);
      if (c.cardType !== 'reroll') throw new Error('That is not a Press Pass card.');
      p.reserve.splice(idx, 1);
      state.discard.push(action.cardId);
      // Delphine Silvertongue: this seat's Press Pass roll count is doubled.
      const delphine = trainerActive(state, seat, TRAINERS.DELPHINE);
      const n = c.count * (delphine ? 2 : 1);
      const results = Array.from({ length: n }, () => rollDie(state, 'collection'));
      log(state, `${p.name} spends ${c.name} for ${n} private Collection Die roll${n > 1 ? 's' : ''}${delphine ? ' (doubled by Delphine Silvertongue)' : ''}: ${results.join(', ')}.`);
      for (const letter of results) resolveCollectionDie(state, letter, seat);
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
    // Explicit "I'm done deciding" from Mesmera's holder: keep the Tomato
    // batch's current results and let it lock immediately, instead of
    // waiting out the server's reveal timer. Marks the same mesmeraRerollUsed
    // flag as actually re-rolling — either way, the round's one decision is
    // spent — so nothing else needs to change to make the pause stop.
    case 'keepTomatoRoll': {
      const d = state.dice;
      if (state.phase !== 'dice' || !d || d.stage !== 'tomato' || !d.tomatoRolled || d.tomatoLocked) {
        throw new Error('There is no Tomato roll open right now.');
      }
      if (!trainerActive(state, seat, TRAINERS.MESMERA)) throw new Error('Mesmera the Veiled is not your active Trainer.');
      if (d.mesmeraRerollUsed) throw new Error('Mesmera has already been used this round.');
      d.mesmeraRerollUsed = true;
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
      if (action.toReserve) {
        if (!item.data.allowReserve) throw new Error('That card must be placed, not reserved.');
        removePending(state, item.id);
        p.reserve.push(item.data.cardId);
        log(state, `${p.name} sends ${card(item.data.cardId).name} to reserve instead of placing it.`);
        break;
      }
      const slot = action.slot;
      if (!item.data.allowedSlots.includes(slot)) throw new Error('Invalid slot for that card.');
      removePending(state, item.id);
      placeAcquiredCard(state, seat, item.data.cardId, slot);
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
      placeAcquiredCard(state, seat, it.cardId, slot);
      break;
    }
    // Professor Stainglass / Jonas Quickfinger / Wendell the Propmaster:
    // right after acquiring a matching card, its owner may immediately
    // discard it for that Trainer's stated effect instead of keeping it. See
    // offerPostAcquireDiscard.
    case 'postAcquireDiscard': {
      const choice = action.choice;
      if (!item.data.choices.includes(choice) && choice !== 'keep') throw new Error('Invalid choice.');
      const { cardId, cardName } = item.data;
      removePending(state, item.id);
      if (choice === 'keep') break;
      if (choice === 'stainglass') {
        discardOwnedCard(state, seat, cardId);
        const drawn = draw(state, 1);
        p.reserve.push(...drawn);
        log(state, `${p.name} discards ${cardName} (Professor Stainglass) to draw ${drawn.length ? card(drawn[0]).name : 'nothing — the deck is empty'}.`);
      } else if (choice === 'jonas') {
        const c = card(cardId);
        discardOwnedCard(state, seat, cardId);
        log(state, `${p.name} discards ${cardName} (Jonas Quickfinger) to collect its resource.`);
        collectResourceUnit(state, seat, c, 'Jonas Quickfinger');
      } else if (choice === 'wendell') {
        const slot = p.slots.indexOf(cardId);
        const cType = card(cardId).cardType;
        discardOwnedCard(state, seat, cardId);
        const options = state.discard.filter((id) => card(id).cardType === cType);
        log(state, `${p.name} discards ${cardName} (Wendell the Propmaster) to take a different one from the discard pile.`);
        pushPending(state, 'wendellSwap', seat, { slot, cardType: cType, options });
      }
      break;
    }
    case 'wendellSwap': {
      const cardId = action.cardId;
      if (!item.data.options.includes(cardId)) throw new Error('That card is not available to swap in.');
      removePending(state, item.id);
      const idx = state.discard.indexOf(cardId);
      if (idx === -1) throw new Error('That card is no longer in the discard pile.');
      state.discard.splice(idx, 1);
      placeInSlot(state, seat, cardId, item.data.slot);
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
    // Auric the Alchemist: offered the instant he actually receives a coin
    // and/or a heart (from a Collection Die or an acquired Coin/Heart
    // resource card — see grantCoinsAndHearts) — not a free-standing swap of
    // resources already banked. He may convert some, all, or none of what
    // he just received to the other type; anything kept (or converted in)
    // as coins credits immediately, anything kept (or converted in) as
    // hearts goes through the normal heartAssign placement prompt next.
    case 'auricGainChoice': {
      const { coinsEarned, heartsEarned, reason } = item.data;
      const convertCoins = !!action.convertCoinsToHearts && coinsEarned > 0;
      const convertHearts = !!action.convertHeartsToCoins && heartsEarned > 0;
      removePending(state, item.id);
      const finalCoins = (convertCoins ? 0 : coinsEarned) + (convertHearts ? heartsEarned : 0);
      const finalHearts = (convertHearts ? 0 : heartsEarned) + (convertCoins ? coinsEarned : 0);
      if (convertCoins || convertHearts) {
        const bits = [];
        if (convertCoins) bits.push(`${coinsEarned} coin${coinsEarned > 1 ? 's' : ''} into heart${coinsEarned > 1 ? 's' : ''}`);
        if (convertHearts) bits.push(`${heartsEarned} heart${heartsEarned > 1 ? 's' : ''} into coin${heartsEarned > 1 ? 's' : ''}`);
        log(state, `${p.name} transmutes ${bits.join(' and ')} (Auric).`);
      }
      creditCoinsAndHearts(state, seat, finalCoins, finalHearts, reason);
      break;
    }
    // Pre-roll Press Pass window: this seat is done deciding (whether or not
    // they spent anything) — see openPressPassWindow/usePressPass. Once
    // every eligible seat's window is closed, the round's 5 shared
    // Collection Dice start rolling (advance()'s pressPassWindowActive
    // branch).
    case 'pressPassWindow': {
      removePending(state, item.id);
      break;
    }
    // Post-dice-roll review: this seat has looked over the round's results
    // and is ready to move on — see stepDice's 'review' stage.
    case 'diceResultsReview': {
      removePending(state, item.id);
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
  const barre = trainerActive(state, seat, TRAINERS.BARRE) || slots[5] === TRAINERS.BARRE || slots[6] === TRAINERS.BARRE || slots[7] === TRAINERS.BARRE;
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
