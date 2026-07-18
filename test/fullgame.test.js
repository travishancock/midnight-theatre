// Full simulated games: AI bots in every seat, for 2-5 players across several
// seeds. Asserts each game completes without throwing, reaches a valid win
// state, and that every one of the 142 cards stays accounted for throughout.
// Run with: node test/fullgame.test.js

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { initCards } from '../engine/cards.js';
import { createGame, applyAction, lockCollectionDie, lockTomatoRoll } from '../engine/engine.js';
import { botAction, seatsNeedingInput, botWantsMesmeraReroll } from '../engine/bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'card_database.json'), 'utf8'));
initCards(db);

const TOTAL_CARDS = 142;

function cardCount(s) {
  let n = s.deck.length + s.discard.length + s.market.length + s.draftRow.length;
  for (const p of s.players) n += p.slots.filter(Boolean).length + p.reserve.length;
  // A card awaiting a placement decision is "in hand": acquired but not yet
  // on the mat, so it lives only in the pending prompt.
  for (const item of s.pending) {
    if (item.kind === 'placement' || item.kind === 'cardResourcePlacement') n += 1;
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
console.log('ALL FULL-GAME TESTS PASSED');
