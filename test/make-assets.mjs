import fs from 'node:fs';
import zlib from 'node:zlib';

/* Minimal dependency-free PNG writer (true colour + alpha). */
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', zlib.deflateSync(raw, { level: 9 })));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

let TBL = null;
function crc32(buf) {
  if (!TBL) {
    TBL = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TBL[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TBL[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/* --- simple canvas --- */
function canvas(w, h, bg) {
  const buf = Buffer.alloc(w * 4 * h);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = bg[0]; buf[i * 4 + 1] = bg[1]; buf[i * 4 + 2] = bg[2]; buf[i * 4 + 3] = bg[3] ?? 255;
  }
  return { w, h, buf };
}
function px(c, x, y, rgb, a = 1) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h || a <= 0) return;
  const i = (y * c.w + x) * 4;
  c.buf[i] = Math.round(c.buf[i] * (1 - a) + rgb[0] * a);
  c.buf[i + 1] = Math.round(c.buf[i + 1] * (1 - a) + rgb[1] * a);
  c.buf[i + 2] = Math.round(c.buf[i + 2] * (1 - a) + rgb[2] * a);
  c.buf[i + 3] = 255;
}
function rect(c, x0, y0, w, h, rgb, a = 1) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(c, x, y, rgb, a);
}
function disc(c, cx, cy, r, rgb, a = 1) {
  const s = 3; // supersample for smooth edges
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      let hit = 0;
      for (let sy = 0; sy < s; sy++) for (let sx = 0; sx < s; sx++) {
        const dx = x + (sx + 0.5) / s - cx, dy = y + (sy + 0.5) / s - cy;
        if (dx * dx + dy * dy <= r * r) hit++;
      }
      if (hit) px(c, x, y, rgb, a * (hit / (s * s)));
    }
  }
}
function ring(c, cx, cy, r, thick, rgb, a = 1) {
  disc(c, cx, cy, r, rgb, a);
  // punch handled by caller re-drawing inner disc
}

const DARK = [24, 26, 31];
const SQ_DARK = [122, 78, 52];
const SQ_LIGHT = [204, 165, 121];
const RED = [196, 68, 52];
const RED_D = [140, 44, 34];
const BLK = [46, 49, 57];
const BLK_D = [26, 28, 34];
const GOLD = [226, 178, 84];

/* ---------- apple-touch-icon 180x180 ---------- */
{
  const S = 180;
  const c = canvas(S, S, [32, 24, 20, 255]);
  // 4x4 mini board
  const cell = S / 4;
  for (let r = 0; r < 4; r++) for (let col = 0; col < 4; col++) {
    const isDark = (r + col) % 2 === 1;
    rect(c, Math.round(col * cell), Math.round(r * cell), Math.ceil(cell), Math.ceil(cell), isDark ? SQ_DARK : SQ_LIGHT);
  }
  // one red king piece, centred
  disc(c, S / 2, S / 2 + 2, S * 0.30, [0, 0, 0], 0.30);
  disc(c, S / 2, S / 2, S * 0.30, RED_D);
  disc(c, S / 2, S / 2 - 1.5, S * 0.285, RED);
  disc(c, S * 0.43, S * 0.42, S * 0.10, [255, 255, 255], 0.16);
  // crown bar
  rect(c, Math.round(S * 0.37), Math.round(S * 0.60), Math.round(S * 0.26), 5, GOLD);
  for (const [x, hh] of [[0.375, 0.13], [0.475, 0.19], [0.575, 0.13]]) {
    rect(c, Math.round(S * x), Math.round(S * (0.60 - hh)), 6, Math.round(S * hh), GOLD);
  }
  fs.writeFileSync('assets/apple-touch-icon.png', png(S, S, c.buf));
  console.log('apple-touch-icon.png 180x180');
}

/* ---------- OG image 1200x630 ---------- */
{
  const W = 1200, H = 630;
  const c = canvas(W, H, DARK);
  // subtle vignette
  for (let y = 0; y < H; y++) {
    const t = y / H;
    rect(c, 0, y, W, 1, [30, 33, 39], 0.35 * (1 - t));
  }
  // board on the right, angled panel feel
  const B = 430, bx = W - B - 80, by = (H - B) / 2;
  rect(c, bx - 14, by - 14, B + 28, B + 28, [66, 44, 32]);
  const cell = B / 8;
  for (let r = 0; r < 8; r++) for (let col = 0; col < 8; col++) {
    const isDark = (r + col) % 2 === 1;
    rect(c, Math.round(bx + col * cell), Math.round(by + r * cell), Math.ceil(cell), Math.ceil(cell), isDark ? SQ_DARK : SQ_LIGHT);
  }
  const place = (r, col, red, king) => {
    const cx = bx + col * cell + cell / 2, cy = by + r * cell + cell / 2;
    disc(c, cx, cy + 2.5, cell * 0.37, [0, 0, 0], 0.34);
    disc(c, cx, cy, cell * 0.37, red ? RED_D : BLK_D);
    disc(c, cx, cy - 1.5, cell * 0.35, red ? RED : BLK);
    disc(c, cx - cell * 0.10, cy - cell * 0.10, cell * 0.12, [255, 255, 255], 0.14);
    if (king) disc(c, cx, cy - 1.5, cell * 0.16, GOLD);
  };
  // a plausible mid-game position
  [[0,1],[0,5],[1,2],[1,6],[2,3],[2,7],[3,0]].forEach(([r,col]) => place(r, col, false, r === 0 && col === 5));
  [[7,0],[7,4],[6,1],[6,5],[5,2],[5,6],[4,3]].forEach(([r,col]) => place(r, col, true, r === 7 && col === 4));

  // typography block (blocky bitmap letters — no font dependency)
  const GLYPH = {
    A:['01110','10001','10001','11111','10001','10001','10001'],
    C:['01110','10001','10000','10000','10000','10001','01110'],
    D:['11110','10001','10001','10001','10001','10001','11110'],
    E:['11111','10000','10000','11110','10000','10000','11111'],
    G:['01110','10001','10000','10111','10001','10001','01111'],
    H:['10001','10001','10001','11111','10001','10001','10001'],
    I:['11111','00100','00100','00100','00100','00100','11111'],
    K:['10001','10010','10100','11000','10100','10010','10001'],
    L:['10000','10000','10000','10000','10000','10000','11111'],
    N:['10001','11001','11001','10101','10011','10011','10001'],
    R:['11110','10001','10001','11110','10100','10010','10001'],
    S:['01111','10000','10000','01110','00001','00001','11110'],
    T:['11111','00100','00100','00100','00100','00100','00100'],
    U:['10001','10001','10001','10001','10001','10001','01110'],
    ' ':['00000','00000','00000','00000','00000','00000','00000'],
  };
  const text = (str, x0, y0, s, rgb) => {
    let x = x0;
    for (const ch of str) {
      const g = GLYPH[ch] || GLYPH[' '];
      for (let r = 0; r < 7; r++) for (let col = 0; col < 5; col++) {
        if (g[r][col] === '1') rect(c, x + col * s, y0 + r * s, s, s, rgb);
      }
      x += 6 * s;
    }
    return x;
  };
  text('SANA', 80, 214, 12, [244, 242, 240]);
  rect(c, 80, 330, 132, 5, [226, 160, 76]);
  text('CHECKERS', 80, 378, 5, [172, 169, 176]);

  fs.writeFileSync('assets/og.png', png(W, H, c.buf));
  console.log('og.png 1200x630');
}
