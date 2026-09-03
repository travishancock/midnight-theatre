// The Midnight Theatre — client. Framework-free SPA: the server broadcasts
// the authoritative game state; this file renders it and sends intents back.

import { io } from 'socket.io-client';

const app = document.getElementById('app');

// ---------------------------------------------------------------------------
// Global client state
// ---------------------------------------------------------------------------

let socket = null;
let cards = new Map(); // id -> card data (from /api/cards)
let my = { code: null, seat: null, name: '' };
let view = { lobby: null, state: null };
// Set when a join lands on a game already in progress and the server needs us
// to say which absent seat we're taking back: { code, seats: [{seat, name,
// playedByAi}] }. Rendering this replaces the welcome screen until it clears.
let rejoin = null;
let assetVersion = ''; // from /api/cards — appended to card image URLs so a browser always fetches fresh art after a deploy that changes it, even under an unchanged filename

// Transient UI state
let ui = {
  mode: null, // null | 'rearrange' | 'amaraMove'
  rearrange: null, // { slots, reserve, picked: {zone, index} | null }
  amaraMove: null, // { from: cardId | null } — Amara the Reliquary's move-a-heart picker
  valentinoPick: null, // [cardId] — draft cards chosen for The Vanishing Valentino's trim
  heartPlan: {}, // cardId -> amount, for heartAssign prompt
  refillPlan: null, // [{slot, cardId}]
  logOpen: true,
  openReserves: {}, // seat -> true while that opponent's reserve row is expanded
};

const SLOT_NAMES = ['Performer 1', 'Performer 2', 'Performer 3', 'Performer 4', 'Performer 5', 'Backdrop / Trainer', 'Prop / Trainer', 'Trainer'];

// Mirrors CELESTINE_MAX_STARS / CELESTINE_STAR_COST in engine/engine.js — the
// server stays authoritative, this just renders the same offer it will accept.
const CELESTINE = { maxStars: 2, starCost: 2 };
// Mirrors AMARA_MAX_MOVES in engine/engine.js.
const AMARA = { maxMoves: 3 };

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function boot() {
  const db = await fetch('/api/cards').then((r) => r.json());
  assetVersion = db.assetVersion || '';
  for (const key of ['performers', 'propsAndBackdrops', 'trainers', 'resources', 'favors', 'rerolls']) {
    for (const c of db[key]) {
      const cardType =
        key === 'performers' ? 'performer'
        : key === 'propsAndBackdrops' ? c.cardKind
        : key === 'trainers' ? 'trainer'
        : key === 'resources' ? 'resource'
        : key === 'favors' ? 'favor'
        : 'reroll';
      cards.set(c.id, { ...c, cardType });
    }
  }
  socket = io();
  socket.on('room', (payload) => {
    const prevVersion = view.state?.version;
    const isFirstState = prevVersion === undefined;
    const prevLogLen = view.state?.log?.length ?? 0;
    const prevTurns = view.state?.turnsCompleted ?? 0;
    view = payload;
    if (view.state && view.state.version !== prevVersion) {
      resetTransientUi();
      if (!isFirstState) {
        announceTrophies(view.state.log.slice(prevLogLen));
        announceSupplyShortage(view.state.log.slice(prevLogLen));
        // engine.js increments turnsCompleted exactly once per finished turn,
        // so this is the one signal that means "play has moved on" regardless
        // of who acted or which phase we are in. Everyone gets the quiet
        // click; only the seat that is now up gets the beep on top of it.
        if (view.state.turnsCompleted > prevTurns) {
          tick();
          if (isMyTurn() || myPending()) alertMyTurn();
        }
      }
    }
    render();
  });
  socket.on('kicked', () => {
    my = { code: null, seat: null, name: my.name };
    view = { lobby: null, state: null };
    render();
  });
  socket.on('disconnect', () => toast('Connection lost — trying to reconnect…'));
  socket.on('connect', () => {
    // Auto-rejoin after a dropped connection that the socket itself recovered
    // from. The page never reloaded, so we still know our name and code and
    // the server matches us straight back into our seat — taking it off the AI
    // if the outage ran long enough for the takeover to kick in. A rejoin that
    // needs a decision (seat gone, seat ambiguous) falls back to the same
    // screens a manually typed code would reach.
    if (!my.code || !my.name) return;
    joinWithCode(my.code);
  });
  render();
}

// Whenever fresh log lines arrive that record a Trophy award, surface it as
// a toast for everyone at the table (in addition to the log entry itself),
// so the round's outcome is hard to miss.
function announceTrophies(newLines) {
  const wins = newLines.filter((l) => l.includes('takes a Trophy!'));
  if (wins.length === 0) return;
  // "X earned the most stars (N) and takes a Trophy!" — split on " earned "
  // to extract the name.
  const names = wins.map((l) => l.split(' earned ')[0]);
  const msg = names.length === 1
    ? `🏆 ${names[0]} wins the Trophy this round!`
    : `🏆 ${names.join(' & ')} tie and share the Trophy this round!`;
  toast(msg, 5000);
}

// A token pool running dry is a component-count problem worth interrupting
// for, so it gets a long toast on top of the standing banner and log line.
function announceSupplyShortage(newLines) {
  const hits = newLines.filter((l) => l.includes('TOKEN SUPPLY'));
  if (hits.length === 0) return;
  toast(hits[hits.length - 1], 8000);
}

function resetTransientUi() {
  ui.mode = null;
  ui.rearrange = null;
  ui.amaraMove = null;
  ui.valentinoPick = null;
  // heartPlan and refillPlan are deliberately NOT wiped here. A state push
  // arrives every time any seat acts — during the dice phase that is every
  // second or two — and wiping would erase a half-finished plan out from
  // under the player's cursor. For hearts that is not just annoying: Confirm
  // only enables at total === must, so a plan that keeps resetting can never
  // be completed, which reads at the table as "it won't let me put these
  // hearts on my reserve cards" — reserve cards being exactly the targets
  // that need the extra clicks once the mat is full. They are reconciled
  // against live state instead.
  pruneHeartPlan();
  if (!st()?.pending?.some((x) => x.seat === my.seat && x.kind === 'refill')) ui.refillPlan = null;
}

// Reconcile a half-built heart plan with the state that just arrived: drop
// cards the player no longer owns, clamp each card to the room it still has,
// and never carry more than the prompt is actually asking for. Clears the
// plan outright once the prompt is gone.
function pruneHeartPlan() {
  const s = st();
  const p = me();
  const item = s && p ? s.pending.find((x) => x.seat === my.seat && x.kind === 'heartAssign') : null;
  if (!item) {
    ui.heartPlan = {};
    return;
  }
  const owned = [...p.slots.filter(Boolean), ...p.reserve];
  const ownedSet = new Set(owned);
  let budget = Math.min(item.data.amount, owned.reduce((a, id) => a + capLeft(p, id), 0));
  const next = {};
  for (const [id, amount] of Object.entries(ui.heartPlan)) {
    if (!ownedSet.has(id)) continue;
    const take = Math.min(amount, capLeft(p, id), budget);
    if (take > 0) {
      next[id] = take;
      budget -= take;
    }
  }
  ui.heartPlan = next;
}

// ---------------------------------------------------------------------------
// Turn chime
// ---------------------------------------------------------------------------
// At a physical table there is an obvious cue that play has moved on: someone
// puts a card down. On screen there is none, so a turn can sit unnoticed. One
// short chime for every connected player each time a turn completes — the
// person who is now up hears it, and so does everyone else, the same way they
// would hear the cards.
//
// Synthesised with Web Audio rather than shipped as an audio file: nothing to
// load, nothing to 404, and it works with the tab offline. Browsers refuse to
// start audio before the user has interacted with the page, so the context is
// created lazily on the first click (see primeAudio's callers) and resumed if
// the browser suspended it.
const SOUND_KEY = 'midnight-theatre:sound';
let audioCtx = null;

function soundOn() {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true; // Safari private mode throws on access — default to audible
  }
}

function setSoundOn(on) {
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {}
}

function primeAudio() {
  if (!soundOn()) return null;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx.state === 'running' ? audioCtx : null;
  } catch {
    return null;
  }
}

