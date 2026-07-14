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
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';

import { initCards } from '../engine/cards.js';
import { createGame, applyAction, lockCollectionDie, lockTomatoRoll, trainerActive, TRAINERS } from '../engine/engine.js';
import { botAction, seatsNeedingInput, botWantsPressPassRerollNow, botWantsMesmeraReroll } from '../engine/bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;

// ---- card database --------------------------------------------------------

const cardDb = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'card_database.json'), 'utf8'));
initCards(cardDb);

// ---- HTTP ------------------------------------------------------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.get('/api/cards', (req, res) => res.json(cardDb));
// No long-lived cache here: card art filenames don't change when the art
// itself is updated (no cache-busting hash in the client's imgUrl()), so a
// long maxAge (this used to be 7d) meant browsers kept serving stale card
// art for up to a week after a deploy that changed a card's image, with no
// way for the user to see the fix short of a hard-refresh. etag stays on
// (express.static's default) so unchanged images still get a cheap 304
// instead of a full re-download — just always revalidated.
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
const DICE_REVEAL_MS = 2200; // how long a rolled die/tomato batch stays on screen (and reactable) before it locks
const DISCONNECT_BOT_MS = 60_000; // absent players become bots so games don't stall

function makeCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? makeCode() : code;
}

function newRoom(hostSocket, hostName) {
  const room = {
    code: makeCode(),
    hostId: hostSocket.id,
    seats: [{ name: hostName, socketId: hostSocket.id, isBot: false, disconnectTimer: null }],
    game: null,
    botTimer: null,
    diceTimer: null,
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

function lobbyView(room) {
  return {
    code: room.code,
    started: !!room.game,
    seats: room.seats.map((s, i) => ({
      seat: i,
      name: s.name,
      isBot: s.isBot,
      connected: s.isBot || s.socketId != null,
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
// and reacted to in real time: a Collection Die sits rolled-but-unlocked
// (state.dieEvent.awaitingLock) so Press Pass holders can react, and the
// Tomato batch sits rolled-but-unlocked (state.dice.tomatoRolled &&
// !state.dice.tomatoLocked) so Mesmera's holder can react. Neither pause is a
// `pending` prompt — they're driven proactively, the same way a human would
// just click the reactive card if they want it. This driver auto-resolves any
// bot's reaction immediately, then waits DICE_REVEAL_MS (so everyone can see
// the die/dice on screen) before locking and letting the engine continue.

function scheduleDicePhase(room) {
  if (room.diceTimer || !room.game || room.game.phase !== 'dice') return;
  const state = room.game;

  const ev = state.dieEvent;
  if (ev && ev.awaitingLock) {
    autoResolveBotDiceReactions(room);
    // If a connected human holds this round's Press Pass pool and still has
    // a re-roll left, give them real time to decide instead of auto-locking
    // on a timer — they either spend a re-roll (usePressPass) or confirm
    // they're keeping this result (lockPressPassDie). Either action goes
    // through the normal 'action' handler, which calls scheduleDicePhase
    // again afterward, so the reveal continues the moment they decide.
    const pp = state.dice.pressPass;
    const ppSeat = pp ? room.seats[pp.seat] : null;
    const humanIsDeciding = pp && pp.usesLeft > 0 && ppSeat && !ppSeat.isBot && ppSeat.socketId;
    if (humanIsDeciding) return;
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
    // Same idea as the Press Pass pause above: if a connected human holds
    // Mesmera the Veiled and hasn't decided yet this round, wait for their
    // mesmeraRerollTomato or keepTomatoRoll action instead of auto-locking.
    const mesmeraSeat = state.players.findIndex((p) => trainerActive(state, p.seat, TRAINERS.MESMERA));
    const mSeatObj = mesmeraSeat !== -1 ? room.seats[mesmeraSeat] : null;
    const humanIsDeciding = !d.mesmeraRerollUsed && mSeatObj && !mSeatObj.isBot && mSeatObj.socketId;
    if (humanIsDeciding) return;
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

function autoResolveBotDiceReactions(room) {
  const state = room.game;
  for (let seat = 0; seat < room.seats.length; seat++) {
    if (!room.seats[seat] || !room.seats[seat].isBot) continue;
    // A bot may spend more than one re-roll on the same stubborn die before
    // giving up and locking it in, same as a human could.
    while (botWantsPressPassRerollNow(state, seat)) {
      try {
        applyAction(state, { type: 'usePressPass', seat });
      } catch (err) {
        console.error(`[room ${room.code}] bot seat ${seat} illegal usePressPass`, err.message);
        break;
      }
    }
    if (botWantsMesmeraReroll(state, seat)) {
      try {
        applyAction(state, { type: 'mesmeraRerollTomato', seat });
      } catch (err) {
        console.error(`[room ${room.code}] bot seat ${seat} illegal mesmeraRerollTomato`, err.message);
      }
    }
  }
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

  socket.on('joinRoom', ({ code, name }, cb) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) return cb?.({ error: 'No room with that code.' });
    const wantName = cleanName(name);

    // Rejoin: reclaim a disconnected human seat with the same name.
    const back = room.seats.findIndex((s) => !s.isBot && s.socketId == null && s.name === wantName);
    if (back !== -1) {
      const seatObj = room.seats[back];
      seatObj.socketId = socket.id;
      if (seatObj.disconnectTimer) clearTimeout(seatObj.disconnectTimer);
      seatObj.disconnectTimer = null;
      socket.data.roomCode = room.code;
      socket.join(room.code);
      cb?.({ ok: true, code: room.code, seat: back });
      broadcast(room);
      return;
    }
    if (room.game) return cb?.({ error: 'That game has already started.' });
    if (room.seats.length >= 5) return cb?.({ error: 'That room is full (5 seats max).' });
    room.seats.push({ name: uniqueName(room, wantName), socketId: socket.id, isBot: false, disconnectTimer: null });
    socket.data.roomCode = room.code;
    socket.join(room.code);
    cb?.({ ok: true, code: room.code, seat: room.seats.length - 1 });
    broadcast(room);
  });

  socket.on('addBot', (_payload, cb) => {
    const room = roomOfSocket(socket);
    if (!room || socket.id !== room.hostId) return cb?.({ error: 'Only the host can add AI players.' });
    if (room.game) return cb?.({ error: 'The game has already started.' });
    if (room.seats.length >= 5) return cb?.({ error: 'The room is full.' });
    const name = BOT_NAMES.find((n) => !room.seats.some((s) => s.name === `${n} (AI)`)) || `Bot ${room.seats.length + 1}`;
    room.seats.push({ name: `${name} (AI)`, socketId: null, isBot: true, disconnectTimer: null });
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
      // Lobby: drop the seat entirely (host leaving hands the room to seat 0,
      // or deletes the room if empty).
      room.seats.splice(seat, 1);
      const humans = room.seats.filter((s) => !s.isBot && s.socketId);
      if (humans.length === 0) {
        rooms.delete(room.code);
        return;
      }
      if (socket.id === room.hostId) room.hostId = humans[0].socketId;
      broadcast(room);
      return;
    }

    // Mid-game: give them a minute to rejoin, then let a bot take over.
    seatObj.disconnectTimer = setTimeout(() => {
      seatObj.disconnectTimer = null;
      if (seatObj.socketId == null && !seatObj.isBot) {
        seatObj.isBot = true;
        seatObj.name = `${seatObj.name} (AI)`;
        if (room.game && seat < room.game.players.length) {
          room.game.players[seat].isBot = true;
          room.game.players[seat].name = seatObj.name;
        }
        broadcast(room);
        scheduleBots(room);
        scheduleDicePhase(room);
      }
      // Clean up rooms where every human has gone.
      if (room.seats.every((s) => s.isBot || s.socketId == null)) rooms.delete(room.code);
    }, DISCONNECT_BOT_MS);
    if (socket.id === room.hostId) {
      const other = room.seats.find((s) => !s.isBot && s.socketId);
      if (other) room.hostId = other.socketId;
    }
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
