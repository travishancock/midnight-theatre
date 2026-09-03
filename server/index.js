// ---------------------------------------------------------------------------
// The Midnight Theatre — game server.
//
// Express serves the built client (client/dist), the card database, and the
// card art. Socket.IO handles rooms, seats, and gameplay: clients send
// intents, the server validates them through the pure rules engine and
// broadcasts the authoritative state. AI seats are driven server-side by
// engine/bot.js.
// ---------------------------------------------------------------------------

import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

import { initCards } from '../engine/cards.js';
import {
  createGame,
  applyAction,
  lockCollectionDie,
  lockTomatoRoll,
  trainerActive,
  mesmeraWindowOpen,
  valentinoRerollAllowance,
  TRAINERS,
} from '../engine/engine.js';
import { botAction, seatsNeedingInput, botWantsMesmeraReroll, botValentinoRerollPicks } from '../engine/bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;

// ---- card database --------------------------------------------------------

const cardDb = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'card_database.json'), 'utf8'));
initCards(cardDb);

// A content hash of every file in assets/cards (name + size + mtime), so the
// client can cache-bust its image URLs (?v=<hash>) whenever the art actually
// changes — including a "the same filename now points at different art"
// deploy, which a filename-based cache alone can't detect. Computed once at
// startup; a fresh deploy always restarts the process, so this is
// recomputed (and changes, if any art changed) on every deploy.
function computeAssetVersion() {
  const dir = path.join(ROOT, 'assets', 'cards');
  const hash = crypto.createHash('sha1');
  for (const f of fs.readdirSync(dir).sort()) {
    const st = fs.statSync(path.join(dir, f));
    hash.update(`${f}:${st.size}:${st.mtimeMs}\n`);
  }
  return hash.digest('hex').slice(0, 10);
}
const ASSET_VERSION = computeAssetVersion();

// ---- HTTP ------------------------------------------------------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.get('/api/cards', (req, res) => res.json({ ...cardDb, assetVersion: ASSET_VERSION }));
// No long-lived cache here: card art filenames don't change when the art
// itself is updated, so a long maxAge (this used to be 7d) meant browsers
// kept serving stale card art for up to a week after a deploy that changed
// a card's image, with no way for the user to see the fix short of a hard
// refresh. etag stays on (express.static's default) so unchanged images
// still get a cheap 304 instead of a full re-download — just always
// revalidated. The client also appends ?v=<ASSET_VERSION> (see
// GET /api/cards above and the client's imgUrl()) so a browser that ignores
// revalidation entirely still fetches fresh art under a new URL whenever
// the art actually changes.
app.use('/cards', express.static(path.join(ROOT, 'assets', 'cards'), { maxAge: 0 }));

const clientDist = path.join(ROOT, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api|cards|socket\.io).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
} else {
  app.get('/', (req, res) =>
    res.send('Midnight Theatre server is running. Build the client with `npm run build` (or use `npm run dev`).')
  );
}

// ---- rooms -----------------------------------------------------------------

const rooms = new Map(); // code -> room

const BOT_NAMES = ['Zoltar', 'Colombina', 'Ferrucio', 'Odette', 'Gaspard'];
const BOT_STEP_MS = 200; // small stagger between a bot's own sub-decisions (e.g. resolving a prompt before its main action)
const BOT_TURN_PAUSE_MS = 2000; // longer pause after a bot fully completes a turn, so players can follow along
const DICE_REVEAL_MS = 1100; // how long a rolled die/tomato batch stays on screen (and reactable) before it locks

// A dropped player's seat gets played by the AI so the table never stalls, but
// not instantly: a browser refresh or a brief network blip round-trips in a
// couple of seconds, and letting the AI take a turn on someone's board in that
// window is worse for everyone than a short pause.
//
// Both of these are env-overridable purely so test/rejoin.test.js can drive
// the takeover-and-return cycle in a second instead of half an hour; nothing
// in production sets them.
const DISCONNECT_BOT_MS = Number(process.env.MT_DISCONNECT_BOT_MS) || 15_000;

// How long a room with nobody connected is kept alive. A seat is only ever
// borrowed by the AI, never lost, so the room has to outlive the last human's
// connection for "re-enter the room code to come back" to mean anything —
// including the case where the only human at a table of AI players drops.
const EMPTY_ROOM_MS = Number(process.env.MT_EMPTY_ROOM_MS) || 30 * 60_000;

function makeCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? makeCode() : code;
}

