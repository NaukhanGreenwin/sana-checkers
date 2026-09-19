/**
 * Browser smoke test over CDP: loads the app, checks for console errors,
 * plays real moves through the UI, exercises undo/theme/modal, and
 * screenshots several viewports.
 */
import { WebSocket } from 'ws';

const CDP = 'http://127.0.0.1:9344';
const URL_BASE = process.argv[2] || 'http://127.0.0.1:8777/';
const OUT = process.argv[3] || '/tmp/sfpm-checkers-build/shots';
import fs from 'node:fs';
fs.mkdirSync(OUT, { recursive: true });

const list = await (await fetch(`${CDP}/json/list`)).json();
let page = list.find((t) => t.type === 'page');
if (!page) {
  page = await (await fetch(`${CDP}/json/new?about:blank`)).json();
}

const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

let id = 0;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    consoleErrors.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    consoleErrors.push('log: ' + msg.params.entry.text);
  }
});

function send(method, params = {}) {
  const mid = ++id;
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 30000);
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

async function viewport(w, h, dsf = 2) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dsf, mobile: w < 700 });
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, 'base64'));
  return `${OUT}/${name}.png`;
}

async function load(url) {
  await send('Page.navigate', { url });
  await sleep(1400);
}

let pass = 0, fail = 0;
const notes = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); notes.push(name + ' ' + detail); }
}

/* ================= desktop ================= */
console.log('\n[desktop 1440x900]');
await viewport(1440, 900, 2);
await load(URL_BASE);

ok('title set', (await evaluate('document.title')).includes('Sana'));
ok('32 dark squares rendered', await evaluate('document.querySelectorAll(".sq--dark").length') === 32);
ok('32 light squares rendered', await evaluate('document.querySelectorAll(".sq--light").length') === 32);
ok('24 pieces rendered', await evaluate('document.querySelectorAll(".piece").length') === 24);
ok('12 black pieces', await evaluate('document.querySelectorAll(".piece--b").length') === 12);
ok('12 red pieces', await evaluate('document.querySelectorAll(".piece--r").length') === 12);
ok('no kings at start', await evaluate('document.querySelectorAll(".piece--king").length') === 0);
ok('score shows 12/12', await evaluate('document.querySelector("#side-b .side__count").textContent') === '12');
ok('undo disabled at start', await evaluate('document.getElementById("undoBtn").disabled') === true);
ok('history empty', await evaluate('!document.getElementById("historyEmpty").hidden'));
ok('board is square', await evaluate('(() => {const r=document.getElementById("board").getBoundingClientRect(); return Math.abs(r.width-r.height)<2})()'));
ok('no horizontal overflow', await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'),
  await evaluate('document.documentElement.scrollWidth + " vs " + window.innerWidth'));
await shot('01-desktop-dark-start');

/* --- switch to two-player so the test drives both sides --- */
await evaluate('document.getElementById("menuBtn").click()');
await sleep(400);
ok('new-game modal opens', await evaluate('document.getElementById("modal").dataset.open') === '1');
await shot('02-desktop-modal');
await evaluate('document.querySelector(\'#segMode .seg__btn[data-v="local"]\').click()');
await sleep(150);
ok('difficulty hidden in local mode', await evaluate('document.getElementById("diffField").hidden') === true);
await evaluate('document.getElementById("startBtn").click()');
await sleep(500);
ok('modal closed after start', await evaluate('document.getElementById("modal").dataset.open') === '0');

/* --- select a piece and verify highlights --- */
const movableFrom = await evaluate(`(() => {
  const cells = [...document.querySelectorAll('.cell[data-playable="1"]')];
  return cells.length ? Number(cells[0].dataset.sq) : -1;
})()`);
ok('playable squares are marked', movableFrom >= 0, String(movableFrom));
await evaluate(`document.querySelector('.cell[data-sq="${movableFrom}"]').click()`);
await sleep(320);
ok('piece shows selected state', await evaluate('document.querySelectorAll(".piece--sel").length') === 1);
const hints = await evaluate('document.querySelectorAll(".sq[data-hint]").length');
ok('legal-move hints appear', hints > 0, String(hints));
await shot('03-desktop-selection');

