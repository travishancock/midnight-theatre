// ---------------------------------------------------------------------------
// AI bot for The Midnight Theatre.
//
// botAction(state, seat) returns one legal action for that seat, or null if
// that seat has nothing to decide right now. Pure and synchronous — the
// server (and the tests) call it in a loop whenever a bot seat owes input.
//
// Heuristics follow the design brief's "AI bot behavior guidance": prefer
// free draft picks that fill empty slots, weight performers toward the
// resource the bot is behind on, spend Favors rather than hoard them, use
// re-roll cards defensively against Tomato dice, and never stall.
// ---------------------------------------------------------------------------

import { card } from './cards.js';
import {
  LETTER_FREQ,
  capacityLeft,
  heartTargets,
  totalCapacityLeft,
  eligibleFavors,
  marketCost,
  trainerActive,
  TRAINERS,
} from './engine.js';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function botAction(state, seat) {
  if (state.phase === 'gameOver') return null;

  // 1) Resolve any prompt addressed to this seat first — prompts block
  //    everything else in the engine.
  const item = state.pending.find((x) => x.seat === seat);
  if (item) return resolvePrompt(state, seat, item);
  if (state.pending.length > 0) return null; // someone else's prompt

  // 2) Take a draft turn if it is ours.
  if (state.phase === 'draft' && state.turn && state.turn.seat === seat && !state.turn.done) {
    return draftTurn(state, seat);
  }
  return null;
}

// Seats from which the engine currently needs input (prompt owners, or the
// active draft-turn seat). Useful for driver loops (server / tests).
export function seatsNeedingInput(state) {
  if (state.phase === 'gameOver') return [];
  if (state.pending.length > 0) return [...new Set(state.pending.map((x) => x.seat))];
  if (state.phase === 'draft' && state.turn && !state.turn.done) return [state.turn.seat];
  return [];
}

// ---------------------------------------------------------------------------
// Prompt resolution
// ---------------------------------------------------------------------------

function resolvePrompt(state, seat, item) {
  const base = { type: 'resolvePending', seat, pendingId: item.id };
  switch (item.kind) {
    case 'placement':
      return { ...base, slot: choosePlacementSlot(state, seat, item) };
    case 'heartAssign':
      return { ...base, assignments: chooseHeartAssignments(state, seat, item.data.amount) };
    case 'favorWindow': {
      // Spend favors rather than hoard them (brief guidance).
      const usable = eligibleFavors(state, seat);
      return { ...base, use: usable[0] ?? null };
    }
    case 'rerollOffer':
      return { ...base, use: chooseReroll(state, seat) };
    case 'mesmera':
      return { ...base, again: mesmeraWantsAnother(state, seat) };
    case 'refill':
      return { ...base, assignments: chooseRefill(state, seat) };
    default:
      // Unknown prompt kind: decline/no-op resolution keeps the game moving.
      return { ...base };
  }
}

// Prefer an empty allowed slot; otherwise bump the least valuable occupant.
function choosePlacementSlot(state, seat, item) {
  const p = state.players[seat];
  const allowed = item.data.allowedSlots;
  const empty = allowed.find((i) => p.slots[i] == null);
  if (empty != null) return empty;
  let best = allowed[0];
  let bestVal = Infinity;
  for (const i of allowed) {
    const v = occupantValue(state, seat, p.slots[i]);
    if (v < bestVal) {
      bestVal = v;
      best = i;
    }
  }
  return best;
}

function occupantValue(state, seat, id) {
  if (!id) return -1;
  const c = card(id);
  let v = (state.hearts[id] || 0);
  if (c.cardType === 'performer') v += LETTER_FREQ[c.letter] || 0;
  else v += 3; // backdrops/props/trainers are scarce — avoid bumping them
  return v;
}

// Assign exactly min(amount, capacity) hearts, favoring on-board cards with
// the fewest hearts (they are closest to being discarded by a Tomato hit).
function chooseHeartAssignments(state, seat, amount) {
  const p = state.players[seat];
  let left = Math.min(amount, totalCapacityLeft(state, seat));
  const targets = heartTargets(state, seat).sort((a, b) => {
    const aBoard = p.slots.includes(a) ? 0 : 1;
    const bBoard = p.slots.includes(b) ? 0 : 1;
    return aBoard - bBoard || (state.hearts[a] || 0) - (state.hearts[b] || 0);
  });
  const out = [];
  for (const id of targets) {
    if (left <= 0) break;
    const take = Math.min(left, capacityLeft(state, seat, id));
    if (take > 0) {
      out.push({ cardId: id, amount: take });
      left -= take;
    }
  }
  return out;
}

