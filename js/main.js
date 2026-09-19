/**
 * main.js — UI controller. Owns the DOM, the interaction model and the
 * game loop. All rules live in rules.js; all search lives in ai.js.
 */

import {
  BLACK, RED, EMPTY, BM, BK, RM, RK,
  RC, colorOf, isKing, opponent,
  initialState, generateMoves, applyMove, gameStatus,
  countMaterial, notation, KING_MOVE_DRAW_LIMIT,
  boardToString, boardFromString,
} from './rules.js';
import { chooseMove, DIFFICULTIES } from './ai.js';
import { sfx, setEnabled as setSound, isEnabled as soundOn } from './sound.js';
import * as online from './online.js';
import { net } from './online.js';

/* ------------------------------------------------------------------ */
/* Elements                                                            */
/* ------------------------------------------------------------------ */

const $ = (sel) => document.querySelector(sel);
const boardEl = $('#board');
const piecesEl = $('#pieces');
const turnbarEl = $('#turnbar');
const turnTextEl = $('#turnText');
const turnHintEl = $('#turnHint');
const historyEl = $('#historyList');
const historyWrapEl = $('#historyWrap');
const undoBtn = $('#undoBtn');
const hintBtn = $('#hintBtn');
const newBtn = $('#newBtn');
const menuBtn = $('#menuBtn');
const themeBtn = $('#themeBtn');
const soundSwitch = $('#soundSwitch');
const coordSwitch = $('#coordSwitch');
const modal = $('#modal');
const modalBody = $('#modalBody');
const confettiEl = $('#confetti');
const statusLive = $('#statusLive');
const netPill = $('#netPill');
const netPillText = $('#netPillText');
const netBanner = $('#netBanner');
const netBannerText = $('#netBannerText');
const netRetryBtn = $('#netRetryBtn');
const netEndBtn = $('#netEndBtn');
const resignBtn = $('#resignBtn');
const chatPanel = $('#chatPanel');
const chatLog = $('#chatLog');
const chatEmpty = $('#chatEmpty');
const chatForm = $('#chatForm');
const chatInput = $('#chatInput');

const LABEL = { [BLACK]: 'Black', [RED]: 'Red' };
const STORE = 'checkers.prefs.v1';

/* ------------------------------------------------------------------ */
/* App state                                                           */
/* ------------------------------------------------------------------ */

const app = {
  state: initialState(),
  history: [],          // { state, move, turn } snapshots BEFORE each move
  moveLog: [],          // notation strings
  mode: 'ai',           // 'ai' | 'local' | 'online'
  difficulty: 'medium',
  humanSide: BLACK,
  selected: null,       // square index
  legal: [],            // moves for the side to act
  targets: new Map(),   // landing square -> move
  busy: false,
  over: false,
  cursor: 11,           // keyboard cursor square
  lastMove: null,
  showHints: true,
  paused: false,        // online: connection down, board frozen
  resigned: null,       // online: colour that resigned
};

/* ------------------------------------------------------------------ */
/* Preferences                                                         */
/* ------------------------------------------------------------------ */

function loadPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { /* ignore */ }
  const theme = p.theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.coords = p.coords === 'off' ? 'off' : 'on';
  setSound(!!p.sound);
  app.showHints = p.showHints !== false;
  if (p.mode === 'local' || p.mode === 'ai') app.mode = p.mode;
  if (DIFFICULTIES[p.difficulty]) app.difficulty = p.difficulty;
  syncToggles();
}

function savePrefs() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      theme: document.documentElement.dataset.theme,
      coords: document.documentElement.dataset.coords,
      sound: soundOn(),
      showHints: app.showHints,
      mode: app.mode === 'online' ? 'local' : app.mode,
      difficulty: app.difficulty,
    }));
  } catch { /* private mode — ignore */ }
}

function syncToggles() {
  soundSwitch.setAttribute('aria-checked', String(soundOn()));
  coordSwitch.setAttribute('aria-checked', String(document.documentElement.dataset.coords !== 'off'));
  hintBtn.setAttribute('aria-pressed', String(app.showHints));
  const dark = document.documentElement.dataset.theme !== 'light';
  themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  themeBtn.querySelector('.themeIcon').innerHTML = dark ? SUN : MOON;
}

const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
const MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';

/* ------------------------------------------------------------------ */
/* Board construction                                                  */
/* ------------------------------------------------------------------ */

const cellEls = new Array(32);
const squareEls = new Array(32);

function buildBoard() {
  boardEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const dark = (row + col) % 2 === 1;
      const sq = document.createElement('div');
      sq.className = 'sq ' + (dark ? 'sq--dark' : 'sq--light');
      if (dark) {
        const idx = RC.findIndex(([r, c]) => r === row && c === col);
        sq.dataset.sq = String(idx);
        const num = document.createElement('span');
        num.className = 'sq__num';
        num.textContent = String(idx + 1);
        sq.appendChild(num);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cell';
        btn.dataset.sq = String(idx);
        btn.tabIndex = -1;
        btn.addEventListener('click', () => onSquare(idx));
        sq.appendChild(btn);

        const hint = document.createElement('span');
        hint.className = 'hint';
        sq.appendChild(hint);

        cellEls[idx] = btn;
        squareEls[idx] = sq;
      }
      frag.appendChild(sq);
    }
  }
  boardEl.appendChild(frag);
  boardEl.appendChild(piecesEl);
}

/* ------------------------------------------------------------------ */
/* Piece rendering — keyed DOM nodes so CSS transforms animate         */
/* ------------------------------------------------------------------ */

const CROWN_SVG =
  '<svg class="crown" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l4.2 3.1L12 4.4l4.8 6.7L21 8l-1.7 10H4.7L3 8z"/></svg>';

let pieceNodes = new Map(); // id -> { el, sq, code }
let nextPieceId = 1;
let idBySquare = new Map();

function posTransform(sq) {
  const [r, c] = RC[sq];
  return `translate3d(${c * 100}%, ${r * 100}%, 0)`;
}

