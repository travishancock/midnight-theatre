// Full simulated games: AI bots in every seat, for 2-5 players across several
// seeds. Asserts each game completes without throwing, reaches a valid win
// state, and that every one of the 145 cards stays accounted for throughout.
// Run with: node test/fullgame.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { initCards } from '../engine/cards.js';
import { createGame, applyAction, lockCollectionDie, lockTomatoRoll } from '../engine/engine.js';
import { botAction, seatsNeedingInput, botWantsMesmeraReroll } from '../engine/bot.js';
import { ghostAction } from '../engine/ghost.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'card_database.json'), 'utf8'));
initCards(db);

const TOTAL_CARDS = 145;

function cardCount(s) {
  // A sold-but-not-yet-refilled market slot is `null` (prices stay frozen
  // until the buyer's turn ends — see compactMarket in engine.js), same as
  // an empty mat slot, so it must not be counted as a card.
  let n = s.deck.length + s.discard.length + s.market.filter(Boolean).length + s.draftRow.length;
  for (const p of s.players) n += p.slots.filter(Boolean).length + p.reserve.length;
  // A card awaiting a placement decision is "in hand": acquired but not yet
  // on the mat, so it lives only in the pending prompt.
  for (const item of s.pending) {
    // A card awaiting a decision is "in hand": out of the deck/row but not
    // yet owned. postAcquireDiscard holds the just-acquired card while
    // Stainglass's offer is open; stainglassKeep holds the cards drawn for it.
    if (item.kind === 'placement' || item.kind === 'cardResourcePlacement') n += 1;
    if (item.kind === 'postAcquireDiscard') n += 1;
    if (item.kind === 'stainglassKeep') n += item.data.drawn.length;
  }
  return n;
}

// The dice phase pauses at two points that are NOT `pending` prompts (so
// seatsNeedingInput reports nothing owed): a rolled-but-unlocked Collection
// Die (pure reveal pacing) and a rolled-but-unlocked Tomato batch (awaiting
// a possible Mesmera reaction). In production the server paces these with
// real timers, after letting any bot decide its reaction synchronously; this
// test drives the same two steps immediately. The pre-roll Press Pass window
// (opened just before these 5 shared dice, once the draft phase ends) and
// the post-roll diceResultsReview pause (opened once both the Collection
// Dice and the Tomato batch have fully resolved) ARE normal `pending`
// prompts, one per eligible/every seat respectively, so they're handled by
// the main seatsNeedingInput/botAction loop below like any other prompt —
// no special driving needed here.
function driveDicePauseIfAny(s) {
  if (s.dieEvent && s.dieEvent.awaitingLock) {
    lockCollectionDie(s);
    return true;
  }
  if (s.dice && s.dice.stage === 'tomato' && s.dice.tomatoRolled && !s.dice.tomatoLocked) {
    for (const p of s.players) {
      if (!p.isBot) continue;
      if (botWantsMesmeraReroll(s, p.seat)) {
        applyAction(s, { type: 'mesmeraRerollTomato', seat: p.seat });
        break; // only one seat can hold the unique Mesmera trainer
      }
    }
    lockTomatoRoll(s);
    return true;
  }
  return false;
}

function playFullGame(players, seed) {
  const s = createGame({
    players: Array.from({ length: players }, (_, i) => ({ name: `Bot ${i + 1}`, isBot: true })),
    seed,
  });
  let actions = 0;
  const MAX_ACTIONS = 100000;

  while (s.phase !== 'gameOver') {
    if (++actions > MAX_ACTIONS) {
      throw new Error(`Game stalled after ${MAX_ACTIONS} actions (round ${s.round}, phase ${s.phase})`);
    }

    if (driveDicePauseIfAny(s)) {
      assert.equal(cardCount(s), TOTAL_CARDS, 'card conservation violated (dice-phase reaction window)');
      continue;
    }

    const needy = seatsNeedingInput(s);
    assert.ok(needy.length > 0, `engine settled with no one to act (phase ${s.phase}, round ${s.round})`);
    const seat = needy[0];
    const action = botAction(s, seat);
    assert.ok(action, `bot for seat ${seat} produced no action (phase ${s.phase})`);
    applyAction(s, action); // throws on any illegal bot move

    assert.equal(cardCount(s), TOTAL_CARDS, 'card conservation violated');
    for (const p of s.players) {
      assert.ok(p.coins >= 0, 'coins went negative');
      assert.ok(p.stars >= 0, 'stars went negative');
    }
  }

  // Valid win state.
  assert.ok(Array.isArray(s.winners) && s.winners.length >= 1, 'no winners recorded');
  const goal = { 2: 6, 3: 5, 4: 4, 5: 3 }[players];
  assert.equal(s.trophyGoal, goal);
  for (const w of s.winners) {
    assert.ok(s.players[w].trophies >= goal, 'winner below trophy threshold');
  }
  for (const p of s.players) {
    if (!s.winners.includes(p.seat)) assert.ok(p.trophies < goal, 'non-winner reached the threshold');
  }
  return { rounds: s.round, actions, winners: s.winners.map((w) => s.players[w].name) };
}

