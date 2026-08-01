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
let assetVersion = ''; // from /api/cards — appended to card image URLs so a browser always fetches fresh art after a deploy that changes it, even under an unchanged filename

// Transient UI state
let ui = {
  mode: null, // null | 'rearrange' | 'amaraMove'
  rearrange: null, // { slots, reserve, picked: {zone, index} | null }
  amaraMove: null, // { from: cardId | null } — Amara the Reliquary's move-a-heart picker
  heartPlan: {}, // cardId -> amount, for heartAssign prompt
  refillPlan: null, // [{slot, cardId}]
  logOpen: true,
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
    view = payload;
    if (view.state && view.state.version !== prevVersion) {
      resetTransientUi();
      if (!isFirstState) {
        announceTrophies(view.state.log.slice(prevLogLen));
        announceGhostRolls(view.state.log.slice(prevLogLen));
        announceAltSoloRolls(view.state.log.slice(prevLogLen));
        announceAltSoloRoundLoss(view.state.log.slice(prevLogLen));
        announceSupplyShortage(view.state.log.slice(prevLogLen));
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
    // Auto-rejoin after a dropped connection.
    if (my.code && my.name) {
      socket.emit('joinRoom', { code: my.code, name: my.name }, (res) => {
        if (res?.ok) my.seat = res.seat;
      });
    }
  });
  render();
}

// Whenever fresh log lines arrive that record a Trophy award, surface it as
// a toast for everyone at the table (in addition to the log entry itself),
// so the round's outcome is hard to miss.
function announceTrophies(newLines) {
  const wins = newLines.filter((l) => l.includes('takes a Trophy!'));
  if (wins.length === 0) return;
  // " earned " is common to both the normal "X earned the most stars (N) and
  // takes a Trophy!" wording and Alt Solo's "X earned N star(s), clearing
  // the round target of T — takes a Trophy!" wording — split on that instead
  // of anything more specific so both phrasings extract the name correctly.
  const names = wins.map((l) => l.split(' earned ')[0]);
  const msg = names.length === 1
    ? `🏆 ${names[0]} wins the Trophy this round!`
    : `🏆 ${names.join(' & ')} tie and share the Trophy this round!`;
  toast(msg, 5000);
}

// Solo mode: surface the Ghost's d12 result as a toast too, since it's the
// core mechanic of the variant and easy to miss buried in the log panel.
function announceGhostRolls(newLines) {
  const rolls = newLines.filter((l) => l.includes('(Ghost) rolls a'));
  if (rolls.length === 0) return;
  toast(`🎲 ${rolls[rolls.length - 1]}`, 4000);
}

// Alt Solo: same idea as announceGhostRolls, for the d8 that shrinks the
// draft row / raises the round's star target after every turn.
function announceAltSoloRolls(newLines) {
  const rolls = newLines.filter((l) => l.includes('Alt Solo d8 rolls a'));
  if (rolls.length === 0) return;
  toast(`🎲 ${rolls[rolls.length - 1]}`, 4000);
}

// Alt Solo: a round can also be lost (tied or fell short of the round
// target) — surface that too, distinct from a Trophy win.
function announceAltSoloRoundLoss(newLines) {
  const losses = newLines.filter((l) => l.includes('the round is lost'));
  if (losses.length === 0) return;
  toast(`💔 ${losses[losses.length - 1]}`, 5000);
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
  ui.heartPlan = {};
  ui.refillPlan = null;
}

// ---------------------------------------------------------------------------
// Helpers mirroring engine rules (server remains authoritative)
// ---------------------------------------------------------------------------

const card = (id) => cards.get(id);
const st = () => view.state;
const me = () => st()?.players?.[my.seat];

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

function marketCost(player, index) {
  let cost = index + 1;
  if (trainerIs(player, 'Barnaby-Pennywhistle')) cost = Math.max(0, cost - 1);
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
  if (!view.lobby) return renderWelcome();
  if (!view.state) return renderLobby();
  renderGame();
}

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const imgUrl = (c) => '/' + encodeURI(c.image) + (assetVersion ? `?v=${assetVersion}` : '');

