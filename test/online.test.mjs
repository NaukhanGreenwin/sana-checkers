/**
 * Two-browser online multiplayer test over CDP.
 *
 * Boots two independent headless Chrome instances (separate user-data dirs, so
 * they are genuinely different clients), has one create a room and the other
 * join via the shared link, then plays 10 alternating moves through the real
 * DOM — including a forced capture and a crowning — asserting after every ply
 * that both boards agree.
 *
 * Usage: node test/online.test.mjs [baseUrl]
 */
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8777/';
const CHROME = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let pass = 0, fail = 0;
const notes = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; notes.push(`${name}${detail ? ' :: ' + detail : ''}`); console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Chrome clients                                                      */
/* ------------------------------------------------------------------ */

async function launch(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `chk-${port}-`));
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    '--headless=new',
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--hide-scrollbars',
    '--window-size=1280,900',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore' });

  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) break;
    } catch { /* not up yet */ }
  }
  return { proc, dir, port };
}

async function connect(client, label) {
  const list = await (await fetch(`http://127.0.0.1:${client.port}/json/list`)).json();
  let page = list.find((t) => t.type === 'page');
  if (!page) page = await (await fetch(`http://127.0.0.1:${client.port}/json/new?about:blank`)).json();

  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
  });

  const send = (method, params = {}) => {
    const mid = ++id;
    return new Promise((resolve, reject) => {
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 30000);
    });
  };

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');

  const load = async (url) => {
    await send('Page.navigate', { url });
    for (let i = 0; i < 60; i++) {
      await sleep(200);
      if (await evaluate('document.readyState === "complete"')) break;
    }
    await sleep(500);
  };

  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  };

  return { label, ws, send, evaluate, load, shot, errors };
}

/* ------------------------------------------------------------------ */
/* Board helpers driven through the real UI                            */
/* ------------------------------------------------------------------ */

/** Everything the test needs to compare two clients. */
const SNAP = `(() => {
  const a = window.__chk;
  return {
    board: a ? a.board() : null,
    turn: a ? a.turn() : null,
    ply: a ? a.ply() : null,
    hash: a ? a.hash() : null,
    pieces: document.querySelectorAll('.piece').length,
    kings: document.querySelectorAll('.piece--king').length,
    history: [...document.querySelectorAll('.history__mv')].map(e => e.textContent).filter(Boolean),
    myTurn: document.querySelectorAll('.cell[data-playable="1"]').length > 0,
    turnText: document.getElementById('turnText').textContent,
    pill: document.getElementById('netPill').dataset.show === '1'
      ? document.getElementById('netPillText').textContent : null,
    banner: document.getElementById('netBanner').dataset.show === '1'
      ? document.getElementById('netBannerText').textContent : null,
  };
})()`;

/** Play one move for whichever client is on turn. Returns the notation played. */
async function playOne(c, preferCapture) {
  const mv = await c.evaluate(`(() => {
    const froms = [...document.querySelectorAll('.cell[data-playable="1"]')]
      .map(e => Number(e.dataset.sq));
    if (!froms.length) return null;
    const a = window.__chk;
    const legal = a.legal();
    // prefer a from-square whose move captures / crowns when asked
    const rank = (m) => (${preferCapture ? '(m.capture?2:0)+(m.crowned?3:0)' : '(m.crowned?3:0)'});
    const best = legal.slice().sort((x,y) => rank(y)-rank(x))[0];
    return best ? { from: best.from, to: best.to } : null;
  })()`);
  if (!mv) return null;
  await c.evaluate(`document.querySelector('.cell[data-sq="${mv.from}"]').click()`);
  await sleep(220);
  await c.evaluate(`document.querySelector('.cell[data-sq="${mv.to}"]').click()`);
  await sleep(1100);
  return mv;
}

async function waitFor(c, expr, ms = 20000, every = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await c.evaluate(expr)) return true; } catch { /* mid-navigation */ }
    await sleep(every);
  }
  return false;
}

/* ------------------------------------------------------------------ */

const OUT = process.env.OUT_DIR || '/tmp/checkers-online-shots';
fs.mkdirSync(OUT, { recursive: true });

