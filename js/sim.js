// Room Showdown: PURE game simulation (side view with gravity).
// Every player is a pistol. Gravity pulls everyone down, and the only way to move is the
// recoil of your own shots: shoot at the floor to fly up, shoot sideways to dash.
// No DOM, no network and no Math.random(), so the exact same code runs on the host,
// in Practice mode, on clients (for movement prediction) and headlessly in Node tests.

import { CONFIG } from './config.js';

const C = CONFIG;
export const DT = 1 / C.TICK_RATE;
const EPS = 1e-6;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
export const r1 = (v) => Math.round(v * 10) / 10;
export const r2 = (v) => Math.round(v * 100) / 100;
export const r3 = (v) => Math.round(v * 1000) / 1000;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

// Mulberry32: tiny, fast, seedable pseudo random generator.
export function makeRng(seed = 1) {
  let s = seed >>> 0;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (lo, hi) => lo + (hi - lo) * rng();
  rng.int = (n) => Math.floor(rng() * n);
  return rng;
}

// ---------------------------------------------------------------------------
// Arena geometry (depends only on the number of players, so every peer builds the same one)
// ---------------------------------------------------------------------------
export function arenaSize(n) {
  const k = clamp(Math.round(n) || 2, 2, C.MAX_PLAYERS) - 2;
  return { w: C.ARENA_BASE_W + k * C.ARENA_GROW_W, h: C.ARENA_BASE_H + k * C.ARENA_GROW_H };
}

/**
 * Build the arena for `n` players: border walls, mirror-symmetric floating platforms,
 * a few low crates on the floor for cover, and spread-out spawn points.
 */
