// Room Showdown: PURE game simulation.
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
// Arena geometry
// ---------------------------------------------------------------------------
export function buildSolids() {
  const W = C.ARENA_W, H = C.ARENA_H, T = C.WALL;
  const walls = [
    { x: 0, y: 0, w: W, h: T, wall: true },
    { x: 0, y: H - T, w: W, h: T, wall: true },
    { x: 0, y: 0, w: T, h: H, wall: true },
    { x: W - T, y: 0, w: T, h: H, wall: true },
  ];
  return walls.concat(C.OBSTACLES.map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h, wall: false })));
}
export const SOLIDS = buildSolids();

export function buildSpawns() {
  const cx = C.ARENA_W / 2, cy = C.ARENA_H / 2;
  const out = [];
  for (let i = 0; i < 7; i++) {
    const ang = ((C.SPAWN_START_DEG + (i * 360) / 7) * Math.PI) / 180;
    const x = r1(cx + Math.cos(ang) * C.SPAWN_RX);
    const y = r1(cy + Math.sin(ang) * C.SPAWN_RY);
    out.push({ x, y, aim: Math.atan2(cy - y, cx - x) });
  }
  return out;
}
export const SPAWNS = buildSpawns();

export function spawnForJoinIndex(i) {
  return SPAWNS[C.SPAWN_ORDER[i % C.SPAWN_ORDER.length]];
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------
export function circleHitsRect(x, y, r, s) {
  const cx = clamp(x, s.x, s.x + s.w), cy = clamp(y, s.y, s.y + s.h);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy < r * r;
}

export function circleBlocked(x, y, r, solids = SOLIDS) {
  for (let i = 0; i < solids.length; i++) if (circleHitsRect(x, y, r, solids[i])) return true;
  return false;
}

// Push a circle out of every rectangle it overlaps (minimum translation).
export function resolveCircle(pos, r, solids = SOLIDS) {
  for (let iter = 0; iter < 4; iter++) {
    let pushed = false;
    for (let i = 0; i < solids.length; i++) {
      const s = solids[i];
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
  pos.x = clamp(pos.x, C.WALL + r, C.ARENA_W - C.WALL - r);
  pos.y = clamp(pos.y, C.WALL + r, C.ARENA_H - C.WALL - r);
}

// Move a circle by (dx, dy), sliding along walls and around corners.
export function moveCircle(pos, dx, dy, r, solids = SOLIDS) {
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-9) { resolveCircle(pos, r, solids); return; }
  const steps = Math.max(1, Math.ceil(dist / (r * 0.5)));
  const sx = dx / steps, sy = dy / steps;
  for (let i = 0; i < steps; i++) {
    pos.x += sx;
    pos.y += sy;
    resolveCircle(pos, r, solids);
  }
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
export function segmentSolidsT(x0, y0, x1, y1, pad = 0, solids = SOLIDS) {
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
    aim: spawn.aim,
    lives: C.LIVES,
    ammo: C.MAG_SIZE,
    reload: 0,   // seconds of reload remaining (0 = not reloading)
    cooldown: 0, // seconds until the pistol can fire again
    invuln: 0,   // seconds of invulnerability remaining
    kbx: 0, kby: 0, // knockback velocity
    alive: true,
    left: false, // disconnected
    hits: 0,
    shots: 0,
    elimTick: -1,
    killedBy: null,
    input: { mx: 0, my: 0, aim: spawn.aim, fire: false, reload: false },
    fireLatch: false,   // a short tap between two ticks still fires
    reloadLatch: false,
  };
}

/**
 * Create a new match.
 * @param {Array<{id:number,name:string,color:string,slot:number}>} roster players in join order
 * @param {{skipCountdown?:boolean, matchTime?:number}} [opts]
 */
export function createMatch(roster, opts = {}) {
  if (!Array.isArray(roster) || roster.length === 0) throw new Error('createMatch: empty roster');
  const players = roster.slice(0, C.MAX_PLAYERS).map((r, i) => makePlayer(r, spawnForJoinIndex(i)));
  const skip = !!opts.skipCountdown;
  return {
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
  const out = { mx: 0, my: 0, aim: prev && Number.isFinite(prev.aim) ? prev.aim : 0, fire: false, reload: false };
  if (!inp || typeof inp !== 'object') return out;
  let mx = Number(inp.mx), my = Number(inp.my);
  if (!Number.isFinite(mx)) mx = 0;
  if (!Number.isFinite(my)) my = 0;
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; } // speed can never exceed PLAYER_SPEED
  out.mx = mx;
  out.my = my;
  const aim = Number(inp.aim);
  if (Number.isFinite(aim) && Math.abs(aim) < 1e6) out.aim = wrapAngle(aim);
  out.fire = inp.fire === true || inp.fire === 1;
  out.reload = inp.reload === true || inp.reload === 1;
  return out;
}

export function setInput(state, id, input) {
  const p = getPlayer(state, id);
  if (!p || p.left) return;
  const inp = sanitizeInput(input, p.input);
  p.input = inp;
  if (inp.fire) p.fireLatch = true;
  if (inp.reload) p.reloadLatch = true;
}

/** A player disconnected: their character is eliminated. */
export function removePlayer(state, id) {
  const p = getPlayer(state, id);
  if (!p || p.left) return;
  p.left = true;
  p.input = { mx: 0, my: 0, aim: p.aim, fire: false, reload: false };
  p.fireLatch = p.reloadLatch = false;
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
      p.fireLatch = p.reloadLatch = false;
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

  // Movement (input vector is already clamped to length <= 1)
  const vx = inp.mx * C.PLAYER_SPEED + p.kbx;
  const vy = inp.my * C.PLAYER_SPEED + p.kby;
  const decay = Math.exp(-C.KNOCKBACK_DECAY * dt);
  p.kbx *= decay;
  p.kby *= decay;
  if (Math.abs(p.kbx) < 1) p.kbx = 0;
  if (Math.abs(p.kby) < 1) p.kby = 0;
  moveCircle(p, vx * dt, vy * dt, C.PLAYER_RADIUS);

  // Reload
  if (p.reload > 0) {
    p.reload -= dt;
    if (p.reload <= EPS) {
      p.reload = 0;
      p.ammo = C.MAG_SIZE;
      emit(state, { type: 'reloaded', id: p.id });
    }
  } else if ((inp.reload || p.reloadLatch) && p.ammo < C.MAG_SIZE) {
    startReload(state, p);
  }

  // Fire (hold to keep firing at the cooldown rate)
  if ((inp.fire || p.fireLatch) && p.reload === 0 && p.cooldown <= EPS && p.ammo > 0) {
    fireBullet(state, p);
  }
  if (p.ammo === 0 && p.reload === 0) startReload(state, p); // automatic reload when empty

  p.fireLatch = false;
  p.reloadLatch = false;
}

function startReload(state, p) {
  if (p.reload > 0 || p.ammo >= C.MAG_SIZE) return;
  p.reload = C.RELOAD_TIME;
  emit(state, { type: 'reload', id: p.id });
}

function fireBullet(state, p) {
  const cos = Math.cos(p.aim), sin = Math.sin(p.aim);
  const mx = p.x + cos * C.MUZZLE_OFFSET, my = p.y + sin * C.MUZZLE_OFFSET;
  p.ammo--;
  p.cooldown = C.FIRE_COOLDOWN;
  p.shots++;
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
  const t = segmentSolidsT(x0, y0, x1, y1, C.BULLET_RADIUS);
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
  target.kbx += (b.vx / sp) * C.KNOCKBACK_SPEED;
  target.kby += (b.vy / sp) * C.KNOCKBACK_SPEED;
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
  p.kbx = p.kby = 0;
  p.reload = 0;
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
// Player: [id, x, y, aim, lives, ammo, reloadLeft, invuln, flags, hits]
//   flags bit0 = alive, bit1 = left the room
export function packPlayer(p) {
  return [
    p.id, r1(p.x), r1(p.y), r2(p.aim), p.lives, p.ammo,
    r2(p.reload), r1(p.invuln), (p.alive ? 1 : 0) | (p.left ? 2 : 0), p.hits,
  ];
}
export function unpackPlayer(a) {
  return {
    id: a[0], x: a[1], y: a[2], aim: a[3], lives: a[4], ammo: a[5],
    reload: a[6], invuln: a[7], alive: (a[8] & 1) === 1, left: (a[8] & 2) === 2, hits: a[9],
  };
}
// Bullet: [id, x, y, vx, vy, owner]
export function packBullet(b) {
  return [b.id, r1(b.x), r1(b.y), r1(b.vx), r1(b.vy), b.owner];
}
export function unpackBullet(a) {
  return { id: a[0], x: a[1], y: a[2], vx: a[3], vy: a[4], owner: a[5] };
}