let games = 0;
const combos = [];
for (const players of [2, 3, 4, 5]) {
  for (const seed of [1, 20260712, 987654]) combos.push([players, seed]);
}

for (const [players, seed] of combos) {
  const t0 = Date.now();
  const res = playFullGame(players, seed);
  games++;
  console.log(
    `  ok  ${players} players, seed ${seed}: ${res.rounds} rounds, ${res.actions} actions, ` +
    `winner ${res.winners.join(' & ')} (${Date.now() - t0}ms)`
  );
}

console.log(`\nfullgame.test.js: ${games} complete AI-only games played to a valid win state`);

// ---------------------------------------------------------------------------
// Solo mode: 1 human seat (stood in here by botAction, purely so the game can
// run unattended) + 2 fixed Ghost seats. A Ghost's whole main-turn action
// comes from 'rollGhostDie', driven here the same way the server does — see
// engine/ghost.js and engine.js's resolveGhostRoll/GHOST_DIE_FACES. Every
// invariant the 2-5p games above check (card conservation, no negative
// resources, a valid win state) is re-checked here too, since solo mode
// reuses the exact same acquire/heart/market machinery.
// ---------------------------------------------------------------------------

function playFullSoloGame(seed) {
  const s = createGame({
    players: [
      { name: 'Solo Player', isBot: true, isGhost: false }, // stand-in bot, testing convenience only
      { name: 'Ghost 1', isBot: false, isGhost: true },
      { name: 'Ghost 2', isBot: false, isGhost: true },
    ],
    solo: true,
    seed,
  });
  let actions = 0;
  const MAX_ACTIONS = 100000;

  while (s.phase !== 'gameOver') {
    if (++actions > MAX_ACTIONS) {
      throw new Error(`Solo game stalled after ${MAX_ACTIONS} actions (round ${s.round}, phase ${s.phase})`);
    }

    if (driveDicePauseIfAny(s)) {
      assert.equal(cardCount(s), TOTAL_CARDS, 'card conservation violated (dice-phase reaction window)');
      continue;
    }

    // A Ghost seat with something to auto-resolve (a pending prompt, or its
    // fixed-timing Favor spend) takes priority, same as the server driver.
    const ghostItem = s.pending.find((x) => s.players[x.seat] && s.players[x.seat].isGhost);
    if (ghostItem) {
      const a = ghostAction(s, ghostItem.seat);
      assert.ok(a, `ghost pending with no ghostAction: ${ghostItem.kind}`);
      applyAction(s, a);
      assert.equal(cardCount(s), TOTAL_CARDS, 'card conservation violated (ghost pending)');
      continue;
    }
    if (s.phase === 'draft' && s.turn && s.players[s.turn.seat].isGhost && !s.turn.done) {
      const a = ghostAction(s, s.turn.seat);
      if (a) {
        applyAction(s, a); // a queued Favor spend before the die roll
        assert.equal(cardCount(s), TOTAL_CARDS, 'card conservation violated (ghost favor)');
        continue;
      }
      // Nothing left to auto-resolve — the solo human rolls the d12 for it.
      applyAction(s, { type: 'rollGhostDie', seat: 0 });
      assert.equal(cardCount(s), TOTAL_CARDS, 'card conservation violated (ghost roll)');
      continue;
    }

    const needy = seatsNeedingInput(s);
    assert.ok(needy.length > 0, `engine settled with no one to act (phase ${s.phase}, round ${s.round})`);
    const seat = needy[0];
    const action = botAction(s, seat);
    assert.ok(action, `bot for seat ${seat} produced no action (phase ${s.phase})`);
    applyAction(s, action);

    assert.equal(cardCount(s), TOTAL_CARDS, 'card conservation violated');
    for (const p of s.players) {
      assert.ok(p.coins >= 0, 'coins went negative');
      assert.ok(p.stars >= 0, 'stars went negative');
    }
  }

  assert.ok(Array.isArray(s.winners) && s.winners.length >= 1, 'no winners recorded');
  assert.equal(s.trophyGoal, 5, 'solo mode uses its own (lower) trophy goal');
  for (const w of s.winners) assert.ok(s.players[w].trophies >= 5, 'winner below trophy threshold');
  for (const p of s.players) {
    if (!s.winners.includes(p.seat)) assert.ok(p.trophies < 5, 'non-winner reached the threshold');
  }
  return { rounds: s.round, actions, winners: s.winners.map((w) => s.players[w].name) };
}