function makePiece(code, sq) {
  const el = document.createElement('div');
  el.className = `piece piece--${colorOf(code)}${isKing(code) ? ' piece--king' : ''}`;
  el.style.transform = posTransform(sq);
  el.innerHTML = `<span class="piece__disc">${CROWN_SVG}</span>`;
  el.setAttribute('aria-hidden', 'true');
  piecesEl.appendChild(el);
  return el;
}

/** Full rebuild — used on new game / undo / mode change. */
function renderPiecesFresh() {
  piecesEl.innerHTML = '';
  pieceNodes = new Map();
  idBySquare = new Map();
  for (let sq = 0; sq < 32; sq++) {
    const code = app.state.board[sq];
    if (code === EMPTY) continue;
    const id = nextPieceId++;
    pieceNodes.set(id, { el: makePiece(code, sq), sq, code });
    idBySquare.set(sq, id);
  }
}

/**
 * Animate one move: slide the mover along its path, fade the victims,
 * then apply the crown. Resolves when the motion has settled.
 */
function animateMove(move, turn) {
  return new Promise((resolve) => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const id = idBySquare.get(move.from);
    const node = id != null ? pieceNodes.get(id) : null;
    if (!node) { renderPiecesFresh(); resolve(); return; }

    idBySquare.delete(move.from);
    node.el.classList.add('piece--capturing');
    node.el.classList.remove('piece--sel');

    const hops = move.path.slice(1);
    const hopMs = reduce ? 0 : (move.capture ? 230 : 250);

    const step = (i) => {
      if (i >= hops.length) {
        node.sq = hops[hops.length - 1];
        idBySquare.set(node.sq, id);
        node.el.classList.remove('piece--capturing');
        if (move.crowned) {
          node.code = turn === BLACK ? BK : RK;
          node.el.classList.add('piece--king', 'piece--crowning');
          setTimeout(() => node.el.classList.remove('piece--crowning'), 460);
          sfx.king();
        }
        setTimeout(resolve, reduce ? 0 : 40);
        return;
      }
      const target = hops[i];
      node.el.style.transform = posTransform(target);

      // remove the victim consumed by this hop, mid-slide
      const victim = move.captured[i];
      if (victim != null) {
        const vid = idBySquare.get(victim);
        const vnode = vid != null ? pieceNodes.get(vid) : null;
        if (vnode) {
          idBySquare.delete(victim);
          setTimeout(() => {
            vnode.el.style.setProperty('--pos', posTransform(victim));
            vnode.el.classList.add('piece--dying');
            setTimeout(() => { vnode.el.remove(); pieceNodes.delete(vid); }, reduce ? 0 : 240);
          }, hopMs * 0.55);
        }
      }
      setTimeout(() => step(i + 1), hopMs);
    };

    if (reduce) { step(0); } else { requestAnimationFrame(() => step(0)); }
  });
}

/* ------------------------------------------------------------------ */
/* Highlight layer                                                     */
/* ------------------------------------------------------------------ */

function clearMarks() {
  for (let i = 0; i < 32; i++) {
    const sq = squareEls[i];
    if (!sq) continue;
    delete sq.dataset.hint;
    delete sq.dataset.doomed;
  }
  piecesEl.querySelectorAll('.piece--sel').forEach((p) => p.classList.remove('piece--sel'));
}

function paintLastMove() {
  for (let i = 0; i < 32; i++) if (squareEls[i]) delete squareEls[i].dataset.last;
  if (!app.lastMove) return;
  for (const s of app.lastMove.path) if (squareEls[s]) squareEls[s].dataset.last = '1';
}

function paintSelection() {
  clearMarks();
  app.targets = new Map();
  if (app.selected == null) return;

  const id = idBySquare.get(app.selected);
  if (id != null) pieceNodes.get(id)?.el.classList.add('piece--sel');

  for (const mv of app.legal) {
    if (mv.from !== app.selected) continue;
    app.targets.set(mv.to, mv);
    const sq = squareEls[mv.to];
    if (sq) sq.dataset.hint = mv.capture ? 'jump' : 'move';
    for (const v of mv.captured) if (squareEls[v]) squareEls[v].dataset.doomed = '1';
  }
}

function markMovablePieces() {
  piecesEl.querySelectorAll('.piece--movable').forEach((p) => p.classList.remove('piece--movable'));
  if (app.over || app.busy || !humanToMove()) return;
  const froms = new Set(app.legal.map((m) => m.from));
  for (const sq of froms) {
    const id = idBySquare.get(sq);
    if (id != null) pieceNodes.get(id)?.el.classList.add('piece--movable');
  }
}

function syncCellAffordance() {
  const active = !app.over && !app.busy && humanToMove();
  const froms = new Set(app.legal.map((m) => m.from));
  for (let i = 0; i < 32; i++) {
    const c = cellEls[i];
    if (!c) continue;
    const playable = active && (froms.has(i) || app.targets.has(i));
    if (playable) c.dataset.playable = '1'; else delete c.dataset.playable;
    c.setAttribute('aria-label', describeSquare(i));
  }
}

function describeSquare(sq) {
  const code = app.state.board[sq];
  const n = sq + 1;
  if (code === EMPTY) {
    if (app.targets.has(sq)) {
      const mv = app.targets.get(sq);
      return `Square ${n}, ${mv.capture ? 'capture landing' : 'legal move'}`;
    }
    return `Square ${n}, empty`;
  }
  const who = LABEL[colorOf(code)];
  const kind = isKing(code) ? 'king' : 'man';
  const sel = app.selected === sq ? ', selected' : '';
  return `Square ${n}, ${who} ${kind}${sel}`;
}

/* ------------------------------------------------------------------ */
/* Panels                                                              */
/* ------------------------------------------------------------------ */

function renderScore() {
  const m = countMaterial(app.state.board);
  for (const side of [BLACK, RED]) {
    const s = side === BLACK ? m.b : m.r;
    const el = $(`#side-${side}`);
    el.dataset.active = !app.over && app.state.turn === side ? '1' : '0';
    el.querySelector('.side__count').textContent = String(s.total);
    el.querySelector('.side__meta').textContent =
      `${s.men} ${s.men === 1 ? 'man' : 'men'} · ${s.kings} ${s.kings === 1 ? 'king' : 'kings'}`;
    el.querySelector('.side__name').textContent = playerName(side);
  }
}

