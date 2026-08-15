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
  eligiblePressPasses,
  expectedUnitsPerCollectionRoll,
  marketCost,
  trainerActive,
  hasFullSet,
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
    case 'cardResourcePlacement':
      return { ...base, slot: choosePlacementSlot(state, seat, item) };
    case 'heartAssign':
      return { ...base, assignments: chooseHeartAssignments(state, seat, item.data.amount) };
    case 'refill':
      return { ...base, assignments: chooseRefill(state, seat) };
    // Pre-roll Press Pass window: spend an eligible Press Pass card if we
    // have a Performer on board to actually benefit from a private roll
    // (mirrors wantsPressPassOffer's old threshold — little downside to
    // spending since these are close to free value), otherwise close the
    // window. Called repeatedly by the driver loop until this seat has
    // nothing left it wants to spend.
    case 'pressPassWindow': {
      const passes = eligiblePressPasses(state, seat);
      if (passes.length > 0 && boardLetterCount(state, seat) >= 1) {
        return { type: 'usePressPass', seat, cardId: passes[0] };
      }
      return { ...base };
    }
    case 'auricGainChoice':
      return { ...base, ...chooseAuricConversion(state, seat, item.data) };
    // Professor Stainglass: the bot never proactively discards a
    // just-acquired card for this (keeps AI behavior simple and
    // non-regressive — the old engine's bot never used the equivalent
    // discard ability either). Wendell the Propmaster is never part of this
    // prompt — see the separate 'wendellTakeDiscard' turn action, which the
    // bot also never proactively uses, same conservative policy.
    case 'postAcquireDiscard':
      return { ...base, choice: 'keep' };
    // ...but if it somehow got here (a human-seat takeover mid-prompt), keep
    // whichever drawn card scores best rather than stalling.
    case 'stainglassKeep': {
      const best = item.data.drawn.reduce(
        (a, b) => (scoreCard(state, seat, b) > scoreCard(state, seat, a) ? b : a),
        item.data.drawn[0]
      );
      return { ...base, cardId: best };
    }
    // Post-dice-roll review: nothing for the bot to decide — just
    // acknowledge and let the round continue. Only meaningful for a human
    // watching the results, so this resolves instantly.
    case 'diceResultsReview':
      return { ...base };
    // Madame Barre: end-of-round free rearrange. The bot never proactively
    // rearranges (same conservative policy as every other optional Trainer
    // action it's offered) — just closes the prompt, leaving the troupe as
    // is.
    case 'barreRearrange':
      return { ...base };
    default:
      // Unknown prompt kind: decline/no-op resolution keeps the game moving.
      return { ...base };
  }
}

// Auric the Alchemist: offered the instant this seat actually receives a
// coin and/or a heart (see engine.js's grantCoinsAndHearts). Convert coins
// to hearts when the board is fragile and there's room for them; convert
// hearts to coins when the board is healthy and this seat is behind on
// coins — and always take earned hearts as coins instead of letting them go
// to waste when there's no capacity for them at all.
function chooseAuricConversion(state, seat, data) {
  const p = state.players[seat];
  const fragile = p.slots.filter((id) => id && (state.hearts[id] || 0) <= 1).length;
  const room = totalCapacityLeft(state, seat) > 0;
  const others = state.players.filter((x) => x.seat !== seat);
  const maxCoins = Math.max(0, ...others.map((x) => x.coins));
  const needsCoins = p.coins < maxCoins;

  const convertHeartsToCoins = data.heartsEarned > 0 && (!room || (fragile === 0 && needsCoins));
  const convertCoinsToHearts = data.coinsEarned > 0 && room && fragile >= 2;
  return { convertCoinsToHearts, convertHeartsToCoins };
}

// ---------------------------------------------------------------------------
// Dice-phase proactive resources (not gated by a pending prompt — driven
// directly by the server's/tests' dice-phase pacing loop, same pattern as a
// human clicking the card whenever it's relevant).
// ---------------------------------------------------------------------------