// Two sounds, because a turn ending and YOUR turn starting are different
// events and only one of them needs you to look up.
//
// tick()  — every completed turn, for everyone. A short, quiet, dry click:
//           the table equivalent of hearing a card go down. Deliberately
//           unmusical and ~40ms so it never competes with conversation.
// alert() — only for the seat that is now up. A two-note rising beep, louder
//           and pitched to carry.
function blip(partials, { attack = 0.006, decay, peak, type = 'sine', delay = 0 } = {}) {
  const ctx = primeAudio();
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(peak, t + attack);
  out.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  out.connect(ctx.destination);
  for (const [freq, level] of partials) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(level, t);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }
}

// A turn went by — someone else's, or yours ending.
function tick() {
  blip([[420, 1], [900, 0.25]], { attack: 0.003, decay: 0.05, peak: 0.1, type: 'triangle' });
}

// You are up. Two rising notes, so it reads as a summons rather than an echo
// of the click that just played for everyone.
function alertMyTurn() {
  blip([[784, 1]], { decay: 0.16, peak: 0.34 });
  blip([[1175, 1]], { decay: 0.34, peak: 0.34, delay: 0.15 });
}

// ---------------------------------------------------------------------------
// Helpers mirroring engine rules (server remains authoritative)
// ---------------------------------------------------------------------------

const card = (id) => cards.get(id);
const st = () => view.state;
const me = () => st()?.players?.[my.seat];

// Mirrors engine.js's activePerformers — the performers actually performing:
// mat slots 0-4, PLUS this seat's reserve Singers while Bellacanto the
// Choirmistress is their active Trainer, who count everywhere an on-stage
// performer would. The server stays authoritative; this only keeps the
// buttons and prices on screen agreeing with it.
function activePerformerIds(player) {
  const out = player.slots.slice(0, 5).filter((id) => id && card(id).cardType === 'performer');
  if (trainerIs(player, 'Bellacanto-the-Choirmistress')) {
    for (const id of player.reserve) {
      const c = card(id);
      if (c.cardType === 'performer' && c.type === 'Singer') out.push(id);
    }
  }
  return out;
}

function activePerformersWhere(player, pred) {
  return activePerformerIds(player).filter((id) => pred(card(id)));
}

// Jonas Quickfinger takes any ACTIVE Haunting performer — which under
// Bellacanto includes a Haunting Singer sitting in reserve, so this keys off
// the active set rather than a slot index. Module-level because both the mat
// renderer and the click handlers need it.
function jonasCanTake(player, id) {
  return !!id && card(id).characteristic === 'Haunting' && activePerformerIds(player).includes(id);
}

function trainerIs(player, id) {
  return player.slots[5] === id || player.slots[6] === id || player.slots[7] === id;
}

// All Trainer ids currently active on a player's board (0-3 of them).
function activeTrainerIds(player) {
  return [player.slots[5], player.slots[6], player.slots[7]].filter((id) => id && card(id).cardType === 'trainer');
}

function maxHearts(player, id) {
  const c = card(id);
  if (!['performer', 'backdrop', 'prop', 'trainer'].includes(c.cardType)) return 0;
  return c.maxHearts ?? c.startingHearts ?? 0;
}

// Like maxHearts, but returns null for card types that don't carry hearts at
// all (favor/reroll/resource) instead of 0, so callers can tell "no capacity"
// apart from "capacity of zero" when deciding whether to show a hearts badge.
function cardMaxHeartsFor(id) {
  const c = card(id);
  if (!['performer', 'backdrop', 'prop', 'trainer'].includes(c.cardType)) return null;
  return c.maxHearts ?? c.startingHearts ?? 0;
}

function capLeft(player, id) {
  return Math.max(0, maxHearts(player, id) - (st().hearts[id] || 0));
}

// All of a player's mat + reserve card ids — the universe Anna the
// Reliquary's "any of your cards" move-a-heart ability can pick from.
function ownedCardIds(p) {
  return [...p.slots.filter(Boolean), ...p.reserve];
}

// Is there at least one legal (from, to) pair for Amara's ability right now?
function anyMovableHeart(p) {
  const s = st();
  const ids = ownedCardIds(p);
  const sources = ids.filter((id) => (s.hearts[id] || 0) > 0);
  const targets = ids.filter((id) => capLeft(p, id) > 0);
  return sources.some((from) => targets.some((to) => to !== from));
}

// Mirrors marketCost in engine/engine.js — the server stays authoritative,
// this only decides the price shown on the button. Barnaby Pennywhistle
// discounts 1 coin per *active* Graceful performer, down to 0 but never below.
function marketCost(player, index) {
  let cost = index + 1;
  if (trainerIs(player, 'Barnaby-Pennywhistle')) {
    const graceful = activePerformersWhere(player, (c) => c.characteristic === 'Graceful').length;
    cost = Math.max(0, cost - graceful);
  }
  return cost;
}

function myPending() {
  if (!st() || my.seat == null) return null;
  return st().pending.find((p) => p.seat === my.seat) || null;
}

function isMyTurn() {
  const s = st();
  return s && s.phase === 'draft' && s.turn && s.turn.seat === my.seat && !s.turn.done && s.pending.length === 0;
}

