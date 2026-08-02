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

// D20 Collection die faces: A,B x4 — C,D x3 — E,F x2 — G,H x1.
export const COLLECTION_FACES = [
  'A', 'A', 'A', 'A', 'B', 'B', 'B', 'B', 'C', 'C',
  'C', 'D', 'D', 'D', 'E', 'E', 'F', 'F', 'G', 'H',
];
export const LETTER_FREQ = { A: 4, B: 4, C: 3, D: 3, E: 2, F: 2, G: 1, H: 1 };

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
  DELPHINE: 'Delphine-Silvertongue',
  AMARA: 'Amara-the-Reliquary',
  JONAS: 'Jonas-Quickfinger',
  WENDELL: 'Wendell-the-Propmaster',
  CELESTINE: 'Celestine-the-Stargazer',
  BELLACANTO: 'Bellacanto-the-Choirmistress',
  EZRA: 'Ezra-the-Sleight-of-Hand',
};

const MAX_TOMATO_DICE = 8; // rolled dice cap at 8 from round 8 onward (physical set has 9 tomato dice)
const MARKET_SIZE = 4;

// First trophy-holder to this many Trophies wins. Fewer players means fewer
// people splitting the round-by-round trophies, so the threshold rises as
// the table shrinks (and drops as it grows) to keep game length comparable.
const TROPHY_GOAL_BY_PLAYERS = { 2: 6, 3: 5, 4: 4, 5: 3 };

// Solo mode: 1 human + 2 Ghost seats (always 3 total). Kept as its own
// constant (rather than reusing TROPHY_GOAL_BY_PLAYERS[3]) so solo balance
// can be tuned independently of the real 3-player multiplayer game later
// without any risk of the two ever accidentally diverging from each other
// in a way that's hard to notice.
const TROPHY_GOAL_SOLO = 5;

// Alt Solo: a different 1-player variant — no Ghosts, no AI, just the human
// against a d8-driven round target. Kept as its own constants (not reused
// from TROPHY_GOAL_SOLO/TROPHY_GOAL_BY_PLAYERS) so its balance can be tuned
// independently. The 5-trophy win goal is an inferred assumption, chosen to
// mirror the explicit 5-loss cap symmetrically (first to 5 wins takes the
// game, first to 5 losses loses it) — see DESIGN_BRIEF.md.
// Physical token supply in the box. Tracked so the app can warn when a real
// table would run out of a component — see checkTokenSupply. Alert-only by
// design: a depleted pool never blocks a gain, it just gets flagged loudly,
// since the point is to validate the printed component counts rather than to
// make scarcity a game mechanic.
export const TOKEN_SUPPLY = { hearts: 90, stars: 30, coins: 80 };

// Celestine the Stargazer's start-of-turn star purchase: up to 2 stars at 2
// coins each. Named rather than inlined so the rule reads in one place; the
// client mirrors these two numbers (see CELESTINE in client/src/main.js),
// same convention it already uses for marketCost and Favor eligibility.
export const CELESTINE_MAX_STARS = 2;
export const CELESTINE_STAR_COST = 2;

// Amara the Reliquary: how many individual heart relocations she may make in
// one turn. Mirrored by the client (see AMARA in client/src/main.js).
export const AMARA_MAX_MOVES = 3;


const ALT_SOLO_TROPHY_GOAL = 5;
const ALT_SOLO_LOSS_LIMIT = 5;
const ALT_SOLO_DRAFT_ROW_SIZE = 5;

// ---------------------------------------------------------------------------
// Game creation
// ---------------------------------------------------------------------------

