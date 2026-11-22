// Room Showdown: canvas rendering (arena, characters, bullets, effects) and the DOM HUD.
// Everything is drawn with shapes and gradients: no image files.

import { CONFIG } from './config.js';
import { SOLIDS, SPAWNS } from './sim.js';

const C = CONFIG;
const AW = C.ARENA_W, AH = C.ARENA_H, R = C.PLAYER_RADIUS;
const TAU = Math.PI * 2;
const INK = '#0b0d16';

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------
const colorCache = new Map();
function parseHex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
function rgb(a) { return `rgb(${a[0] | 0},${a[1] | 0},${a[2] | 0})`; }
function mixRgb(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function colorInfo(hex) {
  let c = colorCache.get(hex);
  if (!c) {
    const base = parseHex(hex || '#ffffff');
    c = {
      base: hex,
      light: rgb(mixRgb(base, [255, 255, 255], 0.45)),
      dark: rgb(mixRgb(base, [0, 0, 0], 0.4)),
      rgba: (a) => `rgba(${base[0]},${base[1]},${base[2]},${a})`,
    };
    colorCache.set(hex, c);
  }
  return c;
}

function roundRectPath(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) { g.roundRect(x, y, w, h, r); return; }
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export function heartPath(g, x, y, s) {
  g.beginPath();
  g.moveTo(x, y + 0.45 * s);
  g.bezierCurveTo(x - 0.1 * s, y + 0.35 * s, x - 0.52 * s, y + 0.1 * s, x - 0.52 * s, y - 0.13 * s);
  g.bezierCurveTo(x - 0.52 * s, y - 0.42 * s, x - 0.12 * s, y - 0.5 * s, x, y - 0.22 * s);
  g.bezierCurveTo(x + 0.12 * s, y - 0.5 * s, x + 0.52 * s, y - 0.42 * s, x + 0.52 * s, y - 0.13 * s);
  g.bezierCurveTo(x + 0.52 * s, y + 0.1 * s, x + 0.1 * s, y + 0.35 * s, x, y + 0.45 * s);
  g.closePath();
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------
export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let W = 1, H = 1, dpr = 1, scale = 1, ox = 0, oy = 0, topInset = 0;
  let arena = null;
  let time = 0;
  let shake = 0;
  let calm = false; // no screen shake (menu background demo)
  const particles = [];
  const rings = [];
  const texts = [];
  const flashes = new Map(); // player id -> time the muzzle flash ends
  const marks = new Map();   // player id -> where they were eliminated

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, window.innerWidth);
    H = Math.max(1, window.innerHeight);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    layout();
  }

  function layout() {
    const availH = Math.max(1, H - topInset);
    scale = Math.min(W / AW, availH / AH);
    ox = (W - AW * scale) / 2;
    oy = topInset + (availH - AH * scale) / 2;
    buildArena();
  }

  function setTopInset(px) {
    px = Math.round(px);
    if (px !== topInset) { topInset = px; layout(); }
  }

  // Static arena, pre-rendered once per resize at full device resolution.
  function buildArena() {
    const pw = Math.max(1, Math.round(AW * scale * dpr));
    const ph = Math.max(1, Math.round(AH * scale * dpr));
    if (!arena) arena = document.createElement('canvas');
    arena.width = pw;
    arena.height = ph;
    const g = arena.getContext('2d');
    g.setTransform(pw / AW, 0, 0, ph / AH, 0, 0);

    // floor + soft tiles
    g.fillStyle = '#1a2034';
    g.fillRect(0, 0, AW, AH);
    const T = 50;
    g.fillStyle = '#1d243a';
    for (let y = 0; y < AH; y += T) for (let x = (y / T) % 2 ? T : 0; x < AW; x += T * 2) g.fillRect(x, y, T, T);

    // floor markings
    g.strokeStyle = 'rgba(255,255,255,0.045)';
    g.lineWidth = 8;
    g.beginPath(); g.arc(AW / 2, AH / 2, 230, 0, TAU); g.stroke();
    g.lineWidth = 4;
    g.beginPath(); g.moveTo(AW / 2, C.WALL); g.lineTo(AW / 2, AH / 2 - 230); g.moveTo(AW / 2, AH / 2 + 230); g.lineTo(AW / 2, AH - C.WALL); g.stroke();
    // spawn pads
    for (const sp of SPAWNS) {
      g.strokeStyle = 'rgba(255,255,255,0.07)';
      g.lineWidth = 3;
      g.beginPath(); g.arc(sp.x, sp.y, 30, 0, TAU); g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.025)';
      g.fill();
    }
    // vignette
    const vg = g.createRadialGradient(AW / 2, AH / 2, 200, AW / 2, AH / 2, 950);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.4)');
    g.fillStyle = vg;
    g.fillRect(0, 0, AW, AH);

    const obstacles = SOLIDS.filter((s) => !s.wall);
    // drop shadows
    g.fillStyle = 'rgba(0,0,0,0.38)';
    for (const o of obstacles) { roundRectPath(g, o.x + 7, o.y + 10, o.w, o.h, 7); g.fill(); }
    // blocks
    for (const o of obstacles) {
      const gr = g.createLinearGradient(0, o.y, 0, o.y + o.h);
      gr.addColorStop(0, '#5f6b97');
      gr.addColorStop(1, '#3b4468');
      g.fillStyle = gr;
      roundRectPath(g, o.x, o.y, o.w, o.h, 7);
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = '#11152a';
      g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.22)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(o.x + 7, o.y + 4);
      g.lineTo(o.x + o.w - 7, o.y + 4);
      g.stroke();
      // rivets for a little character
      g.fillStyle = 'rgba(255,255,255,0.16)';
      const rv = [[o.x + 9, o.y + 10], [o.x + o.w - 9, o.y + 10], [o.x + 9, o.y + o.h - 9], [o.x + o.w - 9, o.y + o.h - 9]];
      if (o.w >= 40 && o.h >= 36) for (const [x, y] of rv) { g.beginPath(); g.arc(x, y, 2.4, 0, TAU); g.fill(); }
    }
    // border walls
    const t = C.WALL;
    g.fillStyle = '#2a3150';
    g.fillRect(0, 0, AW, t); g.fillRect(0, AH - t, AW, t); g.fillRect(0, 0, t, AH); g.fillRect(AW - t, 0, t, AH);
    g.strokeStyle = '#4b578a';
    g.lineWidth = 3;
    g.strokeRect(t - 1.5, t - 1.5, AW - 2 * t + 3, AH - 2 * t + 3);
    g.strokeStyle = '#11152a';
    g.lineWidth = 4;
    g.strokeRect(2, 2, AW - 4, AH - 4);
    // stripes on the walls
    g.save();
    g.beginPath();
    g.rect(0, 0, AW, t); g.rect(0, AH - t, AW, t);
    g.clip();
    g.strokeStyle = 'rgba(255,200,80,0.10)';
    g.lineWidth = 10;
    for (let x = -AH; x < AW + AH; x += 46) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 40, t + 30); g.stroke(); g.beginPath(); g.moveTo(x, AH - t - 10); g.lineTo(x + 40, AH + 20); g.stroke(); }
    g.restore();
  }

  // ---- effects ----
  function rand(a, b) { return a + Math.random() * (b - a); }

  function burst(x, y, n, { colors, speed = [120, 380], life = [0.3, 0.6], size = [2, 4.5], angle = null, spread = Math.PI, drag = 3.5, gravity = 0 }) {
    for (let i = 0; i < n; i++) {
      const a = angle === null ? Math.random() * TAU : angle + rand(-spread, spread);
      const s = rand(speed[0], speed[1]);
      const l = rand(life[0], life[1]);
      particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: l, max: l, size: rand(size[0], size[1]),
        color: colors[(Math.random() * colors.length) | 0], drag, gravity,
      });
    }
    if (particles.length > 700) particles.splice(0, particles.length - 700);
  }

  const fx = {
    muzzle(id) { flashes.set(id, time + 0.07); },
    hit(x, y, angle, color, big) {
      burst(x, y, big ? 20 : 14, { colors: [color, color, '#ffffff', '#ffe08a'], angle, spread: 1.1, speed: [140, 420] });
      rings.push({ x, y, r0: 6, r1: big ? 46 : 32, life: 0.28, max: 0.28, color: '#ffffff', w: 4 });
      texts.push({ x, y: y - 26, text: '-1', color: '#ff5d7a', life: 0.9, max: 0.9, size: big ? 30 : 24 });
      if (!calm) shake = Math.max(shake, big ? 13 : 4);
    },
    death(id, x, y, color, big) {
      burst(x, y, 46, { colors: [color, color, color, '#ffffff', '#ffd25a'], speed: [80, 560], life: [0.5, 1.1], size: [2.5, 6], drag: 2.6 });
      burst(x, y, 16, { colors: ['#ffffff'], speed: [300, 700], life: [0.15, 0.3], size: [1.5, 3] });
      rings.push({ x, y, r0: 10, r1: 110, life: 0.5, max: 0.5, color, w: 8 });
      rings.push({ x, y, r0: 4, r1: 60, life: 0.32, max: 0.32, color: '#ffffff', w: 5 });
      texts.push({ x, y: y - 30, text: 'OUT!', color, life: 1.3, max: 1.3, size: 34 });
      marks.set(id, { x, y, color });
      if (!calm) shake = Math.max(shake, big ? 18 : 9);
    },
    spark(x, y) {
      burst(x, y, 6, { colors: ['#ffe9a8', '#c9d1ff', '#ffffff'], speed: [60, 220], life: [0.12, 0.3], size: [1.5, 3] });
    },
    shake(a) { if (!calm) shake = Math.max(shake, a); },
    clear() {
      particles.length = 0; rings.length = 0; texts.length = 0; flashes.clear(); marks.clear(); shake = 0;
    },
  };

  function updateEffects(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vy = p.vy * k + p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (let i = rings.length - 1; i >= 0; i--) { rings[i].life -= dt; if (rings[i].life <= 0) rings.splice(i, 1); }
    for (let i = texts.length - 1; i >= 0; i--) { texts[i].life -= dt; if (texts[i].life <= 0) texts.splice(i, 1); }
    shake *= Math.exp(-dt * 9);
    if (shake < 0.2) shake = 0;
  }

  // ---- drawing pieces ----
  function drawMark(m) {
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-10, -10); ctx.lineTo(10, 10); ctx.moveTo(10, -10); ctx.lineTo(-10, 10); ctx.stroke();
    ctx.strokeStyle = m.color;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.restore();
  }

  function drawBullets(bullets, colorOf) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const b of bullets) {
      const sp = Math.hypot(b.vx, b.vy) || 1;
      const tx = b.x - (b.vx / sp) * 36, ty = b.y - (b.vy / sp) * 36;
      const col = colorInfo(colorOf(b.owner));
      const gr = ctx.createLinearGradient(tx, ty, b.x, b.y);
      gr.addColorStop(0, col.rgba(0));
      gr.addColorStop(1, col.rgba(0.85));
      ctx.strokeStyle = gr;
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.fillStyle = col.rgba(0.35);
      ctx.beginPath(); ctx.arc(b.x, b.y, 9, 0, TAU); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fffbe8';
    for (const b of bullets) { ctx.beginPath(); ctx.arc(b.x, b.y, C.BULLET_RADIUS, 0, TAU); ctx.fill(); }
    ctx.restore();
  }

  function drawPlayer(p, isMe) {
    const col = colorInfo(p.color);
    ctx.save();
    ctx.translate(p.x, p.y);
    // ground shadow
    ctx.fillStyle = 'rgba(0,0,0,0.33)';
    ctx.beginPath(); ctx.ellipse(3, 10, R * 1.02, R * 0.52, 0, 0, TAU); ctx.fill();
    // "this is you" marker
    if (isMe) {
      ctx.strokeStyle = col.rgba(0.85);
      ctx.lineWidth = 3;
      ctx.setLineDash([7, 6]);
      ctx.lineDashOffset = -time * 24;
      ctx.beginPath(); ctx.arc(0, 0, R + 9, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
    }
    const invuln = p.invuln > 0;
    if (invuln && Math.floor(time * 14) % 2 === 0) ctx.globalAlpha = 0.35;

    // pistol
    ctx.save();
    ctx.rotate(p.aim);
    roundRectPath(ctx, R - 7, -5, 24, 10, 3);
    ctx.fillStyle = '#262b40';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.fillStyle = '#6a74a3';
    ctx.fillRect(R - 4, -4, 19, 3);
    const fl = flashes.get(p.id);
    if (fl && fl > time) {
      const k = (fl - time) / 0.07;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,220,120,${0.9 * k})`;
      ctx.beginPath();
      const mx = C.MUZZLE_OFFSET;
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * TAU, rr = i % 2 ? 6 : 15 * (0.7 + 0.3 * k);
        ctx.lineTo(mx + 4 + Math.cos(a) * rr, Math.sin(a) * rr * 0.8);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${k})`;
      ctx.beginPath(); ctx.arc(mx + 3, 0, 5, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();

    // body
    const gr = ctx.createRadialGradient(-6, -7, 2, 0, 0, R + 3);
    gr.addColorStop(0, col.light);
    gr.addColorStop(0.55, col.base);
    gr.addColorStop(1, col.dark);
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = INK;
    ctx.stroke();
    if (invuln) {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, R + 4, 0, TAU); ctx.stroke();
    }
    // hand on the grip
    const ca = Math.cos(p.aim), sa = Math.sin(p.aim);
    ctx.fillStyle = col.base;
    ctx.beginPath(); ctx.arc(ca * (R - 1), sa * (R - 1), 5.5, 0, TAU); ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK;
    ctx.stroke();
    // eyes look where the gun points
    for (const s of [-1, 1]) {
      const a = p.aim + s * 0.55;
      const ex = Math.cos(a) * 8.5, ey = Math.sin(a) * 8.5;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(ex, ey, 4.4, 0, TAU); ctx.fill();
      ctx.fillStyle = '#141626';
      ctx.beginPath(); ctx.arc(ex + ca * 1.7, ey + sa * 1.7, 2.3, 0, TAU); ctx.fill();
    }
    // number badge on the back
    const bx = -ca * 8, by = -sa * 8;
    ctx.fillStyle = 'rgba(11,13,22,0.75)';
    ctx.beginPath(); ctx.arc(bx, by, 6.5, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.slot + 1), bx, by + 0.5);
    ctx.restore();
  }

  function drawLabel(p, isMe) {
    const small = scale < 0.62;
    const fontPx = small ? 11 : 13;
    const heartPx = small ? 7 : 9;
    const f = fontPx / scale, hs = heartPx / scale;
    const baseY = p.y - R - 7 / scale;
    // hearts
    const gap = hs * 1.2;
    const startX = p.x - (gap * (C.LIVES - 1)) / 2;
    for (let i = 0; i < C.LIVES; i++) {
      heartPath(ctx, startX + i * gap, baseY - hs * 0.5, hs);
      ctx.fillStyle = i < p.lives ? '#ff4d6d' : 'rgba(40,44,66,0.9)';
      ctx.fill();
      ctx.lineWidth = Math.max(1, 1.2 / scale);
      ctx.strokeStyle = 'rgba(11,13,22,0.9)';
      ctx.stroke();
    }
    // name pill with number badge
    const y = baseY - hs - f * 0.75;
    ctx.font = `700 ${f}px system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.textBaseline = 'middle';
    const name = p.name || '?';
    const tw = ctx.measureText(name).width;
    const bw = f * 1.15;
    const pad = f * 0.35;
    const total = bw + pad + tw;
    const lx = p.x - total / 2;
    roundRectPath(ctx, lx - pad, y - f * 0.68, total + pad * 2, f * 1.36, f * 0.68);
    ctx.fillStyle = isMe ? 'rgba(255,255,255,0.18)' : 'rgba(8,10,20,0.55)';
    ctx.fill();
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(lx + bw / 2, y, bw / 2, 0, TAU); ctx.fill();
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.font = `800 ${f * 0.8}px system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.fillText(String(p.slot + 1), lx + bw / 2, y + f * 0.04);
    ctx.font = `700 ${f}px system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(name, lx + bw + pad, y + f * 0.04);
  }

  function drawAimLine(p) {
    const col = colorInfo(p.color);
    const ca = Math.cos(p.aim), sa = Math.sin(p.aim);
    ctx.save();
    ctx.strokeStyle = col.rgba(0.35);
    ctx.lineWidth = 2.5;
    ctx.setLineDash([10, 10]);
    ctx.beginPath();
    ctx.moveTo(p.x + ca * (C.MUZZLE_OFFSET + 8), p.y + sa * (C.MUZZLE_OFFSET + 8));
    ctx.lineTo(p.x + ca * 150, p.y + sa * 150);
    ctx.stroke();
    ctx.restore();
  }

  function drawParticles() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    for (const r of rings) {
      const t = 1 - r.life / r.max;
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.w * (1 - t) + 1;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * t, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const tx of texts) {
      const t = 1 - tx.life / tx.max;
      ctx.globalAlpha = Math.min(1, (1 - t) * 2);
      const size = Math.max(tx.size, 14 / scale);
      ctx.font = `900 ${size}px system-ui, sans-serif`;
      ctx.lineWidth = Math.max(3, 3 / scale);
      ctx.strokeStyle = INK;
      const y = tx.y - t * 40;
      ctx.strokeText(tx.text, tx.x, y);
      ctx.fillStyle = tx.color;
      ctx.fillText(tx.text, tx.x, y);
    }
    ctx.restore();
  }

  function drawCrosshair(x, y, color) {
    ctx.save();
    ctx.lineCap = 'round';
    for (const [w, c] of [[5, 'rgba(0,0,0,0.6)'], [2, '#ffffff']]) {
      ctx.strokeStyle = c;
      ctx.lineWidth = w;
      ctx.beginPath(); ctx.arc(x, y, 10, 0, TAU); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 17, y); ctx.lineTo(x - 13, y);
      ctx.moveTo(x + 13, y); ctx.lineTo(x + 17, y);
      ctx.moveTo(x, y - 17); ctx.lineTo(x, y - 13);
      ctx.moveTo(x, y + 13); ctx.lineTo(x, y + 17);
      ctx.stroke();
    }
    ctx.fillStyle = color || '#ffffff';
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, TAU); ctx.fill();
    ctx.restore();
  }

  function drawStick(s, hintX, hintY, radius, kind, fireZone) {
    ctx.save();
    if (s.id === null) {
      // resting hint so players know where to put their thumbs
      ctx.globalAlpha = 0.16;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(hintX, hintY, radius, 0, TAU); ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${Math.round(radius * 0.32)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(kind === 'move' ? 'MOVE' : 'AIM + FIRE', hintX, hintY);
      ctx.restore();
      return;
    }
    const m = Math.hypot(s.vx, s.vy);
    const firing = kind === 'aim' && m > fireZone;
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(s.ox, s.oy, radius, 0, TAU); ctx.fill(); ctx.stroke();
    if (kind === 'aim') {
      ctx.setLineDash([5, 6]);
      ctx.strokeStyle = 'rgba(255,120,120,0.45)';
      ctx.beginPath(); ctx.arc(s.ox, s.oy, radius * fireZone, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
    }
    const kx = s.ox + Math.max(-1, Math.min(1, s.vx)) * radius;
    const ky = s.oy + Math.max(-1, Math.min(1, s.vy)) * radius;
    ctx.fillStyle = firing ? 'rgba(255,90,110,0.65)' : 'rgba(255,255,255,0.4)';
    ctx.beginPath(); ctx.arc(kx, ky, radius * 0.42, 0, TAU); ctx.fill();
    ctx.restore();
  }

  /**
   * Draw one frame.
   * view = { players, bullets, myId, crosshair:{x,y}|null, sticks|null, stickRadius, fireZone, labels }
   */
  function draw(view, dt) {
    time += dt;
    updateEffects(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0d18';
    ctx.fillRect(0, 0, W, H);

    const sx = shake ? (Math.random() * 2 - 1) * shake : 0;
    const sy = shake ? (Math.random() * 2 - 1) * shake : 0;
    const k = dpr * scale;
    ctx.setTransform(k, 0, 0, k, dpr * ox + sx * k, dpr * oy + sy * k);
    if (arena) ctx.drawImage(arena, 0, 0, AW, AH);

    const colorOf = new Map();
    for (const p of view.players) colorOf.set(p.id, p.color);
    const getColor = (id) => colorOf.get(id) || '#ffffff';

    for (const m of marks.values()) drawMark(m);
    if (view.bullets.length) drawBullets(view.bullets, getColor);

    const alive = view.players.filter((p) => p.alive);
    alive.sort((a, b) => a.y - b.y);
    const me = alive.find((p) => p.id === view.myId);
    if (me && view.aimLine) drawAimLine(me);
    for (const p of alive) drawPlayer(p, p.id === view.myId);
    drawParticles();
    if (view.labels !== false) for (const p of alive) drawLabel(p, p.id === view.myId);

    // screen-space overlays
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (view.sticks) {
      const r = view.stickRadius;
      drawStick(view.sticks.left, r + 24, H - r - 24, r, 'move', view.fireZone);
      drawStick(view.sticks.right, W - r - 24, H - r - 24, r, 'aim', view.fireZone);
    }
    if (view.crosshair) drawCrosshair(view.crosshair.x, view.crosshair.y, me ? me.color : null);
  }

  return {
    resize,
    setTopInset,
    setCalm(on) { calm = !!on; if (calm) shake = 0; },
    draw,
    fx,
    worldToScreen: (x, y) => ({ x: ox + x * scale, y: oy + y * scale }),
    screenToWorld: (x, y) => ({ x: (x - ox) / scale, y: (y - oy) / scale }),
    get scale() { return scale; },
  };
}

// ---------------------------------------------------------------------------
// HUD (DOM overlay: crisp text at any size)
// ---------------------------------------------------------------------------
const HEART_SVG = '<svg viewBox="0 0 24 22" aria-hidden="true"><path d="M12 21.2 2.6 12.4A6 6 0 0 1 12 4.7a6 6 0 0 1 9.4 7.7z"/></svg>';

export function createHud() {
  const $ = (id) => document.getElementById(id);
  const root = $('hud');
  const heartsEl = $('hud-hearts');
  const pipsEl = $('hud-pips');
  const ringEl = $('hud-reload');
  const timerEl = $('hud-timer');
  const boardEl = $('hud-board');
  const pingEl = $('hud-ping');
  const dotEl = $('hud-dot');
  const feedEl = $('killfeed');
  const bannerEl = $('banner');
  const specEl = $('spectate');

  heartsEl.innerHTML = Array.from({ length: C.LIVES }, () => `<span class="heart">${HEART_SVG}</span>`).join('');
  pipsEl.innerHTML = Array.from({ length: C.MAG_SIZE }, () => '<span class="pip"></span>').join('');
  const hearts = [...heartsEl.children];
  const pips = [...pipsEl.children];
  let last = {};
  let boardKey = '';
  let boardRows = new Map();
  let bannerTimer = null;

  function setRoster(players) {
    const key = players.map((p) => `${p.id}:${p.name}:${p.color}:${p.slot}`).join('|');
    if (key === boardKey) return;
    boardKey = key;
    boardEl.textContent = '';
    boardRows = new Map();
    for (const p of players) {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.style.setProperty('--c', p.color);
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = String(p.slot + 1);
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = p.name;
      const hp = document.createElement('span');
      hp.className = 'hp';
      hp.innerHTML = HEART_SVG;
      const n = document.createElement('b');
      hp.appendChild(n);
      chip.append(badge, nm, hp);
      boardEl.appendChild(chip);
      boardRows.set(p.id, { chip, n, lives: -1, alive: null });
    }
  }

  function fmtTime(t) {
    const s = Math.max(0, Math.ceil(t));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  /**
   * m = { me:{lives, ammo, reloadFrac, alive}|null, timeLeft, players:[...], ping:{text, level},
   *       spectating: string|null, myId }
   */
  function update(m) {
    const lives = m.me ? m.me.lives : -1;
    if (lives !== last.lives) {
      hearts.forEach((h, i) => h.classList.toggle('lost', i >= lives));
      if (last.lives !== undefined && lives < last.lives) { heartsEl.classList.remove('bump'); void heartsEl.offsetWidth; heartsEl.classList.add('bump'); }
      heartsEl.classList.toggle('hidden', lives < 0);
      last.lives = lives;
    }
    const ammo = m.me ? m.me.ammo : -1;
    if (ammo !== last.ammo) {
      pips.forEach((p, i) => p.classList.toggle('empty', i >= ammo));
      last.ammo = ammo;
    }
    const reloading = !!(m.me && m.me.reloadFrac !== null && m.me.reloadFrac !== undefined);
    if (reloading !== last.reloading) { ringEl.classList.toggle('active', reloading); last.reloading = reloading; }
    if (reloading) ringEl.style.setProperty('--p', String(Math.max(0, Math.min(1, m.me.reloadFrac))));
    const ammoVisible = !!m.me && m.me.alive;
    if (ammoVisible !== last.ammoVisible) { pipsEl.parentElement.classList.toggle('hidden', !ammoVisible); last.ammoVisible = ammoVisible; }

    const tt = fmtTime(m.timeLeft);
    if (tt !== last.time) { timerEl.textContent = tt; last.time = tt; }
    const low = m.timeLeft <= 10.5 && m.timeLeft > 0;
    if (low !== last.low) { timerEl.classList.toggle('low', low); last.low = low; }

    setRoster(m.players);
    for (const p of m.players) {
      const row = boardRows.get(p.id);
      if (!row) continue;
      if (row.lives !== p.lives) { row.n.textContent = String(p.lives); row.lives = p.lives; }
      const out = !p.alive;
      if (row.alive !== !out) { row.chip.classList.toggle('out', out); row.alive = !out; }
      const isMe = p.id === m.myId;
      if (row.isMe !== isMe) { row.chip.classList.toggle('me', isMe); row.isMe = isMe; }
    }

    const pingText = m.ping ? m.ping.text : '';
    if (pingText !== last.ping) { pingEl.textContent = pingText; last.ping = pingText; }
    const lvl = m.ping ? m.ping.level : 'off';
    if (lvl !== last.lvl) { dotEl.className = 'dot ' + lvl; last.lvl = lvl; }

    const spec = m.spectating || '';
    if (spec !== last.spec) {
      specEl.textContent = spec;
      specEl.classList.toggle('hidden', !spec);
      last.spec = spec;
    }
  }

  function feed(parts) {
    const item = document.createElement('div');
    item.className = 'feed-item';
    for (const part of parts) {
      if (part.color) {
        const b = document.createElement('b');
        b.textContent = part.text;
        b.style.color = part.color;
        item.appendChild(b);
      } else {
        item.appendChild(document.createTextNode(part.text));
      }
    }
    feedEl.prepend(item);
    while (feedEl.children.length > 5) feedEl.lastChild.remove();
    setTimeout(() => item.classList.add('fade'), 3800);
    setTimeout(() => item.remove(), 4500);
  }

  function banner(text, { cls = '', ms = 900 } = {}) {
    clearTimeout(bannerTimer);
    bannerEl.className = 'banner';
    bannerEl.textContent = text;
    void bannerEl.offsetWidth; // restart the animation
    bannerEl.className = `banner show ${cls}`;
    if (ms > 0) bannerTimer = setTimeout(() => { bannerEl.className = 'banner'; }, ms);
  }

  return {
    show(on) {
      root.classList.toggle('hidden', !on);
      if (!on) { feedEl.textContent = ''; specEl.classList.add('hidden'); last.spec = ''; bannerEl.className = 'banner'; }
    },
    get height() { return root.classList.contains('hidden') ? 0 : root.getBoundingClientRect().height; },
    update,
    setRoster,
    feed,
    banner,
    reset() { last = {}; boardKey = ''; },
  };
}