console.log('\n[boot] launching two independent Chrome instances');
const A = await launch(9351);
const B = await launch(9352);
const host = await connect(A, 'host');
const guest = await connect(B, 'guest');

const cleanup = () => {
  try { host.ws.close(); } catch { /* noop */ }
  try { guest.ws.close(); } catch { /* noop */ }
  try { A.proc.kill(); } catch { /* noop */ }
  try { B.proc.kill(); } catch { /* noop */ }
};

try {
  /* ============ 1. create the room ============ */
  console.log('\n[1] host creates a room');
  await host.load(BASE);
  ok('host: app loaded', await host.evaluate('!!document.getElementById("board")'));
  ok('host: test hook exposed', await host.evaluate('!!window.__chk'));

  await host.evaluate('document.getElementById("menuBtn").click()');
  await sleep(400);
  ok('host: Play online option present in the mode modal',
    await host.evaluate('!!document.getElementById("onlineBtn")'));
  await host.shot(path.join(OUT, 'a1-mode-modal.png'));

  await host.evaluate('document.getElementById("onlineBtn").click()');
  await sleep(300);
  ok('host: create/join choice shown',
    await host.evaluate('!!document.getElementById("createBtn") && !!document.getElementById("joinBtn")'));

  await host.evaluate('document.getElementById("createBtn").click()');
  const gotCode = await waitFor(host, '!!document.getElementById("roomCode")', 30000);
  ok('host: room code issued by the broker', gotCode);
  if (!gotCode) throw new Error('never got a room code — broker unreachable?');

  const code = (await host.evaluate('document.getElementById("roomCode").textContent')).trim();
  const link = await host.evaluate('document.getElementById("roomLink").value');
  ok('host: room code is 6 alphanumeric chars', /^[A-Z0-9]{6}$/.test(code), code);
  ok('host: shareable link carries ?room=CODE', link.includes(`?room=${code}`), link);
  ok('host: copy button present', await host.evaluate('!!document.getElementById("copyBtn")'));
  ok('host: waiting spinner shown', await host.evaluate('!!document.querySelector("#waitRow .spinner")'));
  await host.shot(path.join(OUT, 'a2-room-created.png'));
  console.log(`      room=${code}  link=${link}`);

  /* ============ 2. guest joins via the link ============ */
  console.log('\n[2] guest opens the shared link');
  await guest.load(link);
  const joinOpened = await waitFor(guest, 'document.getElementById("modal").dataset.open === "1" && !!document.getElementById("codeInput")', 15000);
  ok('guest: ?room= auto-opens the Join dialog', joinOpened);
  ok('guest: code is pre-filled from the URL',
    (await guest.evaluate('document.getElementById("codeInput").value')) === code);
  ok('guest: Connect button is focused',
    (await guest.evaluate('document.activeElement && document.activeElement.id')) === 'connectBtn');
  await guest.shot(path.join(OUT, 'b1-join-prefilled.png'));

  await guest.evaluate('document.getElementById("connectBtn").click()');

  const hostLive = await waitFor(host, 'window.__chk && window.__chk.net().connected && window.__chk.net().started', 45000);
  const guestLive = await waitFor(guest, 'window.__chk && window.__chk.net().connected && window.__chk.net().started', 45000);
  ok('host: peer connection established', hostLive);
  ok('guest: peer connection established', guestLive);
  if (!hostLive || !guestLive) throw new Error('handshake failed');

  await sleep(800);
  ok('host: modal auto-closed on connect', (await host.evaluate('document.getElementById("modal").dataset.open')) === '0');
  ok('guest: modal auto-closed on connect', (await guest.evaluate('document.getElementById("modal").dataset.open')) === '0');

  const hostNet = await host.evaluate('window.__chk.net()');
  const guestNet = await guest.evaluate('window.__chk.net()');
  ok('host is red', hostNet.color === 'r', hostNet.color);
  ok('guest is black', guestNet.color === 'b', guestNet.color);
  ok('host role is host', hostNet.role === 'host');
  ok('guest role is guest', guestNet.role === 'guest');

  let hs = await host.evaluate(SNAP);
  let gs = await guest.evaluate(SNAP);
  ok('host: status pill shows connected', /Connected/i.test(hs.pill || ''), hs.pill);
  ok('guest: status pill shows connected', /Connected/i.test(gs.pill || ''), gs.pill);
  ok('host: chat pane visible', await host.evaluate('!document.getElementById("chatPanel").hidden'));
  ok('guest: resign button visible', await guest.evaluate('!document.getElementById("resignBtn").hidden'));
  ok('both boards start identical', hs.hash === gs.hash, `${hs.hash} vs ${gs.hash}`);
  ok('black (guest) moves first', hs.turn === 'b' && gs.turn === 'b');
  ok('guest holds the turn', gs.myTurn === true && hs.myTurn === false,
    `guest=${gs.myTurn} host=${hs.myTurn}`);
  ok('host sees "Your friend\'s turn"', /friend/i.test(hs.turnText), hs.turnText);
  await host.shot(path.join(OUT, 'a3-game-started.png'));
  await guest.shot(path.join(OUT, 'b2-game-started.png'));

  /* ============ 3. chat ============ */
  console.log('\n[3] chat round-trip');
  await guest.evaluate(`(() => {
    const i = document.getElementById('chatInput');
    i.value = 'hey, good luck';
    document.getElementById('chatForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
  })()`);
  const chatGot = await waitFor(host, `[...document.querySelectorAll('#chatLog .chat__msg')].some(e => e.textContent.includes('good luck'))`, 10000);
  ok('chat message crossed the data channel', chatGot);
  ok('chat input is labelled for screen readers',
    await host.evaluate(`!!document.querySelector('label[for="chatInput"]')`));

  /* ============ 4. play 10 alternating moves ============ */
  console.log('\n[4] playing 10 alternating moves through the DOM');
  // Seed a position that guarantees a capture and a crowning inside 10 plies.
  await host.evaluate(`window.__chk.seed('.b....b.........r.r..r......R...','b')`);
  await sleep(900);

  let sawCapture = false, sawCrown = false, desyncs = 0;
  const played = [];

  for (let ply = 0; ply < 10; ply++) {
    hs = await host.evaluate(SNAP);
    gs = await guest.evaluate(SNAP);
    if (hs.hash !== gs.hash) { desyncs++; break; }
    if (await host.evaluate('window.__chk.over()')) { console.log(`      game ended at ply ${ply}`); break; }

    const mover = hs.turn === 'r' ? host : guest;
    const other = hs.turn === 'r' ? guest : host;
    const before = hs.pieces;

    const mv = await playOne(mover, true);
    if (!mv) { console.log(`      no legal move for ${mover.label} at ply ${ply}`); break; }

    // both sides must converge on the same state
    const converged = await waitFor(other, `window.__chk.hash() === ${JSON.stringify(await mover.evaluate('window.__chk.hash()'))}`, 12000);
    const h2 = await host.evaluate(SNAP);
    const g2 = await guest.evaluate(SNAP);
    if (h2.hash !== g2.hash) desyncs++;

    if (h2.pieces < before) sawCapture = true;
    if (h2.kings > hs.kings) sawCrown = true;
    played.push(h2.history[h2.history.length - 1] || '?');

    ok(`ply ${ply + 1}: ${mover.label} played ${played[played.length - 1]} — states agree`,
      converged && h2.hash === g2.hash, `${h2.hash} vs ${g2.hash}`);
    ok(`ply ${ply + 1}: turn alternated`, h2.turn !== hs.turn, `${hs.turn} -> ${h2.turn}`);
    ok(`ply ${ply + 1}: move logs match`,
      h2.history.join('|') === g2.history.join('|'),
      `${h2.history.join('|')} vs ${g2.history.join('|')}`);
  }

  ok('10-move run produced no desync', desyncs === 0, `${desyncs} desyncs`);
  ok('a capture occurred during the run', sawCapture, played.join(' '));
  ok('a crowning occurred during the run', sawCrown, played.join(' '));
  console.log(`      moves: ${played.join(' ')}`);
  await host.shot(path.join(OUT, 'a4-midgame.png'));
  await guest.shot(path.join(OUT, 'b3-midgame.png'));

  /* ============ 5. turn enforcement ============ */
  console.log('\n[5] turn enforcement + illegal move rejection');
  const h3 = await host.evaluate(SNAP);
  const idle = h3.turn === 'r' ? guest : host;
  ok('off-turn client has no playable squares',
    (await idle.evaluate('document.querySelectorAll(\'.cell[data-playable="1"]\').length')) === 0);

  // Guest forges an illegal move straight onto the wire; host must reject it.
  const hashBefore = await host.evaluate('window.__chk.hash()');
  await guest.evaluate(`window.__chk.raw(JSON.stringify({t:'move', mv:{from:0,to:31,path:[0,31],captured:[],crowned:false,capture:false}}))`);
  await sleep(2500);
  ok('host rejected a forged illegal move',
    (await host.evaluate('window.__chk.hash()')) === hashBefore);
  ok('host stayed alive after the forged move', (await host.evaluate('!!window.__chk')) === true);

  /* ============ 6. malformed traffic ============ */
  console.log('\n[6] malformed message handling');
  const gHashBefore = await guest.evaluate('window.__chk.hash()');
  for (const junk of ['{not json at all', '', '[]', '{"t":42}', '{"t":"move"}', '{"t":"move","mv":{"from":"x","to":null}}', '{"t":"applied","mv":{"from":999,"to":-4,"path":"nope","captured":{}}}', '{"t":"\\u0000"}']) {
    await host.evaluate(`window.__chk.raw(${JSON.stringify(junk)})`);
    await guest.evaluate(`window.__chk.raw(${JSON.stringify(junk)})`);
  }
  await sleep(2500);
  ok('host survived 8 malformed frames', (await host.evaluate('!!window.__chk && !!document.getElementById("board")')) === true);
  ok('guest survived 8 malformed frames', (await guest.evaluate('!!window.__chk && !!document.getElementById("board")')) === true);
  ok('malformed frames did not mutate guest state',
    (await guest.evaluate('window.__chk.hash()')) === gHashBefore);
  ok('host still connected after garbage', (await host.evaluate('window.__chk.net().connected')) === true);
  ok('no uncaught exceptions on host', host.errors.length === 0, host.errors.slice(0, 3).join(' | '));
  ok('no uncaught exceptions on guest', guest.errors.length === 0, guest.errors.slice(0, 3).join(' | '));

  /* ============ 7. disconnect ============ */
  console.log('\n[7] disconnect → reconnect banner');
  try { guest.ws.close(); } catch { /* noop */ }
  B.proc.kill('SIGKILL');
  const bannerUp = await waitFor(host, 'document.getElementById("netBanner").dataset.show === "1"', 30000, 500);
  ok('host shows the reconnect banner after the peer dies', bannerUp);
  const hb = await host.evaluate(SNAP);
  ok('banner text mentions reconnecting', /reconnect/i.test(hb.banner || ''), hb.banner);
  ok('host pill flips to the disconnected state',
    (await host.evaluate('document.getElementById("netPill").dataset.state')) === 'down');
  ok('board is frozen while disconnected',
    (await host.evaluate('document.querySelectorAll(\'.cell[data-playable="1"]\').length')) === 0);
  ok('End game button offered', await host.evaluate('!document.getElementById("netEndBtn").hidden'));
  await host.shot(path.join(OUT, 'a5-disconnect-banner.png'));

  /* ============ 8. end game returns to a working local board ============ */
  console.log('\n[8] End game falls back to local play');
  await host.evaluate('document.getElementById("netEndBtn").click()');
  await sleep(1200);
  ok('pill hidden after ending', (await host.evaluate('document.getElementById("netPill").dataset.show')) === '0');
  ok('banner hidden after ending', (await host.evaluate('document.getElementById("netBanner").dataset.show')) === '0');
  ok('chat hidden after ending', await host.evaluate('document.getElementById("chatPanel").hidden'));
  ok('local board playable again',
    (await host.evaluate('document.querySelectorAll(\'.cell[data-playable="1"]\').length')) > 0);
  ok('24 pieces back on the board', (await host.evaluate('document.querySelectorAll(".piece").length')) === 24);
} catch (err) {
  fail++;
  notes.push('EXCEPTION: ' + err.message);
  console.log('\n!! ' + err.stack);
} finally {
  cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (notes.length) { console.log('Failures:'); notes.forEach((n) => console.log('  - ' + n)); }
console.log('Screenshots in ' + OUT);
process.exit(fail ? 1 : 0);