function cardHtml(id, { size = 'md', extra = '', badge = null, hearts = null, dim = false } = {}) {
  const c = card(id);
  const h = hearts != null ? hearts : null;
  const max = cardMaxHeartsFor(id);
  return `
    <div class="card ${size} ${dim ? 'dim' : ''} ${extra}" data-cardid="${esc(id)}" title="${esc(cardTitle(c))}">
      <img src="${imgUrl(c)}" alt="${esc(c.name)}" loading="lazy" draggable="false"/>
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
  app.innerHTML = `
    <div class="welcome">
      <h1>The Midnight Theatre</h1>
      <p class="tag">Build the most legendary troupe under the big top.</p>
      <div class="panel">
        <label>Your name <input id="nameInput" maxlength="24" value="${esc(my.name)}" placeholder="e.g. Travis"/></label>
        <div class="row">
          <button id="createBtn" class="primary">Create a room</button>
          <button id="soloBtn">👻 Play solo (vs. 2 Ghosts)</button>
          <button id="altSoloBtn">🎲 Alt Solo (beat the round target)</button>
        </div>
        <div class="row join-row">
          <input id="codeInput" maxlength="4" placeholder="ROOM CODE" style="text-transform:uppercase"/>
          <button id="joinBtn">Join</button>
        </div>
      </div>
    </div>`;
  const name = () => document.getElementById('nameInput').value.trim() || 'Player';
  document.getElementById('createBtn').onclick = () => {
    my.name = name();
    socket.emit('createRoom', { name: my.name }, (res) => {
      if (res?.error) return toast(res.error);
      my.code = res.code;
      my.seat = res.seat;
    });
  };
  document.getElementById('soloBtn').onclick = () => {
    my.name = name();
    socket.emit('createSoloGame', { name: my.name }, (res) => {
      if (res?.error) return toast(res.error);
      my.code = res.code;
      my.seat = res.seat;
    });
  };
  document.getElementById('altSoloBtn').onclick = () => {
    my.name = name();
    socket.emit('createAltSoloGame', { name: my.name }, (res) => {
      if (res?.error) return toast(res.error);
      my.code = res.code;
      my.seat = res.seat;
    });
  };
  document.getElementById('joinBtn').onclick = () => {
    my.name = name();
    const code = document.getElementById('codeInput').value.trim().toUpperCase();
    socket.emit('joinRoom', { code, name: my.name }, (res) => {
      if (res?.error) return toast(res.error);
      my.code = res.code;
      my.seat = res.seat;
    });
  };
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
    <div class="game">
      <header>
        <div class="brand">🎪 The Midnight Theatre <span class="code">room ${esc(view.lobby.code)}</span></div>
        <div class="status">
          Round ${s.round} · ${s.phase === 'draft' ? 'Draft phase' : s.phase === 'dice' ? 'Dice phase' : 'Game over'}
          · First to ${s.trophyGoal} 🏆 wins
          ${s.altSolo ? `· Round target: <b>${s.altSoloTarget}</b>⭐ (beat it, don't tie it) · Losses: <b>${s.altSoloLosses}</b>/5` : ''}
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
  // Alt Solo is the only mode where the game can end with no winner at all —
  // ALT_SOLO_LOSS_LIMIT round losses reached before ALT_SOLO_TROPHY_GOAL wins.
  if (s.winners.length === 0) {
    return `<div class="winners lost">💔 ${esc(s.players[0].name)} lost the show — ${s.altSoloLosses} rounds lost before winning ${s.trophyGoal}. 💔</div>`;
  }
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
  // Stays in sync with engine.js's MAX_TOMATO_DICE (currently 8) — the
  // rolled batch caps there from round 8 onward.
  const n = Math.min(s.round, 8);
  return `${n} tomato ${n === 1 ? 'die' : 'dice'} loom this round.`;
}

function draftRowHtml(s, p, pending) {
  const clickable = isMyTurn() && !ui.mode;
  return `<div class="zone">
    <h3>Draft row <span class="hint">${s.altSolo ? '(free — a d8 also shrinks this row after every turn)' : '(free — ends when 1 card remains)'}</span></h3>
    <div class="cardrow ${clickable ? 'clickable' : ''}" id="draftRow">
      ${s.draftRow.map((id) => cardHtml(id, { size: 'md' })).join('') || '<span class="hint">empty</span>'}
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
  return p.slots.slice(0, 5).filter((id) => id && card(id).type === 'Dancer').length;
}

function turnBarHtml(s, p) {
  if (!p) return '';
  if (s.phase !== 'draft' || !s.turn) return '';
  if (s.pending.length > 0) return '';

  // Solo mode: a Ghost never has a socket of its own — the human rolls a
  // d12 to decide its whole turn (see engine's rollGhostDie/GHOST_DIE_FACES).
  if (s.solo && s.players[s.turn.seat].isGhost && !s.turn.done) {
    const ghost = s.players[s.turn.seat];
    return `<div class="turnbar ghostbar">
      <span class="yourturn">👻 ${esc(ghost.name)}'s turn — roll the d12 to decide their action.</span>
      <button id="rollGhostBtn" class="primary">🎲 Roll for ${esc(ghost.name)}</button>
    </div>`;
  }

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
    }
    // The Vanishing Valentino's end-of-turn window: the main action is spent,
    // and the turn is being held open purely for this one choice. Takes
    // precedence over Maximillian's end-turn button so we never render two
    // controls with the same id (both can be open at once).
    if (t.valentinoWindow) {
      const dramatic = p.slots.slice(0, 5).filter((id) => id && card(id).characteristic === 'Dramatic');
      buttons.push(`<span class="yourturn">The Vanishing Valentino: discard a Dramatic performer to end the draft now, cutting everyone else's remaining picks.</span>`);
      if (ui.mode === 'valentinoPick') {
        buttons.push(`<span class="yourturn">Click the Dramatic performer to discard.</span>`);
        buttons.push(`<button id="cancelMode">Cancel</button>`);
      } else {
        buttons.push(`<button id="valentinoBtn" class="primary" ${dramatic.length ? '' : 'disabled'} title="${dramatic.length ? '' : 'You have no Dramatic performer on stage to discard'}">End the draft (discard a Dramatic performer)</button>`);
      }
      buttons.push(`<button id="endTurnBtn">Just end my turn</button>`);
    } else if (t.open) {
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
  if (s.phase === 'draft' && s.turn && s.turn.seat !== my.seat && !(s.solo && s.players[s.turn.seat].isGhost)) {
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
      return promptBox(`
        <div>You drew <b>${esc(card(item.data.cardId).name)}</b> — click a highlighted slot to place it (the current occupant, if any, moves to your reserve), or send it to reserve instead.</div>
        <button id="cardResourceToReserve">Send to reserve instead</button>`);
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
  const valentinoEligible = (i, id) =>
    ui.mode === 'valentinoPick' && i <= 4 && !!id && card(id).characteristic === 'Dramatic';

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
        <div class="slot ${placing && allowed.includes(i) ? 'highlight' : ''} ${amaraEligible(id) ? 'highlight' : ''} ${valentinoEligible(i, id) ? 'highlight' : ''} ${sel || amaraSel ? 'selected' : ''}" data-slot="${i}">
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
          return `<div class="pickable ${sel || amaraSel ? 'selected' : ''} ${ready ? 'favor-ready' : ''} ${amaraEligible(id) ? 'highlight' : ''}" data-reserve="${i}" ${title ? `title="${title}"` : ''}>${cardHtml(id, { size: 'sm', hearts: cardMaxHeartsFor(id) != null ? (s.hearts[id] || 0) : null })}</div>`;
        }).join('') || (r ? '' : '<span class="hint">empty</span>')}
        ${r ? '<div class="pickable droptarget" data-reserve="-1">⤓ move here</div>' : ''}
      </div>
    </div>
  </section>`;
}

function opponentHtml(s, p) {
  const isTurn = s.phase === 'draft' && s.turn && s.turn.seat === p.seat && !s.turn.done;
  return `<div class="opponent ${isTurn ? 'active' : ''}">
    <div class="mat-head">
      <h4>${esc(p.name)} ${p.isBot ? '🤖' : ''}${p.isGhost ? ' 👻' : ''} <span class="hint">stand ${p.stand}</span></h4>
      <div class="tokens">🪙 ${p.coins} · ⭐ ${p.roundStars} this round · 🏆 ${p.trophies} · reserve ${p.reserve.length}</div>
    </div>
    <div class="slots mini">
      ${p.slots.map((id, i) => `
        <div class="slot mini" title="${SLOT_NAMES[i]}">
          ${id ? cardHtml(id, { size: 'xs', hearts: s.hearts[id] || 0 }) : '<div class="empty">·</div>'}
        </div>`).join('')}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Event wiring for the game screen
// ---------------------------------------------------------------------------

function wireGameEvents(s, p, pending) {
  document.getElementById('logToggle')?.addEventListener('click', () => {
    ui.logOpen = !ui.logOpen;
    render();
  });

  // Draft-row clicks: acquire.
  document.getElementById('draftRow')?.addEventListener('click', (e) => {
    const el = e.target.closest('[data-cardid]');
    if (!el) return;
    const id = el.dataset.cardid;
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
  document.getElementById('rollGhostBtn')?.addEventListener('click', () => send({ type: 'rollGhostDie', seat: my.seat }));

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
    if (ui.mode === 'valentinoPick' && i <= 4 && p.slots[i] && card(p.slots[i]).characteristic === 'Dramatic') {
      const cardId = p.slots[i];
      ui.mode = null;
      send({ type: 'valentinoEndDraft', cardId });
      return;
    }
  });
  document.getElementById('myReserve')?.addEventListener('click', (e) => {
    const el = e.target.closest('[data-reserve]');
    if (!el) return;
    const i = +el.dataset.reserve;
    if (ui.mode === 'rearrange') return pickForSwap('reserve', i);
    if (ui.mode === 'amaraMove' && i >= 0) return pickForAmaraMove(p, p.reserve[i]);
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