function playerName(side) {
  if (app.mode === 'online') {
    return side === net.color ? `${LABEL[side]} (You)` : `${LABEL[side]} (Friend)`;
  }
  if (app.mode === 'local') return LABEL[side];
  return side === app.humanSide ? `${LABEL[side]} (You)` : `${LABEL[side]} (${DIFFICULTIES[app.difficulty].label} AI)`;
}

function renderHistory() {
  if (!app.moveLog.length) {
    historyEl.innerHTML = '';
    historyEl.hidden = true;
    $('#historyEmpty').hidden = false;
    return;
  }
  historyEl.hidden = false;
  $('#historyEmpty').hidden = true;

  let html = '';
  for (let i = 0; i < app.moveLog.length; i += 2) {
    const n = i / 2 + 1;
    html += `<li class="history__row"><span class="history__n">${n}</span>`;
    html += cellHtml(app.moveLog[i], 'b', i === app.moveLog.length - 1);
    html += app.moveLog[i + 1] !== undefined
      ? cellHtml(app.moveLog[i + 1], 'r', i + 1 === app.moveLog.length - 1)
      : '<span class="history__mv"></span>';
    html += '</li>';
  }
  historyEl.innerHTML = html;
  historyWrapEl.scrollTop = historyWrapEl.scrollHeight;
}

function cellHtml(txt, side, latest) {
  const cap = txt.includes('x') ? ' history__mv--cap' : '';
  const s = side === 'b' ? ' history__mv--b' : '';
  const l = latest ? ' history__mv--latest' : '';
  return `<span class="history__mv${s}${cap}${l}">${txt}</span>`;
}

function renderTurnbar() {
  turnbarEl.dataset.turn = app.state.turn;
  if (app.over) {
    turnbarEl.dataset.thinking = '0';
    return;
  }
  const mine = humanToMove();
  if (app.mode === 'online') {
    turnTextEl.textContent = app.paused ? 'Game paused' : (mine ? 'Your move' : "Your friend's turn");
  } else {
    turnTextEl.textContent = app.mode === 'local'
      ? `${LABEL[app.state.turn]} to move`
      : (mine ? 'Your move' : `${DIFFICULTIES[app.difficulty].label} AI to move`);
  }

  const caps = app.legal.some((m) => m.capture);
  let hint = `${app.legal.length} legal ${app.legal.length === 1 ? 'move' : 'moves'}`;
  if (caps) hint = 'Capture is mandatory';
  if (app.state.kingMoves >= KING_MOVE_DRAW_LIMIT - 8) {
    hint = `Draw in ${KING_MOVE_DRAW_LIMIT - app.state.kingMoves} king moves`;
  }
  if (app.mode === 'online' && app.paused) hint = 'Connection lost';
  turnHintEl.textContent = hint;
}

function announce(msg) {
  statusLive.textContent = msg;
}

function renderAll() {
  app.legal = app.over ? [] : generateMoves(app.state.board, app.state.turn);
  paintLastMove();
  paintSelection();
  markMovablePieces();
  syncCellAffordance();
  renderScore();
  renderHistory();
  renderTurnbar();
  if (app.mode === 'online') {
    undoBtn.disabled = app.busy || app.over || app.paused || !net.connected || !app.history.length;
  } else {
    undoBtn.disabled = app.busy || !app.history.length || (app.mode === 'ai' && !humanToMove() && !app.over);
  }
}

/* ------------------------------------------------------------------ */
/* Game flow                                                           */
/* ------------------------------------------------------------------ */

function humanToMove() {
  if (app.mode === 'online') return net.started && !app.paused && !net.pending && app.state.turn === net.color;
  return app.mode === 'local' || app.state.turn === app.humanSide;
}

async function commitMove(move) {
  const turn = app.state.turn;
  app.history.push({ state: app.state, move, lastMove: app.lastMove });
  app.selected = null;
  app.busy = true;
  clearMarks();
  syncCellAffordance();
  undoBtn.disabled = true;

  if (move.capture) sfx.capture(); else sfx.move();

  const anim = animateMove(move, turn);
  app.state = applyMove(app.state, move);
  app.moveLog.push(notation(move));
  app.lastMove = move;
  await anim;

  const st = gameStatus(app.state);
  app.busy = false;

  if (st.over) {
    app.over = true;
    renderAll();
    finish(st);
    return;
  }

  renderAll();
  announce(`${LABEL[turn]} played ${notation(move)}. ${LABEL[app.state.turn]} to move.`);

  if (app.mode === 'ai' && !humanToMove()) queueAI();
}

function queueAI() {
  turnbarEl.dataset.thinking = '1';
  app.busy = true;
  syncCellAffordance();
  undoBtn.disabled = true;

  // Yield twice so the "thinking" state paints before the (blocking) search.
  requestAnimationFrame(() => setTimeout(async () => {
    let mv = null;
    try {
      mv = chooseMove(app.state, app.difficulty);
    } catch (err) {
      console.error('AI search failed, falling back to a legal move', err);
    }
    if (!mv) {
      const legal = generateMoves(app.state.board, app.state.turn);
      mv = legal[0] || null;
    }
    turnbarEl.dataset.thinking = '0';
    app.busy = false;
    if (mv) await commitMove(mv);
    else { app.over = true; renderAll(); finish(gameStatus(app.state)); }
  }, 230));
}