export function buildArena(n) {
  const { w: W, h: H } = arenaSize(n);
  const T = C.WALL, R = C.PLAYER_RADIUS;
  const cx = W / 2;
  const solids = [
    { x: 0, y: H - T, w: W, h: T, wall: true }, // floor
    { x: 0, y: 0, w: W, h: T, wall: true },     // ceiling
    { x: 0, y: 0, w: T, h: H, wall: true },
    { x: W - T, y: 0, w: T, h: H, wall: true },
  ];
  const S = C.PLATFORM_SPACING, PW = C.PLATFORM_W, PH = C.PLATFORM_H;
  const minX = T + 60, maxX = W - T - 60;
  const add = (x, y, w, h, kind) => {
    if (x < minX || x + w > maxX) return;
    solids.push({ x: r1(x), y: r1(y), w, h, wall: false, kind });
  };
  // Platform rows from the floor upwards. Odd rows are shifted by half a spacing.
  let row = 0;
  for (let y = H - T - C.PLATFORM_ROW_GAP; y > T + 170; y -= C.PLATFORM_ROW_GAP, row++) {
    const centers = [];
    if (row % 2 === 0) {
      centers.push(cx);
      for (let k = 1; cx + k * S + PW / 2 <= maxX; k++) centers.push(cx - k * S, cx + k * S);
    } else {
      for (let k = 0; cx + (k + 0.5) * S + PW / 2 <= maxX; k++) centers.push(cx - (k + 0.5) * S, cx + (k + 0.5) * S);
    }
    for (const c of centers) add(c - PW / 2, y, PW, PH, 'platform');
  }
  // Low crates on the floor between the first-row platforms.
  for (let k = 0; cx + (k + 0.5) * S + 40 <= maxX; k += 2) {
    for (const c of [cx - (k + 0.5) * S, cx + (k + 0.5) * S]) add(c - 32, H - T - 64, 64, 64, 'crate');
  }
  return { n, w: W, h: H, solids, spawns: buildSpawns(W, H, n, solids) };

  function buildSpawns(w, h, count, sol) {
    const c = clamp(count, 1, C.MAX_PLAYERS);
    const margin = T + 140;
    const xs = [];
    for (let i = 0; i < c; i++) xs.push(c === 1 ? w / 2 : margin + ((w - 2 * margin) * i) / (c - 1));
    // Join order alternates between the ends so early joiners are far apart: 0, last, 1, last-1 ...
    const order = [];
    for (let lo = 0, hi = c - 1; lo <= hi; lo++, hi--) { order.push(lo); if (hi !== lo) order.push(hi); }
    return order.map((j) => {
      const x = r1(xs[j]);
      let y = r1(h * 0.42);
      while (y > T + R + 10 && circleBlocked(x, y, R + 12, sol)) y -= 10;
      return { x, y, aim: x <= w / 2 ? 0 : Math.PI };
    });
  }
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------
export function circleHitsRect(x, y, r, s) {
  const cx = clamp(x, s.x, s.x + s.w), cy = clamp(y, s.y, s.y + s.h);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy < r * r;
}

export function circleBlocked(x, y, r, solids) {
  for (let i = 0; i < solids.length; i++) if (circleHitsRect(x, y, r, solids[i])) return true;
  return false;
}

// Push a circle out of every rectangle it overlaps (minimum translation).
// `skip(s)` may exclude some rectangles (one-way platforms).
export function resolveCircle(pos, r, arena, skip = null) {
  const solids = arena.solids;
  for (let iter = 0; iter < 4; iter++) {
    let pushed = false;
    for (let i = 0; i < solids.length; i++) {
      const s = solids[i];
      if (skip && skip(s)) continue;
      const cx = clamp(pos.x, s.x, s.x + s.w), cy = clamp(pos.y, s.y, s.y + s.h);
      const dx = pos.x - cx, dy = pos.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      pushed = true;
      if (d2 > 1e-12) {
        const d = Math.sqrt(d2), k = (r - d) / d;
        pos.x += dx * k;
        pos.y += dy * k;
      } else {
        // Center is inside the rectangle: leave through the nearest side.
        const left = pos.x - s.x, right = s.x + s.w - pos.x;
        const top = pos.y - s.y, bottom = s.y + s.h - pos.y;
        const m = Math.min(left, right, top, bottom);
        if (m === left) pos.x = s.x - r;
        else if (m === right) pos.x = s.x + s.w + r;
        else if (m === top) pos.y = s.y - r;
        else pos.y = s.y + s.h + r;
      }
    }
    if (!pushed) break;
  }
  // Final safety clamp inside the border walls.
  pos.x = clamp(pos.x, C.WALL + r, arena.w - C.WALL - r);
  pos.y = clamp(pos.y, C.WALL + r, arena.h - C.WALL - r);
}

// ---------------------------------------------------------------------------
// Physics body: gravity, drag, collisions with bounce, recoil
// ---------------------------------------------------------------------------
/** Apply one shot's recoil: a kick opposite to `aim`, after cancelling part of the speed against it. */
export function applyRecoil(b, aim) {
  const dx = -Math.cos(aim), dy = -Math.sin(aim);
  const along = b.vx * dx + b.vy * dy;
  if (along < 0) { b.vx -= along * C.RECOIL_CANCEL * dx; b.vy -= along * C.RECOIL_CANCEL * dy; }
  b.vx += dx * C.RECOIL;
  b.vy += dy * C.RECOIL;
  limitSpeed(b);
}

function limitSpeed(b) {
  const sp = Math.hypot(b.vx, b.vy);
  if (sp > C.MAX_SPEED) { const k = C.MAX_SPEED / sp; b.vx *= k; b.vy *= k; }
}

/**
 * Advance a body {x, y, vx, vy} by dt: gravity, drag, movement with collisions.
 * Hitting a surface removes the speed into it (keeping a small bounce). Sets b.grounded.
 * Used by the authority and by client prediction, so both move exactly the same way.
 */
export function stepBody(b, dt, arena) {
  const R = C.PLAYER_RADIUS;
  b.vy += C.GRAVITY * dt;
  const drag = Math.exp(-C.AIR_DRAG * dt);
  b.vx *= drag;
  b.vy *= drag;
  limitSpeed(b);
  let grounded = false;
  const dist = Math.hypot(b.vx, b.vy) * dt;
  const steps = Math.max(1, Math.ceil(dist / (R * 0.5)));
  const sx = (b.vx * dt) / steps, sy = (b.vy * dt) / steps;
  // Platforms are one-way: you fly up through them and land on top of them.
  let footY = 0, rising = false;
  const skip = (s) => s.kind === 'platform' && (rising || footY > s.y + 0.5);
  for (let i = 0; i < steps; i++) {
    footY = b.y + R;
    rising = b.vy < 0;
    const bx = b.x + sx, by = b.y + sy;
    b.x = bx; b.y = by;
    resolveCircle(b, R, arena, skip);
    let nx = b.x - bx, ny = b.y - by;
    const l = Math.hypot(nx, ny);
    if (l > 1e-9) {
      nx /= l; ny /= l;
      const vn = b.vx * nx + b.vy * ny; // negative = moving into the surface
      if (vn < 0) {
        const keep = -vn > 160 ? C.BOUNCE : 0; // small impacts just stop (no endless jitter)
        b.vx -= (1 + keep) * vn * nx;
        b.vy -= (1 + keep) * vn * ny;
      }
      if (ny < -0.6) grounded = true;
    }
  }
  if (!grounded) {
    // Resting exactly on a surface produces no push: probe 1 px below.
    footY = b.y + R;
    rising = false;
    if (b.vy >= 0) for (const s of arena.solids) {
      if (!skip(s) && circleHitsRect(b.x, b.y + 1.5, R, s)) { grounded = true; break; }
    }
  }
  if (grounded) {
    const f = Math.exp(-C.GROUND_FRICTION * dt);
    b.vx *= f;
    if (Math.abs(b.vx) < 2) b.vx = 0;
  }
  b.grounded = grounded;
}

// Segment vs. axis-aligned rectangle grown by `pad`. Returns entry time t in [0,1] or -1.
export function segmentRectT(x0, y0, x1, y1, s, pad = 0) {
  const minX = s.x - pad, minY = s.y - pad, maxX = s.x + s.w + pad, maxY = s.y + s.h + pad;
  const dx = x1 - x0, dy = y1 - y0;
  let tmin = 0, tmax = 1;
  if (Math.abs(dx) < 1e-12) {
    if (x0 < minX || x0 > maxX) return -1;
  } else {
    let t1 = (minX - x0) / dx, t2 = (maxX - x0) / dx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (Math.abs(dy) < 1e-12) {
    if (y0 < minY || y0 > maxY) return -1;
  } else {
    let t1 = (minY - y0) / dy, t2 = (maxY - y0) / dy;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

// Segment vs. circle. Returns the first time t in [0,1] the segment is within R, or -1.
export function segmentCircleT(x0, y0, x1, y1, cx, cy, R) {
  const fx = x0 - cx, fy = y0 - cy;
  const c = fx * fx + fy * fy - R * R;
  if (c <= 0) return 0; // starts inside
  const dx = x1 - x0, dy = y1 - y0;
  const a = dx * dx + dy * dy;
  if (a < 1e-12) return -1;
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : -1;
}

// Earliest time a (padded) segment touches any solid, or -1 if the path is clear.
export function segmentSolidsT(x0, y0, x1, y1, pad, solids) {
  let best = -1;
  for (let i = 0; i < solids.length; i++) {
    const t = segmentRectT(x0, y0, x1, y1, solids[i], pad);
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Match state
// ---------------------------------------------------------------------------
function makePlayer(r, spawn) {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    slot: r.slot,
    x: spawn.x, y: spawn.y, px: spawn.x, py: spawn.y,
    vx: 0, vy: 0, grounded: false,
    aim: spawn.aim,
    lives: C.LIVES,
    cooldown: 0, // seconds until the pistol can fire again (bullets are unlimited)
    invuln: 0,   // seconds of invulnerability remaining
    alive: true,
    left: false, // disconnected
    hits: 0,
    shots: 0,
    elimTick: -1,
    killedBy: null,
    input: { aim: spawn.aim, fire: false },
    fireLatch: false,   // a short tap between two ticks still fires
  };
}

/**
 * Create a new match.
 * @param {Array<{id:number,name:string,color:string,slot:number}>} roster players in join order
 * @param {{skipCountdown?:boolean, matchTime?:number}} [opts]
 */
export function createMatch(roster, opts = {}) {
  if (!Array.isArray(roster) || roster.length === 0) throw new Error('createMatch: empty roster');
  const list = roster.slice(0, C.MAX_PLAYERS);
  const arena = buildArena(list.length);
  const players = list.map((r, i) => makePlayer(r, arena.spawns[i]));
  const skip = !!opts.skipCountdown;
  return {
    arena,
    tick: 0,
    phase: skip ? 'playing' : 'countdown', // countdown -> playing -> ended
    countdown: skip ? 0 : C.COUNTDOWN,
    lastCount: Math.ceil(C.COUNTDOWN) + 1,
    timeLeft: opts.matchTime ?? C.MATCH_TIME,
    players,
    bullets: [],
    events: [], // produced by step(); the caller reads and clears them
    nextBulletId: 1,
    result: null,
  };
}

export function getPlayer(state, id) {
  const P = state.players;
  for (let i = 0; i < P.length; i++) if (P[i].id === id) return P[i];
  return null;
}

function emit(state, ev) {
  ev.tick = state.tick;
  state.events.push(ev);
}

/** Validate and clamp an untrusted input object. Never trust what a client sends. */
export function sanitizeInput(inp, prev) {
  // There is no movement input: players only move through recoil, which the host computes.
  const out = { aim: prev && Number.isFinite(prev.aim) ? prev.aim : 0, fire: false };
  if (!inp || typeof inp !== 'object') return out;
  const aim = Number(inp.aim);
  if (Number.isFinite(aim) && Math.abs(aim) < 1e6) out.aim = wrapAngle(aim);
  out.fire = inp.fire === true || inp.fire === 1;
  return out;
}

export function setInput(state, id, input) {
  const p = getPlayer(state, id);
  if (!p || p.left) return;
  const inp = sanitizeInput(input, p.input);
  p.input = inp;
  if (inp.fire) p.fireLatch = true;
}

/** A player disconnected: their character is eliminated. */
export function removePlayer(state, id) {
  const p = getPlayer(state, id);
  if (!p || p.left) return;
  p.left = true;
  p.input = { aim: p.aim, fire: false };
  p.fireLatch = false;
  if (p.alive && state.phase !== 'ended') eliminate(state, p, null, 'left');
}

// ---------------------------------------------------------------------------
// The fixed-timestep update
// ---------------------------------------------------------------------------
export function step(state, dt = DT) {
  state.tick++;
  const P = state.players;
  for (const p of P) { p.px = p.x; p.py = p.y; }
  for (const b of state.bullets) { b.px = b.x; b.py = b.y; }
  if (state.phase === 'ended') return state;

  if (state.phase === 'countdown') {
    state.countdown = Math.max(0, state.countdown - dt);
    for (const p of P) {
      if (p.alive) p.aim = p.input.aim; // aiming is allowed, moving and shooting are not
      p.fireLatch = false;
    }
    const n = Math.ceil(state.countdown - 1e-9);
    if (n >= 1 && n < state.lastCount) {
      state.lastCount = n;
      emit(state, { type: 'count', n });
    }
    if (state.countdown <= 1e-9) {
      state.countdown = 0;
      state.phase = 'playing';
      emit(state, { type: 'go' });
    }
    return state;
  }

  state.timeLeft = Math.max(0, state.timeLeft - dt);
  for (const p of P) if (p.alive) updatePlayer(state, p, dt);
  updateBullets(state, dt);
  checkEnd(state);
  return state;
}

function updatePlayer(state, p, dt) {
  const inp = p.input;
  p.aim = inp.aim;
  if (p.invuln > 0) { p.invuln -= dt; if (p.invuln < EPS) p.invuln = 0; }
  if (p.cooldown > 0) { p.cooldown -= dt; if (p.cooldown < EPS) p.cooldown = 0; }

  // Fire (unlimited bullets; a tap between two ticks still fires, holding keeps firing)
  if ((inp.fire || p.fireLatch) && p.cooldown <= EPS) fireBullet(state, p);
  p.fireLatch = false;

  // Gravity + movement (the shot above may just have kicked us)
  stepBody(p, dt, state.arena);
}

function fireBullet(state, p) {
  const cos = Math.cos(p.aim), sin = Math.sin(p.aim);
  const mx = p.x + cos * C.MUZZLE_OFFSET, my = p.y + sin * C.MUZZLE_OFFSET;
  p.cooldown = C.FIRE_COOLDOWN;
  p.shots++;
  applyRecoil(p, p.aim);
  const b = {
    id: state.nextBulletId++,
    owner: p.id,
    x: p.x, y: p.y, px: p.x, py: p.y,
    vx: cos * C.BULLET_SPEED, vy: sin * C.BULLET_SPEED,
    life: C.BULLET_LIFETIME,
  };
  emit(state, { type: 'shot', id: p.id, b: b.id, x: r1(mx), y: r1(my), a: r2(p.aim) });
  // The bullet travels from the body to the gun tip first, so point-blank shots and
  // shots into a wall you are hugging are handled correctly.
  if (traceBullet(state, b, p.x, p.y, mx, my)) return;
  b.x = b.px = mx;
  b.y = b.py = my;
  state.bullets.push(b);
}

function updateBullets(state, dt) {
  const keep = [];
  for (const b of state.bullets) {
    b.life -= dt;
    const nx = b.x + b.vx * dt, ny = b.y + b.vy * dt;
    if (traceBullet(state, b, b.x, b.y, nx, ny)) continue; // hit something
    b.x = nx;
    b.y = ny;
    if (b.life <= EPS) continue; // out of range
    keep.push(b);
  }
  state.bullets = keep;
}

// Find the first thing the bullet touches on the segment and resolve it. Returns true if consumed.
function traceBullet(state, b, x0, y0, x1, y1) {
  let bestT = Infinity, target = null;
  const t = segmentSolidsT(x0, y0, x1, y1, C.BULLET_RADIUS, state.arena.solids);
  if (t >= 0) bestT = t;
  const R = C.PLAYER_RADIUS + C.BULLET_RADIUS;
  for (const p of state.players) {
    // No self-damage. Eliminated and invulnerable players are not hittable.
    if (!p.alive || p.id === b.owner || p.invuln > 0) continue;
    const tp = segmentCircleT(x0, y0, x1, y1, p.x, p.y, R);
    if (tp >= 0 && tp < bestT) { bestT = tp; target = p; }
  }
  if (bestT === Infinity) return false;
  const hx = x0 + (x1 - x0) * bestT, hy = y0 + (y1 - y0) * bestT;
  if (target) applyHit(state, target, b, hx, hy);
  else emit(state, { type: 'wall', x: r1(hx), y: r1(hy), owner: b.owner });
  return true;
}

function applyHit(state, target, b, hx, hy) {
  target.lives = Math.max(0, target.lives - 1); // exactly one life per hit
  target.invuln = C.INVULN_TIME;
  const sp = Math.hypot(b.vx, b.vy) || 1;
  target.vx += (b.vx / sp) * C.KNOCKBACK_SPEED;
  target.vy += (b.vy / sp) * C.KNOCKBACK_SPEED;
  limitSpeed(target);
  const shooter = getPlayer(state, b.owner);
  if (shooter) shooter.hits++;
  emit(state, {
    type: 'hit', id: target.id, by: b.owner,
    x: r1(hx), y: r1(hy), lives: target.lives, a: r2(Math.atan2(b.vy, b.vx)),
  });
  if (target.lives <= 0) eliminate(state, target, b.owner, 'shot');
}

function eliminate(state, p, by, reason) {
  if (!p.alive) return;
  p.alive = false;
  p.elimTick = state.tick;
  p.killedBy = by;
  p.invuln = 0;
  p.vx = p.vy = 0;
  emit(state, { type: 'elim', id: p.id, by, x: r1(p.x), y: r1(p.y), reason });
}

function checkEnd(state) {
  if (state.phase !== 'playing') return;
  let alive = 0;
  for (const p of state.players) if (p.alive) alive++;
  if (alive <= 1) endMatch(state, alive === 1 ? 'last' : 'draw');
  else if (state.timeLeft <= EPS) endMatch(state, 'timer');
}

function endMatch(state, reason) {
  state.phase = 'ended';
  const ranking = computeRanking(state);
  const winners = ranking.filter((r) => r.place === 1).map((r) => r.id);
  state.result = { reason, ranking, winners, tick: state.tick };
  state.bullets = [];
  emit(state, { type: 'end', reason, winners });
}

/**
 * Placement rules:
 *  - players still alive rank above eliminated players
 *  - alive players: more lives first, then more hits landed
 *  - eliminated players: reverse order of elimination (last out = best), then more hits
 *  - anything still equal shares the same place (and shares the win when it is 1st)
 * This covers "last player standing", the timer tie-breaks and the same-tick double kill.
 */
export function computeRanking(state) {
  const cmp = (a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    if (a.alive) {
      if (a.lives !== b.lives) return b.lives - a.lives;
    } else if (a.elimTick !== b.elimTick) {
      return b.elimTick - a.elimTick;
    }
    return b.hits - a.hits;
  };
  const sorted = state.players.slice().sort(cmp);
  const ranking = [];
  sorted.forEach((p, i) => {
    const place = i > 0 && cmp(sorted[i - 1], p) === 0 ? ranking[i - 1].place : i + 1;
    ranking.push({
      id: p.id, name: p.name, color: p.color, slot: p.slot, place,
      lives: p.lives, hits: p.hits, shots: p.shots, alive: p.alive, left: p.left,
    });
  });
  return ranking;
}

/** Clean a player name: no control/invisible characters, single spaces, max NAME_MAX characters. */
export function cleanName(raw) {
  const s = String(raw == null ? '' : raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(s).slice(0, C.NAME_MAX).join('').trim();
}

// ---------------------------------------------------------------------------
// Compact network encoding (pure, so it is unit tested too)
// ---------------------------------------------------------------------------
// Player: [id, x, y, aim, lives, invuln, flags, hits, vx, vy, cooldown]
//   flags bit0 = alive, bit1 = left the room
export function packPlayer(p) {
  return [
    p.id, r1(p.x), r1(p.y), r2(p.aim), p.lives, r1(p.invuln),
    (p.alive ? 1 : 0) | (p.left ? 2 : 0), p.hits, r1(p.vx), r1(p.vy), r3(p.cooldown),
  ];
}
export function unpackPlayer(a) {
  return {
    id: a[0], x: a[1], y: a[2], aim: a[3], lives: a[4], invuln: a[5],
    alive: (a[6] & 1) === 1, left: (a[6] & 2) === 2, hits: a[7],
    vx: a[8] || 0, vy: a[9] || 0, cooldown: a[10] || 0,
  };
}
// Bullet: [id, x, y, vx, vy, owner]
export function packBullet(b) {
  return [b.id, r1(b.x), r1(b.y), r1(b.vx), r1(b.vy), b.owner];
}
export function unpackBullet(a) {
  return { id: a[0], x: a[1], y: a[2], vx: a[3], vy: a[4], owner: a[5] };
}
