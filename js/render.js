// Room Showdown: canvas rendering (arena, characters, bullets, effects) and the DOM HUD.
// Everything is drawn with shapes and gradients: no image files.

import { CONFIG } from './config.js';

const C = CONFIG;
const R = C.PLAYER_RADIUS;
const GUN_SCALE = 0.8; // the pistol art is drawn at this scale around its center
const MIN_FOLLOW_SCALE = 0.62; // closest zoom-out while the camera follows you
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
      grip: rgb(mixRgb(base, [0, 0, 0], 0.35)),
      shine: rgb(mixRgb(base, [255, 255, 255], 0.35)),
      grooves: rgb(mixRgb(base, [0, 0, 0], 0.3)),
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
  // Camera: world point at the center of the play area, smoothed between frames.
  const cam = { x: 0, y: 0, s: 1, arena: null, focus: false };
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
    cam.arena = null; // re-center instantly
  }

  function setTopInset(px) {
    topInset = Math.round(px);
  }

  /**
   * Follow `focus` (the local player) with the camera, or show the whole arena when
   * there is no focus (spectating, menu demo). Never shows outside the arena when the
   * arena is bigger than the screen.
   */
  function updateCamera(arena, focus, dt) {
    const availH = Math.max(1, H - topInset);
    // Following: show at most VIEW_W x VIEW_H, but zoom in on small screens so the guns stay
    // big enough to read on a phone. Overview: the whole arena.
    const s = focus
      ? Math.max(MIN_FOLLOW_SCALE, Math.min(W / Math.min(arena.w, C.VIEW_W), availH / Math.min(arena.h, C.VIEW_H)))
      : Math.min(W / arena.w, availH / arena.h);
    const visW = W / s, visH = availH / s;
    // While following, the camera may look a little past the walls, and further below the
    // floor: a gun resting on the floor then has room under it to aim down (= jump) with a mouse.
    const padX = focus ? 60 : 0, padTop = focus ? 60 : 0, padBottom = focus ? Math.min(240, visH * 0.3) : 0;
    const fitX = (v, vis) => (vis >= arena.w + 2 * padX ? arena.w / 2 : Math.max(vis / 2 - padX, Math.min(arena.w + padX - vis / 2, v)));
    const fitY = (v, vis) => (vis >= arena.h + padTop + padBottom ? (arena.h + padBottom - padTop) / 2 : Math.max(vis / 2 - padTop, Math.min(arena.h + padBottom - vis / 2, v)));
    const tx = fitX(focus ? focus.x : arena.w / 2, visW);
    const ty = fitY(focus ? focus.y : arena.h / 2, visH);
    if (cam.arena !== arena || cam.focus !== !!focus) {
      // New arena or switching between follow and overview: glide the zoom, jump otherwise.
      if (cam.arena !== arena) { cam.x = tx; cam.y = ty; cam.s = s; }
      cam.arena = arena;
      cam.focus = !!focus;
    }
    const k = 1 - Math.exp(-dt * 9);
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;
    cam.s += (s - cam.s) * (1 - Math.exp(-dt * 5));
    // Re-clamp with the smoothed zoom so the edges never show the void.
    cam.x = fitX(cam.x, W / cam.s);
    cam.y = fitY(cam.y, availH / cam.s);
    scale = cam.s;
    ox = W / 2 - cam.x * scale;
    oy = topInset + availH / 2 - cam.y * scale;
  }

  // Side-view room: back wall with a faint grid, solid border, floating platforms and crates.
  function drawArena(arena) {
    const AW = arena.w, AH = arena.h, t = C.WALL;
    const bg = ctx.createLinearGradient(0, 0, 0, AH);
    bg.addColorStop(0, '#141a2e');
    bg.addColorStop(1, '#1d243a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, AW, AH);
    // grid lines only where the camera looks
    const x0 = Math.max(0, Math.floor(-ox / scale / 50) * 50), x1 = Math.min(AW, (W - ox) / scale);
    const y0 = Math.max(0, Math.floor((topInset - oy) / scale / 50) * 50), y1 = Math.min(AH, (H - oy) / scale);
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = x0; x <= x1; x += 50) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    for (let y = y0; y <= y1; y += 50) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke();
    // big soft "spotlight" so the middle reads as the stage
    const vg = ctx.createRadialGradient(AW / 2, AH * 0.55, 100, AW / 2, AH * 0.55, Math.max(AW, AH) * 0.75);
    vg.addColorStop(0, 'rgba(255,190,90,0.05)');
    vg.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, AW, AH);

    for (const o of arena.solids) {
      if (o.wall) continue;
      if (o.kind === 'platform') {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        roundRectPath(ctx, o.x + 4, o.y + 8, o.w, o.h, 6); ctx.fill();
        const gr = ctx.createLinearGradient(0, o.y, 0, o.y + o.h);
        gr.addColorStop(0, '#6a77a8');
        gr.addColorStop(1, '#3b4468');
        ctx.fillStyle = gr;
        roundRectPath(ctx, o.x, o.y, o.w, o.h, 6); ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = '#11152a'; ctx.stroke();
        ctx.fillStyle = 'rgba(255,200,80,0.55)'; // landing edge
        ctx.fillRect(o.x + 6, o.y + 3, o.w - 12, 3);
      } else {
        // crate
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        roundRectPath(ctx, o.x + 5, o.y + 6, o.w, o.h, 6); ctx.fill();
        ctx.fillStyle = '#4b5784';
        roundRectPath(ctx, o.x, o.y, o.w, o.h, 6); ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = '#11152a'; ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(o.x + 10, o.y + 10); ctx.lineTo(o.x + o.w - 10, o.y + o.h - 10);
        ctx.moveTo(o.x + o.w - 10, o.y + 10); ctx.lineTo(o.x + 10, o.y + o.h - 10); ctx.stroke();
      }
    }
    // ground below the floor (visible when the camera looks under it)
    ctx.fillStyle = '#121729';
    ctx.fillRect(-400, AH, AW + 800, 600);
    ctx.fillRect(-400, -600, AW + 800, 600);
    ctx.fillRect(-400, 0, 400, AH);
    ctx.fillRect(AW, 0, 400, AH);
    // border walls
    ctx.fillStyle = '#2a3150';
    ctx.fillRect(0, 0, AW, t); ctx.fillRect(0, AH - t, AW, t); ctx.fillRect(0, 0, t, AH); ctx.fillRect(AW - t, 0, t, AH);
    ctx.strokeStyle = '#4b578a';
    ctx.lineWidth = 3;
    ctx.strokeRect(t - 1.5, t - 1.5, AW - 2 * t + 3, AH - 2 * t + 3);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, AH - t, AW, t); ctx.rect(0, 0, AW, t);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,200,80,0.12)';
    ctx.lineWidth = 10;
    ctx.beginPath();
    for (let x = Math.floor(x0 / 46) * 46 - 60; x < x1 + 60; x += 46) {
      ctx.moveTo(x, AH - t - 10); ctx.lineTo(x + 40, AH + 20);
      ctx.moveTo(x, -10); ctx.lineTo(x + 40, t + 20);
    }
    ctx.stroke();
    ctx.restore();
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

  // The player IS a cartoon pistol (design "Classic Pistol"). Art coordinates: the barrel
  // points to +x, the grip hangs down; (8, 2) is the center of the hit circle.
  function drawPlayer(p, isMe) {
    const col = colorInfo(p.color);
    ctx.save();
    ctx.translate(p.x, p.y);
    if (isMe) {
      ctx.strokeStyle = col.rgba(0.8);
      ctx.lineWidth = 3;
      ctx.setLineDash([7, 6]);
      ctx.lineDashOffset = -time * 24;
      ctx.beginPath(); ctx.arc(0, 0, R + 14, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
    }
    const invuln = p.invuln > 0;
    if (invuln && Math.floor(time * 14) % 2 === 0) ctx.globalAlpha = 0.35;

    ctx.rotate(p.aim);
    if (Math.cos(p.aim) < 0) ctx.scale(1, -1); // keep the grip below the barrel when facing left
    ctx.scale(GUN_SCALE, GUN_SCALE);
    ctx.translate(-8, -2);
    ctx.lineJoin = 'round';
    const outline = (fill, lw = 3) => { ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = lw; ctx.strokeStyle = INK; ctx.stroke(); };
    // grip
    ctx.save(); ctx.translate(-14, 6); ctx.rotate(0.22);
    roundRectPath(ctx, -9, 0, 20, 32, 6); outline(col.grip);
    ctx.restore();
    // trigger guard
    ctx.beginPath(); ctx.arc(6, 12, 8, 0, Math.PI); ctx.lineWidth = 4; ctx.strokeStyle = INK; ctx.stroke();
    // slide
    roundRectPath(ctx, -28, -14, 62, 22, 6); outline(col.base);
    ctx.fillStyle = col.shine; ctx.fillRect(-22, -10, 48, 4);
    ctx.fillStyle = col.grooves;
    for (let i = 0; i < 4; i++) ctx.fillRect(-22 + i * 5, -2, 2.5, 7);
    // barrel tip
    roundRectPath(ctx, 32, -10, 10, 13, 3); outline('#2a3150');
    if (invuln) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2;
      roundRectPath(ctx, -32, -18, 70, 30, 9); ctx.stroke();
    }
    // muzzle flash
    const fl = flashes.get(p.id);
    if (fl && fl > time) {
      const k = (fl - time) / 0.07;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,220,120,${0.95 * k})`;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * TAU, rr = i % 2 ? 7 : 19 * (0.7 + 0.3 * k);
        ctx.lineTo(52 + Math.cos(a) * rr, -3.5 + Math.sin(a) * rr * 0.75);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${k})`;
      ctx.beginPath(); ctx.arc(48, -3.5, 6, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    // number badge on the grip, text kept upright
    ctx.beginPath(); ctx.arc(-12, 24, 8, 0, TAU); outline('#ffffff', 2.5);
    const m = ctx.getTransform();
    const bx = m.a * -12 + m.c * 24 + m.e, by = m.b * -12 + m.d * 24 + m.f;
    const ks = Math.hypot(m.a, m.b);
    ctx.setTransform(ks, 0, 0, ks, bx, by);
    ctx.fillStyle = INK;
    ctx.font = '800 10.5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.slot + 1), 0, 1);
    ctx.restore();
  }

  // Arrows at the screen edge pointing to players the camera cannot see.
  function drawOffscreen(players, myId) {
    const pad = 22, top = topInset + pad;
    for (const p of players) {
      if (p.id === myId) continue;
      const sx = ox + p.x * scale, sy = oy + p.y * scale;
      if (sx >= 0 && sx <= W && sy >= topInset && sy <= H) continue;
      const cx = Math.max(pad, Math.min(W - pad, sx));
      const cy = Math.max(top, Math.min(H - pad, sy));
      const a = Math.atan2(sy - cy, sx - cx);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(a);
      ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-6, -10); ctx.lineTo(-6, 10); ctx.closePath();
      ctx.fillStyle = p.color; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = INK; ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#ffffff';
      ctx.font = '800 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lx = cx - Math.cos(a) * 16, ly = cy - Math.sin(a) * 16;
      ctx.lineWidth = 3; ctx.strokeStyle = INK; ctx.strokeText(String(p.slot + 1), lx, ly);
      ctx.fillText(String(p.slot + 1), lx, ly);
    }
  }

  function drawLabel(p, isMe) {
    const small = scale < 0.62;
    const fontPx = small ? 11 : 13;
    const heartPx = small ? 7 : 9;
    const f = fontPx / scale, hs = heartPx / scale;
    const baseY = p.y - R - 12 - 7 / scale;
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
    ctx.moveTo(p.x + ca * (C.MUZZLE_OFFSET + 14), p.y + sa * (C.MUZZLE_OFFSET + 14));
    ctx.lineTo(p.x + ca * 170, p.y + sa * 170);
    // recoil hint: a short arrow the other way shows where the shot will push you
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.beginPath();
    ctx.moveTo(p.x - ca * (R + 10), p.y - sa * (R + 10));
    ctx.lineTo(p.x - ca * (R + 34), p.y - sa * (R + 34));
    ctx.stroke();
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
      ctx.fillText(kind === 'move' ? 'AIM' : 'AIM + FIRE', hintX, hintY);
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
   * view = { arena, focus:{x,y}|null, players, bullets, myId, crosshair:{x,y}|null,
   *          sticks|null, stickRadius, fireZone, labels }
   */
  function draw(view, dt) {
    time += dt;
    updateEffects(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0d18';
    ctx.fillRect(0, 0, W, H);
    if (!view.arena) return;
    updateCamera(view.arena, view.focus || null, dt);

    const sx = shake ? (Math.random() * 2 - 1) * shake : 0;
    const sy = shake ? (Math.random() * 2 - 1) * shake : 0;
    const k = dpr * scale;
    ctx.setTransform(k, 0, 0, k, dpr * ox + sx * k, dpr * oy + sy * k);
    drawArena(view.arena);

    const colorOf = new Map();
    for (const p of view.players) colorOf.set(p.id, p.color);
    const getColor = (id) => colorOf.get(id) || '#ffffff';

    for (const m of marks.values()) drawMark(m);
    if (view.bullets.length) drawBullets(view.bullets, getColor);

    const alive = view.players.filter((p) => p.alive);
    const me = alive.find((p) => p.id === view.myId);
    if (me && view.aimLine) drawAimLine(me);
    for (const p of alive) drawPlayer(p, p.id === view.myId);
    drawParticles();
    if (view.labels !== false) for (const p of alive) drawLabel(p, p.id === view.myId);

    // screen-space overlays
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (view.focus) drawOffscreen(alive, view.myId);
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
