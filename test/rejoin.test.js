// ---------------------------------------------------------------------------
// Reconnection tests: a player who drops mid-game keeps their seat, the AI
// covers it while they're away, and re-entering the room code hands it back.
//
// Unlike the other two suites these need a real server, so this file spawns
// server/index.js on its own port with the takeover timers shortened
// (MT_DISCONNECT_BOT_MS / MT_EMPTY_ROOM_MS) and talks to it over socket.io.
// ---------------------------------------------------------------------------

import assert from 'assert';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { io } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PORT = 3987;
const URL = `http://localhost:${PORT}`;
const TAKEOVER_MS = 400; // MT_DISCONNECT_BOT_MS below
const EMPTY_ROOM_MS = 3000; // MT_EMPTY_ROOM_MS below — must comfortably outlast TAKEOVER_MS
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    console.log('  ok ', name);
    passed++;
  } catch (err) {
    console.log('  FAIL', name);
    console.log('       ', err.message);
    failures.push(name);
  }
}

// ---- harness ---------------------------------------------------------------

function connect() {
  const sock = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
  return new Promise((resolve, reject) => {
    sock.once('connect', () => resolve(sock));
    sock.once('connect_error', reject);
  });
}

// Every server call in this file is request/response, so wrap the ack callback.
function call(sock, event, payload) {
  return new Promise((resolve) => sock.emit(event, payload, resolve));
}

// The next 'room' broadcast this socket sees, with a timeout so a test that
// waits for something that never happens fails loudly instead of hanging.
function nextRoom(sock, ms = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for a room broadcast')), ms);
    sock.once('room', (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
  });
}

// The room payload this socket is currently holding, refreshed on every push.
function track(sock) {
  const box = { latest: null };
  sock.on('room', (p) => (box.latest = p));
  return box;
}

// A started 2-seat game: one human, one AI player, so the table keeps moving
// while the human is away.
async function startedGame(hostName = 'Travis') {
  const host = await connect();
  const seen = track(host);
  const created = await call(host, 'createRoom', { name: hostName });
  await call(host, 'addBot', {});
  await call(host, 'startGame', {});
  await sleep(150);
  return { host, seen, code: created.code };
}

// ---- tests -----------------------------------------------------------------