/* --- play 30 real moves through the DOM in two-player mode --- */
console.log('\n[playing 30 UI moves]');
const playScript = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const errs = [];
  let played = 0, captures = 0, maxKings = 0;
  for (let i = 0; i < 40 && played < 30; i++) {
    if (document.getElementById('modal').dataset.open === '1') break;
    // clear any stale selection
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(40);
    const candidates = [...document.querySelectorAll('.piece--movable')];
    if (!candidates.length) { errs.push('no movable pieces at move ' + played); break; }
    const cells = [...document.querySelectorAll('.cell[data-playable="1"]')];
    let moved = false;
    for (const c of cells) {
      c.click();
      await sleep(70);
      const targets = [...document.querySelectorAll('.sq[data-hint]')];
      if (targets.length) {
        const pick = targets[Math.floor(Math.random() * targets.length)];
        if (pick.dataset.hint === 'jump') captures++;
        pick.querySelector('.cell').click();
        moved = true; played++;
        break;
      }
    }
    if (!moved) { errs.push('selected a piece with no destination at move ' + played); break; }
    // wait for the slide + capture-fade animations to fully settle before asserting
    await sleep(300);
    for (let w = 0; w < 40 && document.querySelector('.piece--dying, .piece--capturing'); w++) await sleep(50);
    await sleep(120);
    maxKings = Math.max(maxKings, document.querySelectorAll('.piece--king').length);
    const pieceCount = document.querySelectorAll('.piece').length;
    const scoreTotal = Number(document.querySelector('#side-b .side__count').textContent)
                     + Number(document.querySelector('#side-r .side__count').textContent);
    if (pieceCount !== scoreTotal) errs.push('DOM/score mismatch at move ' + played + ': ' + pieceCount + ' vs ' + scoreTotal);
    // turn indicator, score highlight and banner text must always agree
    const plies = [...document.querySelectorAll('.history__mv')].map(e => e.textContent).filter(Boolean).length;
    const bar = document.getElementById('turnbar').dataset.turn;
    const bAct = document.getElementById('side-b').dataset.active;
    const rAct = document.getElementById('side-r').dataset.active;
    const txt = document.getElementById('turnText').textContent.toLowerCase();
    const scoreSide = bAct === '1' ? 'b' : (rAct === '1' ? 'r' : 'none');
    if (bar !== (plies % 2 === 0 ? 'b' : 'r')) errs.push('turn desync at ply ' + plies + ': bar=' + bar);
    if (scoreSide !== bar) errs.push('score highlight desync at ply ' + plies + ': score=' + scoreSide + ' bar=' + bar);
    if (!txt.includes(bar === 'b' ? 'black' : 'red')) errs.push('banner desync at ply ' + plies + ': "' + txt + '" bar=' + bar);
  }
  const entries = [...document.querySelectorAll('.history__mv')].map(e => e.textContent).filter(Boolean);
  return {
    played, errs, captures, maxKings,
    log: entries.length,
    pieces: document.querySelectorAll('.piece').length,
    firstMoves: entries.slice(0, 8),
    ended: document.getElementById('modal').dataset.open === '1',
  };
})()`;
const res = await evaluate(playScript);
console.log('  played:', res.played, '| history:', res.log, '| pieces left:', res.pieces,
  '| captures:', res.captures, '| kings seen:', res.maxKings, '| game ended:', res.ended);
console.log('  opening:', res.firstMoves.join(' '));
ok('played >= 20 UI moves', res.played >= 20, `only ${res.played}; ${res.errs.join('; ')}`);
ok('DOM piece count always matched the score panel', res.errs.filter((e) => e.includes('mismatch')).length === 0, res.errs.join('; '));
ok('turn / score / banner stayed in sync every ply', res.errs.filter((e) => e.includes('desync')).length === 0, res.errs.filter((e) => e.includes('desync')).join('; '));
ok('history recorded every move', res.log === res.played, `${res.log} vs ${res.played}`);
ok('pieces were actually captured', res.pieces < 24, `still ${res.pieces}`);
ok('notation looks valid', res.firstMoves.every((m) => /^\d+([-x]\d+)+$/.test(m)), res.firstMoves.join(','));
await shot('04-desktop-midgame');

/* --- undo --- */
const countHist = 'document.querySelectorAll(".history__mv") && [...document.querySelectorAll(".history__mv")].map(e=>e.textContent).filter(Boolean).length';
const beforeUndo = await evaluate(countHist);
await evaluate('document.getElementById("undoBtn").click()');
await sleep(500);
const afterUndo = await evaluate(countHist);
ok('undo removes a move from history', afterUndo === beforeUndo - 1, `${beforeUndo} -> ${afterUndo}`);
ok('undo restores piece count consistency',
  await evaluate('document.querySelectorAll(".piece").length === (Number(document.querySelector("#side-b .side__count").textContent) + Number(document.querySelector("#side-r .side__count").textContent))'));

/* --- theme --- */
await evaluate('document.getElementById("themeBtn").click()');
await sleep(400);
ok('light theme applies', await evaluate('document.documentElement.dataset.theme') === 'light');
await shot('05-desktop-light');
await evaluate('document.getElementById("themeBtn").click()');
await sleep(350);

/* --- keyboard accessibility --- */
await evaluate('document.querySelector(".cell[tabindex=\\"0\\"]").focus()');
await sleep(120);
ok('a board cell is focusable', await evaluate('document.activeElement.classList.contains("cell")'));
const beforeKey = await evaluate('document.activeElement.dataset.sq');
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
await sleep(220);
const afterKey = await evaluate('document.activeElement.dataset.sq');
ok('arrow key moves the board cursor', beforeKey !== afterKey, `${beforeKey} -> ${afterKey}`);
ok('cells expose aria-labels', (await evaluate('document.querySelector(".cell").getAttribute("aria-label")') || '').includes('Square'));
ok('live region present', await evaluate('!!document.querySelector("[aria-live]")'));

/* ================= AI mode ================= */
console.log('\n[AI mode — hard]');
await load(URL_BASE);
await evaluate('document.getElementById("menuBtn").click()');
await sleep(350);
await evaluate('document.querySelector(\'#segMode .seg__btn[data-v="ai"]\').click()');
await evaluate('document.querySelector(\'#segDiff .seg__btn[data-v="hard"]\').click()');
await evaluate('document.getElementById("startBtn").click()');
await sleep(500);

const aiRes = await evaluate(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let humanMoves = 0, sawThinking = false;
  // observe the thinking flag so a fast search can't slip past a polled check
  const bar = document.getElementById('turnbar');
  const obs = new MutationObserver(() => { if (bar.dataset.thinking === '1') sawThinking = true; });
  obs.observe(bar, { attributes: true, attributeFilter: ['data-thinking'] });

  for (let i = 0; i < 8; i++) {
    const cells = [...document.querySelectorAll('.cell[data-playable="1"]')];
    if (!cells.length) break;
    let moved = false;
    for (const c of cells) {
      c.click(); await sleep(70);
      const t = document.querySelector('.sq[data-hint]');
      if (t) { t.querySelector('.cell').click(); moved = true; humanMoves++; break; }
    }
    if (!moved) break;
    // wait for the AI reply to land
    for (let w = 0; w < 120; w++) {
      await sleep(120);
      if (bar.dataset.thinking === '0' && !document.getElementById('undoBtn').disabled) break;
    }
    await sleep(200);
    if (document.getElementById('modal').dataset.open === '1') break;
  }
  obs.disconnect();
  return {
    humanMoves, sawThinking,
    history: [...document.querySelectorAll('.history__mv')].map(e => e.textContent).filter(Boolean).length,
    pieces: document.querySelectorAll('.piece').length,
    turnText: document.getElementById('turnText').textContent,
  };
})()`);
console.log('  human moves:', aiRes.humanMoves, '| total plies in history:', aiRes.history, '| pieces:', aiRes.pieces);
ok('AI mode played several rounds', aiRes.humanMoves >= 5, String(aiRes.humanMoves));
ok('AI responded to every human move', aiRes.history >= aiRes.humanMoves * 2 - 1, `${aiRes.history} plies for ${aiRes.humanMoves} human moves`);
ok('thinking indicator fires', aiRes.sawThinking === true);
await shot('06-desktop-ai');

