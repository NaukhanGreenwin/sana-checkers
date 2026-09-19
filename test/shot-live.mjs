import { WebSocket } from 'ws'; import fs from 'node:fs';
const OUT = process.argv[2];
const list = await (await fetch('http://127.0.0.1:9344/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise(r => ws.on('open', r));
let id=0; const pend=new Map();
ws.on('message', raw=>{const m=JSON.parse(raw); if(pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id);}});
const send=(m,p={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async e=>(await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result.value;
const s=ms=>new Promise(r=>setTimeout(r,ms));
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:2,mobile:false});
await send('Page.navigate',{url:'https://naukhangreenwin.github.io/sana-checkers/'});
await s(2500);
// play an engaging mid-game position in two-player mode, then select a piece
await ev('document.getElementById("menuBtn").click()'); await s(400);
await ev('document.querySelector(\'#segMode .seg__btn[data-v="local"]\').click()');
await ev('document.getElementById("startBtn").click()'); await s(500);
await ev(`(async()=>{const z=ms=>new Promise(r=>setTimeout(r,ms));
for(let i=0;i<16;i++){let mv=false;
 for(const c of document.querySelectorAll('.cell[data-playable="1"]')){c.click();await z(60);
  const t=[...document.querySelectorAll('.sq[data-hint]')];
  if(t.length){t[Math.floor(Math.random()*t.length)].querySelector('.cell').click();mv=true;break;}}
 if(!mv)break; await z(620); if(document.getElementById('modal').dataset.open==='1')break;}})()`);
await s(1200);
// select a piece with a capture available if possible, else any piece
await ev(`(async()=>{const z=ms=>new Promise(r=>setTimeout(r,ms));
 let best=null;
 for(const c of document.querySelectorAll('.cell[data-playable="1"]')){c.click();await z(80);
   if(document.querySelector('.sq[data-hint="jump"]')){best=c;break;}
   if(document.querySelector('.sq[data-hint]')&&!best)best=c;}
 if(best){best.click();await z(150);if(!document.querySelector('.sq[data-hint]')){best.click();}}})()`);
await s(700);
console.log('state:', JSON.stringify(await ev(`({turn:document.getElementById('turnText').textContent,bar:document.getElementById('turnbar').dataset.turn,bAct:document.getElementById('side-b').dataset.active,rAct:document.getElementById('side-r').dataset.active,sel:document.querySelectorAll('.piece--sel').length,hints:document.querySelectorAll('.sq[data-hint]').length,plies:[...document.querySelectorAll('.history__mv')].map(e=>e.textContent).filter(Boolean).length})`)));
const r=await send('Page.captureScreenshot',{format:'png'});
fs.writeFileSync(OUT, Buffer.from(r.data,'base64'));
console.log('saved', OUT);
ws.close(); process.exit(0);