async function run() {
  await test('a mid-game disconnect holds the seat, and the AI takes it over', async () => {
    const { host, code } = await startedGame();
    host.disconnect();
    await sleep(TAKEOVER_MS + 300);

    const probe = await connect();
    const info = await call(probe, 'roomInfo', { code });
    assert.ok(info.ok, 'the room outlives the last human leaving');
    assert.equal(info.started, true);
    const mine = info.seats.find((s) => s.name === 'Travis');
    assert.ok(mine, 'the empty seat is still listed under the human name, not the AI name');
    assert.equal(mine.playedByAi, true, 'and it is flagged as covered by the AI');
    probe.disconnect();
  });

  await test('re-entering the code under the same name takes the seat back off the AI', async () => {
    const { host, code } = await startedGame();
    host.disconnect();
    await sleep(TAKEOVER_MS + 300);

    const back = await connect();
    const seen = track(back);
    const res = await call(back, 'joinRoom', { code, name: 'Travis' });
    assert.ok(res.ok, `expected a clean rejoin, got ${JSON.stringify(res)}`);
    assert.equal(res.seat, 0, 'the same seat, not a new one');
    await sleep(150);

    const seat = seen.latest.lobby.seats[0];
    assert.equal(seat.isBot, false, 'the seat is human again');
    assert.equal(seat.name, 'Travis', 'and the "(AI)" suffix is gone');
    assert.equal(seen.latest.state.players[0].isBot, false, 'the engine state agrees');
    assert.equal(seen.latest.state.players[0].name, 'Travis');
    back.disconnect();
  });

  await test('rejoining inside the grace period skips the AI entirely', async () => {
    const { host, code } = await startedGame();
    host.disconnect();
    await sleep(50); // faster than a browser refresh, well inside the window

    const back = await connect();
    const seen = track(back);
    const res = await call(back, 'joinRoom', { code, name: 'Travis' });
    assert.ok(res.ok);
    await sleep(TAKEOVER_MS + 300); // the pending takeover timer must not fire on us
    assert.equal(seen.latest.lobby.seats[0].isBot, false, 'the stale takeover timer did not steal the seat back');
    back.disconnect();
  });

  await test('a name that matches nothing gets the seat picker, not a rejection', async () => {
    const { host, code } = await startedGame();
    host.disconnect();
    await sleep(TAKEOVER_MS + 300);

    const back = await connect();
    const res = await call(back, 'joinRoom', { code, name: 'Travsi' }); // typo
    assert.ok(!res.ok, 'a mismatched name should not silently seat you');
    assert.equal(res.needSeat, true, 'it offers a choice instead');
    assert.equal(res.seats.length, 1);
    assert.equal(res.seats[0].name, 'Travis');

    const claimed = await call(back, 'joinRoom', { code, name: 'Travsi', seat: res.seats[0].seat });
    assert.ok(claimed.ok, `picking the offered seat should work, got ${JSON.stringify(claimed)}`);
    assert.equal(claimed.seat, 0);
    back.disconnect();
  });

  await test('an AI player added in the lobby is never offered as a reclaimable seat', async () => {
    const { host, code } = await startedGame();
    const info = await call(host, 'roomInfo', { code });
    assert.deepEqual(info.seats, [], 'nobody is absent yet, so nothing is on offer');
    host.disconnect();
    await sleep(TAKEOVER_MS + 300);

    const probe = await connect();
    const after = await call(probe, 'roomInfo', { code });
    assert.equal(after.seats.length, 1, 'only the human seat, never the AI player from the lobby');
    assert.equal(after.seats[0].name, 'Travis');
    probe.disconnect();
  });

  await test('a seat someone else has already taken is refused, with a fresh list', async () => {
    const { host, code } = await startedGame();
    host.disconnect();
    await sleep(TAKEOVER_MS + 300);

    const first = await connect();
    await call(first, 'joinRoom', { code, name: 'Travis' });
    const second = await connect();
    const res = await call(second, 'joinRoom', { code, name: 'Someone', seat: 0 });
    assert.ok(!res.ok, 'an occupied seat cannot be claimed out from under someone');
    first.disconnect();
    second.disconnect();
  });

  await test('a game in progress with nobody absent still refuses new players', async () => {
    const { host, code } = await startedGame();
    const other = await connect();
    const res = await call(other, 'joinRoom', { code, name: 'Latecomer' });
    assert.ok(!res.ok);
    assert.ok(!res.needSeat, 'there is no seat to offer');
    assert.match(res.error, /already started/);
    host.disconnect();
    other.disconnect();
  });

  await test('the room is dropped once nobody has come back within the empty-room window', async () => {
    const { host, code } = await startedGame();
    host.disconnect();
    await sleep(EMPTY_ROOM_MS + 500);

    const probe = await connect();
    const info = await call(probe, 'roomInfo', { code });
    assert.ok(!info.ok, 'the room is eventually reclaimed');
    probe.disconnect();
  });
}

// ---- runner -----------------------------------------------------------------

const server = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    MT_DISCONNECT_BOT_MS: String(TAKEOVER_MS),
    MT_EMPTY_ROOM_MS: String(EMPTY_ROOM_MS),
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});

// Wait for the listening line rather than a fixed sleep.
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start in time')), 10000);
  server.stdout.on('data', (chunk) => {
    if (String(chunk).includes('listening')) {
      clearTimeout(t);
      resolve();
    }
  });
});

try {
  await run();
} finally {
  server.kill();
}

console.log(`\nrejoin.test.js: ${passed} passing`);
if (failures.length) {
  console.log(`FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('ALL REJOIN TESTS PASSED');