// The round's Tomato batch is rolled but not locked: does this seat control
// Mesmera and want to re-roll the whole batch? Only if the current batch
// threatens at least one of our own cards.
export function botWantsMesmeraReroll(state, seat) {
  const d = state.dice;
  if (!d || d.stage !== 'tomato' || !d.tomatoRolled || d.tomatoLocked || d.mesmeraRerollUsed) return false;
  if (!trainerActive(state, seat, TRAINERS.MESMERA)) return false;
  return d.tomatoResults.some((n) => tomatoThreatens(state, seat, n));
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

function tomatoThreatens(state, seat, value) {
  const p = state.players[seat];
  const id = p.slots[value - 1];
  if (!id) return false;
  return (state.hearts[id] || 0) <= 1; // the hit would discard this card
}

function boardLetterCount(state, seat) {
  const p = state.players[seat];
  return p.slots.slice(0, 5).filter((id) => id && card(id).cardType === 'performer').length;
}

// Fill every fillable empty slot (mandatory). Performers: best first.
function chooseRefill(state, seat) {
  const p = state.players[seat];
  const remaining = [...p.reserve];
  const out = [];
  for (let slot = 0; slot < 8; slot++) {
    if (p.slots[slot] != null) continue;
    const wantTypes = slot <= 4 ? ['performer'] : slot === 5 ? ['backdrop', 'trainer'] : slot === 6 ? ['prop', 'trainer'] : ['trainer'];
    let bestIdx = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = card(remaining[i]);
      if (!wantTypes.includes(c.cardType)) continue;
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

  // Spend any eligible Favor(s) for an extra turn before acting — never
  // hoard them (brief guidance). Must happen before the main action, same
  // as a human clicking the Favor card in their reserve.
  if (!state.turn.mainDone) {
    const usable = eligibleFavors(state, seat);
    if (usable.length > 0) return { type: 'useFavor', seat, cardId: usable[0] };
  }

  // Free start-of-turn Trainer actions, taken before the main action.
  if (!state.turn.mainDone) {
    // Jonas Quickfinger: cash in a Haunting performer only when the resources
    // clearly beat keeping it on stage — it's a real card off the board.
    if (!state.turn.jonasUsed && trainerActive(state, seat, TRAINERS.JONAS)) {
      const haunting = p.slots
        .slice(0, 5)
        .filter((id) => id && card(id).characteristic === 'Haunting');
      const worth = (id) => (card(id).powerDots || 0) * 0.9;
      const best = haunting.find((id) => worth(id) > scoreCard(state, seat, id) + 1.0);
      if (best) return { type: 'jonasDiscard', seat, cardId: best };
    }
    // The Vanishing Valentino: trim the cards our opponents would most want.
    // Free, so the only question is whether anything in the row is worth
    // denying — judged by what the best-placed opponent would score it at.
    if (!state.turn.valentinoUsed && trainerActive(state, seat, TRAINERS.VALENTINO)) {
      const allowance = p.slots
        .slice(0, 5)
        .filter((id) => id && card(id).characteristic === 'Dramatic').length;
      if (allowance > 0 && state.draftRow.length > 0) {
        const rivals = state.players.filter((x) => x.seat !== seat);
        const threat = (id) =>
          rivals.length ? Math.max(...rivals.map((r) => scoreCard(state, r.seat, id))) : 0;
        const mine = (id) => scoreCard(state, seat, id);
        // Never bin something we'd rather draft ourselves this turn.
        const targets = state.draftRow
          .filter((id) => threat(id) > 3.5 && threat(id) > mine(id))
          .sort((a, b) => threat(b) - threat(a))
          .slice(0, allowance);
        if (targets.length > 0) return { type: 'valentinoTrimDraft', seat, cardIds: targets };
      }
    }
  }

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

  // Nothing on offer is worth having? Pay 1 coin to reshuffle the market and
  // look again, rather than settling for a weak pick. Only worth doing with
  // coins to spare — you still need to afford whatever turns up — and capped
  // per turn because resetting doesn't spend the main action, so an unbounded
  // version would loop forever.
  if (
    !state.turn.mainDone &&
    (state.turn.resets || 0) < BOT_MAX_RESETS &&
    p.coins >= BOT_RESET_MIN_COINS &&
    bestDraftScore < BOT_WEAK_OPTION &&
    bestMarketScore(state, seat) < BOT_WEAK_OPTION
  ) {
    return { type: 'resetMarket', seat };
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

// Reshuffling the market when the table is weak.
//
// BOT_WEAK_OPTION is the cost-adjusted score below which an option counts as
// "not worth taking". Calibrated against measured play: a random deck card
// scores ~3.8 and the best card in a typical draft row ~4.1, so a best option
// under 3.0 genuinely is a below-average board.
// BOT_RESET_MIN_COINS keeps the bot from resetting itself broke — 1 coin for
// the reset plus enough left to actually buy whatever it turns up.
// BOT_MAX_RESETS bounds it: resetMarket doesn't consume the main action, so
// without a cap a bot facing a permanently weak board would reset forever.
const BOT_WEAK_OPTION = 3.0;
const BOT_RESET_MIN_COINS = 5;
const BOT_MAX_RESETS = 2;

// Best cost-adjusted market score available right now, or -Infinity if the
// bot can't afford anything. Same scoring basis bestMarketBuy uses.
function bestMarketScore(state, seat) {
  const p = state.players[seat];
  let best = -Infinity;
  for (let i = 0; i < state.market.length; i++) {
    if (!state.market[i]) continue;
    const cost = marketCost(state, seat, i);
    if (p.coins < cost) continue;
    best = Math.max(best, scoreCard(state, seat, state.market[i]) - cost * 0.9);
  }
  return best;
}

function bestMarketBuy(state, seat, spareCoins, mustBeat = -Infinity) {
  const p = state.players[seat];
  let best = null;
  let bestScore = mustBeat;
  for (let i = 0; i < state.market.length; i++) {
    if (!state.market[i]) continue; // sold this turn, not yet refilled
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

// Heuristic desirability of acquiring a card. Exported for direct unit
// testing of the AI's draft-valuation heuristics (see rules.test.js).
export function scoreCard(state, seat, id) {
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
      const emptyTrainerSlot = [5, 6, 7].some((i) => p.slots[i] == null);
      if (emptyTrainerSlot) s += 2;
      else s -= 1.5;
      return s;
    }
    case 'resource': {
      if (c.resourceType === 'Heart' && totalCapacityLeft(state, seat) === 0) return 0.2;
      if (c.resourceType === 'Card') return drawValue(c.amount || 1);
      return 0.9 * (c.amount || 1);
    }
    case 'favor':
      // A "1st" Favor is usable from turn 1 of any round; a "2nd" only from
      // turn 2. Measured across real games, 6.7% of a player's rounds never
      // reach a second turn at all, stranding a "2nd" Favor entirely — and
      // even when it is spendable it always comes later and is the one
      // blocked by the same-timing bonus-turn restriction more often. They
      // scored identically before, so the bot picked between them arbitrarily.
      return c.triggerAfterTurn === 1 ? FAVOR_FIRST : FAVOR_SECOND;
    case 'reroll':
      return pressPassValue(state, seat, c.count || 1);
    default:
      return 0;
  }
}

// What a "draw N cards" Resource is actually worth.
//
// A drawn card isn't a token — it's a real acquisition, placed on the mat (or
// resolved, if it's itself a Resource) exactly like a drafted card. So Draw-3
// is worth roughly three acquisitions, not three coins, and the old
// `0.9 * N + 0.5` curve (Draw-3 = 3.2) badly underrated it.
//
// DRAW_CARD_VALUE is the measured mean scoreCard of a random deck card across
// ~1,900 real bot decision points, excluding the Card resources themselves so
// the estimate can't inflate its own inputs. For reference, the *best* card in
// a typical draft row scores about 4.1 — so a single random draw is very
// nearly as good as a free draft pick, and three of them are worth far more.
//
// DRAW_DECAY reflects the measured diminishing return (~96% per extra card):
// the cards arrive together, so the second and third are likelier to find the
// empty slots already taken and get bumped to reserve.
const DRAW_CARD_VALUE = 3.8;
const DRAW_DECAY = 0.96;

function drawValue(n) {
  let total = 0;
  for (let k = 0; k < n; k++) total += DRAW_CARD_VALUE * Math.pow(DRAW_DECAY, k);
  return total;
}

// What a Press Pass is actually worth.
//
// It buys `count` private Collection Die rolls (doubled by Delphine
// Silvertongue), so its value is entirely a function of the printed number
// AND of how much the holder's board collects per roll — the old flat 1.4
// was wrong on both axes at once, overpricing a Press Pass 1 and badly
// underpricing a 5, 6 or 7.
//
// Measured across real games: a board collects ~0.68 resource units per roll
// on average (0 with an empty stage, ~1.01 with five performers). At the
// bot's own ~0.9 score per resource unit, that puts a Press Pass 7 near 4.3
// on a typical board and over 6 on a full one — versus the 1.4 it used to
// score, which is why it kept passing them up.
//
// PRESS_PASS_MIN_UNITS is a deliberate floor rather than trusting the current
// board outright: a Press Pass isn't spent until the pre-roll window at the
// *end* of this round's draft, by which point the holder has usually drafted
// more performers. Without the floor a bot with an empty stage would price
// every Press Pass at exactly 0 and never take one early in a round.
// A "1st" Favor is strictly the more flexible of the two — see scoreCard.
const FAVOR_FIRST = 2.0;
const FAVOR_SECOND = 1.5;

const PRESS_PASS_UNIT_SCORE = 0.9; // one resource unit, same scale as a Coin resource
const PRESS_PASS_MIN_UNITS = 0.35; // ~a 2-3 performer board, the floor for a stage that will grow

function pressPassValue(state, seat, count) {
  const perRoll = Math.max(expectedUnitsPerCollectionRoll(state, seat), PRESS_PASS_MIN_UNITS);
  const rolls = count * (trainerActive(state, seat, TRAINERS.DELPHINE) ? 2 : 1);
  return rolls * perRoll * PRESS_PASS_UNIT_SCORE;
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

// Wildcard "Any Characteristic"/"Any Type" Prop/Backdrop cards (boosts list
// of length 4) are dormant until the player has one active Performer of
// every value of that boostKind — see engine.js's hasFullSet/boostCount.
// A single-match card (length 1) has no such gate.
function boostActiveNow(state, seat, b) {
  return b.boosts.length < 4 || hasFullSet(state, seat, b.boostKind);
}

function boostSynergy(state, seat, performer) {
  let s = 0;
  for (const slotIdx of [5, 6]) {
    const id = state.players[seat].slots[slotIdx];
    if (!id) continue;
    const b = card(id);
    if (!b.boosts) continue;
    const key = b.boostKind === 'characteristic' ? performer.characteristic : performer.type;
    if (!b.boosts.includes(key)) continue;
    // A wildcard boost that isn't active yet is still worth something for
    // drafting this performer (it may help complete the set), just less
    // than a boost that's already live.
    s += boostActiveNow(state, seat, b) ? 0.7 : 0.3;
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
  // A wildcard card only actually helps once it's active; if the player
  // isn't there yet, don't let its "matches everything" list overstate how
  // many performers currently benefit.
  if (boostCard.boosts.length >= 4 && !hasFullSet(state, seat, boostCard.boostKind)) {
    return Math.min(n, 1);
  }
  return n;
}