function send(action, silent = false) {
  socket.emit('action', { ...action, seat: my.seat }, (res) => {
    if (res?.error && !silent) toast(res.error);
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  if (!view.lobby && rejoin) return renderRejoin();
  if (!view.lobby) return renderWelcome();
  if (!view.state) return renderLobby();
  renderGame();
}

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const imgUrl = (c) => '/' + encodeURI(c.image) + (assetVersion ? `?v=${assetVersion}` : '');

// `letter: true` stamps the performer's Collection letter over the top-left
// corner of the art. The printed letter lives in the card's bottom-right
// medallion, which is legible in the hand and at mat size but not at the
// small sizes the reserve rows use — and the bottom strip is also where the
// hearts pill sits. Since the letter is the single thing an opponent needs to
// read off a reserve card, it gets its own high-contrast chip in a corner
// nothing else uses.
// `heartTokens: n` lays n heart tokens across the middle of the card, the way
// loose heart tokens sit on a card at a physical table. That is how every
// opponent's card reports its hearts — mat and reserve alike — because a
// count of tokens is read at a glance from across a table where "2/3" is not.
// `hearts: n` is the alternative: a small "❤ n/max" pill, kept for your OWN
// cards, where the capacity matters because you are the one filling it.
// The card's type is emitted as a class because hover-to-enlarge is
// Trainer-only (see style.css).
function cardHtml(id, { size = 'md', extra = '', badge = null, hearts = null, dim = false, heartTokens = null } = {}) {
  const c = card(id);
  const h = hearts != null ? hearts : null;
  const max = cardMaxHeartsFor(id);
  return `
    <div class="card ${size} ${c.cardType} ${dim ? 'dim' : ''} ${extra}" data-cardid="${esc(id)}" title="${esc(cardTitle(c))}">
      <img src="${imgUrl(c)}" alt="${esc(c.name)}" loading="lazy" draggable="false"/>
      ${heartTokens ? `<span class="heart-tokens" aria-label="${heartTokens} heart${heartTokens > 1 ? 's' : ''} remaining">${
        '<i>\u2665</i>'.repeat(heartTokens)
      }</span>` : ''}
      ${h != null ? `<span class="hearts">❤ ${h}${max != null ? `/${max}` : ''}</span>` : ''}
      ${badge ? `<span class="badge">${badge}</span>` : ''}
    </div>`;
}

function cardTitle(c) {
  const bits = [c.name];
  if (c.cardType === 'performer') bits.push(`Letter ${c.letter} · ${c.resource} · ${c.startingHearts}❤ · ${c.powerDots} power dots`);
  if (c.effect) bits.push(c.effect);
  if (c.ability) bits.push(c.ability);
  return bits.join('\n');
}

// ---- welcome / lobby --------------------------------------------------------

function renderWelcome() {
  const last = recall();
  app.innerHTML = `
    <div class="welcome">
      <h1>The Midnight Theatre</h1>
      <p class="tag">Build the most legendary troupe under the big top.</p>
      <div class="panel">
        <label>Your name <input id="nameInput" maxlength="24" value="${esc(my.name || last.name)}" placeholder="e.g. Travis"/></label>
        <div class="row">
          <button id="createBtn" class="primary">Create a room</button>
        </div>
        <div class="row join-row">
          <input id="codeInput" maxlength="4" placeholder="ROOM CODE" style="text-transform:uppercase" value="${esc(last.code)}"/>
          <button id="joinBtn">Join</button>
        </div>
        <p class="hint">Same box either way — if you were dropped from a game that's still running, put the code back in to take your seat again. The AI covers for you while you're away.</p>
      </div>
    </div>`;
  const name = () => document.getElementById('nameInput').value.trim() || 'Player';
  document.getElementById('createBtn').onclick = () => {
    my.name = name();
    socket.emit('createRoom', { name: my.name }, (res) => {
      if (res?.error) return toast(res.error);
      enterRoom(res);
    });
  };
  const doJoin = () => {
    my.name = name();
    const code = document.getElementById('codeInput').value.trim().toUpperCase();
    if (!code) return toast('Enter a room code first.');
    joinWithCode(code);
  };
  document.getElementById('joinBtn').onclick = doJoin;
  document.getElementById('codeInput').onkeydown = (e) => e.key === 'Enter' && doJoin();
}

function joinWithCode(code, seat) {
  socket.emit('joinRoom', { code, name: my.name, seat }, (res) => {
    if (res?.needSeat) {
      // The game is already running and our name didn't match an absent seat —
      // let the player point at the one that's theirs.
      rejoin = { code: res.code, seats: res.seats };
      if (res.error) toast(res.error);
      return render();
    }
    if (res?.error) {
      // Includes the auto-rejoin case where the room is simply gone — drop
      // back to the welcome screen rather than leaving a dead board on screen.
      rejoin = null;
      my.code = null;
      my.seat = null;
      view = { lobby: null, state: null };
      render();
      return toast(res.error);
    }
    rejoin = null;
    enterRoom(res);
  });
}

function enterRoom(res) {
  my.code = res.code;
  my.seat = res.seat;
  remember(my.name, my.code);
}

// The seat picker: shown when someone re-enters the code of a game in
// progress under a name the server can't match to an absent seat (a typo, a
// different device, or they simply don't remember what they typed).
function renderRejoin() {
  app.innerHTML = `
    <div class="welcome">
      <h1>The Midnight Theatre</h1>
      <p class="tag">That game is still going — which seat is yours?</p>
      <div class="panel">
        <h2>Room <span class="code">${esc(rejoin.code)}</span></h2>
        <ul class="seatlist">
          ${rejoin.seats.map((s) => `
            <li>
              <span>${esc(s.name)} ${s.playedByAi ? '<span class="hint">· the AI is playing this seat</span>' : '<span class="hint">· empty</span>'}</span>
              <button class="small" data-claim="${s.seat}">Take this seat</button>
            </li>`).join('')}
        </ul>
        <div class="row">
          <button id="rejoinBack">Back</button>
        </div>
      </div>
    </div>`;
  app.querySelectorAll('[data-claim]').forEach((b) =>
    b.addEventListener('click', () => joinWithCode(rejoin.code, +b.dataset.claim))
  );
  document.getElementById('rejoinBack').onclick = () => {
    rejoin = null;
    render();
  };
}

// A refresh wipes everything in memory, so the room code and name are kept in
// localStorage purely to pre-fill the welcome form — the actual reclaim still
// goes through the server, this just saves retyping a code you can no longer
// see. Wrapped because Safari's private mode throws on access.
const REMEMBER_KEY = 'midnight-theatre:last';
function remember(name, code) {
  try {
    localStorage.setItem(REMEMBER_KEY, JSON.stringify({ name, code }));
  } catch {}
}
function recall() {
  try {
    const v = JSON.parse(localStorage.getItem(REMEMBER_KEY) || '{}');
    return { name: v.name || '', code: v.code || '' };
  } catch {
    return { name: '', code: '' };
  }
}

function renderLobby() {
  const L = view.lobby;
  const iAmHost = L.seats.some((s) => s.seat === my.seat && s.isHost);
  app.innerHTML = `
    <div class="welcome">
      <h1>The Midnight Theatre</h1>
      <div class="panel">
        <h2>Room <span class="code">${esc(L.code)}</span></h2>
        <p class="hint">Share this code (or this page's address) with the other players.</p>
        <ul class="seatlist">
          ${L.seats.map((s) => `
            <li>
              <span>${esc(s.name)} ${s.isHost ? '· host' : ''} ${s.isBot ? '· AI' : ''} ${!s.connected && !s.isBot ? '· disconnected' : ''}</span>
              ${iAmHost && !s.isHost ? `<button class="small" data-remove="${s.seat}">remove</button>` : ''}
            </li>`).join('')}
        </ul>
        ${iAmHost ? `
          <div class="row">
            <button id="addBotBtn" ${L.seats.length >= 5 ? 'disabled' : ''}>Add AI player</button>
            <button id="startBtn" class="primary" ${L.seats.length < 2 ? 'disabled' : ''}>Start game (${L.seats.length} players)</button>
          </div>
          <p class="hint">2–5 players. AI can fill any empty seat.</p>`
        : `<p class="hint">Waiting for the host to start the game…</p>`}
      </div>
    </div>`;
  if (iAmHost) {
    document.getElementById('addBotBtn')?.addEventListener('click', () => socket.emit('addBot', {}, (r) => r?.error && toast(r.error)));
    document.getElementById('startBtn')?.addEventListener('click', () => socket.emit('startGame', {}, (r) => r?.error && toast(r.error)));
    app.querySelectorAll('[data-remove]').forEach((b) =>
      b.addEventListener('click', () => socket.emit('removeSeat', { seat: +b.dataset.remove }, (r) => r?.error && toast(r.error)))
    );
  }
}

// ---- game --------------------------------------------------------------------

function renderGame() {
  const s = st();
  const p = me();
  const iAmSpectator = !p;
  const pending = myPending();

  app.innerHTML = `
    <div class="game ${ui.mode === 'rearrange' ? 'rearranging' : ''}">
      <header>
        <div class="brand">🎪 The Midnight Theatre <span class="code">room ${esc(view.lobby.code)}</span></div>
        <div class="status">
          Round ${s.round} · ${s.phase === 'draft' ? 'Draft phase' : s.phase === 'dice' ? 'Dice phase' : 'Game over'}
          · First to ${s.trophyGoal} 🏆 wins
          <button id="soundToggle" class="small sound-toggle"
            title="${soundOn() ? 'Turn the end-of-turn chime off' : 'Turn the end-of-turn chime on'}">
            ${soundOn() ? '🔔 Sound on' : '🔕 Sound off'}
          </button>
        </div>
      </header>
      ${s.phase === 'gameOver' ? winnersBanner(s) : ''}
      ${supplyHtml(s)}
      ${diceTray(s, p)}
      <section class="table">
        <div class="center-col">
          ${draftRowHtml(s, p, pending)}
          ${marketHtml(s, p)}
          ${turnBarHtml(s, p)}
          ${wendellDiscardHtml(s)}
          ${pending ? promptHtml(s, p, pending) : ''}
          ${waitingNoteHtml(s, p, pending)}
        </div>
        <aside class="log ${ui.logOpen ? '' : 'closed'}">
          <div class="log-head" id="logToggle">Show log ${ui.logOpen ? '▾' : '▸'}</div>
          <div class="log-body">${s.log.slice(-80).map((l) => `<div>${esc(l)}</div>`).join('')}</div>
        </aside>
      </section>
      ${iAmSpectator ? '' : myMatHtml(s, p, pending)}
      <section class="opponents">
        ${s.players.filter((x) => x.seat !== my.seat).map((x) => opponentHtml(s, x)).join('')}
      </section>
    </div>`;

  wireGameEvents(s, p, pending);
  const body = app.querySelector('.log-body');
  if (body) body.scrollTop = body.scrollHeight;
}

// Physical token supply (see engine.js's TOKEN_SUPPLY/tokenSupply). Purely
// informational — a dry pool never blocks a gain — but a pool that has run
// out at any point this game stays flagged, since the whole reason to track
// this is catching a component count that's too low for the printed game.
function supplyHtml(s) {
  const sup = s.tokenSupply;
  if (!sup) return '';
  const alerts = s.supplyAlerts || {};
  const icon = { hearts: '❤', stars: '⭐', coins: '🪙' };
  const cells = ['hearts', 'stars', 'coins'].map((k) => {
    const { left, total, out } = sup[k];
    const dry = left <= 0;
    return `<span class="supply-cell ${dry ? 'dry' : ''}" title="${out} of ${total} ${k} in play">
      ${icon[k]} ${Math.max(0, left)}<span class="hint">/${total}</span>
    </span>`;
  }).join('');
  const short = Object.entries(alerts).map(([k, a]) =>
    a.deficit > 0
      ? `${k} ran ${a.deficit} short in round ${a.round} (needed ${a.out}, only ${a.total} exist)`
      : `${k} hit exactly zero in round ${a.round}`
  );
  return `<div class="supply">
    <span class="lbl">Token supply:</span>${cells}
    ${short.length ? `<span class="supply-alert">⚠ ${short.map(esc).join(' · ')}</span>` : ''}
  </div>`;
}

function winnersBanner(s) {
  const names = s.winners.map((w) => s.players[w].name).join(' & ');
  return `<div class="winners">🏆 ${esc(names)} win${s.winners.length === 1 ? 's' : ''} the game! 🏆</div>`;
}

// Mesmera the Veiled: proactive re-roll of the whole Tomato batch, available
// only in the window after the batch is rolled and before it locks.
function mesmeraReady(s, p) {
  if (!p) return false;
  const d = s.dice;
  if (!d || d.stage !== 'tomato' || !d.tomatoRolled || d.tomatoLocked || d.mesmeraRerollUsed) return false;
  return trainerIs(p, 'Mesmera-the-Veiled');
}

// Whoever holds Mesmera the Veiled also gets real (unhurried) time to decide
// on the open Tomato batch — the server skips its usual reveal timer for
// them (see server's scheduleDicePhase). Everyone else sees a waiting note.
function mesmeraDecider(s) {
  const d = s.dice;
  if (!d || d.stage !== 'tomato' || !d.tomatoRolled || d.tomatoLocked || d.mesmeraRerollUsed) return null;
  return s.players.find((pl) => trainerIs(pl, 'Mesmera-the-Veiled')) || null;
}

function diceTray(s, p) {
  const d = s.dice;
  const ev = s.dieEvent;
  const evHtml = ev
    ? `<span class="die live ${ev.kind}">${ev.value}</span>
       <span class="hint">${ev.kind === 'collection' ? `Collection Die${ev.position ? ` #${ev.position}` : ''}` : 'Tomato die'}
       ${ev.rerollHistory ? `re-rolled (${ev.rerollHistory.join(' → ')})` : 'just rolled'}
       ${ev.source !== 'phase' ? ` (${ev.source === 'tomasso' ? 'Tomasso the Terrible' : 'Madame Curio'})` : ''}</span>`
    : '';
  if (!d && !ev) return `<div class="dicetray"><span class="hint">Dice are rolled after the draft. ${tomatoForecast(s)}</span></div>`;

  const mes = mesmeraReady(s, p);
  const mDecider = mesmeraDecider(s);
  const reactionHtml = mes
    ? `<div class="dice-reaction">
         <button id="mesmeraBtn" class="primary">Mesmera: re-roll all Tomato dice</button>
         <button id="keepTomatoBtn">Keep this result</button>
       </div>`
    : mDecider && (!p || mDecider.seat !== p.seat)
    ? `<div class="dice-reaction"><span class="hint">Waiting for ${esc(mDecider.name)} to decide (Mesmera the Veiled)…</span></div>`
    : d && d.stage === 'tomato' && d.tomatoRolled && !d.tomatoLocked
    ? `<div class="dice-reaction"><span class="hint">Tomato dice locking in…</span></div>`
    : '';

  return `<div class="dicetray">
    ${d ? `<span class="lbl">Collection:</span>${d.results.map((r) => `<span class="die collection">${r}</span>`).join('')}` : ''}
    ${d && d.tomatoResults.length ? `<span class="lbl">Tomatoes:</span>${d.tomatoResults.map((r) => `<span class="die tomato">${r}</span>`).join('')}` : ''}
    ${evHtml}
    ${d ? `<span class="hint">${d.tomatoTotal} tomato ${d.tomatoTotal === 1 ? 'die' : 'dice'} this round</span>` : ''}
    ${reactionHtml}
  </div>
  ${s.phase === 'dice' ? earnedTableHtml(s) : ''}`;
}

function earnedTableHtml(s) {
  return `<table class="earned">
    <thead><tr><th>Player</th><th>🪙 coins</th><th>⭐ stars</th><th>❤ hearts</th></tr></thead>
    <tbody>
      ${s.players.map((pl) => `
        <tr class="${pl.seat === my.seat ? 'me' : ''}">
          <td>${esc(pl.name)}</td>
          <td>${pl.roundCoins}</td>
          <td>${pl.roundStars}</td>
          <td>${pl.roundHearts}</td>
        </tr>`).join('')}
    </tbody>
  </table>`;
}

function tomatoForecast(s) {
  // Stays in sync with engine.js's MAX_TOMATO_DICE (currently 7) — the
  // rolled batch caps there from round 7 onward.
  const n = Math.min(s.round, 7);
  return `${n} tomato ${n === 1 ? 'die' : 'dice'} loom this round.`;
}

function draftRowHtml(s, p, pending) {
  const clickable = (isMyTurn() && !ui.mode) || ui.mode === 'valentinoPick';
  return `<div class="zone">
    <h3>Draft row <span class="hint">(free — ends when 1 card remains)</span></h3>
    <div class="cardrow ${clickable ? 'clickable' : ''}" id="draftRow">
      ${s.draftRow.map((id) => cardHtml(id, {
        size: 'md',
        extra: ui.mode === 'valentinoPick' ? ((ui.valentinoPick || []).includes(id) ? 'selected' : 'highlight') : '',
      })).join('') || '<span class="hint">empty</span>'}
    </div>
  </div>`;
}

// Wendell the Propmaster: the discard-pile cards this seat may take (Props
// and Backdrops only), shown only while ui.mode === 'wendellTake'.
function wendellDiscardHtml(s) {
  if (ui.mode !== 'wendellTake') return '';
  const options = s.discard.filter((id) => card(id).cardType === 'prop' || card(id).cardType === 'backdrop');
  return `<div class="zone">
    <h3>Discard pile <span class="hint">(Wendell the Propmaster — click one to take it)</span></h3>
    <div class="cardrow clickable" id="wendellDiscardRow">
      ${options.map((id) => cardHtml(id, { size: 'md' })).join('') || '<span class="hint">no eligible Props or Backdrops</span>'}
    </div>
  </div>`;
}

function marketHtml(s, p) {
  const canAct = isMyTurn() && !ui.mode;
  return `<div class="zone">
    <h3>Market
      <span class="hint">deck ${s.deck.length} · discard ${s.discard.length}</span>
      ${canAct && !s.turn.mainDone ? `<button class="small" id="resetMarketBtn" ${p && p.coins >= 1 ? '' : 'disabled'}>Reset market (1🪙)</button>` : ''}
    </h3>
    <div class="cardrow">
      ${s.market.map((id, i) => {
        if (!id) {
          return `<div class="market-slot"><div class="sold">Sold —<br/>refills once<br/>your turn ends</div></div>`;
        }
        const cost = p ? marketCost(p, i) : i + 1;
        const afford = p && p.coins >= cost;
        return `<div class="market-slot">
          ${cardHtml(id, { size: 'md' })}
          <button class="small buy" data-buy="${i}" ${canAct && afford && (!s.turn.mainDone || s.turn.open) ? '' : 'disabled'}>Buy ${cost}🪙</button>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function dancerCountOf(p) {
  return activePerformersWhere(p, (c) => c.type === 'Dancer').length;
}

function turnBarHtml(s, p) {
  if (!p) return '';
  if (s.phase !== 'draft' || !s.turn) return '';
  if (s.pending.length > 0) return '';

  if (s.turn.seat !== my.seat || s.turn.done) return '';

  const t = s.turn;
  const trainers = activeTrainerIds(p);
  const buttons = [];

  if (ui.mode === 'rearrange') {
    buttons.push(`<button id="confirmRearrange" class="primary">Confirm arrangement (ends turn)</button>`);
    buttons.push(`<button id="cancelMode">Cancel</button>`);
  } else if (ui.mode === 'amaraMove') {
    buttons.push(`<span class="yourturn">${ui.amaraMove?.from
      ? 'Amara the Reliquary: now click the card to move that heart onto.'
      : 'Amara the Reliquary: click one of your cards with a ❤ to move it from.'}</span>`);
    buttons.push(`<button id="cancelMode">Cancel</button>`);
  } else if (ui.mode === 'jonasPick') {
    buttons.push(`<span class="yourturn">Jonas Quickfinger: click a Haunting performer on your stage to discard it for its resource x its power dots.</span>`);
    buttons.push(`<button id="cancelMode">Cancel</button>`);
  } else if (ui.mode === 'valentinoPick') {
    const picked = ui.valentinoPick || [];
    const allowance = activePerformersWhere(p, (c) => c.characteristic === 'Dramatic').length;
    buttons.push(`<span class="yourturn">The Vanishing Valentino: click up to ${allowance} draft card${allowance === 1 ? '' : 's'} to vanish (${picked.length} chosen).</span>`);
    if (picked.length > 0) buttons.push(`<button id="valentinoConfirm" class="primary">Vanish ${picked.length} card${picked.length === 1 ? '' : 's'}</button>`);
    buttons.push(`<button id="cancelMode">Cancel</button>`);
  } else if (ui.mode === 'wendellTake') {
    buttons.push(`<span class="yourturn">Wendell the Propmaster: click a card below to take it from the discard pile.</span>`);
    buttons.push(`<button id="cancelMode">Cancel</button>`);
  } else {
    if (!t.mainDone) {
      buttons.push(`<span class="yourturn">Your turn — click a draft card to take it, buy from the market, or:</span>`);
      buttons.push(`<button id="rearrangeBtn">Rearrange troupe (uses turn)</button>`);
      if (trainers.includes('Tomasso-the-Terrible')) {
        const n = dancerCountOf(p);
        buttons.push(`<button id="tomassoBtn" ${n >= 1 ? '' : 'disabled'} title="${n < 1 ? 'You need at least 1 Dancer on your board' : ''}">Tomasso the Terrible: roll ${n} Tomato ${n === 1 ? 'die' : 'dice'} (uses turn)</button>`);
      }
      if (trainers.includes('Wendell-the-Propmaster')) {
        const hasOption = s.discard.some((id) => card(id).cardType === 'prop' || card(id).cardType === 'backdrop');
        buttons.push(`<button id="wendellBtn" ${hasOption ? '' : 'disabled'} title="${hasOption ? '' : 'No Props or Backdrops are in the discard pile'}">Wendell the Propmaster: take a Prop/Backdrop from discard (uses turn)</button>`);
      }
      if (trainers.includes('Celestine-the-Stargazer') && !t.celestineUsed) {
        for (let n = 1; n <= CELESTINE.maxStars; n++) {
          const cost = n * CELESTINE.starCost;
          buttons.push(`<button class="small" data-celestine="${n}" ${p.coins >= cost ? '' : 'disabled'}>Celestine: buy ${n}⭐ (${cost}🪙)</button>`);
        }
      }
      if (trainers.includes('Amara-the-Reliquary') && (t.amaraMoves || 0) < AMARA.maxMoves) {
        const has = anyMovableHeart(p);
        const left = AMARA.maxMoves - (t.amaraMoves || 0);
        buttons.push(`<button id="amaraMoveBtn" ${has ? '' : 'disabled'} title="${has ? '' : 'None of your cards currently hold a heart'}">Amara the Reliquary: rearrange a heart (${left} left, free)</button>`);
      }
      if (trainers.includes('Jonas-Quickfinger') && !t.jonasUsed) {
        const haunting = activePerformerIds(p).filter((id) => jonasCanTake(p, id));
        buttons.push(`<button id="jonasBtn" ${haunting.length ? '' : 'disabled'} title="${haunting.length ? '' : 'No Haunting performer on your stage'}">Jonas Quickfinger: cash in a Haunting performer (free)</button>`);
      }
      if (trainers.includes('The-Vanishing-Valentino') && !t.valentinoUsed) {
        const allowance = activePerformersWhere(p, (c) => c.characteristic === 'Dramatic').length;
        const can = allowance > 0 && s.draftRow.length > 0;
        buttons.push(`<button id="valentinoBtn" ${can ? '' : 'disabled'} title="${can ? '' : 'Needs a Dramatic performer on stage and cards in the draft row'}">The Vanishing Valentino: vanish ${allowance} draft card${allowance === 1 ? '' : 's'} (free)</button>`);
      }
    }
    if (t.open) {
      buttons.push(`<button id="endTurnBtn" class="primary">End turn (Maximillian)</button>`);
    }
  }
  return `<div class="turnbar">${buttons.join(' ')}</div>`;
}

function waitingNoteHtml(s, p, pending) {
  if (!p || pending || s.phase === 'gameOver') return '';
  if (s.pending.length > 0) {
    const who = [...new Set(s.pending.map((x) => s.players[x.seat].name))].join(', ');
    return `<div class="waiting">Waiting on ${esc(who)}…</div>`;
  }
  if (s.phase === 'draft' && s.turn && s.turn.seat !== my.seat) {
    return `<div class="waiting">Waiting on ${esc(s.players[s.turn.seat].name)}'s draft turn…</div>`;
  }
  return '';
}

// ---- prompts -------------------------------------------------------------------

function promptHtml(s, p, item) {
  switch (item.kind) {
    case 'pressPassWindow': {
      const myPasses = p.reserve.filter((id) => card(id).cardType === 'reroll');
      return promptBox(`
        <div>Before this round's 5 shared Collection Dice roll, you may spend any Press Pass card${myPasses.length === 1 ? '' : 's'} below for private roll${myPasses.length === 1 ? '' : 's'} of your own. Click one to spend it, or continue whenever you're ready.</div>
        <button id="pressPassContinue" class="primary">${myPasses.length > 0 ? "I'm done — roll the dice" : 'Continue — roll the dice'}</button>`);
    }
    case 'placement': {
      return promptBox(`
        <div>Place <b>${esc(card(item.data.cardId).name)}</b> — click a highlighted slot on your mat below (the current occupant, if any, moves to your reserve)${item.data.allowReserve ? ', or send it to reserve instead' : ''}.</div>
        ${item.data.allowReserve ? `<button id="placementToReserve">Send to reserve instead</button>` : ''}`);
    }
    case 'cardResourcePlacement': {
      // Show the cards, not their names. A drawn card is a thing you look at
      // and judge; a sentence naming it makes you go and find it in the
      // database in your head. The whole batch this Resource drew is shown,
      // with the one currently asking for a home called out.
      const drawn = item.data.drawn && item.data.drawn.length ? item.data.drawn : [item.data.cardId];
      const placing = item.data.cardId;
      const many = drawn.length > 1;
      return promptBox(`
        <div>${many
          ? `You drew <b>${drawn.length}</b> cards${item.data.source ? ` from <b>${esc(item.data.source)}</b>` : ''}. <b>${esc(card(placing).name)}</b> needs a home`
          : `You drew <b>${esc(card(placing).name)}</b>`} — click a highlighted slot on your mat below to place it (the current occupant, if any, moves to your reserve), or send it to reserve instead.</div>
        <div class="cardrow">
          ${drawn.map((id) => cardHtml(id, {
            size: 'md',
            dim: id !== placing,
            extra: id === placing ? 'placing' : '',
          })).join('')}
        </div>
        <button id="cardResourceToReserve">Send to reserve instead</button>`);
    }
    case 'drawnCardsReveal': {
      const drawn = item.data.drawn || [];
      return promptBox(`
        <div>${esc(item.data.source || 'Your Resource card')} drew ${drawn.length === 1 ? 'this' : `these <b>${drawn.length}</b>`} for you${drawn.length === 1 ? '' : ''} — ${drawn.length === 1 ? 'it has' : 'they have'} gone straight to your mat.</div>
        <div class="cardrow">
          ${drawn.map((id) => cardHtml(id, { size: 'md' })).join('')}
        </div>
        <button id="drawnRevealContinue" class="primary">Continue</button>`);
    }
    case 'heartAssign': {
      const targets = [...p.slots.filter(Boolean), ...p.reserve].filter((id) => capLeft(p, id) > 0);
      const total = Object.values(ui.heartPlan).reduce((a, b) => a + b, 0);
      const cap = targets.reduce((a, id) => a + capLeft(p, id), 0);
      const must = Math.min(item.data.amount, cap);
      return promptBox(`
        <div>Assign <b>${must}</b> heart(s) <span class="hint">(${esc(item.data.reason)})</span> — ${must - total} left to place.</div>
        <div class="assignrow">
          ${targets.map((id) => `
            <div class="assign">
              ${cardHtml(id, { size: 'sm', hearts: (s.hearts[id] || 0) + (ui.heartPlan[id] || 0) })}
              <div class="stepper">
                <button data-hminus="${esc(id)}" ${ui.heartPlan[id] ? '' : 'disabled'}>−</button>
                <span>${ui.heartPlan[id] || 0}</span>
                <button data-hplus="${esc(id)}" ${total < must && capLeft(p, id) - (ui.heartPlan[id] || 0) > 0 ? '' : 'disabled'}>+</button>
              </div>
            </div>`).join('')}
        </div>
        <button id="confirmHearts" class="primary" ${total === must ? '' : 'disabled'}>Confirm</button>`);
    }
    case 'auricGainChoice': {
      const { coinsEarned, heartsEarned, reason } = item.data;
      const parts = [];
      if (coinsEarned > 0) parts.push(`<b>${coinsEarned}</b> coin${coinsEarned > 1 ? 's' : ''}`);
      if (heartsEarned > 0) parts.push(`<b>${heartsEarned}</b> heart${heartsEarned > 1 ? 's' : ''}`);
      return promptBox(`
        <div>You've received ${parts.join(' and ')} <span class="hint">(${esc(reason)})</span>. Auric the Alchemist may transmute this on the way in — check any you'd like to convert:</div>
        <div class="assignrow">
          ${coinsEarned > 0 ? `<label><input type="checkbox" id="auricConvertCoins"/> Take the ${coinsEarned} coin${coinsEarned > 1 ? 's' : ''} as heart${coinsEarned > 1 ? 's' : ''} instead</label>` : ''}
          ${heartsEarned > 0 ? `<label><input type="checkbox" id="auricConvertHearts"/> Take the ${heartsEarned} heart${heartsEarned > 1 ? 's' : ''} as coin${heartsEarned > 1 ? 's' : ''} instead</label>` : ''}
        </div>
        <button id="auricGainConfirm" class="primary">Confirm</button>`);
    }
    case 'postAcquireDiscard': {
      const labels = {
        stainglass: 'Discard it (Professor Stainglass) — draw 1 per Powerful performer, keep one',
      };
      return promptBox(`
        <div>You just acquired <b>${esc(item.data.cardName)}</b> — keep it, or discard it right now for a Trainer effect?</div>
        <div class="assignrow">
          ${item.data.choices.map((ch) => `<button data-postacquire="${esc(ch)}">${labels[ch]}</button>`).join('')}
        </div>
        <button id="postAcquireKeep" class="primary">Keep it</button>`);
    }
    case 'stainglassKeep': {
      return promptBox(`
        <div>Professor Stainglass drew <b>${item.data.drawn.length}</b> cards — click the one you want to keep. The rest are discarded.</div>
        <div class="cardrow clickable" id="stainglassKeepRow">
          ${item.data.drawn.map((id) => cardHtml(id, { size: 'md' })).join('')}
        </div>`);
    }
    case 'diceResultsReview': {
      return promptBox(`
        <div>This round's Collection Dice and Tomato dice have both finished rolling — take a look at the results above, then continue when you're ready.</div>
        <button id="diceReviewContinue" class="primary">Continue</button>`);
    }
    case 'barreRearrange': {
      if (ui.mode !== 'rearrange' || !ui.rearrange) {
        ui.mode = 'rearrange';
        ui.rearrange = { slots: [...p.slots], reserve: [...p.reserve], picked: null };
      }
      return promptBox(`
        <div>The round is over — Madame Barre may freely rearrange your troupe now (any card, any slot, active or reserve) before the next round begins. Click cards on your mat/reserve below to swap them, then confirm — or skip if you don't want to change anything.</div>
        <button id="confirmBarreRearrange" class="primary">Confirm rearrangement</button>
        <button id="skipBarreRearrange">Skip — leave as is</button>`);
    }
    case 'refill': {
      const plan = ui.refillPlan ?? defaultRefillPlan(s, p);
      ui.refillPlan = plan;
      return promptBox(`
        <div>Refill your empty slots from your reserve (required where possible):</div>
        <div class="refillrows">
          ${plan.map((a, i) => `
            <div class="refillrow">
              <span>${SLOT_NAMES[a.slot]}:</span>
              <select data-refill="${i}">
                ${suitableFor(p, a.slot).map((id) => `<option value="${esc(id)}" ${id === a.cardId ? 'selected' : ''}>${esc(card(id).name)} (❤${s.hearts[id] || 0})</option>`).join('')}
              </select>
            </div>`).join('')}
        </div>
        <button id="confirmRefill" class="primary">Confirm refill</button>`);
    }
    default:
      return promptBox(`Waiting on a decision (${esc(item.kind)})…`);
  }
}

function promptBox(inner) {
  return `<div class="prompt">${inner}</div>`;
}

function wantTypesForSlot(slot) {
  if (slot <= 4) return ['performer'];
  if (slot === 5) return ['backdrop', 'trainer'];
  if (slot === 6) return ['prop', 'trainer'];
  return ['trainer'];
}

function suitableFor(p, slot) {
  const wantTypes = wantTypesForSlot(slot);
  return p.reserve.filter((id) => wantTypes.includes(card(id).cardType));
}

function defaultRefillPlan(s, p) {
  const remaining = [...p.reserve];
  const plan = [];
  for (let slot = 0; slot < 8; slot++) {
    if (p.slots[slot] != null) continue;
    const wantTypes = wantTypesForSlot(slot);
    const idx = remaining.findIndex((id) => wantTypes.includes(card(id).cardType));
    if (idx >= 0) {
      plan.push({ slot, cardId: remaining[idx] });
      remaining.splice(idx, 1);
    }
  }
  return plan;
}

// ---- mats ------------------------------------------------------------------------

// A Favor card can be spent, right now, if it's this player's turn, they
// haven't yet taken their main turn action, nothing else is pending, and
// the card's printed timing is met: a "1st" Favor on the player's first
// turn of the round OR any later turn (p.turns >= 0 — never expires), a
// "2nd" Favor starting on their second turn or any later turn that round
// (p.turns >= 1, not their very first). Stays in sync with engine.js's
// favorEligibleNow. There is never a forced prompt for this — the card is
// just clickable, and nothing stops spending more than one in the same
// pre-action window, or again during any bonus turn a Favor grants.
function favorReadyNow(s, p, id) {
  if (!isMyTurn() || s.turn.mainDone) return false;
  const c = card(id);
  if (c.cardType !== 'favor') return false;
  return p.turns >= c.triggerAfterTurn - 1;
}

// A Press Pass card can be spent only during this player's own pre-roll
// window — a pending 'pressPassWindow' prompt that opens the instant the
// draft ends, before the round's 5 shared Collection Dice roll (see
// engine.js's openPressPassWindow/usePressPass). Never a forced choice
// within that window — the card is just clickable, like a Favor — but not
// spendable at any other time.
function pressPassReadyNow(s, p, id) {
  if (!s.pending.some((x) => x.kind === 'pressPassWindow' && x.seat === my.seat)) return false;
  return card(id).cardType === 'reroll';
}

function myMatHtml(s, p, pending) {
  const placing = pending?.kind === 'placement' || pending?.kind === 'cardResourcePlacement';
  const allowed = placing ? pending.data.allowedSlots : [];
  const r = ui.mode === 'rearrange' ? ui.rearrange : null;
  const amaraMove = ui.mode === 'amaraMove' ? ui.amaraMove : null;
  const slots = r ? r.slots : p.slots;
  const reserve = r ? r.reserve : p.reserve;
  const anyFavorReady = !r && reserve.some((id) => favorReadyNow(s, p, id));
  const anyPressPassReady = !r && reserve.some((id) => pressPassReadyNow(s, p, id));
  // Amara the Reliquary: highlight hearted cards while picking a source, or
  // cards with room once a source is picked.
  const amaraEligible = (id) => {
    if (!amaraMove || !id) return false;
    if (!amaraMove.from) return (s.hearts[id] || 0) > 0;
    return id !== amaraMove.from && capLeft(p, id) > 0;
  };

  // The Vanishing Valentino: highlight the Dramatic performers that can be
  // discarded to pay for ending the draft.
  const jonasEligible = (id) => ui.mode === 'jonasPick' && jonasCanTake(p, id);

  return `<section class="mymat">
    <div class="mat-head">
      <h3>${esc(p.name)} <span class="hint">(you) · stand ${p.stand}</span></h3>
      <div class="tokens">🪙 ${p.coins} &nbsp; ⭐ ${p.roundStars} <span class="hint">this round</span> &nbsp; 🏆 ${p.trophies}/${s.trophyGoal}</div>
    </div>
    <div class="slots" id="mySlots">
      ${slots.map((id, i) => {
        const sel = r?.picked?.zone === 'slot' && r.picked.index === i;
        const amaraSel = amaraMove && id === amaraMove.from;
        return `
        <div class="slot ${placing && allowed.includes(i) ? 'highlight' : ''} ${amaraEligible(id) ? 'highlight' : ''} ${jonasEligible(id) ? 'highlight' : ''} ${sel || amaraSel ? 'selected' : ''}" data-slot="${i}">
          <span class="slotname">${SLOT_NAMES[i]}</span>
          ${id ? cardHtml(id, { size: 'lg', hearts: s.hearts[id] || 0 }) : '<div class="empty">empty</div>'}
        </div>`;
      }).join('')}
    </div>
    <div class="reserve">
      <h4>Reserve (${reserve.length}) <span class="hint">favor & re-roll cards live here; bumped cards wait here</span>
        ${anyFavorReady ? '<span class="hint gold">— click a Favor below for an extra turn</span>' : ''}
        ${anyPressPassReady ? '<span class="hint gold">— click a Press Pass below for private die roll(s)</span>' : ''}</h4>
      <div class="cardrow" id="myReserve">
        ${reserve.map((id, i) => {
          const sel = r?.picked?.zone === 'reserve' && r.picked.index === i;
          const amaraSel = amaraMove && id === amaraMove.from;
          const favorReady = !r && favorReadyNow(s, p, id);
          const pressPassReady = !r && pressPassReadyNow(s, p, id);
          const ready = favorReady || pressPassReady;
          const title = favorReady
            ? 'Click to spend this Favor for an extra turn'
            : pressPassReady
            ? 'Click to spend this Press Pass for private Collection Die roll(s)'
            : '';
          return `<div class="pickable ${sel || amaraSel ? 'selected' : ''} ${ready ? 'favor-ready' : ''} ${amaraEligible(id) || jonasEligible(id) ? 'highlight' : ''}" data-reserve="${i}" ${title ? `title="${title}"` : ''}>${cardHtml(id, { size: 'sm', hearts: cardMaxHeartsFor(id) != null ? (s.hearts[id] || 0) : null })}</div>`;
        }).join('') || (r ? '' : '<span class="hint">empty</span>')}
        ${r ? '<div class="pickable droptarget" data-reserve="-1">⤓ move here</div>' : ''}
      </div>
    </div>
  </section>`;
}

// An opponent's reserve is open information at a physical table — the cards
// sit face-up beside their mat — so it's shown here too, but behind a
// per-opponent toggle: with four opponents on screen, four always-expanded
// reserves push the mats off the bottom of the page. ui.openReserves survives
// re-renders (see resetTransientUi, which deliberately leaves it alone) so a
// reserve you opened stays open as the game state ticks over.
function opponentHtml(s, p) {
  const isTurn = s.phase === 'draft' && s.turn && s.turn.seat === p.seat && !s.turn.done;
  const open = !!ui.openReserves[p.seat];
  const empty = p.reserve.length === 0;
  // A seat the AI is only covering reads differently from an AI player who was
  // dealt in at the start — that person may well be back mid-round.
  const lobbySeat = view.lobby?.seats?.[p.seat];
  const who = lobbySeat?.playedByAi
    ? `${esc(lobbySeat.humanName)} <span title="Away — the AI is playing their seat until they return">⏳🤖</span>`
    : `${esc(p.name)} ${p.isBot ? '🤖' : ''}`;
  return `<div class="opponent ${isTurn ? 'active' : ''}">
    <div class="mat-head">
      <h4>${who} <span class="hint">stand ${p.stand}</span></h4>
      <div class="tokens">🪙 ${p.coins} · ⭐ ${p.roundStars} this round · 🏆 ${p.trophies}</div>
    </div>
    <div class="slots mini">
      ${p.slots.map((id, i) => `
        <div class="slot mini" title="${SLOT_NAMES[i]}">
          ${id ? cardHtml(id, { size: 'xs', heartTokens: s.hearts[id] || 0 }) : '<div class="empty">·</div>'}
        </div>`).join('')}
    </div>
    <div class="opp-reserve">
      <button class="reserve-toggle" data-oppreserve="${p.seat}" ${empty ? 'disabled' : ''}
        title="${empty ? 'Nothing in reserve' : 'Show this player’s reserve (favors, press passes and bumped cards)'}">
        ${empty ? '·' : open ? '▾' : '▸'} Reserve (${p.reserve.length})
      </button>
      ${open && !empty ? `<div class="cardrow mini-reserve">
        ${p.reserve.map((id) => cardHtml(id, { size: 'xs', heartTokens: s.hearts[id] || 0 })).join('')}
      </div>` : ''}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Event wiring for the game screen
// ---------------------------------------------------------------------------

function wireGameEvents(s, p, pending) {
  // Any click anywhere in the app counts as the user gesture browsers require
  // before audio may start, so by the time the first turn ends the context is
  // already running and the chime is not swallowed.
  app.addEventListener('click', () => primeAudio(), { once: true });

  document.getElementById('soundToggle')?.addEventListener('click', () => {
    const next = !soundOn();
    setSoundOn(next);
    if (next) {
      primeAudio();
      alertMyTurn(); // preview the loudest of the two, at the real volume
    }
    render();
  });

  document.getElementById('logToggle')?.addEventListener('click', () => {
    ui.logOpen = !ui.logOpen;
    render();
  });

  // Expand/collapse an opponent's reserve row.
  app.querySelectorAll('[data-oppreserve]').forEach((b) =>
    b.addEventListener('click', () => {
      const seat = +b.dataset.oppreserve;
      ui.openReserves[seat] = !ui.openReserves[seat];
      render();
    })
  );

  // Draft-row clicks: acquire.
  document.getElementById('draftRow')?.addEventListener('click', (e) => {
    const el = e.target.closest('[data-cardid]');
    if (!el) return;
    const id = el.dataset.cardid;
    if (ui.mode === 'valentinoPick') {
      const picked = ui.valentinoPick || [];
      const allowance = activePerformersWhere(p, (c) => c.characteristic === 'Dramatic').length;
      const at = picked.indexOf(id);
      if (at >= 0) picked.splice(at, 1);
      else if (picked.length < allowance) picked.push(id);
      ui.valentinoPick = picked;
      render();
      return;
    }
    if (isMyTurn() && !ui.mode && !s.turn.mainDone) {
      send({ type: 'acquireDraft', cardId: id });
    }
  });

  // Market buys / reset.
  app.querySelectorAll('[data-buy]').forEach((b) =>
    b.addEventListener('click', () => send({ type: 'buyMarket', index: +b.dataset.buy }))
  );
  document.getElementById('resetMarketBtn')?.addEventListener('click', () => send({ type: 'resetMarket' }));

  // Turn bar.
  document.getElementById('rearrangeBtn')?.addEventListener('click', () => {
    ui.mode = 'rearrange';
    ui.rearrange = { slots: [...p.slots], reserve: [...p.reserve], picked: null };
    render();
  });
  document.getElementById('cancelMode')?.addEventListener('click', () => {
    ui.mode = null;
    ui.rearrange = null;
    ui.amaraMove = null;
    render();
  });
  document.getElementById('amaraMoveBtn')?.addEventListener('click', () => {
    ui.mode = 'amaraMove';
    ui.amaraMove = { from: null };
    render();
  });
  document.getElementById('confirmRearrange')?.addEventListener('click', () => {
    const r = ui.rearrange;
    ui.mode = null;
    ui.rearrange = null;
    send({ type: 'rearrange', slots: r.slots, reserve: r.reserve });
  });
  document.getElementById('tomassoBtn')?.addEventListener('click', () => send({ type: 'tomassoRoll' }));
  document.getElementById('wendellBtn')?.addEventListener('click', () => {
    ui.mode = 'wendellTake';
    render();
  });
  document.getElementById('wendellDiscardRow')?.addEventListener('click', (e) => {
    const el = e.target.closest('[data-cardid]');
    if (!el) return;
    ui.mode = null;
    send({ type: 'wendellTakeDiscard', cardId: el.dataset.cardid });
  });
  document.getElementById('valentinoBtn')?.addEventListener('click', () => {
    ui.mode = 'valentinoPick';
    ui.valentinoPick = [];
    render();
  });
  document.getElementById('valentinoConfirm')?.addEventListener('click', () => {
    const ids = ui.valentinoPick || [];
    ui.mode = null;
    ui.valentinoPick = null;
    if (ids.length) send({ type: 'valentinoTrimDraft', cardIds: ids });
  });
  document.getElementById('jonasBtn')?.addEventListener('click', () => {
    ui.mode = 'jonasPick';
    render();
  });
  document.getElementById('stainglassKeepRow')?.addEventListener('click', (e) => {
    const el = e.target.closest('[data-cardid]');
    if (!el || !pending) return;
    send({ type: 'resolvePending', pendingId: pending.id, cardId: el.dataset.cardid });
  });
  app.querySelectorAll('[data-celestine]').forEach((b) =>
    b.addEventListener('click', () => send({ type: 'celestineBuyStars', count: +b.dataset.celestine }))
  );
  document.getElementById('endTurnBtn')?.addEventListener('click', () => send({ type: 'endTurn' }));

  // My mat: placement prompt, rearrange swaps.
  document.getElementById('mySlots')?.addEventListener('click', (e) => {
    const slotEl = e.target.closest('[data-slot]');
    if (!slotEl) return;
    const i = +slotEl.dataset.slot;
    if (
      (pending?.kind === 'placement' || pending?.kind === 'cardResourcePlacement') &&
      pending.data.allowedSlots.includes(i)
    ) {
      send({ type: 'resolvePending', pendingId: pending.id, slot: i });
      return;
    }
    if (ui.mode === 'rearrange') return pickForSwap('slot', i);
    if (ui.mode === 'amaraMove' && p.slots[i]) return pickForAmaraMove(p, p.slots[i]);
    if (ui.mode === 'jonasPick' && jonasCanTake(p, p.slots[i])) {
      const cardId = p.slots[i];
      ui.mode = null;
      send({ type: 'jonasDiscard', cardId });
      return;
    }
  });
  document.getElementById('myReserve')?.addEventListener('click', (e) => {
    const el = e.target.closest('[data-reserve]');
    if (!el) return;
    const i = +el.dataset.reserve;
    if (ui.mode === 'rearrange') return pickForSwap('reserve', i);
    if (ui.mode === 'amaraMove' && i >= 0) return pickForAmaraMove(p, p.reserve[i]);
    if (ui.mode === 'jonasPick' && i >= 0 && jonasCanTake(p, p.reserve[i])) {
      const cardId = p.reserve[i];
      ui.mode = null;
      send({ type: 'jonasDiscard', cardId });
      return;
    }
    if (!ui.mode && i >= 0 && favorReadyNow(s, p, p.reserve[i])) {
      send({ type: 'useFavor', cardId: p.reserve[i] });
    } else if (!ui.mode && i >= 0 && pressPassReadyNow(s, p, p.reserve[i])) {
      send({ type: 'usePressPass', cardId: p.reserve[i] });
    }
  });

  // Prompt widgets.
  app.querySelectorAll('[data-hplus]').forEach((b) =>
    b.addEventListener('click', () => { ui.heartPlan[b.dataset.hplus] = (ui.heartPlan[b.dataset.hplus] || 0) + 1; render(); })
  );
  app.querySelectorAll('[data-hminus]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.hminus;
      ui.heartPlan[id] = Math.max(0, (ui.heartPlan[id] || 0) - 1);
      if (!ui.heartPlan[id]) delete ui.heartPlan[id];
      render();
    })
  );
  document.getElementById('confirmHearts')?.addEventListener('click', () => {
    const assignments = Object.entries(ui.heartPlan).map(([cardId, amount]) => ({ cardId, amount }));
    ui.heartPlan = {};
    send({ type: 'resolvePending', pendingId: pending.id, assignments });
  });
  document.getElementById('pressPassContinue')?.addEventListener('click', () =>
    send({ type: 'resolvePending', pendingId: pending.id })
  );
  document.getElementById('mesmeraBtn')?.addEventListener('click', () => send({ type: 'mesmeraRerollTomato' }));
  document.getElementById('keepTomatoBtn')?.addEventListener('click', () => send({ type: 'keepTomatoRoll' }));
  document.getElementById('drawnRevealContinue')?.addEventListener('click', () =>
    send({ type: 'resolvePending', pendingId: pending.id })
  );
  document.getElementById('cardResourceToReserve')?.addEventListener('click', () =>
    send({ type: 'resolvePending', pendingId: pending.id, toReserve: true })
  );
  document.getElementById('placementToReserve')?.addEventListener('click', () =>
    send({ type: 'resolvePending', pendingId: pending.id, toReserve: true })
  );
  document.getElementById('diceReviewContinue')?.addEventListener('click', () =>
    send({ type: 'resolvePending', pendingId: pending.id })
  );
  document.getElementById('confirmBarreRearrange')?.addEventListener('click', () => {
    const r = ui.rearrange;
    ui.mode = null;
    ui.rearrange = null;
    send({ type: 'resolvePending', pendingId: pending.id, slots: r.slots, reserve: r.reserve });
  });
  document.getElementById('skipBarreRearrange')?.addEventListener('click', () => {
    ui.mode = null;
    ui.rearrange = null;
    send({ type: 'resolvePending', pendingId: pending.id });
  });
  document.getElementById('postAcquireKeep')?.addEventListener('click', () =>
    send({ type: 'resolvePending', pendingId: pending.id, choice: 'keep' })
  );
  app.querySelectorAll('[data-postacquire]').forEach((b) =>
    b.addEventListener('click', () => send({ type: 'resolvePending', pendingId: pending.id, choice: b.dataset.postacquire }))
  );
  document.getElementById('auricGainConfirm')?.addEventListener('click', () => {
    const convertCoinsToHearts = !!document.getElementById('auricConvertCoins')?.checked;
    const convertHeartsToCoins = !!document.getElementById('auricConvertHearts')?.checked;
    send({ type: 'resolvePending', pendingId: pending.id, convertCoinsToHearts, convertHeartsToCoins });
  });
  app.querySelectorAll('[data-refill]').forEach((sel) =>
    sel.addEventListener('change', () => {
      ui.refillPlan[+sel.dataset.refill].cardId = sel.value;
      render();
    })
  );
  document.getElementById('confirmRefill')?.addEventListener('click', () => {
    const plan = ui.refillPlan || [];
    ui.refillPlan = null;
    send({ type: 'resolvePending', pendingId: pending.id, assignments: plan });
  });
}

function pickForSwap(zone, index) {
  const r = ui.rearrange;
  // "move here" target: append the picked card to the reserve.
  if (zone === 'reserve' && index === -1) {
    if (r.picked) {
      const a = r.picked;
      r.picked = null;
      const v = a.zone === 'slot' ? r.slots[a.index] : r.reserve[a.index];
      if (v != null) {
        if (a.zone === 'slot') r.slots[a.index] = null;
        else r.reserve.splice(a.index, 1);
        r.reserve.push(v);
      }
    }
    return render();
  }
  if (!r.picked) {
    r.picked = { zone, index };
    return render();
  }
  const a = r.picked;
  r.picked = null;
  if (a.zone === zone && a.index === index) return render(); // deselect
  const get = (z, i) => (z === 'slot' ? r.slots[i] : r.reserve[i]);
  const set = (z, i, v) => (z === 'slot' ? (r.slots[i] = v) : (r.reserve[i] = v));
  const va = get(a.zone, a.index);
  const vb = get(zone, index);
  set(a.zone, a.index, vb ?? null);
  set(zone, index, va ?? null);
  // Compact the reserve (no holes).
  r.reserve = r.reserve.filter((x) => x != null);
  render();
}

// Amara the Reliquary: first click picks the source (must currently hold a
// heart), second click picks the destination (must have room) and fires
// the action. Clicking the already-picked source again deselects it.
function pickForAmaraMove(p, cardId) {
  const move = ui.amaraMove;
  const s = st();
  if (!move.from) {
    if ((s.hearts[cardId] || 0) < 1) return;
    move.from = cardId;
    return render();
  }
  if (cardId === move.from) {
    move.from = null;
    return render();
  }
  if (capLeft(p, cardId) < 1) return;
  const fromCardId = move.from;
  ui.mode = null;
  ui.amaraMove = null;
  send({ type: 'amaraMoveHeart', fromCardId, toCardId: cardId });
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

let toastTimer = null;
function toast(msg, duration = 3500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

boot();
