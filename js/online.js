/**
 * online.js — peer-to-peer two-player checkers over WebRTC.
 *
 * Transport: PeerJS (self-hosted in /vendor/peerjs.min.js, loaded on demand so
 * the offline modes never pay for it). Signalling uses the free public PeerJS
 * broker; media/data itself is a direct WebRTC DataChannel between the two
 * browsers. No application server exists and none is needed.
 *
 * Authority model: the HOST owns the rules engine. A guest never mutates its
 * own board directly — it posts an *intent*, the host validates the intent
 * against `generateMoves()` for the current position, applies it, and echoes an
 * `applied` frame carrying the resulting ply and a state hash. The guest
 * replays the move and compares hashes; a mismatch triggers a full resync from
 * the host. Nothing that arrives on the wire is trusted.
 *
 * This module is deliberately free of board rendering: it talks to the UI
 * controller through the `ctl` object handed to `attach()`.
 */

import { generateMoves, boardToString, BLACK, RED } from './rules.js';

const PROTOCOL = 1;
const ID_PREFIX = 'chkrsv1';           // namespaces our ids on the shared broker
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const CODE_LEN = 6;
const MAX_ID_ATTEMPTS = 3;
const RECONNECT_GRACE_MS = 30000;
const UNDO_TIMEOUT_MS = 15000;
const CHAT_MAX = 200;
const VENDOR_SRC = 'vendor/peerjs.min.js';
/**
 * Liveness. A browser that is killed, sleeps, or loses its network never sends
 * a clean close — Chrome's ICE agent can sit in `disconnected` for minutes
 * before it gives up, so `conn.on('close')` alone is not a disconnect detector.
 * We heartbeat at the application layer and declare the peer gone on silence.
 */
const PING_MS = 3000;
const SILENCE_MS = 9000;

/* ------------------------------------------------------------------ */
/* Public-ish state                                                    */
/* ------------------------------------------------------------------ */

export const net = {
  active: false,      // an online session exists (maybe not connected)
  role: null,         // 'host' | 'guest'
  code: null,         // room code
  color: null,        // our colour in the game
  connected: false,   // data channel is open
  pending: false,     // we posted a move intent and await the host's ruling
  started: false,     // both sides are in the game
};

let ctl = null;
let peer = null;
let conn = null;
let graceTimer = null;
let undoTimer = null;
let heartTimer = null;
let lastSeen = 0;
let undoPendingFrom = null;
let rejoinTries = 0;
let vendorPromise = null;

/** The UI controller installs itself here. See main.js. */
export function attach(controller) {
  ctl = controller;
}

const log = (...a) => {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') console.info('[online]', ...a);
};

/* ------------------------------------------------------------------ */
/* Room codes & links                                                  */
/* ------------------------------------------------------------------ */

export function randomCode() {
  const bytes = new Uint8Array(CODE_LEN);
  (globalThis.crypto || {}).getRandomValues
    ? crypto.getRandomValues(bytes)
    : bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256); });
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function normaliseCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
}

export function isValidCode(raw) {
  const c = normaliseCode(raw);
  return c.length === CODE_LEN && [...c].every((ch) => CODE_ALPHABET.includes(ch));
}

export function roomLink(code) {
  const u = new URL(location.href);
  u.hash = '';
  u.search = `?room=${code}`;
  return u.toString();
}

/** Room code supplied in the URL, or null. */
export function codeFromUrl() {
  try {
    const c = new URL(location.href).searchParams.get('room');
    return c && isValidCode(c) ? normaliseCode(c) : null;
  } catch { return null; }
}

const peerIdFor = (code) => `${ID_PREFIX}${code}`;

/* ------------------------------------------------------------------ */
/* State hashing — cheap desync detector                               */
/* ------------------------------------------------------------------ */