// Defensive re-roll logic. Returns the reserve card id to spend, or null to pass.
function chooseReroll(state, seat) {
  const ev = state.dieEvent;
  if (!ev) return null;
  const p = state.players[seat];
  const want = ev.kind === 'collection' ? 'collection' : 'tomato';
  const cardId = p.reserve.find((id) => card(id).cardType === 'reroll' && card(id).rerollTarget === want);
  if (!cardId) return null;

  if (ev.kind === 'tomato') {
    if (ev.excludeSeat === seat) return null; // Tomasso: this die cannot hit us
    return tomatoThreatens(state, seat, ev.value) ? cardId : null;
  }
  // Collection die: re-roll only when we gain nothing from the current letter
  // and we have enough performers that a new letter probably helps.
  if (collectionGain(state, seat, ev.value) > 0) return null;
  const lettersOnBoard = boardLetterCount(state, seat);
  return lettersOnBoard >= 3 ? cardId : null;
}

function tomatoThreatens(state, seat, value) {
  const p = state.players[seat];
  const id = p.slots[value - 1];
  if (!id) return false;
  return (state.hearts[id] || 0) <= 1; // the hit would discard this card
}

function collectionGain(state, seat, letter) {
  const p = state.players[seat];
  let n = 0;
  for (let i = 0; i < 5; i++) {
    const id = p.slots[i];
    if (id && card(id).cardType === 'performer' && card(id).letter === letter) n++;
  }
  return n;
}

function boardLetterCount(state, seat) {
  const p = state.players[seat];
  return p.slots.slice(0, 5).filter((id) => id && card(id).cardType === 'performer').length;
}

function mesmeraWantsAnother(state, seat) {
  const ev = state.dieEvent;
  if (!ev) return false;
  if (ev.kind === 'tomato') return tomatoThreatens(state, seat, ev.value);
  return collectionGain(state, seat, ev.value) === 0;
}

