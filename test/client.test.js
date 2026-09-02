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

// chime() builds exactly two oscillators per ring, so counting them counts rings.
let oscillators = 0;
dom.window.AudioContext = class {
  constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x) => x }; }
  createOscillator() { oscillators++; return { type: '', frequency: { setValueAtTime() {} }, connect: (x) => x, start() {}, stop() {} }; }
  resume() { this.state = 'running'; }
};
const rings = () => oscillators / 2;

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

test('reserve cards show their Collection letter', () => {
  const letters = [...app.querySelectorAll('#myReserve .card .letter')].map((e) => e.textContent);
  assert.deepEqual(letters, me.reserve.map((id) => card(id).letter));
});

test("an opponent's held letters are readable without expanding their reserve", () => {
  them.reserve = [perfs[7]];
  push(s);
  const chips = [...app.querySelectorAll('.opponent .reserve-letters .letter-chip')].map((e) => e.textContent);
  assert.deepEqual(chips, [card(perfs[7]).letter], 'letters are not shown beside the collapsed toggle');
});

test('a completed turn chimes for everyone at the table', () => {
  click('#soundToggle'); // off
  click('#soundToggle'); // on again — also primes the audio context
  const before = rings();
  s.turnsCompleted = (s.turnsCompleted || 0) + 1;
  push(s);
  assert.ok(rings() > before, 'no chime when turnsCompleted advanced');
  const mid = rings();
  push(s);
  assert.equal(rings(), mid, 'chimed on a push that did not complete a turn');
});

test('the chime can be muted', () => {
  click('#soundToggle');
  assert.ok(/Sound off/.test(html()), 'the toggle did not flip');
  const before = rings();
  s.turnsCompleted += 1;
  push(s);
  assert.equal(rings(), before, 'chimed while muted');
});

if (failures) {
  console.log(`\nclient.test.js: ${failures} FAILED`);
  process.exit(1);
}
console.log('\nALL CLIENT TESTS PASSED');