function finish(status) {
  const humanWon = app.mode === 'ai' && status.winner === app.humanSide;
  const onlineWon = app.mode === 'online' && status.winner === net.color;
  if (status.winner === null) sfx.lose();
  else if (app.mode === 'local' || humanWon || onlineWon) sfx.win();
  else sfx.lose();

  let title, detail;
  if (status.winner === null) {
    title = 'Draw';
    detail = `Neither side made progress for ${KING_MOVE_DRAW_LIMIT} king moves.`;
  } else {
    const w = LABEL[status.winner];
    if (app.mode === 'online') {
      title = onlineWon ? 'You win' : 'Your friend wins';
    } else {
      title = app.mode === 'local'
        ? `${w} wins`
        : (humanWon ? 'You win' : `${DIFFICULTIES[app.difficulty].label} AI wins`);
    }
    if (status.reason === 'resigned') {
      detail = onlineWon ? 'Your friend resigned.' : 'You resigned.';
    } else {
      detail = status.reason === 'captured'
        ? `${w} captured every opposing piece in ${app.moveLog.length} moves.`
        : `${LABEL[opponent(status.winner)]} has no legal move left.`;
    }
  }
  announce(`Game over. ${title}. ${detail}`);
  if (status.winner !== null && (app.mode === 'local' || humanWon || onlineWon)) burstConfetti();
  showResult(title, detail);
}

function burstConfetti() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['var(--accent)', 'var(--red-piece)', 'var(--ok)', 'var(--ink-muted)'];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 70; i++) {
    const b = document.createElement('i');
    b.style.left = Math.random() * 100 + 'vw';
    b.style.background = colors[i % colors.length];
    b.style.setProperty('--x', (Math.random() * 220 - 110) + 'px');
    b.style.setProperty('--rot', Math.round(Math.random() * 900 - 450) + 'deg');
    b.style.setProperty('--t', (1.7 + Math.random() * 1.5) + 's');
    b.style.setProperty('--d', (Math.random() * 0.5) + 's');
    if (i % 3 === 0) b.style.borderRadius = '50%';
    frag.appendChild(b);
  }
  confettiEl.innerHTML = '';
  confettiEl.appendChild(frag);
  setTimeout(() => { confettiEl.innerHTML = ''; }, 3600);
}

/* ------------------------------------------------------------------ */
/* Interaction                                                         */
/* ------------------------------------------------------------------ */

function onSquare(sq) {
  if (app.over || app.busy || !humanToMove()) return;

  const mv = app.targets.get(sq);
  if (mv) {
    if (app.mode === 'online') {
      app.selected = null;
      // Host applies immediately; guest posts an intent and waits for the ruling.
      if (!online.localMove(mv)) renderAll();
      else if (net.role === 'guest') { clearMarks(); renderAll(); }
    } else {
      commitMove(mv);
    }
    return;
  }

  const code = app.state.board[sq];
  if (code !== EMPTY && colorOf(code) === app.state.turn) {
    if (app.selected === sq) { app.selected = null; renderAll(); return; }
    if (!app.legal.some((m) => m.from === sq)) {
      sfx.invalid();
      const caps = app.legal.some((m) => m.capture);
      announce(caps ? 'That piece cannot move: a capture is mandatory elsewhere.' : 'That piece has no legal move.');
      const id = idBySquare.get(sq);
      const el = id != null ? pieceNodes.get(id)?.el : null;
      if (el) { el.animate?.([{ transform: el.style.transform + ' translateX(-3px)' }, { transform: el.style.transform + ' translateX(3px)' }, { transform: el.style.transform }], { duration: 170 }); }
      return;
    }
    app.selected = sq;
    sfx.select();
    renderAll();
    announce(`Selected square ${sq + 1}. ${app.legal.filter((m) => m.from === sq).length} destination(s).`);
    return;
  }

  if (app.selected != null) { app.selected = null; renderAll(); }
}

/* --- keyboard navigation over the dark squares --- */
function moveCursor(dr, dc) {
  const [r, c] = RC[app.cursor];
  for (let step = 1; step <= 8; step++) {
    const nr = r + dr * step;
    const nc = c + dc * step;
    if (nr < 0 || nr > 7 || nc < 0 || nc > 7) break;
    const idx = RC.findIndex(([rr, cc]) => rr === nr && cc === nc);
    if (idx >= 0) { focusSquare(idx); return; }
  }
}

function focusSquare(idx) {
  app.cursor = idx;
  cellEls[idx]?.focus();
}

function onKey(e) {
  if (modal.dataset.open === '1') {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
    return;
  }
  // Never steal keys from a text field (chat, room code).
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const k = e.key;
  if (k === 'ArrowUp') { e.preventDefault(); moveCursor(-1, 0); }
  else if (k === 'ArrowDown') { e.preventDefault(); moveCursor(1, 0); }
  else if (k === 'ArrowLeft') { e.preventDefault(); moveCursor(0, -1); }
  else if (k === 'ArrowRight') { e.preventDefault(); moveCursor(0, 1); }
  else if (k === 'Enter' || k === ' ') {
    if (document.activeElement?.classList.contains('cell')) {
      e.preventDefault();
      onSquare(Number(document.activeElement.dataset.sq));
    }
  } else if (k === 'Escape') {
    if (app.selected != null) { e.preventDefault(); app.selected = null; renderAll(); }
  } else if (k.toLowerCase() === 'u') { if (!undoBtn.disabled) undo(); }
  else if (k.toLowerCase() === 'n') { openNewGame(); }
}

/* ------------------------------------------------------------------ */
/* Undo                                                                */
/* ------------------------------------------------------------------ */

function undo() {
  if (app.busy || !app.history.length) return;

  if (app.mode === 'online') {
    if (!net.connected || app.over) return;
    if (online.requestUndo()) {
      undoBtn.disabled = true;
      announce('Undo requested. Waiting for your friend.');
      netNotice('Undo requested — waiting for your friend…');
    }
    return;
  }

  // In AI mode, roll back a full round-trip so it is the human's turn again.
  const steps = (app.mode === 'ai' && app.history.length >= 2 && !app.over) ? 2 : 1;
  rollback(steps);
  if (app.mode === 'ai' && app.history.length && app.state.turn !== app.humanSide) rollback(1);
  finishUndo();
}

/** Pop `n` plies off the history. Pure state surgery, no rendering. */
function rollback(n) {
  for (let i = 0; i < n; i++) {
    const prev = app.history.pop();
    if (!prev) break;
    app.state = prev.state;
    app.lastMove = prev.lastMove;
    app.moveLog.pop();
  }
}