// Fill every fillable empty slot (mandatory). Performers: best first.
function chooseRefill(state, seat) {
  const p = state.players[seat];
  const remaining = [...p.reserve];
  const out = [];
  for (let slot = 0; slot < 8; slot++) {
    if (p.slots[slot] != null) continue;
    const wantType = slot <= 4 ? 'performer' : slot === 5 ? 'backdrop' : slot === 6 ? 'prop' : 'trainer';
    let bestIdx = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = card(remaining[i]);
      if (c.cardType !== wantType) continue;
      const v = (state.hearts[remaining[i]] || 0) * 2 + (c.cardType === 'performer' ? LETTER_FREQ[c.letter] || 0 : 1);
      if (v > bestVal) {
        bestVal = v;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) {
      out.push({ slot, cardId: remaining[bestIdx] });
      remaining.splice(bestIdx, 1);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Draft-turn choice
// ---------------------------------------------------------------------------

function draftTurn(state, seat) {
  const p = state.players[seat];

  // Maximillian follow-up buys: buy again only if a market card scores well
  // and we can spare the coins; otherwise end the turn.
  if (state.turn.open) {
    const buy = bestMarketBuy(state, seat, /*spare*/ 2);
    if (buy) return buy;
    return { type: 'endTurn', seat };
  }

  // Score every free draft card.
  let bestDraft = null;
  let bestDraftScore = -Infinity;
  for (const id of state.draftRow) {
    if (!legalDraftPick(state, id)) continue;
    const s = scoreCard(state, seat, id);
    if (s > bestDraftScore) {
      bestDraftScore = s;
      bestDraft = id;
    }
  }

  // Consider a market buy only when it clearly beats the best free pick.
  const buy = bestMarketBuy(state, seat, 0, bestDraftScore + 1.5);
  if (buy) return buy;

  if (bestDraft) return { type: 'acquireDraft', seat, cardId: bestDraft };

  // Extremely rare (e.g. a bonus turn where every remaining card is a
  // same-timing Favor): burn the turn with a no-op rearrange.
  return { type: 'rearrange', seat, slots: [...p.slots], reserve: [...p.reserve] };
}

function legalDraftPick(state, id) {
  const c = card(id);
  if (state.turn.isBonus && c.cardType === 'favor' && c.triggerAfterTurn === state.turn.bonusTiming) return false;
  return true;
}

function bestMarketBuy(state, seat, spareCoins, mustBeat = -Infinity) {
  const p = state.players[seat];
  let best = null;
  let bestScore = mustBeat;
  for (let i = 0; i < state.market.length; i++) {
    const cost = marketCost(state, seat, i);
    if (p.coins < cost + spareCoins) continue;
    const s = scoreCard(state, seat, state.market[i]) - cost * 0.9;
    if (s > bestScore) {
      bestScore = s;
      best = { type: 'buyMarket', seat, index: i };
    }
  }
  return best;
}

// Heuristic desirability of acquiring a card.
function scoreCard(state, seat, id) {
  const c = card(id);
  const p = state.players[seat];
  switch (c.cardType) {
    case 'performer': {
      let s = (LETTER_FREQ[c.letter] || 0) * 0.9 + (c.startingHearts || 0) * 0.6;
      const emptyPerformer = p.slots.slice(0, 5).some((x) => x == null);
      if (emptyPerformer) s += 2.2; // fill empty slots before bumping cards
      s += resourceNeedBonus(state, seat, c.resource);
      s += boostSynergy(state, seat, c);
      return s;
    }
    case 'backdrop':
    case 'prop': {
      const slot = c.cardType === 'backdrop' ? 5 : 6;
      let s = 1 + matchingPerformers(state, seat, c) * 0.8;
      if (p.slots[slot] == null) s += 2;
      else s -= 1.5; // already have one
      return s;
    }
    case 'trainer': {
      let s = 2.4;
      if (p.slots[7] == null) s += 2;
      else s -= 1.5;
      return s;
    }
    case 'resource': {
      if (c.resourceType === 'Heart' && totalCapacityLeft(state, seat) === 0) return 0.2;
      return 0.9 * (c.amount || 1) + (c.resourceType === 'Star' ? 0.6 : 0);
    }
    case 'favor':
      return 1.8;
    case 'reroll':
      return 1.4;
    default:
      return 0;
  }
}

// Prefer the resource we are furthest behind the table leader on.
function resourceNeedBonus(state, seat, resource) {
  const p = state.players[seat];
  const others = state.players.filter((x) => x.seat !== seat);
  const maxStars = Math.max(0, ...others.map((x) => x.stars));
  const maxCoins = Math.max(0, ...others.map((x) => x.coins));
  const starGap = Math.max(0, maxStars - p.stars);
  const coinGap = Math.max(0, maxCoins - p.coins);
  if (resource === 'Star') return Math.min(1.2, starGap * 0.15) + 0.4; // stars win trophies
  if (resource === 'Coin') return Math.min(0.9, coinGap * 0.12);
  // Hearts: valuable when our board is fragile.
  const fragile = p.slots.filter((id) => id && (state.hearts[id] || 0) <= 1).length;
  return Math.min(1.0, fragile * 0.25);
}

function boostSynergy(state, seat, performer) {
  let s = 0;
  for (const slotIdx of [5, 6]) {
    const id = state.players[seat].slots[slotIdx];
    if (!id) continue;
    const b = card(id);
    if (!b.boosts) continue;
    const key = b.boostKind === 'characteristic' ? performer.characteristic : performer.type;
    if (b.boosts.includes(key)) s += 0.7;
  }
  return s;
}

function matchingPerformers(state, seat, boostCard) {
  const p = state.players[seat];
  let n = 0;
  for (let i = 0; i < 5; i++) {
    const id = p.slots[i];
    if (!id) continue;
    const c = card(id);
    if (c.cardType !== 'performer') continue;
    const key = boostCard.boostKind === 'characteristic' ? c.characteristic : c.type;
    if (boostCard.boosts.includes(key)) n++;
  }
  return n;
}