/* ================= responsive ================= */
for (const [name, w, h] of [['07-mobile-320', 320, 568], ['08-mobile-390', 390, 844], ['09-tablet-820', 820, 1180], ['10-desktop-2560', 2560, 1440]]) {
  console.log(`\n[${name}]`);
  await viewport(w, h, w > 1600 ? 1 : 2);
  await load(URL_BASE);
  await sleep(400);
  const overflow = await evaluate('document.documentElement.scrollWidth - window.innerWidth');
  ok(`${name}: no horizontal overflow`, overflow <= 1, `${overflow}px`);
  const sq = await evaluate('(() => {const r=document.getElementById("board").getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]})()');
  ok(`${name}: board stays square`, Math.abs(sq[0] - sq[1]) <= 2, sq.join('x'));
  ok(`${name}: board fits viewport`, sq[0] <= w, `${sq[0]} > ${w}`);
  const tap = await evaluate(`(() => {
    const bad = [];
    document.querySelectorAll('.btn, .seg__btn, .switch').forEach(b => {
      const r = b.getBoundingClientRect();
      if (r.width > 0 && (r.height < ${w < 700 ? 40 : 30})) bad.push(b.id || b.className);
    });
    return bad;
  })()`);
  ok(`${name}: touch targets sized`, tap.length === 0, tap.join(','));
  await shot(name);
}

/* --- mobile drawer --- */
await viewport(390, 844, 2);
await load(URL_BASE);
await sleep(400);
ok('history collapsed on mobile', await evaluate('getComputedStyle(document.getElementById("historyPanel")).display') === 'none');
await evaluate('document.getElementById("histToggle").click()');
await sleep(300);
ok('history drawer opens on mobile', await evaluate('getComputedStyle(document.getElementById("historyPanel")).display') !== 'none');
await shot('11-mobile-drawer');

/* ================= errors ================= */
console.log('\n[console]');
const realErrors = consoleErrors.filter((e) => !/favicon|manifest|DevTools|Autofill/i.test(e));
ok('no uncaught page exceptions', pageErrors.length === 0, pageErrors.join(' | '));
ok('no console errors/warnings', realErrors.length === 0, realErrors.slice(0, 5).join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
if (notes.length) { console.log('Issues:'); notes.forEach((n) => console.log('  - ' + n)); }
console.log('Screenshots in ' + OUT);
ws.close();
process.exit(fail ? 1 : 0);