function finishUndo() {
  app.over = false;
  app.resigned = null;
  app.selected = null;
  turnbarEl.dataset.thinking = '0';
  renderPiecesFresh();
  renderAll();
  announce('Move undone.');
}

/* ------------------------------------------------------------------ */
/* Modals                                                              */
/* ------------------------------------------------------------------ */

let lastFocus = null;

function openModal(html) {
  lastFocus = document.activeElement;
  modalBody.innerHTML = html;
  modal.dataset.open = '1';
  modal.removeAttribute('aria-hidden');
  const first = modal.querySelector('button, [tabindex]:not([tabindex="-1"])');
  setTimeout(() => first?.focus(), 60);
}

function closeModal() {
  modal.dataset.open = '0';
  modal.setAttribute('aria-hidden', 'true');
  lastFocus?.focus?.();
}

function openNewGame() {
  if (app.mode === 'online' && net.active) { confirmOnlineRestart(); return; }
  const localMode = app.mode === 'online' ? 'local' : app.mode;
  openModal(`
    <div>
      <h2 class="modal__title" id="modalTitle">New game</h2>
      <p class="modal__sub">Black always moves first. Captures are mandatory.</p>
    </div>
    <div class="field">
      <span class="field__label" id="lblMode">Mode</span>
      <div class="seg" role="radiogroup" aria-labelledby="lblMode" id="segMode">
        <button type="button" class="seg__btn" role="radio" data-v="ai" aria-checked="${localMode === 'ai'}">vs Computer</button>
        <button type="button" class="seg__btn" role="radio" data-v="local" aria-checked="${localMode === 'local'}">Two players</button>
      </div>
    </div>
    <div class="field" id="diffField" ${localMode === 'local' ? 'hidden' : ''}>
      <span class="field__label" id="lblDiff">Difficulty</span>
      <div class="seg" role="radiogroup" aria-labelledby="lblDiff" id="segDiff">
        ${Object.entries(DIFFICULTIES).map(([k, v]) =>
          `<button type="button" class="seg__btn" role="radio" data-v="${k}" aria-checked="${app.difficulty === k}">${v.label}</button>`).join('')}
      </div>
    </div>
    <div class="field" id="sideField" ${localMode === 'local' ? 'hidden' : ''}>
      <span class="field__label" id="lblSide">You play</span>
      <div class="seg" role="radiogroup" aria-labelledby="lblSide" id="segSide">
        <button type="button" class="seg__btn" role="radio" data-v="b" aria-checked="${app.humanSide === BLACK}">Black · first</button>
        <button type="button" class="seg__btn" role="radio" data-v="r" aria-checked="${app.humanSide === RED}">Red · second</button>
      </div>
    </div>
    <div class="field">
      <span class="field__label">Or play over the internet</span>
      <button type="button" class="choice" id="onlineBtn">
        <span class="choice__title">Play online</span>
        <span class="choice__sub">Share a room link and play a friend anywhere.</span>
      </button>
    </div>
    <div class="actions">
      <button type="button" class="btn" id="cancelBtn">Cancel</button>
      <button type="button" class="btn btn--primary" id="startBtn">Start game</button>
    </div>
  `);

  const pick = (wrap, cb) => {
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('.seg__btn');
      if (!b) return;
      wrap.querySelectorAll('.seg__btn').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      cb(b.dataset.v);
    });
  };
  const $m = (s) => modalBody.querySelector(s);
  app.mode = localMode;
  pick($m('#segMode'), (v) => {
    app.mode = v;
    $m('#diffField').hidden = v === 'local';
    $m('#sideField').hidden = v === 'local';
  });
  pick($m('#segDiff'), (v) => { app.difficulty = v; });
  pick($m('#segSide'), (v) => { app.humanSide = v === 'b' ? BLACK : RED; });
  $m('#onlineBtn').addEventListener('click', openOnlineChoice);
  $m('#cancelBtn').addEventListener('click', closeModal);
  $m('#startBtn').addEventListener('click', () => { closeModal(); leaveOnline(); startGame(); });
}

function showResult(title, detail) {
  const check = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.6l5 5L19.5 6.5"/></svg>';
  openModal(`
    <div class="result">
      <div class="result__badge">${check}</div>
      <h2 class="modal__title" id="modalTitle">${title}</h2>
      <p class="result__detail">${detail}</p>
    </div>
    <div class="actions">
      <button type="button" class="btn" id="reviewBtn">Review board</button>
      <button type="button" class="btn btn--primary" id="againBtn">New game</button>
    </div>
  `);
  modalBody.querySelector('#reviewBtn').addEventListener('click', closeModal);
  modalBody.querySelector('#againBtn').addEventListener('click', () => { closeModal(); openNewGame(); });
}

/* ------------------------------------------------------------------ */
/* Online — modals, status chrome and the controller bridge            */
/* ------------------------------------------------------------------ */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function openOnlineChoice() {
  openModal(`
    <div>
      <h2 class="modal__title" id="modalTitle">Play online</h2>
      <p class="modal__sub">One of you creates a room and shares the link. No accounts, nothing saved.</p>
    </div>
    <div class="field">
      <button type="button" class="choice" id="createBtn">
        <span class="choice__title">Create a room</span>
        <span class="choice__sub">You play red and move first.</span>
      </button>
      <button type="button" class="choice" id="joinBtn">
        <span class="choice__title">Join a room</span>
        <span class="choice__sub">Enter the 6-character code your friend sent.</span>
      </button>
    </div>
    <div class="actions">
      <button type="button" class="btn" id="backBtn">Back</button>
    </div>
  `);
  const $m = (s) => modalBody.querySelector(s);
  $m('#createBtn').addEventListener('click', openCreateRoom);
  $m('#joinBtn').addEventListener('click', () => openJoinRoom(''));
  $m('#backBtn').addEventListener('click', openNewGame);
}

