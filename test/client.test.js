// Client rendering + interaction tests.
//
// The engine tests prove the rules; this proves the screen in front of a
// player agrees with them. It loads the REAL client/src/main.js under jsdom
// with a stubbed socket.io-client, pushes real engine states through the same
// 'room' event the server broadcasts, and asserts on the resulting DOM.
//
// jsdom is a devDependency. If it isn't installed this file skips rather than
// failing, so `npm test` still works on a machine that hasn't run
// `npm install` since jsdom was added.
//
// Run with: node test/client.test.js

import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { fileURLToPath, pathToFileURL } from 'url';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('client.test.js: jsdom is not installed — skipping (npm install)');
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const { initCards, card } = await import(pathToFileURL(path.join(root, 'engine', 'cards.js')).href);
const { createGame } = await import(pathToFileURL(path.join(root, 'engine', 'engine.js')).href);

const db = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'card_database.json'), 'utf8'));
initCards(db);

// --- the browser main.js expects ------------------------------------------
const dom = new JSDOM(
  '<!doctype html><html><body><div id="app"></div><div id="toast"></div></body></html>',
  { url: 'http://localhost/', pretendToBeVisual: true }
);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.fetch = async () => ({ json: async () => ({ ...db, assetVersion: 'test' }) });

// Sounds are identified by the frequencies they schedule: the turn-passed
// click is a low triangle pair, the your-turn alert is two rising sine notes.
let tones = [];
dom.window.AudioContext = class {
  constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x) => x }; }
  createOscillator() {
    const o = { type: '', frequency: { setValueAtTime: (f) => tones.push(f) }, connect: (x) => x, start() {}, stop() {} };
    return o;
  }
  resume() { this.state = 'running'; }
};
const TICK = 420;      // the click's fundamental
const ALERT = 784;     // the alert's first note
const heard = () => ({ tick: tones.includes(TICK), alert: tones.includes(ALERT) });
const listen = () => { tones = []; };

// --- socket.io-client stub -------------------------------------------------
// main.js does `import { io } from 'socket.io-client'`, so the stub has to be
// installed as a module. Node has no loader hook here, so instead the real
// module is imported and its io() replaced would not work — main.js is loaded
// through a tiny shim module written beside it in a temp dir.
const tmp = fs.mkdtempSync(path.join(root, '.client-test-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
fs.mkdirSync(path.join(tmp, 'node_modules', 'socket.io-client'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'node_modules', 'socket.io-client', 'package.json'),
  JSON.stringify({ name: 'socket.io-client', version: '0.0.0', type: 'module', main: 'index.js' }));
fs.writeFileSync(path.join(tmp, 'node_modules', 'socket.io-client', 'index.js'), `
export function io() {
  const handlers = new Map();
  const s = {
    on(ev, fn) { handlers.set(ev, fn); },
    emit(ev, payload, cb) {
      (s.sent ||= []).push([ev, payload]);
      if (typeof cb === 'function') cb(ev === 'createRoom' || ev === 'joinRoom' ? { code: 'TEST', seat: 0 } : {});
    },
    __fire(ev, payload) { const h = handlers.get(ev); if (h) h(payload); },
  };
  globalThis.__socket = s;
  return s;
}
`);
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'client-test', type: 'module' }));
fs.copyFileSync(path.join(root, 'client', 'src', 'main.js'), path.join(tmp, 'main.js'));

await import(pathToFileURL(path.join(tmp, 'main.js')).href);
await new Promise((r) => setTimeout(r, 30));

const socket = globalThis.__socket;
const app = document.getElementById('app');
const html = () => app.innerHTML;
const click = (sel) => {
  const el = app.querySelector(sel);
  assert.ok(el, `no element matching ${sel}`);
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
};

document.getElementById('createBtn').click(); // real join path -> my.seat = 0

const lobby = { code: 'TEST', seats: [{ seat: 0, name: 'Travis' }, { seat: 1, name: 'Bot' }], started: true };
let version = 0;
const push = (state) => socket.__fire('room', { lobby, state: { ...state, version: ++version } });