export function createGame({ players, seed, solo, altSolo }) {
  const minPlayers = altSolo ? 1 : 2;
  if (!players || players.length < minPlayers || players.length > 5) {
    throw new Error('The Midnight Theatre supports 2-5 players.');
  }
  const state = {
    version: 0,
    rng: (seed ?? makeSeed()) >>> 0,
    phase: 'draft', // 'draft' | 'dice' | 'gameOver'
    round: 1,
    solo: !!solo, // 1-player variant: always the human + 2 Ghost seats
    altSolo: !!altSolo, // 1-player variant: no Ghosts/AI at all — a d8-driven round target instead
    trophyGoal: altSolo ? ALT_SOLO_TROPHY_GOAL : solo ? TROPHY_GOAL_SOLO : TROPHY_GOAL_BY_PLAYERS[players.length],
    altSoloTarget: 0, // this round's star target — reset to 0 every round, raised by ALT_SOLO_DIE_FACES rolls
    altSoloLosses: 0, // whole-game counter — reaching ALT_SOLO_LOSS_LIMIT ends the game in a loss
    altSoloRollEvent: null, // { roll, label } — the most recent d8 result, for the client to display
    deck: [],
    discard: [],
    market: [],
    draftRow: [],
    hearts: {}, // cardId -> current (printed) hearts on that card
    ghostRollEvent: null, // { seat, roll, label } — the most recent d12 result, for the client to display
    players: players.map((p, i) => ({
      seat: i,
      name: p.name || `Player ${i + 1}`,
      isBot: !!p.isBot,
      isGhost: !!p.isGhost, // solo mode: acts via the d12 roll table, never AI heuristics — see resolveGhostRoll
      coins: 0,
      stars: 0,
      trophies: 0,
      roundStars: 0,
      carryStars: 0, // stars earned after this round was scored — become next round's opening roundStars
      roundCoins: 0,
      roundHearts: 0,
      turns: 0, // turns completed this round
      stand: 0, // draft-order stand 1..n
      slots: [null, null, null, null, null, null, null, null],
      reserve: [],
    })),
    turn: null, // { seat, mainDone, done, open, buys, isBonus, bonusTiming, curioDone, celestineUsed, amaraUsed }
    dice: null, // dice-phase progress
    dieEvent: null, // an in-flight die roll open to re-roll reactions
    pending: [], // decision prompts awaiting player input
    nextPendingId: 1,
    winners: null,
    log: [],
    tokenSupply: null, // { hearts|stars|coins: {out,total,left} } — refreshed by checkTokenSupply for the client
    supplyAlerts: {}, // kind -> { deficit, round, out, total } for every pool that has run dry this game
    turnsCompleted: 0, // incremented once per finished turn — lets a driver (e.g. the server's bot loop) detect "a turn just ended" without re-deriving it from seat/phase changes
    pressPassWindowActive: false, // true while waiting on one or more seats' 'pressPassWindow' pending items to close — see openPressPassWindow
  };

  state.deck = shuffle(state, allCardIds().slice());

  // Randomly pick the first player; stands go clockwise from them.
  // Starting coins are 2x the draft stand number: stand 1 starts with 2
  // coins, stand 2 with 4, stand 3 with 6, and so on.
  const first = randInt(state, players.length);
  for (let i = 0; i < players.length; i++) {
    const p = state.players[(first + i) % players.length];
    p.stand = i + 1;
    p.coins = p.stand * 2;
  }

  state.market = draw(state, MARKET_SIZE);
  state.draftRow = draw(state, altSolo ? ALT_SOLO_DRAFT_ROW_SIZE : players.length * 2 + 1);
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
    curioDone: false, celestineUsed: false,
    // Amara the Reliquary: up to AMARA_MAX_MOVES individual heart relocations
    // per turn, counted rather than a single-use flag.
    amaraMoves: 0,
    // Free once-per-turn Trainer actions taken before the main action.
    jonasUsed: false, valentinoUsed: false,
    // Maximillian the Magnate: each draft-row draft grants one bonus market
    // buy. Counted rather than boolean so a Favor chain of several drafts in
    // one turn window accrues one bonus buy each, and so a market buy can
    // never grant another (they don't chain).
    bonusBuys: 0,
    // How many times the market has been reset this turn. Purely informational
    // (resetting stays unlimited, 1 coin each) — the AI uses it to cap its own
    // resets so it can never loop, since resetMarket doesn't spend the turn.
    resets: 0,
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
  // Barnaby Pennywhistle: -1 coin per Graceful performer on stage, so the
  // discount scales with the troupe rather than being a flat -1 (and is
  // nothing at all with no Graceful performers). Applies fully, even down to
  // 0 coins — a free-to-take market slot still costs the player's turn to
  // acquire, just no coins.
  if (trainerActive(state, seat, TRAINERS.BARNABY)) {
    cost = Math.max(0, cost - countActivePerformers(state, seat, (c) => c.characteristic === 'Graceful'));
  }
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
// 1st turn, 1 = about to take their 2nd, etc). A "1st" Favor is usable on
// the player's first turn of the round OR any later turn that round (i.e.
// from turn 1 onward, never expires); a "2nd" Favor is usable starting on
// their second turn or any later turn that round (not their very first).
export function favorEligibleNow(triggerAfterTurn, turnsSoFar) {
  return turnsSoFar >= triggerAfterTurn - 1;
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
  const h = state.hearts[id] || 0;
  if (h > 0) {
    state.hearts[id] = h - 1;
    log(state, `${p.name}'s ${card(id).name} loses a heart (${why}) — ${h - 1} left.`);
    return;
  }
  p.slots[slotIdx] = null;
  state.discard.push(id);
  log(state, `${p.name}'s ${card(id).name} (${SLOT_NAMES[slotIdx]}) loses its last heart and leaves the stage! (${why})`);
  if (id === TRAINERS.BARRE) relocateReserveOnBarreLeaving(state, seat);
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
  // Scan every mat slot, not just the natural Backdrop/Prop pair: Madame
  // Barre can place an acquired card in any of the 8 slots, and a Prop or
  // Backdrop sitting in a non-traditional slot is still equipped and still
  // boosts. (Reserve is excluded — a card in reserve isn't in play.)
  for (let slotIdx = 0; slotIdx < 8; slotIdx++) {
    const id = state.players[seat].slots[slotIdx];
    if (!id) continue;
    const b = card(id);
    if (b.cardType !== 'prop' && b.cardType !== 'backdrop') continue;
    if (!b.boosts) continue;
    const key = b.boostKind === 'characteristic' ? performer.characteristic : performer.type;
    if (!b.boosts.includes(key)) continue;
    if (b.boosts.length >= 4 && !hasFullSet(state, seat, b.boostKind)) continue;
    n++;
  }
  return n;
}

// Expected resource units this seat would collect from ONE Collection Die
// roll, given their board right now. Mirrors resolveCollectionDie's payout
// exactly — boosts, Orsino's G/H bonus and Bellacanto's reserve Singers all
// included — weighted by each letter's frequency on the d20.
//
// Exported for the AI, which needs it to price a Press Pass (N private rolls)
// against everything else on offer. A flat score can't work: the same card is
// worth nothing to an empty board and a great deal to a full one.
export function expectedUnitsPerCollectionRoll(state, seat) {
  const p = state.players[seat];
  const sources = [...p.slots.slice(0, 5)];
  if (trainerActive(state, seat, TRAINERS.BELLACANTO)) {
    for (const id of p.reserve) {
      const c = card(id);
      if (c.cardType === 'performer' && c.type === 'Singer') sources.push(id);
    }
  }
  let ev = 0;
  for (const id of sources) {
    if (!id) continue;
    const c = card(id);
    if (c.cardType !== 'performer') continue;
    let units = 1 + boostCount(state, seat, c);
    if ((c.letter === 'G' || c.letter === 'H') && trainerActive(state, seat, TRAINERS.ORSINO)) units += 3;
    ev += ((LETTER_FREQ[c.letter] || 0) / 20) * units;
  }
  return ev;
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
      const c = card(id);
      if (c.cardType !== 'performer' || c.letter !== letter) continue;
      if (typeFilterFn && !typeFilterFn(c)) continue;
      let units = 1 + boostCount(state, p.seat, c);
      if ((letter === 'G' || letter === 'H') && trainerActive(state, p.seat, TRAINERS.ORSINO)) units += 3;
      if (c.resource === 'Star') {
        addStars(state, p.seat, units);
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

// Every star gain goes through here so the post-scoring carry-over is applied
// uniformly, whatever the source (Collection Die, Star resource, Celestine,
// Jonas, ...).
//
// A round's stars are compared for the Trophy and then wiped when the next
// round starts. But stars can still arrive *after* that comparison — most
// obviously Jonas Quickfinger firing on performers discarded by the Tomato
// dice, which resolve after both the trophy and the new draft order are
// settled. Those stars would otherwise be earned and immediately deleted, so
// they're banked in carryStars and become the player's opening roundStars
// next round instead. p.stars (the lifetime tally) is unaffected either way.
export function addStars(state, seat, n) {
  if (n <= 0) return;
  const p = state.players[seat];
  p.stars += n;
  p.roundStars += n;
  if (state.dice && state.dice.trophyAssigned) p.carryStars += n;
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
        addStars(state, seat, c.amount);
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
      } else if (trainerActive(state, seat, TRAINERS.BARRE)) {
        // Madame Barre: every acquisition is offered a genuine placement
        // choice — any of the 8 mat slots, or reserve — even when a natural
        // slot is sitting open. Never auto-filled while she's active.
        pushPending(state, 'placement', seat, { cardId, allowedSlots: allowed, allowReserve: true });
        return;
      } else if (c.cardType === 'performer') {
        // Default fill order: lowest empty Performer slot; if the row is
        // full, offer the bump-or-reserve choice above.
        slot = [0, 1, 2, 3, 4].find((i) => p.slots[i] == null);
        if (slot == null) {
          pushPending(state, 'placement', seat, { cardId, allowedSlots: allowed, allowReserve: true });
          return;
        }
      } else if (c.cardType === 'trainer') {
        // Slot 8 (Trainer-only) is always tried first, automatically. Once
        // it's taken, the player chooses which of all 3 Trainer slots (6, 7,
        // or 8) to bump — or sends the newly acquired Trainer to reserve
        // instead.
        if (p.slots[7] == null) {
          slot = 7;
        } else {
          pushPending(state, 'placement', seat, { cardId, allowedSlots: [5, 6, 7], allowReserve: true });
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
// apply to it (Professor Stainglass). Not used for refills or rearranges —
// only genuine new acquisitions.
function placeAcquiredCard(state, seat, cardId, slot, { offerPostAcquire = true } = {}) {
  placeInSlot(state, seat, cardId, slot);
  if (offerPostAcquire) offerPostAcquireDiscard(state, seat, cardId);
}

function offerPostAcquireDiscard(state, seat, cardId) {
  const c = card(cardId);
  const choices = [];
  // Stainglass draws 1 per Powerful performer on stage, so with none there is
  // nothing the trade could produce — don't offer it at all.
  if (
    trainerActive(state, seat, TRAINERS.STAINGLASS) &&
    countActivePerformers(state, seat, (x) => x.characteristic === 'Powerful') > 0
  ) {
    choices.push('stainglass');
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
  if (cardId === TRAINERS.BARRE) relocateReserveOnBarreLeaving(state, seat);
}

// Madame Barre: while active, acquired cards may be freely parked in reserve
// even when a matching active slot is open. Once she's discarded, that
// standing exception ends — any reserve card that could now fill an empty,
// correctly-matching active slot is immediately moved there. (Cards already
// sitting in a mismatched active slot are unaffected — see applyRearrange —
// and stay put until they themselves are discarded.)
function relocateReserveOnBarreLeaving(state, seat) {
  const p = state.players[seat];
  for (const cardId of [...p.reserve]) {
    const c = card(cardId);
    if (!SLOTTABLE.has(c.cardType)) continue;
    const emptySlot = SLOTS_FOR_TYPE[c.cardType].find((i) => p.slots[i] == null);
    if (emptySlot == null) continue;
    const ri = p.reserve.indexOf(cardId);
    p.reserve.splice(ri, 1);
    p.slots[emptySlot] = cardId;
    log(state, `${p.name}'s ${c.name} moves from reserve into ${SLOT_NAMES[emptySlot]} — Madame Barre has left play.`);
  }
}

// A card may never idle in reserve while an empty starter slot it legally
// fits is sitting open — if it can be a starter, it must be. Enforced as a
// standing invariant during the draft phase (see advance()), so it catches
// every way a slot can open up mid-turn: a Trainer bumped out of slot 7 by a
// a newly acquired Prop relocates into an empty Trainer slot, a card lost to
// Jonas frees a slot a reserve Performer must fill, and so on.
//
// Two deliberate carve-outs:
//   - Madame Barre. Her whole standing exception is that her holder MAY park
//     acquired cards in reserve with a matching slot open, so this invariant
//     is skipped entirely for a seat while she's active (and
//     relocateReserveOnBarreLeaving sweeps up the moment she leaves play).
//   - The dice phase. Refilling there stays at its own designated 'refill'
//     stage — after trophy fatigue and the Tomato batch have resolved — so a
//     card promoted out of reserve never eats hits from dice already rolled
//     this round. That stage enforces the same "fill every slot you can"
//     rule via refillIsNeeded, so the invariant still holds by end of round.
//
// A card with exactly one legal empty slot is moved automatically (there is
// nothing to decide). A card with several — a Trainer with slots 6, 7 and 8
// all open — is a genuine choice, so it raises the normal mandatory 'refill'
// prompt instead and the player picks. Returns true if anything changed.
function enforceReservePlacement(state) {
  let changed = false;
  for (const p of state.players) {
    const seat = p.seat;
    if (trainerActive(state, seat, TRAINERS.BARRE)) continue;

    // Auto-place every forced card first. Each placement can change which
    // slots are open, so rescan from the top until nothing more is forced.
    let again = true;
    while (again) {
      again = false;
      for (const cardId of [...p.reserve]) {
        const c = card(cardId);
        if (!SLOTTABLE.has(c.cardType)) continue;
        const empties = SLOTS_FOR_TYPE[c.cardType].filter((i) => p.slots[i] == null);
        if (empties.length !== 1) continue; // 0 = nowhere to go; >1 = a real choice, prompted below
        const slot = empties[0];
        p.reserve.splice(p.reserve.indexOf(cardId), 1);
        p.slots[slot] = cardId; // keeps its current hearts, same as a refill
        log(state, `${p.name}'s ${c.name} moves from reserve into ${SLOT_NAMES[slot]} — a card that can be a starter must be one.`);
        changed = true;
        again = true;
        break;
      }
    }

    // Anything still placeable has more than one destination — let them choose.
    if (refillIsNeeded(state, seat) && !state.pending.some((x) => x.kind === 'refill' && x.seat === seat)) {
      pushPending(state, 'refill', seat, {});
      changed = true;
    }
  }
  return changed;
}

// Jonas Quickfinger: collect `amount` units of a card's printed resource in
// one shot (no boosts — this isn't a Collection Die roll, just a straight
// cash-in). Used for his discard-a-performer-for-resources action, where
// amount is the discarded performer's power dots.
function collectResourceUnits(state, seat, c, amount, reason) {
  if (amount <= 0) return;
  const p = state.players[seat];
  if (c.resource === 'Star') {
    addStars(state, seat, amount);
    log(state, `${p.name} collects ${amount} star${amount === 1 ? '' : 's'} (${reason}).`);
  } else if (c.resource === 'Coin') {
    grantCoinsAndHearts(state, seat, amount, 0, reason);
  } else {
    grantCoinsAndHearts(state, seat, 0, amount, reason);
  }
}

// THE ACTIVE-PERFORMER RULE
// -------------------------
// Whenever a Trainer's ability keys off "your performers", it means only the
// ones actually on stage — mat slots 0-4. Cards in reserve are held, not
// performing, and never count. Every performer-counting ability routes
// through these two helpers so the rule can't drift apart card by card.
//
// There are exactly two deliberate exceptions, both written into the
// Trainer's own printed text rather than handled here:
//   - Bellacanto the Choirmistress: her Singers in reserve also collect on a
//     matching Collection Die (see resolveCollectionDie's reserve branch).
//   - Amara the Reliquary: she may move hearts on any of her cards, reserve
//     included (see the 'amaraMoveHearts' action).
export function activePerformers(state, seat) {
  const p = state.players[seat];
  const out = [];
  for (let i = 0; i < 5; i++) {
    const id = p.slots[i];
    if (id && card(id).cardType === 'performer') out.push(id);
  }
  return out;
}

// Count active performers matching a predicate over the card data — e.g.
// (c) => c.type === 'Dancer', or (c) => c.characteristic === 'Graceful'.
export function countActivePerformers(state, seat, pred) {
  return activePerformers(state, seat).filter((id) => pred(card(id))).length;
}

// The Vanishing Valentino's payable cost: Dramatic performers this seat owns,
// on stage OR in reserve. His printed text says "on stage or in reserve", so
// he's a third, narrower carve-out from the active-performer rule above —
// scoped to what he can spend, not to any ongoing effect.
export function dramaticPerformersOwned(state, seat) {
  const p = state.players[seat];
  return [...p.slots.filter(Boolean), ...p.reserve].filter((id) => {
    const c = card(id);
    return c.cardType === 'performer' && c.characteristic === 'Dramatic';
  });
}

// Tomasso the Terrible: how many Dancer performers this seat has on stage —
// determines how many Tomato dice they may roll (at least 1 required).
function dancerCount(state, seat) {
  return countActivePerformers(state, seat, (c) => c.type === 'Dancer');
}

// Ezra the Sleight-of-Hand: at least one Illusionist on stage?
function hasIllusionist(state, seat) {
  return countActivePerformers(state, seat, (c) => c.type === 'Illusionist') > 0;
}

function placeInSlot(state, seat, cardId, slot) {
  const p = state.players[seat];
  const old = p.slots[slot];
  if (old) {
    p.reserve.push(old);
    log(state, `${p.name}'s ${card(old).name} moves to reserve.`);
  }
  p.slots[slot] = cardId;
  setStartingHearts(state, seat, cardId);
  const startFull = trainerActive(state, seat, TRAINERS.COEUR);
  log(state, `${p.name} places ${card(cardId).name} in ${SLOT_NAMES[slot]}${startFull ? ' at full hearts (Madame Coeur)' : ''}.`);
}

// Give a newly acquired card its printed starting hearts. Applies wherever it
// lands — a card sent straight to reserve is just as "acquired" as one placed
// on the mat, and arrives with the same hearts filled in, so it's ready to go
// the moment it's promoted into a slot.
// Madame Coeur: acquired cards start at their printed maximum instead.
function setStartingHearts(state, seat, cardId) {
  const startFull = trainerActive(state, seat, TRAINERS.COEUR);
  state.hearts[cardId] = startFull ? maxHearts(state, seat, cardId) : (card(cardId).startingHearts ?? 0);
}

// A card drawn straight from the deck (currently only via the "Card"
// resource effect): resource/favor/reroll cards resolve or reserve exactly
// as they would from a normal acquisition. Slottable cards (performer/
// backdrop/prop/trainer) go into an empty starting slot automatically; if
// every natural slot for that card's type is already occupied, the player
// chooses whether to place it anyway (bumping the current occupant to
// reserve) or send the drawn card straight to reserve instead.
// offerPostAcquire=false suppresses Professor Stainglass's discard-to-draw
// offer for this card. Used for the card he lets you keep: only the card you
// originally acquired may be traded in, so the keep can't be recursively
// re-traded for another draw (which would otherwise let one acquisition churn
// the deck indefinitely).
function intakeDrawnCard(state, seat, cardId, { offerPostAcquire = true } = {}) {
  const p = state.players[seat];
  const c = card(cardId);
  if (c.cardType === 'resource' || c.cardType === 'favor' || c.cardType === 'reroll') {
    acquireCard(state, seat, cardId, null);
    return;
  }
  const allowed = allowedSlots(state, seat, cardId);
  if (!trainerActive(state, seat, TRAINERS.BARRE)) {
    const natural = SLOTS_FOR_TYPE[c.cardType];
    const emptySlot = natural.find((i) => p.slots[i] == null);
    if (emptySlot != null) {
      placeAcquiredCard(state, seat, cardId, emptySlot, { offerPostAcquire });
      return;
    }
  }
  // Madame Barre active: always a genuine choice, any of the 8 mat slots
  // (or reserve — see the 'cardResourcePlacement' resolution), even when a
  // natural slot is open.
  pushPending(state, 'cardResourcePlacement', seat, { cardId, allowedSlots: allowed, noPostAcquire: !offerPostAcquire });
}

// ---------------------------------------------------------------------------
// Turn / phase flow
// ---------------------------------------------------------------------------

// Slots sold via buyMarket sit empty (null) for the rest of the turn so
// prices stay stable across multiple buys (Maximillian, Favor bonus turns).
// Once play is truly moving on, collapse the gaps and refill from the deck.
function compactMarket(state) {
  const remaining = state.market.filter(Boolean);
  if (remaining.length === state.market.length) return;
  state.market = remaining.concat(draw(state, MARKET_SIZE - remaining.length));
}

function finishTurn(state) {
  const seat = state.turn.seat;
  const p = state.players[seat];
  const bonusQueue = state.turn.bonusQueue || [];
  p.turns++;
  state.turn = null;
  state.turnsCompleted++;

  // The market only slides once this seat's turn is truly over. A same-seat
  // Favor bonus turn continues the same turn from the player's perspective
  // (see the bonusQueue branch below), so skip compacting here and let it
  // happen the next time finishTurn resolves without a queued bonus turn.
  if (bonusQueue.length === 0) compactMarket(state);

  // Alt Solo: after every finished turn (including a Favor bonus turn — it's
  // a turn in its own right), roll the d8 — see ALT_SOLO_DIE_FACES. It may
  // discard from either end of the draft row (in place of the normal "leave
  // 1, discard it" ending below) and/or raise this round's star target.
  if (state.altSolo) rollAltSoloDie(state);

  // Draft ends the moment the row runs out. In Alt Solo that's strictly 0 —
  // its fixed 5-card row is drained entirely by picks and the d8's discard
  // faces, with no "leave 1 card, auto-discard it" step (see rollAltSoloDie).
  const drained = state.altSolo ? state.draftRow.length === 0 : state.draftRow.length <= 1;
  if (drained) {
    if (!state.altSolo && state.draftRow.length === 1) {
      const last = state.draftRow.pop();
      // Ezra the Sleight-of-Hand: if its (unique) owner has at least one
      // Illusionist on their board, the leftover card goes to them instead
      // of the discard pile — resolved exactly like any other acquisition
      // (resource cards resolve their effect and discard, favor/reroll cards
      // go to reserve, slottable cards fill an empty matching slot or prompt
      // a placement choice), via the same intakeDrawnCard dispatch used for
      // "Card" resource draws.
      const ezraOwner = state.players.find((pl) => trainerActive(state, pl.seat, TRAINERS.EZRA) && hasIllusionist(state, pl.seat));
      if (ezraOwner) {
        log(state, `${card(last).name} remains in the draft row — ${ezraOwner.name} receives it instead of it being discarded (Ezra the Sleight-of-Hand). The draft ends.`);
        intakeDrawnCard(state, ezraOwner.seat, last);
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
    trophyAssigned: false, // true once this round's Trophy is decided — see addStars
    barreRearrangeOpened: false, // true once this round's end-of-round Madame Barre rearrange prompts have been pushed — see stepDice's 'barreRearrange' stage
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
      if (state.altSolo) assignAltSoloResult(state);
      else assignTrophy(state);
      d.trophyAssigned = true; // stars earned from here on carry to next round
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
      d.stage = 'barreRearrange';
      return;
    }
    // Madame Barre: once trophy fatigue and the Tomato batch have both fully
    // resolved for the round (so this reflects who's actually still holding
    // her, and what's actually left standing), any seat with her still
    // active gets one blocking, optional chance to freely rearrange their
    // whole troupe — any card, any of the 8 mat slots, active or reserve —
    // before the round advances. See applyRearrange's allowAnySlot option
    // and resolvePendingItem's 'barreRearrange' case.
    case 'barreRearrange': {
      if (!d.barreRearrangeOpened) {
        d.barreRearrangeOpened = true;
        for (const p of state.players) {
          if (trainerActive(state, p.seat, TRAINERS.BARRE)) pushPending(state, 'barreRearrange', p.seat, {});
        }
        return;
      }
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
// TOTAL (career) coins currently owned -> better stand (i.e. more coins owned
// is the worse draft pick, mirroring assignTrophy's tie-break direction);
// then fewer trophies; then a roll-off.
export function assignDraftOrder(state) {
  const tiebreak = new Map(state.players.map((p) => [p.seat, randInt(state, 1000)]));
  const ranked = [...state.players].sort(
    (a, b) =>
      a.roundStars - b.roundStars ||
      a.coins - b.coins ||
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
  for (const p of state.players) {
    p.roundStars = p.carryStars || 0; // stars banked after scoring carry in
    p.carryStars = 0;
    p.roundCoins = 0;
    p.roundHearts = 0;
    p.turns = 0;
  }
  if (state.altSolo) state.altSoloTarget = 0; // fresh 1-round challenge, resets to the default of 0 each round
  state.draftRow = draw(state, state.altSolo ? ALT_SOLO_DRAFT_ROW_SIZE : state.players.length * 2 + 1);
  state.phase = 'draft';
  state.turn = newTurn(seatWithStand(state, 1));
  log(state, `— Round ${state.round} — ${Math.min(state.round, MAX_TOMATO_DICE)} tomato dice loom this round. ${nameOf(state, state.turn.seat)} drafts first.`);
}

// How many of each token are physically on the table right now, and how many
// are therefore still in the supply. Deliberately *derived* from board state
// rather than incremented/decremented at every grant and spend, so it can
// never drift: coins return to the pool the moment they're spent, hearts the
// moment they're lost or their card is discarded, and stars at the end of
// each round (only roundStars sit on the table — p.stars is just a lifetime
// tally, not physical tokens).
export function tokenSupply(state) {
  let heartsOut = 0;
  for (const id of Object.keys(state.hearts)) heartsOut += state.hearts[id] || 0;
  let coinsOut = 0;
  let starsOut = 0;
  for (const p of state.players) {
    coinsOut += p.coins;
    starsOut += p.roundStars;
  }
  const of = (out, total) => ({ out, total, left: total - out });
  return {
    hearts: of(heartsOut, TOKEN_SUPPLY.hearts),
    stars: of(starsOut, TOKEN_SUPPLY.stars),
    coins: of(coinsOut, TOKEN_SUPPLY.coins),
  };
}

// Refresh state.tokenSupply (so the client can render it without recomputing)
// and record the first — and then each new worst — time a pool runs dry.
// state.supplyAlerts persists for the rest of the game rather than clearing
// when the pool recovers, so a shortage spotted mid-game is still reported
// afterwards; that record is the whole point of tracking this.
function checkTokenSupply(state) {
  const supply = tokenSupply(state);
  state.tokenSupply = supply;
  for (const kind of ['hearts', 'stars', 'coins']) {
    const { out, total, left } = supply[kind];
    if (left > 0) continue;
    const deficit = -left;
    const prev = state.supplyAlerts[kind];
    if (prev && deficit <= prev.deficit) continue;
    state.supplyAlerts[kind] = { deficit, round: state.round, out, total };
    log(
      state,
      deficit > 0
        ? `⚠ TOKEN SUPPLY: the ${kind} pool is ${deficit} short — ${out} in play, only ${total} exist.`
        : `⚠ TOKEN SUPPLY: the last ${kind} token has been taken (${out}/${total} in play).`
    );
  }
}

// Run every automatic step until the game needs input (or is over).
function advance(state) {
  let guard = 0;
  while (guard++ < 10000) {
    checkTokenSupply(state);
    if (state.phase === 'gameOver') return;
    if (state.pending.length > 0) return;
    // "A card that can be a starter must be one" — re-checked every time the
    // engine settles during the draft. Deliberately not applied in the dice
    // phase, which refills at its own stage after the dice resolve. See
    // enforceReservePlacement.
    if (state.phase === 'draft' && enforceReservePlacement(state)) continue;
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
// Alt Solo mode — no Ghosts, no AI: just the human against a d8-driven round
// target instead of other players' scores.
// ---------------------------------------------------------------------------

// The 8 faces of the Alt Solo d8, in printed order (index 0 = face "1").
// Discard faces shrink the fixed 5-card draft row from either end (in place
// of the normal 2-5p "leave 1 card, discard it" ending — see finishTurn);
// target faces raise this round's star target, the bar the player's own
// roundStars must clear (not tie) to win the round's Trophy.
export const ALT_SOLO_DIE_FACES = [
  { kind: 'discard', side: 'right', count: 1, label: 'Discard the right-most draft card' },
  { kind: 'discard', side: 'left', count: 1, label: 'Discard the left-most draft card' },
  { kind: 'discard', side: 'right', count: 2, label: 'Discard the 2 right-most draft cards' },
  { kind: 'discard', side: 'left', count: 2, label: 'Discard the 2 left-most draft cards' },
  { kind: 'target', amount: 1, resetMarket: true, label: 'Add 1 star to the round target and reset the market' },
  { kind: 'target', amount: 2, resetMarket: true, label: 'Add 2 stars to the round target and reset the market' },
  { kind: 'target', amount: 1, resetMarket: false, label: 'Add 1 star to the round target' },
  { kind: 'target', amount: 2, resetMarket: false, label: 'Add 2 stars to the round target' },
];

function rollAltSoloDie(state) {
  const rollIdx = randInt(state, ALT_SOLO_DIE_FACES.length);
  const face = ALT_SOLO_DIE_FACES[rollIdx];
  const rollNumber = rollIdx + 1;
  state.altSoloRollEvent = { roll: rollNumber, label: face.label };
  log(state, `Alt Solo d8 rolls a ${rollNumber} — ${face.label}.`);

  if (face.kind === 'discard') {
    const removed = [];
    for (let i = 0; i < face.count && state.draftRow.length > 0; i++) {
      removed.push(face.side === 'right' ? state.draftRow.pop() : state.draftRow.shift());
    }
    if (removed.length > 0) {
      state.discard.push(...removed);
      log(state, `${removed.map((id) => card(id).name).join(', ')} discarded from the draft row.`);
    }
    return;
  }

  // face.kind === 'target'
  state.altSoloTarget += face.amount;
  log(state, `The round target rises to ${state.altSoloTarget} star${state.altSoloTarget === 1 ? '' : 's'}.`);
  if (face.resetMarket) {
    state.discard.push(...state.market.filter(Boolean));
    state.market = draw(state, MARKET_SIZE);
    log(state, 'The market is reset.');
  }
}

// Alt Solo's replacement for assignTrophy: there's no one else to compare
// against, so the round's outcome is the player's own roundStars against
// this round's altSoloTarget (raised over the round by rollAltSoloDie).
// Strictly more than the target wins the round's Trophy (and, same as the
// normal game's trophy-winner heart removal, costs 1 heart from each of the
// 8 starters); a tie or a shortfall loses the round — no heart penalty, per
// the owner's ruling, just a mark against ALT_SOLO_LOSS_LIMIT.
export function assignAltSoloResult(state) {
  const p = state.players[0];
  if (p.roundStars > state.altSoloTarget) {
    p.trophies++;
    log(state, `${p.name} earned ${p.roundStars} star${p.roundStars === 1 ? '' : 's'}, clearing the round target of ${state.altSoloTarget} — takes a Trophy! (${p.trophies}/${state.trophyGoal})`);
    for (let i = 0; i < 8; i++) heartHit(state, p.seat, i, 'trophy fatigue');
    if (p.trophies >= state.trophyGoal) {
      state.phase = 'gameOver';
      state.winners = [p.seat];
      log(state, `The crowd roars — ${p.name} wins the game!`);
    }
  } else {
    state.altSoloLosses++;
    log(state, `${p.name} earned ${p.roundStars} star${p.roundStars === 1 ? '' : 's'}, failing to clear the round target of ${state.altSoloTarget} — the round is lost. (${state.altSoloLosses}/${ALT_SOLO_LOSS_LIMIT} losses)`);
    if (state.altSoloLosses >= ALT_SOLO_LOSS_LIMIT) {
      state.phase = 'gameOver';
      state.winners = [];
      log(state, `${p.name} has lost ${ALT_SOLO_LOSS_LIMIT} rounds — the show is cancelled. Game over.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Ghost seats (solo mode)
// ---------------------------------------------------------------------------

// The 12 faces of the Ghost d12, in printed order (index 0 = face "1"). Two
// of the draft faces additionally grant an extra roll — a bonus action
// chained onto the same Ghost turn, resolved by rolling again rather than
// ending the turn.
export const GHOST_DIE_FACES = [
  { kind: 'resetMarket', resource: 'coins', label: 'Reset market and collect 3 coins' },
  { kind: 'resetMarket', resource: 'hearts', label: 'Reset market and collect 3 hearts' },
  { kind: 'buyMarket', index: 0, label: 'Buy market slot 1' },
  { kind: 'buyMarket', index: 1, label: 'Buy market slot 2' },
  { kind: 'buyMarket', index: 2, label: 'Buy market slot 3' },
  { kind: 'buyMarket', index: 3, label: 'Buy market slot 4' },
  { kind: 'draft', side: 'left', again: false, label: 'Draft the left-most card' },
  { kind: 'draft', side: 'left', again: false, label: 'Draft the left-most card' },
  { kind: 'draft', side: 'right', again: false, label: 'Draft the right-most card' },
  { kind: 'draft', side: 'right', again: false, label: 'Draft the right-most card' },
  { kind: 'draft', side: 'left', again: true, label: 'Draft the left-most card, then roll again' },
  { kind: 'draft', side: 'right', again: true, label: 'Draft the right-most card, then roll again' },
];

// Roll the Ghost d12 and resolve exactly one face. A face that can't
// actually be completed right now (an unaffordable buy, an empty slot) or
// that explicitly grants another roll leaves the turn open (mainDone/done
// unset, or open:true for a Maximillian chain-buy) so the driver rolls
// again; every other face ends the Ghost's turn, same as any normal main
// action. Reuses the exact same acquireCard/marketCost machinery a human's
// buyMarket/acquireDraft would, so every passive rule (Barnaby's discount,
// Maximillian's chain buys, the market price freeze, Stainglass's
// post-acquire offer, a full mat slot's placement choice, etc.) applies to
// a Ghost identically — only the *choice* of which slot/card comes from the
// die instead of a human clicking.
function resolveGhostRoll(state, seat) {
  const p = state.players[seat];
  const rollIdx = randInt(state, GHOST_DIE_FACES.length);
  const face = GHOST_DIE_FACES[rollIdx];
  const rollNumber = rollIdx + 1;
  state.ghostRollEvent = { seat, roll: rollNumber, label: face.label };
  log(state, `${p.name} (Ghost) rolls a ${rollNumber} on the d12 — ${face.label}.`);

  if (face.kind === 'resetMarket') {
    state.discard.push(...state.market.filter(Boolean));
    state.market = draw(state, MARKET_SIZE);
    if (face.resource === 'coins') grantCoinsAndHearts(state, seat, 3, 0, 'Ghost roll: reset market');
    else grantCoinsAndHearts(state, seat, 0, 3, 'Ghost roll: reset market');
    state.turn.mainDone = true;
    state.turn.done = true;
    return;
  }

  if (face.kind === 'buyMarket') {
    const i = face.index;
    if (!state.market[i]) {
      log(state, `${p.name} (Ghost) finds that market slot already sold — rolls again.`);
      return;
    }
    const cost = marketCost(state, seat, i);
    if (p.coins < cost) {
      log(state, `${p.name} (Ghost) can't afford that slot (needs ${cost}, has ${p.coins}) — rolls again.`);
      return;
    }
    p.coins -= cost;
    const cardId = state.market[i];
    state.market[i] = null;
    log(state, `${p.name} (Ghost) buys ${card(cardId).name} from the market for ${cost} coins.`);
    acquireCard(state, seat, cardId, null);
    state.turn.mainDone = true;
    state.turn.buys = (state.turn.buys || 0) + 1;
    // Same as a human's buyMarket: consumes a Maximillian bonus buy if one is
    // owed, and never grants another.
    if (state.turn.bonusBuys > 0) state.turn.bonusBuys -= 1;
    state.turn.open = state.turn.bonusBuys > 0;
    state.turn.done = !state.turn.open;
    return;
  }

  // face.kind === 'draft'
  if (state.draftRow.length === 0) {
    log(state, `${p.name} (Ghost) finds the draft row empty — rolls again.`);
    return;
  }
  const idx = face.side === 'left' ? 0 : state.draftRow.length - 1;
  const cardId = state.draftRow[idx];
  const c = card(cardId);
  if (state.turn.isBonus && c.cardType === 'favor' && c.triggerAfterTurn === state.turn.bonusTiming) {
    log(state, `${p.name} (Ghost) can't draft a same-timing Favor on a bonus turn — rolls again.`);
    return;
  }
  state.draftRow.splice(idx, 1);
  log(state, `${p.name} (Ghost) drafts ${c.name} for free.`);
  acquireCard(state, seat, cardId, null);
  state.turn.mainDone = true;
  // Maximillian: a Ghost's draft earns a market buy too, taken by rolling
  // again (a buyMarket face consumes it; anything else simply forfeits it).
  if (trainerActive(state, seat, TRAINERS.MAXIMILLIAN)) {
    state.turn.bonusBuys += 1;
    state.turn.open = true;
  }
  if (face.again) {
    // Extra roll granted — the turn continues, offering a fresh main action.
    state.turn.mainDone = false;
  } else if (!state.turn.open) {
    state.turn.done = true;
  }
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
      // Maximillian the Magnate: drafting a card also earns one market buy,
      // so the turn stays open for it (declined via endTurn).
      if (trainerActive(state, seat, TRAINERS.MAXIMILLIAN)) {
        state.turn.bonusBuys += 1;
        state.turn.open = true;
        log(state, `${nameOf(state, seat)} may also buy one card from the market (Maximillian the Magnate).`);
      } else {
        state.turn.done = true;
      }
      break;
    }
    case 'buyMarket': {
      requireTurn(state, seat);
      const i = action.index;
      if (!Number.isInteger(i) || i < 0 || i >= state.market.length) throw new Error('Invalid market slot.');
      if (state.turn.mainDone && !state.turn.open) throw new Error('You have already acted this turn.');
      if (!state.market[i]) throw new Error('That market slot has already been sold this turn.');
      const cost = marketCost(state, seat, i);
      const p = state.players[seat];
      if (p.coins < cost) throw new Error(`You need ${cost} coins for that market slot.`);
      p.coins -= cost;
      const cardId = state.market[i];
      // The sold slot is left empty (not shifted/refilled) until this seat's
      // turn is actually over — see compactMarket — so a player buying
      // multiple cards in one turn (Favor, Maximillian) sees stable prices.
      state.market[i] = null;
      log(state, `${p.name} buys ${card(cardId).name} from the market for ${cost} coins.`);
      acquireCard(state, seat, cardId, action.slot ?? null);
      state.turn.mainDone = true;
      state.turn.buys++;
      // A market buy consumes a Maximillian bonus buy if one is owed, and
      // never grants another — only drafting earns them, so buys can't chain.
      if (state.turn.bonusBuys > 0) state.turn.bonusBuys -= 1;
      state.turn.open = state.turn.bonusBuys > 0;
      state.turn.done = !state.turn.open;
      break;
    }
    case 'resetMarket': {
      requireTurn(state, seat);
      if (state.turn.mainDone) throw new Error('You can only reset the market before your acquire decision.');
      const p = state.players[seat];
      if (p.coins < 1) throw new Error('Resetting the market costs 1 coin.');
      p.coins -= 1;
      state.discard.push(...state.market.filter(Boolean));
      state.market = draw(state, MARKET_SIZE);
      state.turn.resets += 1;
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
    // Wendell the Propmaster: spend your whole turn to take any Prop or
    // Backdrop card, your choice, straight out of the discard pile. Placed
    // exactly like any other acquisition (natural slot, or the usual
    // bump-to-reserve / send-to-reserve choice if that slot is already
    // occupied) — and since every Prop/Backdrop's printed starting-heart
    // value already equals its max, it always enters play with hearts full.
    case 'wendellTakeDiscard': {
      requireTurn(state, seat);
      if (state.turn.mainDone) throw new Error('You have already acted this turn.');
      if (!trainerActive(state, seat, TRAINERS.WENDELL)) throw new Error('Wendell the Propmaster is not your active Trainer.');
      const cardId = action.cardId;
      const idx = state.discard.indexOf(cardId);
      if (idx === -1) throw new Error('That card is not in the discard pile.');
      const c = card(cardId);
      if (c.cardType !== 'prop' && c.cardType !== 'backdrop') {
        throw new Error('Wendell the Propmaster can only take a Prop or Backdrop from the discard pile.');
      }
      const p = state.players[seat];
      state.discard.splice(idx, 1);
      log(state, `${p.name} spends the turn with Wendell the Propmaster — takes ${c.name} from the discard pile.`);
      acquireCard(state, seat, cardId, action.slot ?? null);
      state.turn.mainDone = true;
      state.turn.done = true;
      break;
    }
    // The Vanishing Valentino: to start your turn, you may discard 1 card from
    // the draft row per Dramatic performer on stage. Free (the turn's main
    // action is untouched) and once per turn, like every other "to start your
    // turn" Trainer. The player chooses exactly which cards go, so it's
    // targeted denial rather than a blind trim; taking fewer than the maximum
    // is allowed. Reserve Dramatic performers do not count — the standard
    // active-performer rule applies.
    case 'valentinoTrimDraft': {
      requireTurn(state, seat);
      if (state.turn.mainDone) throw new Error('This must be used before your main turn action.');
      if (!trainerActive(state, seat, TRAINERS.VALENTINO)) throw new Error('The Vanishing Valentino is not your active Trainer.');
      if (state.turn.valentinoUsed) throw new Error('You have already used that this turn.');
      const p = state.players[seat];
      const allowance = countActivePerformers(state, seat, (c) => c.characteristic === 'Dramatic');
      if (allowance < 1) throw new Error('You need at least one Dramatic performer on stage.');
      const ids = action.cardIds || [];
      if (ids.length < 1) throw new Error('Choose at least one draft card to discard.');
      if (ids.length > allowance) throw new Error(`You may discard at most ${allowance} draft card(s).`);
      if (new Set(ids).size !== ids.length) throw new Error('Card listed twice.');
      for (const id of ids) {
        if (!state.draftRow.includes(id)) throw new Error('That card is not in the draft row.');
      }
      for (const id of ids) {
        state.draftRow.splice(state.draftRow.indexOf(id), 1);
        state.discard.push(id);
      }
      state.turn.valentinoUsed = true;
      log(state, `${p.name} vanishes ${ids.map((id) => card(id).name).join(', ')} from the draft (The Vanishing Valentino).`);
      break;
    }
    // Jonas Quickfinger: to start your turn, you may discard one Haunting
    // performer from your stage and take its printed resource times its power
    // dots. Free (the main action is untouched) and once per turn. Only
    // active performers are eligible — the standard active-performer rule.
    case 'jonasDiscard': {
      requireTurn(state, seat);
      if (state.turn.mainDone) throw new Error('This must be used before your main turn action.');
      if (!trainerActive(state, seat, TRAINERS.JONAS)) throw new Error('Jonas Quickfinger is not your active Trainer.');
      if (state.turn.jonasUsed) throw new Error('You have already used that this turn.');
      const p = state.players[seat];
      const cardId = action.cardId;
      const slotIdx = p.slots.indexOf(cardId);
      if (slotIdx < 0 || slotIdx > 4) throw new Error('That is not one of your active Performers.');
      const c = card(cardId);
      if (c.characteristic !== 'Haunting') throw new Error('Jonas Quickfinger only takes Haunting performers.');
      const amount = c.powerDots;
      log(state, `${p.name} discards ${c.name} for ${amount} ${c.resource.toLowerCase()}${amount === 1 ? '' : 's'} (Jonas Quickfinger).`);
      discardOwnedCard(state, seat, cardId);
      collectResourceUnits(state, seat, c, amount, 'Jonas Quickfinger');
      state.turn.jonasUsed = true;
      break;
    }
    // Celestine the Stargazer: to start your turn, you may buy up to 2
    // stars for 2 coins each.
    case 'celestineBuyStars': {
      requireTurn(state, seat);
      if (state.turn.mainDone) throw new Error('This must be used before your main turn action.');
      if (!trainerActive(state, seat, TRAINERS.CELESTINE)) throw new Error('Celestine the Stargazer is not your active Trainer.');
      if (state.turn.celestineUsed) throw new Error('You have already used that this turn.');
      const n = action.count;
      if (!Number.isInteger(n) || n < 1 || n > CELESTINE_MAX_STARS) throw new Error(`Choose 1-${CELESTINE_MAX_STARS} stars.`);
      const p = state.players[seat];
      const cost = n * CELESTINE_STAR_COST;
      if (p.coins < cost) throw new Error(`You need ${cost} coins for that.`);
      p.coins -= cost;
      addStars(state, seat, n);
      state.turn.celestineUsed = true;
      log(state, `${p.name} spends ${cost} coins to buy ${n} star${n > 1 ? 's' : ''} (Celestine the Stargazer).`);
      break;
    }
    // Amara the Reliquary: to start your turn, you may rearrange up to 3
    // hearts across your cards — submitted one move at a time, each from one
    // card to another, capped by the destination's printed capacity. Hearts
    // are only ever relocated, never created or destroyed, so a player's
    // total is unchanged. Reserve cards are eligible on both ends: Amara is
    // one of the two documented exceptions to the active-performer rule (see
    // activePerformers), because her text says "any of your cards".
    case 'amaraMoveHeart': {
      requireTurn(state, seat);
      if (state.turn.mainDone) throw new Error('This must be used before your main turn action.');
      if (!trainerActive(state, seat, TRAINERS.AMARA)) throw new Error('Amara the Reliquary is not your active Trainer.');
      if (state.turn.amaraMoves >= AMARA_MAX_MOVES) throw new Error(`You have already rearranged ${AMARA_MAX_MOVES} hearts this turn.`);
      const p = state.players[seat];
      const { fromCardId, toCardId } = action;
      const owned = new Set([...p.slots.filter(Boolean), ...p.reserve]);
      if (!owned.has(fromCardId) || !owned.has(toCardId)) throw new Error('You can only move a heart between your own cards.');
      if (fromCardId === toCardId) throw new Error('Choose two different cards.');
      if ((state.hearts[fromCardId] || 0) < 1) throw new Error('That card has no heart to move.');
      if (capacityLeft(state, seat, toCardId) < 1) throw new Error('That card has no room for another heart.');
      state.hearts[fromCardId] -= 1;
      state.hearts[toCardId] = (state.hearts[toCardId] || 0) + 1;
      state.turn.amaraMoves += 1;
      log(state, `${p.name} moves a heart from ${card(fromCardId).name} to ${card(toCardId).name} (Amara the Reliquary, ${state.turn.amaraMoves}/${AMARA_MAX_MOVES}).`);
      break;
    }
    // ----- Ghost seats (solo mode) ---------------------------------------
    // A Ghost's whole main turn action is decided by a d12 roll instead of
    // AI heuristics — see resolveGhostRoll and GHOST_DIE_FACES. The solo
    // human player is the one who submits this action (there is no socket
    // "controlling" a Ghost seat), so `seat` here is the human's own seat,
    // not the Ghost's — same pattern as the pre-roll Press Pass window and
    // Mesmera's reaction, which are also submitted by whichever seat the
    // rule lets act, not necessarily state.turn.seat.
    case 'rollGhostDie': {
      if (state.phase !== 'draft' || !state.turn) throw new Error('No Ghost turn is active right now.');
      if (state.pending.length > 0) throw new Error('Resolve the current prompt first.');
      const ghostSeat = state.turn.seat;
      const ghost = state.players[ghostSeat];
      if (!ghost || !ghost.isGhost) throw new Error("It isn't a Ghost's turn.");
      if (!state.players[seat] || state.players[seat].isGhost) throw new Error('Only the solo player may roll for a Ghost.');
      // Mirrors buyMarket's own tolerance for Maximillian chain-buys: once
      // the Ghost's main action is spent, only an explicitly still-open turn
      // (another buy still allowed) may roll again.
      if (state.turn.mainDone && !state.turn.open) throw new Error('This Ghost has already acted this turn.');
      resolveGhostRoll(state, ghostSeat);
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
        setStartingHearts(state, seat, item.data.cardId); // reserved cards still arrive with their hearts filled in
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
        setStartingHearts(state, seat, it.cardId); // reserved cards still arrive with their hearts filled in
        log(state, `${p.name} sends ${card(it.cardId).name} to reserve instead of placing it.`);
        break;
      }
      const slot = action.slot;
      if (!Number.isInteger(slot) || !it.allowedSlots.includes(slot)) throw new Error('Invalid slot for that card.');
      removePending(state, item.id);
      placeAcquiredCard(state, seat, it.cardId, slot, { offerPostAcquire: !it.noPostAcquire });
      break;
    }
    // Professor Stainglass: right after acquiring a matching card, its
    // owner may immediately discard it for that Trainer's stated effect
    // instead of keeping it. See offerPostAcquireDiscard. (Jonas Quickfinger
    // has never been part of this prompt — see the separate 'jonasDiscard'
    // turn action instead; Wendell the Propmaster is a whole-turn action
    // now — see the 'wendellTakeDiscard' turn action instead.)
    case 'postAcquireDiscard': {
      const choice = action.choice;
      if (!item.data.choices.includes(choice) && choice !== 'keep') throw new Error('Invalid choice.');
      const { cardId, cardName } = item.data;
      removePending(state, item.id);
      if (choice === 'keep') break;
      if (choice === 'stainglass') {
        // Professor Stainglass: discard the card you just acquired to draw 1
        // per Powerful performer on stage, then keep exactly one of them —
        // the rest are discarded. With no Powerful performers there is
        // nothing to draw, so the offer isn't made in the first place (see
        // offerPostAcquireDiscard).
        const n = countActivePerformers(state, seat, (c) => c.characteristic === 'Powerful');
        discardOwnedCard(state, seat, cardId);
        const drawn = draw(state, n);
        if (drawn.length === 0) {
          log(state, `${p.name} discards ${cardName} (Professor Stainglass) but the deck is empty — nothing drawn.`);
          break;
        }
        log(state, `${p.name} discards ${cardName} (Professor Stainglass) to draw ${drawn.length} card(s) — keeping one.`);
        if (drawn.length === 1) {
          intakeDrawnCard(state, seat, drawn[0], { offerPostAcquire: false });
          break;
        }
        pushPending(state, 'stainglassKeep', seat, { drawn });
      }
      break;
    }
    // Professor Stainglass: pick exactly one of the cards just drawn to keep
    // (placed like any normal acquisition); the others go to the discard pile.
    case 'stainglassKeep': {
      const { drawn } = item.data;
      const keepId = action.cardId;
      if (!drawn.includes(keepId)) throw new Error('That is not one of the cards you drew.');
      removePending(state, item.id);
      for (const id of drawn) {
        if (id !== keepId) state.discard.push(id);
      }
      log(state, `${p.name} keeps ${card(keepId).name} and discards the rest (Professor Stainglass).`);
      // The kept card may not itself be traded in for another draw — only the
      // card originally acquired can be.
      intakeDrawnCard(state, seat, keepId, { offerPostAcquire: false });
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
    // Madame Barre: end-of-round free rearrange. action.slots/reserve are
    // optional — omitting them (or passing nothing) just skips it, leaving
    // the troupe exactly as it is. See stepDice's 'barreRearrange' stage.
    case 'barreRearrange': {
      removePending(state, item.id);
      if (action.slots) {
        applyRearrange(state, seat, action.slots, action.reserve, { allowAnySlot: true });
        log(state, `${p.name} freely rearranges their troupe at the end of the round (Madame Barre).`);
      }
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
      // suitable reserve card is still available. Madame Barre is the
      // exception — her holder MAY fill empty slots at the end of a round but
      // is never required to, the same standing "reserve is yours to use"
      // privilege that exempts her from enforceReservePlacement mid-draft.
      if (!trainerActive(state, seat, TRAINERS.BARRE) && refillIsNeeded(state, seat)) {
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

function applyRearrange(state, seat, slots, reserve, { allowAnySlot = false } = {}) {
  const p = state.players[seat];
  if (!Array.isArray(slots) || slots.length !== 8 || !Array.isArray(reserve)) throw new Error('Malformed arrangement.');
  const before = [...p.slots.filter(Boolean), ...p.reserve].sort();
  const after = [...slots.filter(Boolean), ...reserve].sort();
  if (before.length !== after.length || before.some((id, i) => id !== after[i])) {
    throw new Error('Rearranging cannot add or remove cards.');
  }
  for (let i = 0; i < 8; i++) {
    const id = slots[i];
    if (!id) continue;
    const c = card(id);
    if (!SLOTTABLE.has(c.cardType)) throw new Error(`${c.name} cannot occupy a mat slot.`);
    // A card already sitting in a mismatched slot (placed there earlier via
    // Madame Barre's acquisition-time choice) may remain there untouched —
    // it isn't forced out until it's discarded — but a normal rearrange can
    // never introduce a *new* type mismatch. allowAnySlot (Madame Barre's
    // end-of-round free rearrange only) lifts this restriction entirely.
    const alreadyThere = p.slots[i] === id;
    if (!allowAnySlot && !alreadyThere && !SLOTS_FOR_TYPE[c.cardType].includes(i)) {
      throw new Error(`${c.name} cannot go in ${SLOT_NAMES[i]}.`);
    }
  }
  p.slots = [...slots.map((x) => x ?? null)];
  p.reserve = [...reserve];
}