function openCreateRoom() {
  openModal(`
    <div>
      <h2 class="modal__title" id="modalTitle">Create a room</h2>
      <p class="modal__sub">Claiming a room code…</p>
    </div>
    <div class="waitrow"><span class="spinner" aria-hidden="true"></span><span>Connecting…</span></div>
    <div class="actions">
      <button type="button" class="btn" id="backBtn">Cancel</button>
      <span></span>
    </div>
  `);
  modalBody.querySelector('#backBtn').addEventListener('click', () => { online.leave(); openOnlineChoice(); });

  online.createRoom().then(({ code, link }) => {
    if (!net.active) return;
    app.mode = 'online';
    openModal(`
      <div>
        <h2 class="modal__title" id="modalTitle">Your room is open</h2>
        <p class="modal__sub">Send your friend the link. The game starts the moment they join.</p>
      </div>
      <div class="field">
        <span class="field__label">Room code</span>
        <p class="roomcode" id="roomCode">${esc(code)}</p>
      </div>
      <div class="field">
        <label class="field__label" for="roomLink">Shareable link</label>
        <input class="roomlink" id="roomLink" type="text" readonly value="${esc(link)}"
               aria-label="Shareable room link">
      </div>
      <button type="button" class="btn btn--primary btn--block" id="copyBtn">Copy link</button>
      <div class="waitrow" id="waitRow">
        <span class="spinner" aria-hidden="true"></span>
        <span>Waiting for your friend…</span>
      </div>
      <div class="actions">
        <button type="button" class="btn" id="cancelRoomBtn">Cancel room</button>
        <span></span>
      </div>
    `);
    const $m = (s) => modalBody.querySelector(s);
    const copyBtn = $m('#copyBtn');
    copyBtn.addEventListener('click', async () => {
      const input = $m('#roomLink');
      let done = false;
      try {
        if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(link); done = true; }
      } catch { /* fall through to selection */ }
      if (!done) {
        input.focus();
        input.setSelectionRange(0, input.value.length);
        try { done = document.execCommand('copy'); } catch { done = false; }
      }
      copyBtn.textContent = done ? 'Link copied' : 'Press ⌘C to copy';
      announce(done ? 'Room link copied to the clipboard.' : 'Select the link and copy it.');
      setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 2200);
    });
    $m('#cancelRoomBtn').addEventListener('click', () => { online.leave(); app.mode = 'local'; openNewGame(); });
    netStatus();
  }).catch((err) => {
    showOnlineError('Create a room', err.message, openOnlineChoice);
  });
}

function openJoinRoom(prefill) {
  openModal(`
    <div>
      <h2 class="modal__title" id="modalTitle">Join a room</h2>
      <p class="modal__sub">Enter the 6-character code your friend sent you.</p>
    </div>
    <div class="field">
      <label class="field__label" for="codeInput">Room code</label>
      <input class="codeinput" id="codeInput" type="text" inputmode="latin" autocomplete="off"
             autocapitalize="characters" spellcheck="false" maxlength="6" placeholder="ABC123"
             value="${esc(online.normaliseCode(prefill))}">
      <p class="modal__err" id="joinErr" role="alert"></p>
    </div>
    <div class="actions">
      <button type="button" class="btn" id="backBtn">Back</button>
      <button type="button" class="btn btn--primary" id="connectBtn">Connect</button>
    </div>
  `);
  const $m = (s) => modalBody.querySelector(s);
  const input = $m('#codeInput');
  const errEl = $m('#joinErr');
  const connectBtn = $m('#connectBtn');

  input.addEventListener('input', () => {
    const c = online.normaliseCode(input.value);
    if (input.value !== c) input.value = c;
    errEl.textContent = '';
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); connectBtn.click(); } });

  connectBtn.addEventListener('click', () => {
    const code = online.normaliseCode(input.value);
    if (!online.isValidCode(code)) { errEl.textContent = 'A room code is 6 letters and numbers.'; input.focus(); return; }
    connectBtn.disabled = true;
    input.disabled = true;
    errEl.textContent = '';
    openModal(`
      <div>
        <h2 class="modal__title" id="modalTitle">Joining ${esc(code)}</h2>
        <p class="modal__sub">Connecting to your friend…</p>
      </div>
      <div class="waitrow"><span class="spinner" aria-hidden="true"></span><span>Handshaking…</span></div>
      <div class="actions">
        <button type="button" class="btn" id="abortBtn">Cancel</button>
        <span></span>
      </div>
    `);
    modalBody.querySelector('#abortBtn').addEventListener('click', () => { online.leave(); openJoinRoom(code); });

    online.joinRoom(code).then(() => {
      app.mode = 'online';
      netStatus();
    }).catch((err) => {
      online.leave(true);
      showOnlineError('Join a room', err.message, () => openJoinRoom(code));
    });
  });

  // Pre-filled from ?room= — put the caret on Connect so Enter just works.
  setTimeout(() => {
    if (online.isValidCode(input.value)) connectBtn.focus();
    else input.focus();
  }, 80);
}

function showOnlineError(title, message, retry) {
  openModal(`
    <div>
      <h2 class="modal__title" id="modalTitle">${esc(title)}</h2>
      <p class="modal__sub">${esc(message || 'Something went wrong.')}</p>
    </div>
    <div class="actions">
      <button type="button" class="btn" id="backBtn">Back</button>
      <button type="button" class="btn btn--primary" id="retryBtn">Try again</button>
    </div>
  `);
  modalBody.querySelector('#backBtn').addEventListener('click', () => { app.mode = 'local'; openNewGame(); });
  modalBody.querySelector('#retryBtn').addEventListener('click', retry);
}

function confirmDialog(title, sub, okLabel, onAnswer, timeoutMs) {
  let answered = false;
  let timer = null;
  const settle = (v) => {
    if (answered) return;
    answered = true;
    clearTimeout(timer);
    closeModal();
    onAnswer(v);
  };
  openModal(`
    <div>
      <h2 class="modal__title" id="modalTitle">${esc(title)}</h2>
      <p class="modal__sub">${esc(sub)}</p>
    </div>
    <div class="actions">
      <button type="button" class="btn" id="noBtn">Decline</button>
      <button type="button" class="btn btn--primary" id="yesBtn">${esc(okLabel)}</button>
    </div>
  `);
  modalBody.querySelector('#noBtn').addEventListener('click', () => settle(false));
  modalBody.querySelector('#yesBtn').addEventListener('click', () => settle(true));
  if (timeoutMs) timer = setTimeout(() => settle(false), timeoutMs);
}