function ui_open(seat) {
  push(s);
  const btn = app.querySelector(`[data-oppreserve="${seat}"]`);
  assert.ok(btn, 'no reserve toggle for that opponent');
  if (!/▾/.test(btn.textContent)) btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n        ' + e.message); }
}

// ---------------------------------------------------------------------------
const s = createGame({ players: [{ name: 'Travis' }, { name: 'Bot', isBot: true }], seed: 4242 });
const me = s.players[0];
const them = s.players[1];

// A full mat with every card at max hearts, and two bumped performers waiting
// in reserve: the exact shape where the ONLY legal heart targets are reserve
// cards, which is the situation Travis reported as un-assignable.
const perfs = db.performers.filter((c) => c.maxHearts > 0).map((c) => c.id);
for (let i = 0; i < 5; i++) {
  me.slots[i] = perfs[i];
  s.hearts[perfs[i]] = card(perfs[i]).maxHearts;
}
me.reserve = [perfs[5], perfs[6]];
s.hearts[perfs[5]] = 0;
s.hearts[perfs[6]] = 0;
s.pending = [{ id: 99, kind: 'heartAssign', seat: 0, data: { amount: 2, reason: 'Collection Die A' } }];
push(s);

test('the heart prompt offers reserve cards when the mat is full', () => {
  assert.ok(/Assign <b>2<\/b> heart/.test(html()), 'heart prompt not rendered');
  for (const id of me.reserve) {
    assert.ok(html().includes(`data-hplus="${id}"`), `reserve card ${id} was not offered as a target`);
  }
});

// The bug this file exists for. resetTransientUi() runs on every state push,
// and a push arrives whenever ANY seat acts — during the dice phase, every
// second or two. It used to wipe ui.heartPlan, so a plan needing more than one
// click could never reach total === must and Confirm never enabled. At the
// table that reads as "it won't let me put hearts on my reserve cards", since
// reserve targets are exactly the ones that need the extra clicks.
test('a half-built heart plan survives other seats acting', () => {
  click(`[data-hplus="${me.reserve[0]}"]`);
  assert.ok(/1 left to place/.test(html()), 'first heart did not register');
  push(s);
  push(s);
  assert.ok(/1 left to place/.test(html()), 'the plan was wiped by a state push');
  click(`[data-hplus="${me.reserve[1]}"]`);
  assert.ok(/0 left to place/.test(html()), 'second heart did not register');
  const confirm = app.querySelector('#confirmHearts');
  assert.ok(confirm && !confirm.disabled, 'Confirm still disabled with the full amount planned');
});

test('a heart plan is pruned against live state, not carried forward blindly', () => {
  s.hearts[me.reserve[1]] = card(me.reserve[1]).maxHearts; // that target just filled up
  push(s);
  assert.ok(!/0 left to place/.test(html()), 'an assignment that is no longer legal was kept');
  assert.ok(/left to place/.test(html()), 'the prompt disappeared');
});

test('a heart plan is dropped once the prompt is gone', () => {
  s.pending = [];
  push(s);
  assert.ok(!/left to place/.test(html()), 'the prompt is still rendered');
});

test('no card anywhere carries a letter chip', () => {
  s.pending = [{ id: 101, kind: 'heartAssign', seat: 0, data: { amount: 1, reason: 'Collection Die A' } }];
  s.hearts[me.reserve[0]] = 0;
  push(s);
  assert.ok(/left to place/.test(html()), 'heart prompt not shown');
  assert.equal(app.querySelectorAll('.letter, .letter-chip').length, 0,
    'the gold letter chips are still being rendered somewhere');
  s.pending = [];
  push(s);
});