// humanName is the name a human seat was created with, kept separate from
// `name` because an AI takeover renames the seat to "Foo (AI)". Reclaiming a
// seat matches on humanName and restores it, so a player who drops, gets
// covered by the AI, and comes back is the same player under the same name.
// A seat added with "Add AI player" has humanName null and is never
// reclaimable.
function newSeat(name, socketId) {
  return { name, humanName: name, socketId, isBot: false, disconnectTimer: null };
}

function newBotSeat(name) {
  return { name, humanName: null, socketId: null, isBot: true, disconnectTimer: null };
}

// A seat someone can walk back into: it belonged to a human, and nobody is
// currently sitting in it. Being played by the AI doesn't disqualify it —
// that's the whole point of the takeover being temporary.
function isReclaimable(seat) {
  return !!seat && seat.humanName != null && seat.socketId == null;
}

function reclaimableSeats(room) {
  return room.seats
    .map((s, i) => ({ seat: i, name: s.humanName, playedByAi: s.isBot }))
    .filter((_, i) => isReclaimable(room.seats[i]));
}

function newRoom(hostSocket, hostName) {
  const room = {
    code: makeCode(),
    hostId: hostSocket.id,
    seats: [newSeat(hostName, hostSocket.id)],
    game: null,
    botTimer: null,
    diceTimer: null,
    emptyTimer: null, // set while no human is connected; deletes the room on expiry
  };
  rooms.set(room.code, room);
  return room;
}

function roomOfSocket(socket) {
  return rooms.get(socket.data.roomCode);
}

function seatOfSocket(room, socket) {
  return room.seats.findIndex((s) => s.socketId === socket.id);
}

function anyoneConnected(room) {
  return room.seats.some((s) => s.socketId != null);
}

// Called whenever the last human might have left or come back. An empty room
// isn't dropped on the spot — a player who refreshes their browser or loses
// wifi has EMPTY_ROOM_MS to re-enter the code, and any AI seats keep playing
// the game forward in the meantime.
function updateEmptyRoomTimer(room) {
  if (anyoneConnected(room)) {
    if (room.emptyTimer) clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
    return;
  }
  if (room.emptyTimer) return;
  room.emptyTimer = setTimeout(() => {
    room.emptyTimer = null;
    if (anyoneConnected(room)) return;
    if (room.botTimer) clearTimeout(room.botTimer);
    if (room.diceTimer) clearTimeout(room.diceTimer);
    for (const s of room.seats) if (s.disconnectTimer) clearTimeout(s.disconnectTimer);
    rooms.delete(room.code);
  }, EMPTY_ROOM_MS);
}

function lobbyView(room) {
  return {
    code: room.code,
    started: !!room.game,
    seats: room.seats.map((s, i) => ({
      seat: i,
      name: s.name,
      humanName: s.humanName,
      isBot: s.isBot,
      // A seat the AI is only covering for is shown as an absent human, not as
      // an AI player, so the rest of the table knows someone may be back.
      playedByAi: s.isBot && s.humanName != null,
      connected: (s.isBot && s.humanName == null) || s.socketId != null,
      isHost: s.socketId === room.hostId,
    })),
  };
}

function broadcast(room) {
  io.to(room.code).emit('room', { lobby: lobbyView(room), state: room.game });
}

// ---- bot driver -------------------------------------------------------------

function scheduleBots(room, delay = BOT_STEP_MS) {
  if (room.botTimer || !room.game || room.game.phase === 'gameOver') return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    runOneBotStep(room);
  }, delay);
}

function runOneBotStep(room) {
  const state = room.game;
  if (!state || state.phase === 'gameOver') return;
  const needy = seatsNeedingInput(state);
  const botSeat = needy.find((seat) => room.seats[seat] && room.seats[seat].isBot);
  if (botSeat == null) return;
  const action = botAction(state, botSeat);
  if (!action) return;
  const turnsBefore = state.turnsCompleted;
  try {
    applyAction(state, action);
  } catch (err) {
    // A bot should never produce an illegal action; log and stop rather than spin.
    console.error(`[room ${room.code}] bot seat ${botSeat} illegal action`, action, err.message);
    return;
  }
  broadcast(room);
  // If that action completed a turn (own turn ended, whether it passes to the
  // next seat or chains into a Favor bonus turn), pause longer before the
  // next bot step so players have time to see what just happened.
  const justFinishedATurn = state.turnsCompleted > turnsBefore;
  scheduleBots(room, justFinishedATurn ? BOT_TURN_PAUSE_MS : BOT_STEP_MS);
  scheduleDicePhase(room);
}

