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
        // Biggest first: the loop normally spends them all, but if the window
        // is ever cut short (a takeover, a disconnect) the most rolls have
        // already been banked.
        const best = passes.reduce((a, b) => ((card(b).count || 1) > (card(a).count || 1) ? b : a), passes[0]);
        return { type: 'usePressPass', seat, cardId: best };
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
    // Purely informational (see engine.js's drawnCardsReveal) — acknowledge
    // and move on; it only means anything to a human watching.
    case 'drawnCardsReveal':
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

// Is this the moment to spend a Favor?
//
// A Favor spent before the main action grants a bonus turn taken immediately
// afterwards, so the payoff is specifically the chance to take the two best
// cards in the row back to back, before any opponent gets at the second one.
// That makes spending a timing decision, not a reflex — and the bot used to
// treat it as a reflex, burning a Favor on the first turn it was eligible
// whatever was on the table. Measured over 240 AI-only games, that policy
// spent 1,534 Favors of which **27% bought a bonus turn that never happened**
// (see the row-length guard below) and 54% bought a second pick scoring under
// 3.0, i.e. a card the bot would not otherwise have wanted. Mean value of the
// card the bonus turn actually took: 2.78.
//
// Two conditions now have to hold.
function wantsFavorNow(state, seat, favorId) {
  // 1) The bonus turn has to actually happen. finishTurn ends the draft the
  //    instant the row runs down to its last card, and that check runs BEFORE
  //    the queued bonus turn is granted — so a Favor spent when this turn's
  //    pick would leave 1 card standing is silently thrown away. Each bonus
  //    turn already queued claims a card too, hence the subtraction.
  const queued = (state.turn.bonusQueue || []).length;
  if (state.draftRow.length - queued < 3) return false;

  // 2) The card the bonus turn would take has to be worth having. A bonus
  //    turn from a Favor may not draft another Favor of the same timing, so
  //    those are excluded from what it could pick up.
  const timing = card(favorId).triggerAfterTurn;
  const scores = state.draftRow
    .filter((id) => {
      const c = card(id);
      return !(c.cardType === 'favor' && c.triggerAfterTurn === timing);
    })
    .map((id) => scoreCard(state, seat, id))
    .sort((a, b) => b - a);
  // scores[0] is this turn's own pick; each queued bonus turn takes the next
  // one down; this Favor's bonus turn takes the one after that.
  const wouldTake = scores[queued + 1];
  return wouldTake != null && wouldTake >= FAVOR_SPEND_MIN;
}