test("every one of an opponent's cards reports hearts as tokens, mat and reserve", () => {
  const held = perfs[7];
  const onMat = perfs[8];
  them.reserve = [held];
  them.slots[0] = onMat;
  s.hearts[held] = 2;
  s.hearts[onMat] = 3;
  ui_open(them.seat);

  const matCard = app.querySelector('.opponent .slots.mini .card');
  assert.ok(matCard, 'no card rendered in the opponent mat');
  assert.equal(matCard.querySelectorAll('.hearts').length, 0, 'a mat card still shows the "n/max" pill');
  assert.equal(matCard.querySelectorAll('.heart-tokens i').length, 3, 'mat card token count is wrong');

  const resCard = app.querySelector('.opponent .mini-reserve .card');
  assert.ok(resCard, 'opponent reserve did not expand');
  assert.equal(resCard.querySelectorAll('.hearts').length, 0, 'a reserve card still shows the pill');
  assert.equal(resCard.querySelectorAll('.heart-tokens i').length, 2, 'reserve card token count is wrong');

  s.hearts[held] = 0;
  push(s);
  assert.equal(app.querySelectorAll('.opponent .mini-reserve .heart-tokens i').length, 0,
    'a card with no hearts left should show no tokens');
});

test("an opponent's reserve cards are the same size as the cards on their mat", () => {
  them.reserve = [perfs[7]];
  ui_open(them.seat);
  const sizeOf = (el) => ['xs', 'sm', 'md', 'lg'].find((c) => el.classList.contains(c));
  const mat = sizeOf(app.querySelector('.opponent .slots.mini .card'));
  const res = sizeOf(app.querySelector('.opponent .mini-reserve .card'));
  assert.equal(res, mat, `reserve cards render at ${res} but mat cards at ${mat}`);
});

// Regression: the tokens were first written as `font-size: 30%`, which
// resolves against the INHERITED font size (the 14px body), not the card
// width — so they rendered at ~4px and were effectively invisible. Any
// percentage or em/rem here is the same bug wearing a different hat.
test('heart tokens are sized in absolute units, not a percentage', () => {
  const css = fs.readFileSync(path.join(root, 'client', 'src', 'style.css'), 'utf8');
  const rules = css.match(/\.card[^{]*\.heart-tokens i\s*\{[^}]*\}/g) || [];
  assert.ok(rules.length >= 1, 'no .heart-tokens i rule found at all');
  const sized = rules.filter((r) => /font-size\s*:/.test(r));
  assert.ok(sized.length >= 1, 'no font-size set on the heart tokens');
  for (const r of sized) {
    const value = /font-size\s*:\s*([^;]+)/.exec(r)[1].trim();
    assert.ok(/^\d+(\.\d+)?px$/.test(value),
      `heart token font-size must be an absolute px value, got "${value}"`);
    assert.ok(parseFloat(value) >= 12,
      `heart tokens at ${value} are too small to read on a card`);
  }
});

// A drawn card is a thing you look at and judge. Naming it in a sentence
// makes the player reconstruct it from memory; showing it does not.
test('the placement prompt shows the drawn cards as cards, not as text', () => {
  const drawn = [perfs[10], perfs[11], perfs[12]];
  s.pending = [{
    id: 200, kind: 'cardResourcePlacement', seat: 0,
    data: { cardId: drawn[1], allowedSlots: [0, 1, 2, 3, 4], drawn, source: 'Resource 3 Cards' },
  }];
  push(s);
  const imgs = [...app.querySelectorAll('.prompt .card')];
  assert.equal(imgs.length, 3, `expected all 3 drawn cards rendered, got ${imgs.length}`);
  assert.ok(/Resource 3 Cards/.test(html()), 'the prompt does not say what drew them');
  const placing = app.querySelectorAll('.prompt .card.placing');
  assert.equal(placing.length, 1, 'exactly one card should be marked as the one being placed');
  assert.equal(placing[0].dataset.cardid, drawn[1], 'the wrong card is marked for placement');
  const dimmed = [...app.querySelectorAll('.prompt .card.dim')].map((e) => e.dataset.cardid);
  assert.deepEqual(dimmed.sort(), [drawn[0], drawn[2]].sort(), 'the other drawn cards should be dimmed');
  assert.ok(app.querySelector('#cardResourceToReserve'), 'no send-to-reserve option');
});