let soloGames = 0;
for (const seed of [1, 2, 3, 4, 5, 20260712, 987654]) {
  const t0 = Date.now();
  const res = playFullSoloGame(seed);
  soloGames++;
  console.log(
    `  ok  solo, seed ${seed}: ${res.rounds} rounds, ${res.actions} actions, ` +
    `winner ${res.winners.join(' & ')} (${Date.now() - t0}ms)`
  );
}

console.log(`\nfullgame.test.js (solo): ${soloGames} complete solo games played to a valid win state`);

// ---------------------------------------------------------------------------
// Alt Solo mode: just 1 human seat (stood in here by botAction, same testing
// convenience as above), no Ghosts or AI at all. Every decision is this one
// seat's own action — no auxiliary driver logic needed beyond the normal
// dice-phase pauses every game has. Unlike every other mode, a game here can
// legitimately end with NO winner (ALT_SOLO_LOSS_LIMIT round losses reached
// before ALT_SOLO_TROPHY_GOAL wins), so the valid-end-state check below
// accepts either outcome instead of requiring at least one winner.
// ---------------------------------------------------------------------------

function playFullAltSoloGame(seed) {
  const s = createGame({
    players: [{ name: 'Solo Player', isBot: true, isGhost: false }], // stand-in bot, testing convenience only
    altSolo: true,
    seed,
  });
  let actions = 0;
  const MAX_ACTIONS = 100000;

  while (s.phase !== 'gameOver') {
    if (++actions > MAX_ACTIONS) {
      throw new Error(`Alt Solo game stalled after ${MAX_ACTIONS} actions (round ${s.round}, phase ${s.phase})`);
    }

    if (driveDicePauseIfAny(s)) {
      assert.equal(cardCount(s), TOTAL_CARDS, 'card conservation violated (dice-phase reaction window)');
      continue;
    }

    const needy = seatsNeedingInput(s);
    assert.ok(needy.length > 0, `engine settled with no one to act (phase ${s.phase}, round ${s.round})`);
    const seat = needy[0];
    const action = botAction(s, seat);
    assert.ok(action, `bot for seat ${seat} produced no action (phase ${s.phase})`);
    applyAction(s, action);

    assert.equal(cardCount(s), TOTAL_CARDS, 'card conservation violated');
    assert.ok(s.players[0].coins >= 0, 'coins went negative');
    assert.ok(s.players[0].stars >= 0, 'stars went negative');
    assert.ok(s.altSoloLosses <= 5, 'loss counter overshot the cap');
  }

  assert.equal(s.trophyGoal, 5, 'Alt Solo uses its own trophy goal');
  assert.ok(Array.isArray(s.winners), 'winners should always be an array (possibly empty)');
  if (s.winners.length > 0) {
    assert.deepEqual(s.winners, [0]);
    assert.ok(s.players[0].trophies >= 5, 'winner below trophy threshold');
  } else {
    assert.ok(s.altSoloLosses >= 5, 'an empty winners list should only happen after 5 round losses');
    assert.ok(s.players[0].trophies < 5, 'should not have actually reached the trophy goal');
  }
  return {
    rounds: s.round,
    actions,
    outcome: s.winners.length > 0 ? `won (${s.players[0].trophies} trophies)` : `lost (${s.altSoloLosses} losses)`,
  };
}

let altSoloGames = 0;
for (const seed of [1, 2, 3, 4, 5, 20260712, 987654]) {
  const t0 = Date.now();
  const res = playFullAltSoloGame(seed);
  altSoloGames++;
  console.log(`  ok  alt solo, seed ${seed}: ${res.rounds} rounds, ${res.actions} actions, ${res.outcome} (${Date.now() - t0}ms)`);
}

console.log(`\nfullgame.test.js (alt solo): ${altSoloGames} complete alt solo games played to a valid end state`);
console.log('ALL FULL-GAME TESTS PASSED');
