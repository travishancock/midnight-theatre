// ---------------------------------------------------------------------------
// Ghost seats — solo mode's 2 fixed non-AI opponents.
//
// A Ghost never uses AI heuristics (see bot.js). Its actual main turn
// action (draft / buy / reset market) is entirely decided by the solo
// player rolling a d12 — see engine.js's resolveGhostRoll and the
// 'rollGhostDie' action. This module only covers everything a Ghost does
// *around* that roll, per the owner's exact rules:
//
//   - Always spends every Press Pass card in the round it's acquired (the
//     window that opens right after the draft phase ends).
//   - Always spends a "1st" Favor on its own next literal 1st turn of a
//     round, and a "2nd" Favor on its own next literal 2nd turn — never
//     early, never held for later (unlike a human, who may sit on an
//     eligible Favor).
//   - Always fills earned hearts onto its board left to right, as evenly as
//     possible (round-robin across mat slots).
//
// Anything else a Ghost is offered (a full-slot placement bump, Professor
// Stainglass's post-acquire offer, Auric's convert choice, a mandatory
// refill, ...) isn't covered by the owner's rules, so it falls back to the
// same defaults bot.js already uses for the exact same prompts — reused
// directly, not reimplemented, so a Ghost behaves exactly like a
// conservative bot would in those unspecified situations.
//
// ghostAction(state, seat) mirrors bot.js's botAction(state, seat): called
// by the server driver whenever a Ghost seat has something to auto-resolve.
// It deliberately never produces the Ghost's main turn action itself —
// that only ever happens via a human-submitted 'rollGhostDie'.
// ---------------------------------------------------------------------------

import { card } from './cards.js';
import { capacityLeft } from './engine.js';
import { choosePlacementSlot, chooseRefill } from './bot.js';

export function ghostAction(state, seat) {
  if (state.phase === 'gameOver') return null;

  // 1) Resolve any prompt addressed to this Ghost first, same priority
  //    order as a bot.
  const item = state.pending.find((x) => x.seat === seat);
  if (item) return ghostResolvePrompt(state, seat, item);
  if (state.pending.length > 0) return null; // someone else's prompt

  // 2) Before the Ghost's main action, spend a Favor if this is exactly the
  //    turn it committed to spending it on. Never produces the main action
  //    itself (draft/buy/reset) — that's the human's 'rollGhostDie'.
  if (state.phase === 'draft' && state.turn && state.turn.seat === seat && !state.turn.done) {
    // The Vanishing Valentino's end-of-turn window (see engine.js). Ending
    // the draft early isn't one of the owner's fixed Ghost rules, so a Ghost
    // always declines and simply ends its turn — this also keeps the window
    // from deadlocking a Ghost seat, whose only other input is the human's
    // 'rollGhostDie' (illegal once the main action is already spent).
    if (state.turn.valentinoWindow) return { type: 'endTurn', seat };
    if (!state.turn.mainDone) {
      const favorId = ghostFavorToSpend(state, seat);
      if (favorId) return { type: 'useFavor', seat, cardId: favorId };
    }
    return null;
  }
  return null;
}

// A "1st" Favor is spent on this Ghost's own next literal 1st turn of a
// round (p.turns === 0, i.e. about to take that very turn); a "2nd" Favor
// on its own next literal 2nd turn (p.turns === 1). This is a stricter,
// fixed commitment than the general eligibility window humans get (see
// engine.js's favorEligibleNow) — a Ghost never holds one back for later.
function ghostFavorToSpend(state, seat) {
  const p = state.players[seat];
  const found = p.reserve.find((id) => {
    const c = card(id);
    if (c.cardType !== 'favor') return false;
    return c.triggerAfterTurn === 1 ? p.turns === 0 : p.turns === 1;
  });
  return found ?? null;
}

// Ghosts always fill earned hearts onto their board (mat slots only, 0-7)
// from left to right, as evenly as possible: one heart per left-to-right
// pass over slots that still have room, looping back to slot 0 for another
// pass until every earned heart is placed or a full pass places nothing
// (board full — the remainder is forfeited, same as the human/bot path).
function ghostHeartAssignments(state, seat, amount) {
  const p = state.players[seat];
  const placed = new Map(); // cardId -> amount already planned this call
  let left = amount;

  // Primary rule: fill hearts left to right across the board (mat slots),
  // as evenly as possible — one heart per pass, round-robin.
  let placedThisPass = true;
  while (left > 0 && placedThisPass) {
    placedThisPass = false;
    for (let slot = 0; slot < 8 && left > 0; slot++) {
      const id = p.slots[slot];
      if (!id) continue;
      const already = placed.get(id) || 0;
      if (capacityLeft(state, seat, id) - already <= 0) continue;
      placed.set(id, already + 1);
      left--;
      placedThisPass = true;
    }
  }

  // Fallback: the engine requires every available point of capacity to be
  // used (mat slots + reserve cards). If the board is full but a reserve
  // card still has room, spill the remainder there (same round-robin idea,
  // in reserve order) so we always satisfy the engine's mandatory total.
  if (left > 0) {
    placedThisPass = true;
    while (left > 0 && placedThisPass) {
      placedThisPass = false;
      for (const id of p.reserve) {
        if (left <= 0) break;
        const already = placed.get(id) || 0;
        if (capacityLeft(state, seat, id) - already <= 0) continue;
        placed.set(id, already + 1);
        left--;
        placedThisPass = true;
      }
    }
  }

  return [...placed.entries()].map(([cardId, amt]) => ({ cardId, amount: amt }));
}

function ghostResolvePrompt(state, seat, item) {
  const base = { type: 'resolvePending', seat, pendingId: item.id };
  const p = state.players[seat];
  switch (item.kind) {
    case 'placement':
    case 'cardResourcePlacement':
      // Not covered by the owner's rules — same default a bot would use.
      return { ...base, slot: choosePlacementSlot(state, seat, item) };
    case 'heartAssign':
      return { ...base, assignments: ghostHeartAssignments(state, seat, item.data.amount) };
    case 'refill':
      // Not covered by the owner's rules — same default a bot would use.
      return { ...base, assignments: chooseRefill(state, seat) };
    // Press Pass: always spend everything held, unconditionally — "Ghosts
    // always spend their press pass in the round it is acquired." Since
    // this window opens once per round right after the draft (and a Ghost
    // never carries one over — see below), anything sitting in reserve
    // here was necessarily acquired this same round.
    case 'pressPassWindow': {
      const passes = p.reserve.filter((id) => card(id).cardType === 'reroll');
      if (passes.length > 0) return { type: 'usePressPass', seat, cardId: passes[0] };
      return { ...base };
    }
    // Not covered by the owner's rules — decline, same conservative default
    // bot.js uses for its own optional reactions elsewhere.
    case 'auricGainChoice':
      return { ...base, convertCoinsToHearts: false, convertHeartsToCoins: false };
    case 'postAcquireDiscard':
      return { ...base, choice: 'keep' };
    case 'diceResultsReview':
      return { ...base };
    case 'barreRearrange':
      return { ...base };
    default:
      return { ...base };
  }
}