test('a single drawn card still renders as a card', () => {
  s.pending = [{
    id: 201, kind: 'cardResourcePlacement', seat: 0,
    data: { cardId: perfs[10], allowedSlots: [0] },
  }];
  push(s);
  assert.equal(app.querySelectorAll('.prompt .card').length, 1);
  assert.equal(app.querySelectorAll('.prompt .card.dim').length, 0, 'a lone card must not be dimmed');
});

// When every drawn card finds its own slot, nothing prompts — the cards would
// otherwise appear on the mat unannounced and the player would never see what
// the Resource actually drew.
test('cards that placed themselves are still shown, once', () => {
  const drawn = [perfs[13], perfs[14]];
  s.pending = [{ id: 202, kind: 'drawnCardsReveal', seat: 0, data: { drawn, source: 'Resource 2 Cards' } }];
  push(s);
  assert.equal(app.querySelectorAll('.prompt .card').length, 2, 'the drawn cards are not shown');
  assert.ok(/Resource 2 Cards/.test(html()), 'the prompt does not say what drew them');
  const go = app.querySelector('#drawnRevealContinue');
  assert.ok(go, 'no way to dismiss the reveal');
  go.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const sent = (socket.sent || []).map(([ev, payload]) => payload).filter(Boolean);
  assert.ok(sent.some((a) => a && a.pendingId === 202 && a.type === 'resolvePending'),
    'Continue did not resolve the prompt');
  s.pending = [];
  push(s);
});

test('hover-to-enlarge is offered on Trainers and nothing else', () => {
  s.hearts[perfs[7]] = 1;
  push(s);
  const trainerId = db.trainers[0].id;
  me.reserve = [perfs[5], trainerId];
  push(s);
  const classes = [...app.querySelectorAll('#myReserve .card')].map((e) => e.className);
  assert.ok(classes.some((c) => /\btrainer\b/.test(c)), 'the Trainer card carries no .trainer class to hover on');
  assert.ok(classes.some((c) => /\bperformer\b/.test(c) && !/\btrainer\b/.test(c)),
    'a performer must not be marked as hoverable');
});

test('a completed turn clicks for everyone, without the your-turn alert', () => {
  click('#soundToggle'); // off
  click('#soundToggle'); // on again — also primes the audio context
  s.pending = [];
  s.phase = 'dice';     // definitively not my turn, and no prompt of mine
  s.turn = null;
  listen();
  s.turnsCompleted = (s.turnsCompleted || 0) + 1;
  push(s);
  const h = heard();
  assert.ok(h.tick, 'no click when turnsCompleted advanced');
  assert.ok(!h.alert, 'played the your-turn alert on someone else\'s turn');

  listen();
  push(s); // a push that did not complete a turn
  assert.ok(!heard().tick, 'clicked on a push that did not complete a turn');
});

test('the alert plays on top of the click when it becomes your turn', () => {
  s.phase = 'draft';
  s.turn = { seat: 0, done: false, mainDone: false, open: false, buys: 0, turns: 0 };
  s.pending = [];
  listen();
  s.turnsCompleted += 1;
  push(s);
  const h = heard();
  assert.ok(h.alert, 'no alert when the turn passed to me');
  assert.ok(h.tick, 'the click should still play for everyone, including me');
});

test('both sounds can be muted', () => {
  click('#soundToggle');
  assert.ok(/Sound off/.test(html()), 'the toggle did not flip');
  listen();
  s.turnsCompleted += 1;
  push(s);
  const h = heard();
  assert.ok(!h.tick && !h.alert, 'made noise while muted');
  click('#soundToggle');
});

if (failures) {
  console.log(`\nclient.test.js: ${failures} FAILED`);
  process.exit(1);
}
console.log('\nALL CLIENT TESTS PASSED');