function confirmOnlineRestart() {
  confirmDialog(
    'Start a new game?',
    'Your friend has to agree before the board resets.',
    'Ask my friend',
    (yes) => {
      if (!yes) return;
      if (online.requestNewGame()) netNotice('New game requested — waiting for your friend…');
    },
  );
}

function confirmResign() {
  confirmDialog('Resign this game?', 'Your friend wins immediately. This cannot be undone.', 'Resign', (yes) => {
    if (!yes) return;
    online.resign();
    app.over = true;
    app.resigned = net.color;
    renderAll();
    finish({ over: true, winner: net.color === BLACK ? RED : BLACK, reason: 'resigned', moves: [] });
  });
}

/* --- status chrome --- */

function netStatus() {
  const on = app.mode === 'online' && net.active;
  netPill.dataset.show = on ? '1' : '0';
  resignBtn.hidden = !on || app.over;
  chatPanel.hidden = !on;
  if (!on) { netBanner.dataset.show = '0'; return; }

  let state = 'wait';
  let text = 'Waiting for your friend…';
  if (net.connected && net.started) {
    state = 'live';
    const yours = LABEL[net.color];
    text = `Connected · you are ${yours.toLowerCase()}`;
  } else if (!net.connected && net.started) {
    state = 'down';
    text = 'Waiting for your friend to reconnect…';
  } else if (net.code) {
    text = `Room ${net.code} · waiting for your friend…`;
  }
  netPill.dataset.state = state;
  netPillText.textContent = text;
  chatInput.disabled = !net.connected;
}

function netNotice(msg) {
  announce(msg);
  addChatLine(msg, 'sys');
}

function showBanner(text, showRetry) {
  netBannerText.textContent = text;
  netRetryBtn.hidden = !showRetry;
  netBanner.dataset.show = '1';
}

function hideBanner() { netBanner.dataset.show = '0'; }

function addChatLine(text, kind) {
  const li = document.createElement('li');
  if (kind === 'sys') {
    li.className = 'chat__msg';
    li.style.background = 'transparent';
    li.style.color = 'var(--ink-faint)';
    li.style.fontSize = '12px';
    li.style.padding = '2px 0';
    li.style.maxWidth = '100%';
    li.textContent = text;
  } else {
    li.className = `chat__msg${kind === 'me' ? ' chat__msg--me' : ''}`;
    const who = document.createElement('span');
    who.className = 'chat__who';
    who.textContent = kind === 'me' ? 'You' : 'Friend';
    li.appendChild(who);
    li.appendChild(document.createTextNode(text));
  }
  chatLog.appendChild(li);
  while (chatLog.children.length > 60) chatLog.removeChild(chatLog.firstChild);
  chatEmpty.hidden = true;
  chatLog.scrollTop = chatLog.scrollHeight;
}

function leaveOnline() {
  if (net.active) online.leave();
  hideBanner();
  netPill.dataset.show = '0';
  resignBtn.hidden = true;
  chatPanel.hidden = true;
  chatLog.innerHTML = '';
  chatEmpty.hidden = false;
  app.paused = false;
  app.resigned = null;
}

/** The bridge the network module drives. Every entry point is UI-only. */
online.attach({
  getState: () => app.state,
  isOver: () => app.over,

  snapshot: () => ({
    board: Array.from(app.state.board),
    turn: app.state.turn,
    kingMoves: app.state.kingMoves,
    ply: app.state.ply,
    moveLog: app.moveLog.slice(),
    over: app.over,
  }),

  restore(snap) {
    if (!snap || !Array.isArray(snap.board) || snap.board.length !== 32) return;
    app.state = {
      board: Int8Array.from(snap.board.map((v) => (Number.isInteger(v) && v >= 0 && v <= 4 ? v : 0))),
      turn: snap.turn === RED ? RED : BLACK,
      kingMoves: Number.isInteger(snap.kingMoves) ? snap.kingMoves : 0,
      ply: Number.isInteger(snap.ply) ? snap.ply : 0,
    };
    app.moveLog = Array.isArray(snap.moveLog) ? snap.moveLog.filter((s) => typeof s === 'string').slice(0, 400) : [];
    app.history = [];
    app.selected = null;
    app.lastMove = null;
    app.over = !!snap.over;
    app.busy = false;
    renderPiecesFresh();
    renderAll();
  },

  applyMove: (mv) => commitMove(mv),

  undoStepsFor(requester) {
    // Roll back to just before that player's most recent move.
    for (let i = app.history.length - 1, n = 1; i >= 0; i--, n++) {
      if (app.history[i].state.turn === requester) return n;
    }
    return 0;
  },

  undoPlies(n) {
    rollback(n);
    finishUndo();
    netStatus();
  },

  netStart(color) {
    app.mode = 'online';
    net.color = color;
    closeModal();
    hideBanner();
    app.paused = false;
    app.resigned = null;
    app.state = initialState();
    app.history = [];
    app.moveLog = [];
    app.selected = null;
    app.lastMove = null;
    app.over = false;
    app.busy = false;
    app.cursor = color === BLACK ? 11 : 20;
    turnbarEl.dataset.thinking = '0';
    confettiEl.innerHTML = '';
    chatLog.innerHTML = '';
    chatEmpty.hidden = false;
    renderPiecesFresh();
    renderAll();
    netStatus();
    announce(`Connected. You are ${LABEL[color]}. ${color === BLACK ? 'Your move.' : "Your friend moves first."}`);
    sfx.select();
  },

  netRestart() {
    closeModal();
    app.state = initialState();
    app.history = [];
    app.moveLog = [];
    app.selected = null;
    app.lastMove = null;
    app.over = false;
    app.busy = false;
    app.paused = false;
    app.resigned = null;
    turnbarEl.dataset.thinking = '0';
    confettiEl.innerHTML = '';
    renderPiecesFresh();
    renderAll();
    netStatus();
    announce('New game. Black moves first.');
  },

  netStatus,

  netInterrupted() {
    app.paused = true;
    showBanner('Your friend dropped out. Waiting to reconnect…', true);
    renderAll();
    netStatus();
  },

  netResumed() {
    app.paused = false;
    hideBanner();
    renderAll();
    netStatus();
    announce('Reconnected. Game resumed.');
  },

  netGaveUp() {
    showBanner('Could not reconnect. The session has ended.', false);
    app.paused = true;
    renderAll();
  },

  netEnded(reason) {
    app.paused = false;
    hideBanner();
    netPill.dataset.show = '0';
    resignBtn.hidden = true;
    if (reason) {
      announce(reason);
      showOnlineError('Game ended', reason, openOnlineChoice);
    }
    app.mode = 'local';
  },

  netNotice,

  askUndo(answer) {
    confirmDialog('Undo requested', 'Your friend wants to take their move back.', 'Allow undo', answer, online.UNDO_TIMEOUT_MS);
  },

  undoAnswered(ok, timedOut) {
    netNotice(ok ? 'Your friend allowed the undo.' : (timedOut ? 'No answer — undo cancelled.' : 'Your friend declined the undo.'));
    renderAll();
  },

  askNew(answer) {
    confirmDialog('New game?', 'Your friend wants to start over.', 'Start over', answer, online.UNDO_TIMEOUT_MS);
  },

  newAnswered(ok) {
    if (!ok) netNotice('Your friend would rather keep playing.');
  },

  peerResigned(color) {
    app.over = true;
    app.resigned = color;
    renderAll();
    netStatus();
    finish({ over: true, winner: color === BLACK ? RED : BLACK, reason: 'resigned', moves: [] });
  },

  chatIn(text, mine) {
    addChatLine(text, mine ? 'me' : 'them');
    if (!mine) sfx.select();
  },
});

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