// ---- dice-phase driver -------------------------------------------------------
//
// The engine pauses mid-dice-phase at two points so the reveal can be watched
// in real time: a Collection Die sits rolled-but-unlocked
// (state.dieEvent.awaitingLock) purely for reveal pacing, and the Tomato
// batch sits rolled-but-unlocked (state.dice.tomatoRolled &&
// !state.dice.tomatoLocked) so Mesmera's holder — and then Valentino's — can
// react. Neither pause is a `pending` prompt. This driver auto-resolves any bot's reaction immediately,
// then waits DICE_REVEAL_MS (so everyone can see the die/dice on screen)
// before locking and letting the engine continue.

function scheduleDicePhase(room) {
  if (room.diceTimer || !room.game || room.game.phase !== 'dice') return;
  const state = room.game;

  const ev = state.dieEvent;
  if (ev && ev.awaitingLock) {
    autoResolveBotDiceReactions(room);
    room.diceTimer = setTimeout(() => {
      room.diceTimer = null;
      lockCollectionDie(state);
      broadcast(room);
      scheduleBots(room);
      scheduleDicePhase(room);
    }, DICE_REVEAL_MS);
    return;
  }

  const d = state.dice;
  if (d && d.stage === 'tomato' && d.tomatoRolled && !d.tomatoLocked) {
    autoResolveBotDiceReactions(room);
    // Same idea as the Press Pass pause above: if a connected human still owes
    // a decision on this batch, wait for their action instead of auto-locking.
    if (humanTomatoDeciderPending(room)) return;
    room.diceTimer = setTimeout(() => {
      room.diceTimer = null;
      lockTomatoRoll(state);
      broadcast(room);
      scheduleBots(room);
      scheduleDicePhase(room);
    }, DICE_REVEAL_MS);
    return;
  }
}

// A connected human still owes a decision on the open Tomato batch. Bot seats
// have already been resolved by autoResolveBotDiceReactions, so whatever is
// still open belongs to a person and the reveal timer waits for them rather
// than locking the batch out from under them. Mesmera comes first — while her
// window is open Valentino's allowance is 0 by construction, so the two can
// never both be waited on at once.
function humanTomatoDeciderPending(room) {
  const state = room.game;
  const d = state.dice;
  if (!d || d.stage !== 'tomato' || !d.tomatoRolled || d.tomatoLocked) return false;
  const isConnectedHuman = (seat) => {
    const s = room.seats[seat];
    return !!(s && !s.isBot && s.socketId);
  };
  if (mesmeraWindowOpen(state)) {
    return state.players.some((p) => trainerActive(state, p.seat, TRAINERS.MESMERA) && isConnectedHuman(p.seat));
  }
  return state.players.some((p) => valentinoRerollAllowance(state, p.seat) > 0 && isConnectedHuman(p.seat));
}

function autoResolveBotDiceReactions(room) {
  const state = room.game;
  const isBotSeat = (seat) => !!(room.seats[seat] && room.seats[seat].isBot);
  const act = (seat, action) => {
    try {
      applyAction(state, action);
    } catch (err) {
      console.error(`[room ${room.code}] bot seat ${seat} illegal ${action.type}`, err.message);
    }
  };

  // Mesmera the Veiled first, and CLOSE her window explicitly even when the
  // bot declines. Leaving it open used to be harmless (the timer just locked
  // the batch), but The Vanishing Valentino now waits on her: an undecided
  // bot Mesmera would otherwise hold his window shut forever.
  for (let seat = 0; seat < room.seats.length; seat++) {
    if (!isBotSeat(seat)) continue;
    if (!trainerActive(state, seat, TRAINERS.MESMERA)) continue;
    if (state.dice?.mesmeraRerollUsed) continue;
    act(seat, { type: botWantsMesmeraReroll(state, seat) ? 'mesmeraRerollTomato' : 'keepTomatoRoll', seat });
  }

  // Then Valentino's selective re-roll — valentinoRerollAllowance stays 0
  // until Mesmera's window is closed, so this cannot run out of order.
  for (let seat = 0; seat < room.seats.length; seat++) {
    if (!isBotSeat(seat)) continue;
    if (valentinoRerollAllowance(state, seat) < 1) continue;
    const picks = botValentinoRerollPicks(state, seat);
    act(seat, picks.length > 0
      ? { type: 'valentinoRerollTomato', seat, indices: picks }
      : { type: 'keepTomatoRoll', seat });
  }
}