function draftTurn(state, seat) {
  const p = state.players[seat];

  // Spend an eligible Favor for an extra turn before acting — but only when
  // the row is actually worth doubling up on (see wantsFavorNow). Must happen
  // before the main action, same as a human clicking the Favor card in their
  // reserve.
  if (!state.turn.mainDone) {
    const usable = eligibleFavors(state, seat).filter((id) => wantsFavorNow(state, seat, id));
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

  // Consider a market buy only when it beats the best free pick — by a clear
  // margin normally, because drafting costs no coins and the card passed over
  // goes to an opponent either way, but by a hair once the bank is past
  // RICH_COINS and those coins have nothing else to do. This is what makes the
  // bot reach for the market on a weak draft row instead of settling for junk
  // and banking yet another coin.
  const premium = p.coins >= RICH_COINS ? RICH_MARKET_PREMIUM : MARKET_PREMIUM;
  const buy = bestMarketBuy(state, seat, 0, bestDraftScore + premium);
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

// COIN ECONOMICS
// --------------
// Travis reported a game where a bot finished with 29 unspent coins. That is
// real — but measured, it is not what was costing the AI games. Over ~28,000
// mirrored A/B games across five independent seed sets, EVERY lever swept here
// (cheaper coins, a lower market premium, more market resets, valuing Coin
// resource cards lower when rich, and every combination of them) came back
// win-rate neutral or worse. A configuration that looked like +1.5pp on its own
// tuning seed set measured 50.0% on hold-out seeds — the classic overfit this
// file's constants are supposed to be protected from.
//
// The reason is structural, not a bug: a coin can only be spent on a 4-slot
// market that costs the same main action a FREE draft pick costs, and career
// coins are the Trophy tiebreaker, so a bank is not worthless. Coins simply
// arrive faster than the board can absorb them.
//
// The constants below are therefore shipped as a BEHAVIOUR fix, not a strength
// claim: they consistently cut mean unspent coins from ~9.3 to ~8.7 and trim
// the long tail, at a measured cost of nothing (50.1% over the same 28,000
// games). Do not "revert them because they don't help" — they are not there to
// help; and equally, do not treat them as validated strength gains.
const COIN_PRICE = 0.9;          // score charged per coin at full price
const COIN_SPEND_SURPLUS = 16;   // bank size past which a coin starts costing less
const COIN_SPEND_FLOOR = 0.45;   // a coin is never worth less than this fraction
const RICH_COINS = 10;           // at or above this, stop guarding the bank
const MARKET_PREMIUM = 1.5;      // how far a market card must beat the free pick by
const RICH_MARKET_PREMIUM = 0.2; // ...and how far, once the bank is idle anyway

// What one coin is worth to this seat right now, as a fraction of COIN_PRICE.
// A coin only counts if it is going to be spent; past COIN_SPEND_SURPLUS the
// marginal one tapers, floored so a coin never becomes free (a bot that treats
// coins as free empties itself and then cannot afford a reset — measured at
// 46.4% win share, the worst result of the whole sweep).
function coinValueFactor(coins) {
  return Math.max(COIN_SPEND_FLOOR, Math.min(1, COIN_SPEND_SURPLUS / Math.max(coins, 1)));
}

// The score a market slot's price costs this seat.
function coinCost(state, seat, cost) {
  return cost * COIN_PRICE * coinValueFactor(state.players[seat].coins);
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
    best = Math.max(best, scoreCard(state, seat, state.market[i]) - coinCost(state, seat, cost));
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
    const s = scoreCard(state, seat, state.market[i]) - coinCost(state, seat, cost);
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
      if (c.resourceType === 'Card') return drawValue(c.amount || 1);
      if (c.resourceType === 'Heart') {
        // Hearts with nowhere to go are forfeited outright (see
        // creditCoinsAndHearts), so what a Heart resource is worth is what
        // FITS, not what is printed on it. Flat `0.9 * amount` was harmless
        // while the biggest Heart card was a 3; the Sept 2026 deck runs to 5,
        // and a 5-heart card on a board with room for 2 delivers 2.
        const room = totalCapacityLeft(state, seat);
        if (room === 0) return 0.2;
        return COIN_PRICE * Math.min(c.amount || 1, room);
      }
      return COIN_PRICE * (c.amount || 1);
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
// Silvertongue), so its value is the printed number times how much the
// holder's stage collects per roll, times what a collected resource unit is
// worth. Because it is `count` rolls of the same stage, the value is strictly
// proportional to the printed number — a Press Pass 7 is always worth exactly
// seven times a Press Pass 1 to the same seat, so a higher card can never be
// ranked below a lower one. (rules.test.js asserts that ordering.)
//
// The two board-dependent terms were both measured, and both were wrong.
//
// 1. TIMING. A Press Pass is never spent at the moment it is drafted — it is
//    spent in the pre-roll window at the *end* of that round's draft, by which
//    point the holder has taken more turns and filled more of their stage.
//    Measured over 240 AI-only games (5,107 decision points, comparing each
//    draft-time stage against that same seat's stage when the draft actually
//    ended): units/roll rises from a mean 0.523 at draft time to 0.675 at
//    spend time. PRESS_PASS_EMPTY_SLOT_UNITS credits each empty Performer slot
//    with the share of that gap it accounts for; 0.08 is the value that makes
//    the projection unbiased (mean 0.674 vs the actual 0.675). The old code
//    approximated this with a flat 0.35 floor, which was biased ~11% low and
//    left a half-full stage underpriced. The floor stays, lowered to 0.25,
//    purely as a guard for a stage with nothing on it at all.
//
// 2. WHAT A UNIT IS WORTH. This was the real problem. A unit was priced at
//    0.9, the same as a Coin resource card, but a unit collected from a
//    private roll is worth far more than a coin: ~41% of collected units are
//    Stars (the trophy currency, which the bot already prices above Coins
//    everywhere else — see resourceNeedBonus), they arrive at the end of the
//    round precisely when round stars are compared for the Trophy, and the
//    card costs no mat slot to cash in. Sweeping this constant head-to-head
//    against the previous bot, win share climbs monotonically from 50.0% at
//    0.9 to ~53% around 1.5-1.7 and falls off again by 2.4 — a real optimum.
//    1.5 sits at the top of that range.
//
// THE FAVOR CONSTANTS.
//
// A Favor spent before the main action grants a bonus turn taken immediately
// afterwards, so what it really buys is the two best cards in the row back to
// back, before any opponent gets at the second one. Measured over 240 AI-only
// games (16,821 draft decisions): the card a bot takes averages 4.31, and the
// next-best card still sitting in the row averages 3.34 — so a Favor taken at
// a random moment is worth about the mean of the two, ~3.8.
//
// But the bot does not have to spend it at a random moment, and a bonus turn
// is not a *replacement* pick, it is an *extra* one: a round deals exactly
// 2 x players + 1 cards and ends with 1 left, so the pool is fixed and every
// bonus turn takes a card that would otherwise have gone to an opponent.
// Held until wantsFavorNow's window opens, the card the bonus turn takes
// averages 5.85 rather than 3.34. FAVOR_FIRST is that number discounted for
// the delay and for the risk of never getting a good window. Swept head to
// head, win share rises through 4.4-5.0, then falls off a cliff by 6.4 (49.8%)
// and 7.4 (45.3%) where the bot starts drafting Favors over the very cards
// they are meant to help it take. 4.7 sits at the top of the safe range.
//
// This only works because spending is now selective: under the old reflex
// policy the same sweep punished anything above 4.0. A "1st" Favor stays
// strictly above a "2nd+" for the reason given in scoreCard, at roughly the
// same ratio as before.
//
const FAVOR_FIRST = 4.7;
const FAVOR_SECOND = 3.6;

// The bonus turn must be able to take a card worth at least this. Swept head
// to head: 4.5 beats 3.5, 4.0 and 5.0 on every seed set tried. Below it the
// bot spends Favors on cards it does not want; above it, it hoards them.
const FAVOR_SPEND_MIN = 4.5;

const PRESS_PASS_UNIT_SCORE = 1.5;        // one collected resource unit, Star premium included
const PRESS_PASS_EMPTY_SLOT_UNITS = 0.08; // units/roll an empty Performer slot is worth by spend time
const PRESS_PASS_MIN_UNITS = 0.25;        // floor, so a bare stage still rates a big Press Pass

// The stage this Press Pass will actually be rolled on, not the one it is
// being drafted onto.
function projectedUnitsPerRoll(state, seat) {
  const p = state.players[seat];
  const now = expectedUnitsPerCollectionRoll(state, seat);
  const emptyPerformerSlots = p.slots.slice(0, 5).filter((x) => x == null).length;
  return Math.max(now + emptyPerformerSlots * PRESS_PASS_EMPTY_SLOT_UNITS, PRESS_PASS_MIN_UNITS);
}

function pressPassValue(state, seat, count) {
  const perRoll = projectedUnitsPerRoll(state, seat);
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