function startGame() {
  leaveOnline();
  app.state = initialState();
  app.history = [];
  app.moveLog = [];
  app.selected = null;
  app.lastMove = null;
  app.over = false;
  app.busy = false;
  app.cursor = app.humanSide === BLACK ? 11 : 20;
  turnbarEl.dataset.thinking = '0';
  confettiEl.innerHTML = '';
  renderPiecesFresh();
  renderAll();
  savePrefs();
  announce(app.mode === 'local'
    ? 'New two-player game. Black to move.'
    : `New game against the ${DIFFICULTIES[app.difficulty].label} computer. You are ${LABEL[app.humanSide]}.`);
  if (app.mode === 'ai' && !humanToMove()) queueAI();
}

function wire() {
  newBtn.addEventListener('click', openNewGame);
  menuBtn.addEventListener('click', openNewGame);
  undoBtn.addEventListener('click', undo);
  resignBtn.addEventListener('click', confirmResign);
  netEndBtn.addEventListener('click', () => { leaveOnline(); app.mode = 'local'; startGame(); });
  netRetryBtn.addEventListener('click', () => {
    online.retryConnection();
    netBannerText.textContent = 'Retrying…';
  });

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    if (online.sendChat(text)) chatInput.value = '';
  });

  hintBtn.addEventListener('click', () => {
    app.showHints = !app.showHints;
    document.body.classList.toggle('no-hints', !app.showHints);
    hintBtn.setAttribute('aria-pressed', String(app.showHints));
    savePrefs();
  });

  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    syncToggles();
    savePrefs();
  });

  soundSwitch.addEventListener('click', () => {
    setSound(!soundOn());
    syncToggles();
    savePrefs();
    if (soundOn()) sfx.select();
  });

  coordSwitch.addEventListener('click', () => {
    const on = document.documentElement.dataset.coords !== 'off';
    document.documentElement.dataset.coords = on ? 'off' : 'on';
    syncToggles();
    savePrefs();
  });

  $('#histToggle')?.addEventListener('click', (e) => {
    const p = $('#historyPanel');
    const open = p.dataset.open === '1';
    p.dataset.open = open ? '0' : '1';
    e.currentTarget.setAttribute('aria-expanded', String(!open));
  });

  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', onKey);

  // The board is a single tab stop; arrows move within it.
  boardEl.addEventListener('focusin', (e) => {
    const c = e.target.closest('.cell');
    if (c) {
      cellEls.forEach((x) => { if (x) x.tabIndex = -1; });
      c.tabIndex = 0;
      app.cursor = Number(c.dataset.sq);
    }
  });
}

function init() {
  buildBoard();
  loadPrefs();
  wire();
  cellEls[app.cursor].tabIndex = 0;
  renderPiecesFresh();
  renderAll();
  document.body.classList.toggle('no-hints', !app.showHints);

  // ?room=ABC123 — open Join with the code filled in and Connect focused.
  const invited = online.codeFromUrl();
  if (invited) setTimeout(() => openJoinRoom(invited), 120);
}

window.addEventListener('beforeunload', () => { if (net.active) online.leave(); });

/**
 * Test hook. Everything here is reachable from the page's own console anyway,
 * so exposing it changes no trust boundary: the host still validates every
 * move it is handed, whatever the source.
 */
window.__chk = {
  board: () => boardToString(app.state.board),
  turn: () => app.state.turn,
  ply: () => app.state.ply,
  hash: () => online.hashState(app.state),
  legal: () => app.legal.map((m) => ({ from: m.from, to: m.to, capture: m.capture, crowned: m.crowned })),
  over: () => app.over,
  mode: () => app.mode,
  net: () => ({ ...net }),
  /** Host-only: install a position and push it to the guest. */
  seed(str, turn) {
    if (net.active && net.role !== 'host') return false;
    app.state = { board: boardFromString(str), turn: turn === RED ? RED : BLACK, kingMoves: 0, ply: 0 };
    app.history = [];
    app.moveLog = [];
    app.lastMove = null;
    app.selected = null;
    app.over = false;
    renderPiecesFresh();
    renderAll();
    if (net.active) online.pushState();
    return true;
  },
  /** Inject a raw frame as if it arrived from the peer. */
  raw: (s) => online.injectRaw(s),
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