export function hashState(state) {
  const s = `${boardToString(state.board)}|${state.turn}|${state.ply}|${state.kingMoves}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/* ------------------------------------------------------------------ */
/* Vendor loading                                                      */
/* ------------------------------------------------------------------ */

function loadPeerJs() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (vendorPromise) return vendorPromise;
  vendorPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = VENDOR_SRC;
    s.async = true;
    s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error('PeerJS did not register')));
    s.onerror = () => { vendorPromise = null; reject(new Error('Could not load the networking library')); };
    document.head.appendChild(s);
  });
  return vendorPromise;
}

/* ------------------------------------------------------------------ */
/* Wire helpers                                                        */
/* ------------------------------------------------------------------ */

function send(obj) {
  if (!conn || !conn.open) return false;
  try {
    conn.send(JSON.stringify(obj));
    return true;
  } catch (err) {
    log('send failed', err);
    return false;
  }
}

/** Strip a wire move down to the fields we accept, with type checks. */
function sanitizeMove(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const int = (v) => (Number.isInteger(v) && v >= 0 && v <= 31 ? v : null);
  const from = int(raw.from);
  const to = int(raw.to);
  if (from === null || to === null) return null;
  if (!Array.isArray(raw.path) || !Array.isArray(raw.captured)) return null;
  if (raw.path.length > 12 || raw.captured.length > 11) return null;
  const path = raw.path.map(int);
  const captured = raw.captured.map(int);
  if (path.includes(null) || captured.includes(null)) return null;
  return { from, to, path, captured, crowned: !!raw.crowned, capture: !!raw.capture };
}

const moveKey = (m) => `${m.from}>${m.to}:${m.path.join(',')}:${m.captured.join(',')}`;

/**
 * Match an untrusted move against the legal moves for `state`. Returns the
 * ENGINE's own move object (never the peer's), or null if it is not legal.
 */
export function validateMove(state, raw) {
  const m = sanitizeMove(raw);
  if (!m) return null;
  const legal = generateMoves(state.board, state.turn);
  const want = moveKey(m);
  return legal.find((lm) => moveKey(lm) === want) || null;
}

/* ------------------------------------------------------------------ */
/* Session lifecycle                                                   */
/* ------------------------------------------------------------------ */

function resetSession() {
  clearTimeout(graceTimer); graceTimer = null;
  clearTimeout(undoTimer); undoTimer = null;
  stopHeartbeat();
  undoPendingFrom = null;
  rejoinTries = 0;
  net.active = false; net.role = null; net.code = null;
  net.color = null; net.connected = false; net.pending = false; net.started = false;
}

export function leave(quiet) {
  if (net.active && !quiet) send({ t: 'bye' });
  try { conn?.close(); } catch { /* already gone */ }
  try { peer?.destroy(); } catch { /* already gone */ }
  conn = null; peer = null;
  resetSession();
  ctl?.netEnded?.();
}

/** Host: claim a room id, retrying on collision. */
export function createRoom() {
  return loadPeerJs().then((Peer) => new Promise((resolve, reject) => {
    let attempt = 0;
    const tryOnce = () => {
      attempt++;
      const code = randomCode();
      const p = new Peer(peerIdFor(code), { debug: 0 });
      let settled = false;

      p.on('open', () => {
        settled = true;
        peer = p;
        net.active = true; net.role = 'host'; net.code = code; net.color = RED;
        wireHostPeer(p);
        resolve({ code, link: roomLink(code) });
      });

      p.on('error', (err) => {
        if (settled) { handlePeerError(err); return; }
        const taken = err && (err.type === 'unavailable-id' || /taken|unavailable/i.test(err.message || ''));
        try { p.destroy(); } catch { /* noop */ }
        if (taken && attempt < MAX_ID_ATTEMPTS) { log('room code taken, retrying'); tryOnce(); return; }
        settled = true;
        reject(new Error(taken
          ? 'Could not claim a room code. Please try again.'
          : friendlyError(err)));
      });
    };
    tryOnce();
  }));
}

function wireHostPeer(p) {
  p.on('connection', (c) => {
    if (conn && conn.open && c.peer !== conn.peer) { try { c.close(); } catch { /* noop */ } return; }
    bindConnection(c);
  });
  p.on('disconnected', () => { if (!p.destroyed) { try { p.reconnect(); } catch { /* noop */ } } });
  p.on('close', () => { if (net.active) onPeerLost(); });
}

/** Guest: dial a room code. */
export function joinRoom(rawCode) {
  const code = normaliseCode(rawCode);
  if (!isValidCode(code)) return Promise.reject(new Error('That room code does not look right.'));
  return loadPeerJs().then((Peer) => new Promise((resolve, reject) => {
    const p = new Peer({ debug: 0 });
    let settled = false;
    const fail = (msg) => { if (!settled) { settled = true; try { p.destroy(); } catch { /* noop */ } reject(new Error(msg)); } };
    const timer = setTimeout(() => fail('No answer from that room. Check the code and that your friend is still waiting.'), 20000);

    p.on('open', () => {
      peer = p;
      net.active = true; net.role = 'guest'; net.code = code; net.color = BLACK;
      p.on('disconnected', () => { if (!p.destroyed) { try { p.reconnect(); } catch { /* noop */ } } });
      p.on('close', () => { if (net.active) onPeerLost(); });

      const c = p.connect(peerIdFor(code), { reliable: true, metadata: { v: PROTOCOL } });
      c.on('open', () => {
        clearTimeout(timer);
        settled = true;
        bindConnection(c);
        send({ t: 'hello', v: PROTOCOL });
        resolve({ code });
      });
      c.on('error', () => { clearTimeout(timer); fail('Could not reach that room.'); });
    });

    p.on('error', (err) => {
      if (settled) { handlePeerError(err); return; }
      clearTimeout(timer);
      const gone = err && (err.type === 'peer-unavailable' || /unavailable/i.test(err.message || ''));
      fail(gone ? 'No room with that code is open right now.' : friendlyError(err));
    });
  }));
}

function friendlyError(err) {
  const t = err && err.type;
  if (t === 'browser-incompatible') return 'This browser cannot do WebRTC, so online play will not work here.';
  if (t === 'network' || t === 'server-error' || t === 'socket-error') return 'Could not reach the matchmaking service. Check your connection and try again.';
  if (t === 'ssl-unavailable') return 'A secure connection to the matchmaking service failed.';
  return (err && err.message) || 'Something went wrong setting up the connection.';
}

function handlePeerError(err) {
  log('peer error', err?.type, err?.message);
  if (err && (err.type === 'peer-unavailable' || err.type === 'network')) onPeerLost();
}

/* ------------------------------------------------------------------ */
/* Connection binding                                                  */
/* ------------------------------------------------------------------ */

function bindConnection(c) {
  conn = c;
  clearTimeout(graceTimer); graceTimer = null;
  rejoinTries = 0;

  c.on('data', (raw) => {
    lastSeen = Date.now();
    let msg;
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      log('dropped malformed frame'); // never throw on peer garbage
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') { log('dropped frame with no type'); return; }
    try {
      onMessage(msg);
    } catch (err) {
      log('handler error, frame dropped', err);
    }
  });

  c.on('close', () => { if (net.active) onPeerLost(); });
  c.on('error', () => { if (net.active) onPeerLost(); });

  const wasStarted = net.started;
  net.connected = true;
  net.pending = false;
  startHeartbeat();

  if (net.role === 'host') {
    if (wasStarted) {
      send({ t: 'resume', snap: ctl.snapshot(), hash: hashState(ctl.getState()) });
      ctl.netResumed();
    }
    // A fresh guest announces itself with `hello`; we start the game there.
  } else if (wasStarted) {
    ctl.netResumed();
  }
  ctl.netStatus();
}

function onPeerLost() {
  if (!net.active) return;
  if (!net.connected && graceTimer) return;
  net.connected = false;
  net.pending = false;
  stopHeartbeat();
  clearTimeout(undoTimer); undoTimer = null; undoPendingFrom = null;
  ctl.netStatus();

  if (!net.started) { ctl.netEnded('The other player disconnected before the game started.'); leave(true); return; }

  ctl.netInterrupted();
  if (net.role === 'guest') scheduleRejoin();

  clearTimeout(graceTimer);
  graceTimer = setTimeout(() => {
    if (!net.connected) ctl.netGaveUp();
  }, RECONNECT_GRACE_MS);
}

function scheduleRejoin() {
  if (rejoinTries >= 1 || !peer || peer.destroyed) return;
  rejoinTries++;
  setTimeout(() => {
    if (net.connected || !peer || peer.destroyed) return;
    try {
      const c = peer.connect(peerIdFor(net.code), { reliable: true, metadata: { v: PROTOCOL } });
      c.on('open', () => { bindConnection(c); send({ t: 'hello', v: PROTOCOL, resume: true }); });
    } catch (err) { log('rejoin failed', err); }
  }, 1800);
}

/* --- liveness --- */

function startHeartbeat() {
  lastSeen = Date.now();
  clearInterval(heartTimer);
  heartTimer = setInterval(() => {
    if (!net.active || !net.connected) return;
    // A silent peer is a dead peer, whatever the ICE state claims.
    if (Date.now() - lastSeen > SILENCE_MS) { log('peer silent, treating as lost'); onPeerLost(); return; }
    send({ t: 'ping' });
  }, PING_MS);
}

function stopHeartbeat() {
  clearInterval(heartTimer);
  heartTimer = null;
}

/** Manual retry from the reconnect banner. */
export function retryConnection() {
  rejoinTries = 0;
  if (net.role === 'guest') scheduleRejoin();
  ctl.netStatus();
}

/* ------------------------------------------------------------------ */
/* Protocol                                                            */
/* ------------------------------------------------------------------ */

function onMessage(msg) {
  switch (msg.t) {
    /* Liveness only — `lastSeen` was already stamped by the data handler. */
    case 'ping':
      return;

    case 'hello': {
      if (net.role !== 'host') return;
      if (msg.v !== PROTOCOL) { send({ t: 'bye', reason: 'version' }); return; }
      if (net.started) {
        send({ t: 'resume', snap: ctl.snapshot(), hash: hashState(ctl.getState()) });
        ctl.netResumed();
      } else {
        net.started = true;
        send({ t: 'start', color: BLACK, v: PROTOCOL });
        ctl.netStart(RED);
      }
      ctl.netStatus();
      return;
    }

    case 'start': {
      if (net.role !== 'guest' || net.started) return;
      net.started = true;
      net.color = msg.color === RED ? RED : BLACK;
      ctl.netStart(net.color);
      ctl.netStatus();
      return;
    }

    case 'resume': {
      if (net.role !== 'guest' || !msg.snap) return;
      net.started = true;
      ctl.restore(msg.snap);
      ctl.netResumed();
      ctl.netStatus();
      return;
    }

    /* Guest -> host: a move intent. The host is the only validator. */
    case 'move': {
      if (net.role !== 'host') return;
      const state = ctl.getState();
      if (ctl.isOver() || state.turn === net.color) { send({ t: 'reject', reason: 'not-your-turn', snap: ctl.snapshot() }); return; }
      const legal = validateMove(state, msg.mv);
      if (!legal) {
        log('rejected illegal peer move', msg.mv);
        send({ t: 'reject', reason: 'illegal', snap: ctl.snapshot() });
        return;
      }
      ctl.applyMove(legal).then(() => {
        send({ t: 'applied', mv: legal, ply: ctl.getState().ply, hash: hashState(ctl.getState()) });
      });
      return;
    }

    /* Host -> guest: the authoritative result of a move by either side. */
    case 'applied': {
      if (net.role !== 'guest') return;
      const legal = validateMove(ctl.getState(), msg.mv);
      if (!legal) { log('applied frame did not validate locally; resyncing'); send({ t: 'resync' }); return; }
      net.pending = false;
      ctl.applyMove(legal).then(() => {
        if (msg.hash && msg.hash !== hashState(ctl.getState())) {
          log('state hash mismatch; resyncing');
          send({ t: 'resync' });
        }
      });
      return;
    }

    case 'reject': {
      if (net.role !== 'guest') return;
      net.pending = false;
      if (msg.snap) ctl.restore(msg.snap);
      ctl.netNotice(msg.reason === 'not-your-turn' ? 'It is not your turn.' : 'That move was not legal.');
      return;
    }

    case 'resync': {
      if (net.role !== 'host') return;
      send({ t: 'resume', snap: ctl.snapshot(), hash: hashState(ctl.getState()) });
      return;
    }

    case 'undoreq': {
      undoPendingFrom = 'peer';
      ctl.askUndo((agreed) => {
        if (undoPendingFrom !== 'peer') return;
        undoPendingFrom = null;
        send({ t: 'undoans', ok: !!agreed });
        if (agreed && net.role === 'host') doHostUndo(opposite(net.color));
      });
      return;
    }

    case 'undoans': {
      clearTimeout(undoTimer); undoTimer = null;
      undoPendingFrom = null;
      ctl.undoAnswered(!!msg.ok);
      if (msg.ok && net.role === 'host') doHostUndo(net.color);
      return;
    }

    case 'undo': {
      if (net.role !== 'guest') return;
      const n = Number(msg.n);
      if (Number.isInteger(n) && n > 0 && n <= 4) ctl.undoPlies(n);
      return;
    }

    case 'newreq': {
      ctl.askNew((agreed) => {
        send({ t: 'newans', ok: !!agreed });
        if (agreed) { net.started = true; ctl.netRestart(); }
      });
      return;
    }

    case 'newans': {
      ctl.newAnswered(!!msg.ok);
      if (msg.ok) { net.started = true; ctl.netRestart(); }
      return;
    }

    case 'resign': {
      const who = msg.color === RED ? RED : BLACK;
      ctl.peerResigned(who);
      return;
    }

    case 'chat': {
      const text = typeof msg.s === 'string' ? msg.s.slice(0, CHAT_MAX) : '';
      if (text.trim()) ctl.chatIn(text, false);
      return;
    }

    case 'bye': {
      ctl.netEnded('Your friend left the game.');
      leave(true);
      return;
    }

    default:
      log('ignored unknown frame', msg.t);
  }
}

const opposite = (c) => (c === BLACK ? RED : BLACK);

function doHostUndo(requester) {
  const n = ctl.undoStepsFor(requester);
  if (n <= 0) return;
  ctl.undoPlies(n);
  send({ t: 'undo', n });
}

/* ------------------------------------------------------------------ */
/* Outbound actions (called by the UI)                                 */
/* ------------------------------------------------------------------ */

/** A move the local player made on the board. */
export function localMove(mv) {
  if (!net.active) return false;
  if (net.role === 'host') {
    ctl.applyMove(mv).then(() => {
      send({ t: 'applied', mv, ply: ctl.getState().ply, hash: hashState(ctl.getState()) });
    });
    return true;
  }
  if (!net.connected) { ctl.netNotice('Not connected — waiting for your friend.'); return false; }
  net.pending = true;
  ctl.netStatus();
  const sent = send({ t: 'move', mv });
  if (!sent) { net.pending = false; ctl.netNotice('Could not send that move.'); }
  return sent;
}

export function requestUndo() {
  if (!net.connected) return false;
  if (undoPendingFrom) return false;
  undoPendingFrom = 'me';
  send({ t: 'undoreq' });
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    if (undoPendingFrom !== 'me') return;
    undoPendingFrom = null;
    ctl.undoAnswered(false, true);
  }, UNDO_TIMEOUT_MS);
  return true;
}

export function requestNewGame() {
  if (!net.connected) return false;
  send({ t: 'newreq' });
  return true;
}

export function resign() {
  if (!net.active) return false;
  send({ t: 'resign', color: net.color });
  return true;
}

export function sendChat(text) {
  const s = String(text || '').slice(0, CHAT_MAX).trim();
  if (!s || !net.connected) return false;
  const okSent = send({ t: 'chat', s });
  if (okSent) ctl.chatIn(s, true);
  return okSent;
}

/** Host: force the guest to adopt our current position (test/resync helper). */
export function pushState() {
  if (net.role !== 'host' || !net.connected) return false;
  return send({ t: 'resume', snap: ctl.snapshot(), hash: hashState(ctl.getState()) });
}

/**
 * Feed a raw wire frame through the same path a peer message takes. Used by the
 * test suite to prove malformed and forged frames are survivable; it is exactly
 * the code the DataChannel handler runs, so it tests the real thing.
 */
export function injectRaw(raw) {
  let msg;
  try {
    msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    log('dropped malformed frame');
    return false;
  }
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') { log('dropped frame with no type'); return false; }
  try { onMessage(msg); } catch (err) { log('handler error, frame dropped', err); return false; }
  return true;
}

export { CHAT_MAX, RECONNECT_GRACE_MS, UNDO_TIMEOUT_MS };