// ---- seat reclaim -------------------------------------------------------------

// Put a socket back into an existing seat, taking it back off the AI if the AI
// had been covering it. The engine keeps `isBot` on the player too (the bot
// driver reads the room's copy, but bot.js and the client both read the
// state's), so both have to be handed back together.
function claimSeat(room, seat, socket, cb) {
  const seatObj = room.seats[seat];
  if (seatObj.disconnectTimer) clearTimeout(seatObj.disconnectTimer);
  seatObj.disconnectTimer = null;
  seatObj.socketId = socket.id;

  const wasAi = seatObj.isBot;
  seatObj.isBot = false;
  seatObj.name = seatObj.humanName;
  const player = room.game?.players?.[seat];
  if (player) {
    player.isBot = false;
    player.name = seatObj.humanName;
    if (wasAi) room.game.log.push(`${seatObj.humanName} is back and takes their seat over from the AI.`);
  }

  socket.data.roomCode = room.code;
  socket.join(room.code);
  // The host may have left while this player was away; an empty chair can't
  // start a game or add AI seats, so hand the room to whoever is actually here.
  if (!room.seats.some((s) => s.socketId === room.hostId)) room.hostId = socket.id;
  updateEmptyRoomTimer(room);

  cb?.({ ok: true, code: room.code, seat });
  broadcast(room);
  // This seat may have been the one the drivers were waiting on (or the AI was
  // mid-flight for it) — re-evaluate both now that a human holds it.
  scheduleBots(room);
  scheduleDicePhase(room);
}

// ---- socket handlers ---------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }, cb) => {
    const room = newRoom(socket, cleanName(name));
    socket.data.roomCode = room.code;
    socket.join(room.code);
    cb?.({ ok: true, code: room.code, seat: 0 });
    broadcast(room);
  });

  // Joining and rejoining are the same door: you type a room code. If the game
  // hasn't started you get a new seat; if it has, you get your old seat back —
  // matched by name when we can, or picked from a list when we can't.
  //
  // `seat` is only ever sent by that picker, and is honoured strictly: if the
  // seat was taken in the meantime the client gets a fresh list rather than
  // being silently dropped into some other player's chair.
  socket.on('joinRoom', ({ code, name, seat }, cb) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) return cb?.({ error: 'No room with that code.' });
    const wantName = cleanName(name);

    if (seat != null) {
      if (!isReclaimable(room.seats[seat])) {
        const open = reclaimableSeats(room);
        return open.length
          ? cb?.({ needSeat: true, code: room.code, seats: open, error: 'Someone just took that seat.' })
          : cb?.({ error: 'That seat is no longer available.' });
      }
      return claimSeat(room, seat, socket, cb);
    }

    // Rejoin: reclaim an absent seat with the same name, whether it is sitting
    // empty or currently being played by the AI.
    const back = room.seats.findIndex((s) => isReclaimable(s) && s.humanName === wantName);
    if (back !== -1) return claimSeat(room, back, socket, cb);

    if (room.game) {
      const open = reclaimableSeats(room);
      if (open.length) return cb?.({ needSeat: true, code: room.code, seats: open });
      return cb?.({ error: 'That game has already started and every seat is filled.' });
    }
    if (room.seats.length >= 5) return cb?.({ error: 'That room is full (5 seats max).' });
    room.seats.push(newSeat(uniqueName(room, wantName), socket.id));
    socket.data.roomCode = room.code;
    socket.join(room.code);
    updateEmptyRoomTimer(room);
    cb?.({ ok: true, code: room.code, seat: room.seats.length - 1 });
    broadcast(room);
  });

  // Read-only peek used by the client's "rejoin a game in progress" screen, so
  // it can offer the seat list without first attempting a join.
  socket.on('roomInfo', ({ code }, cb) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) return cb?.({ error: 'No room with that code.' });
    cb?.({ ok: true, code: room.code, started: !!room.game, seats: reclaimableSeats(room) });
  });

  socket.on('addBot', (_payload, cb) => {
    const room = roomOfSocket(socket);
    if (!room || socket.id !== room.hostId) return cb?.({ error: 'Only the host can add AI players.' });
    if (room.game) return cb?.({ error: 'The game has already started.' });
    if (room.seats.length >= 5) return cb?.({ error: 'The room is full.' });
    const name = BOT_NAMES.find((n) => !room.seats.some((s) => s.name === `${n} (AI)`)) || `Bot ${room.seats.length + 1}`;
    room.seats.push(newBotSeat(`${name} (AI)`));
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('removeSeat', ({ seat }, cb) => {
    const room = roomOfSocket(socket);
    if (!room || socket.id !== room.hostId) return cb?.({ error: 'Only the host can remove seats.' });
    if (room.game) return cb?.({ error: 'The game has already started.' });
    if (!room.seats[seat] || room.seats[seat].socketId === room.hostId) return cb?.({ error: 'Cannot remove that seat.' });
    const [gone] = room.seats.splice(seat, 1);
    if (gone.socketId) {
      const s = io.sockets.sockets.get(gone.socketId);
      if (s) {
        s.leave(room.code);
        s.data.roomCode = null;
        s.emit('kicked');
      }
    }
    cb?.({ ok: true });
    broadcast(room);
  });

  socket.on('startGame', (_payload, cb) => {
    const room = roomOfSocket(socket);
    if (!room || socket.id !== room.hostId) return cb?.({ error: 'Only the host can start the game.' });
    if (room.game) return cb?.({ error: 'Already started.' });
    if (room.seats.length < 2) return cb?.({ error: 'You need at least 2 seats (add an AI player?).' });
    room.game = createGame({
      players: room.seats.map((s) => ({ name: s.name, isBot: s.isBot })),
    });
    cb?.({ ok: true });
    broadcast(room);
    scheduleBots(room);
    scheduleDicePhase(room);
  });

  socket.on('action', (action, cb) => {
    const room = roomOfSocket(socket);
    if (!room || !room.game) return cb?.({ error: 'No game in progress.' });
    const seat = seatOfSocket(room, socket);
    if (seat === -1) return cb?.({ error: 'You are not seated in this room.' });
    if (action?.seat !== seat) return cb?.({ error: 'You can only act for your own seat.' });
    try {
      applyAction(room.game, action);
    } catch (err) {
      return cb?.({ error: err.message });
    }
    cb?.({ ok: true });
    broadcast(room);
    scheduleBots(room);
    scheduleDicePhase(room);
  });

  socket.on('disconnect', () => {
    const room = roomOfSocket(socket);
    if (!room) return;
    const seat = seatOfSocket(room, socket);
    if (seat === -1) return;
    const seatObj = room.seats[seat];
    seatObj.socketId = null;

    if (!room.game) {
      // Lobby: nothing to come back to yet, so drop the seat entirely (host
      // leaving hands the room to whoever is left, or deletes it if empty).
      room.seats.splice(seat, 1);
      const humans = room.seats.filter((s) => !s.isBot && s.socketId);
      if (humans.length === 0) {
        if (room.emptyTimer) clearTimeout(room.emptyTimer);
        rooms.delete(room.code);
        return;
      }
      if (socket.id === room.hostId) room.hostId = humans[0].socketId;
      broadcast(room);
      return;
    }

    // Mid-game the seat is never given up — it is held for them, briefly as an
    // empty chair and then played by the AI, until they re-enter the room code.
    seatObj.disconnectTimer = setTimeout(() => {
      seatObj.disconnectTimer = null;
      if (seatObj.socketId != null || seatObj.isBot) return;
      seatObj.isBot = true;
      seatObj.name = `${seatObj.humanName} (AI)`;
      const player = room.game?.players?.[seat];
      if (player) {
        player.isBot = true;
        player.name = seatObj.name;
        room.game.log.push(`${seatObj.humanName} disconnected — the AI is playing their seat until they return.`);
      }
      broadcast(room);
      scheduleBots(room);
      scheduleDicePhase(room);
    }, DISCONNECT_BOT_MS);

    if (socket.id === room.hostId) {
      const other = room.seats.find((s) => !s.isBot && s.socketId);
      if (other) room.hostId = other.socketId;
    }
    updateEmptyRoomTimer(room);
    broadcast(room);
  });
});

function cleanName(name) {
  const n = String(name || '').trim().slice(0, 24);
  return n || 'Player';
}

function uniqueName(room, name) {
  let n = name;
  let i = 2;
  while (room.seats.some((s) => s.name === n)) n = `${name} ${i++}`;
  return n;
}

server.listen(PORT, () => {
  console.log(`Midnight Theatre server listening on http://localhost:${PORT}`);
});
