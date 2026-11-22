// Room Showdown: bot AI for Practice mode (and the menu's background demo).
// Bots only produce inputs ({mx, my, aim, fire, reload}) and feed them into the very same
// simulation that multiplayer uses. Pure logic: no DOM, deterministic with a seed.

import { CONFIG } from './config.js';
import { DT, makeRng, wrapAngle, circleBlocked, segmentSolidsT, getPlayer } from './sim.js';

const C = CONFIG;

export const BOT_LEVELS = {
  easy: {
    aimError: 0.2, turnRate: 3.2, reaction: 0.6, fireGap: [0.35, 1.1], range: 650, fireTol: 3,
    preferDist: 430, strafe: 0.35, lead: 0, dodge: 0, speed: 0.72, holdOnInvuln: false,
  },
  normal: {
    aimError: 0.11, turnRate: 5, reaction: 0.4, fireGap: [0.12, 0.55], range: 820, fireTol: 1.3,
    preferDist: 360, strafe: 0.7, lead: 0.5, dodge: 0.3, speed: 0.88, holdOnInvuln: true,
  },
  hard: {
    aimError: 0.025, turnRate: 11, reaction: 0.12, fireGap: [0, 0.05], range: 980, fireTol: 0.8,
    preferDist: 320, strafe: 1, lead: 1, dodge: 0.9, speed: 1, holdOnInvuln: true,
  },
};

export const BOT_NAMES = ['Rusty', 'Dusty', 'Pickles', 'Tumble', 'Sprocket', 'Biscuit', 'Gizmo', 'Noodle', 'Pepper', 'Widget'];

// ---------------------------------------------------------------------------
// Coarse navigation grid (computed once; the arena never changes)
// ---------------------------------------------------------------------------
const CELL = 40;
const COLS = Math.ceil(C.ARENA_W / CELL);
const ROWS = Math.ceil(C.ARENA_H / CELL);
let walkable = null;

function getWalkable() {
  if (walkable) return walkable;
  walkable = new Uint8Array(COLS * ROWS);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = c * CELL + CELL / 2, y = r * CELL + CELL / 2;
      walkable[r * COLS + c] = circleBlocked(x, y, C.PLAYER_RADIUS + 2) ? 0 : 1;
    }
  }
  return walkable;
}

const cellCol = (x) => Math.max(0, Math.min(COLS - 1, Math.floor(x / CELL)));
const cellRow = (y) => Math.max(0, Math.min(ROWS - 1, Math.floor(y / CELL)));

// Breadth-first distance field from a target cell (8-connected, no corner cutting).
function distanceField(tc, tr) {
  const W = getWalkable();
  const dist = new Int16Array(COLS * ROWS).fill(-1);
  const queue = new Int32Array(COLS * ROWS);
  let head = 0, tail = 0;
  const start = tr * COLS + tc;
  dist[start] = 0;
  queue[tail++] = start;
  while (head < tail) {
    const cur = queue[head++];
    const c = cur % COLS, r = (cur - c) / COLS;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
        const ni = nr * COLS + nc;
        if (!W[ni] || dist[ni] >= 0) continue;
        if (dr && dc && (!W[r * COLS + nc] || !W[nr * COLS + c])) continue;
        dist[ni] = dist[cur] + 1;
        queue[tail++] = ni;
      }
    }
  }
  return dist;
}

// ---------------------------------------------------------------------------
// Bot brain
// ---------------------------------------------------------------------------
export function createBot(id, level = 'normal', seed = 1) {
  const cfg = BOT_LEVELS[level] || BOT_LEVELS.normal;
  const B = {
    id, cfg, level,
    rng: makeRng(seed),
    targetId: null, retargetT: 0,
    aim: null, aimNoise: 0, noiseT: 0,
    seenT: 0, fireT: 0.3,
    strafeDir: 1, strafeT: 0,
    stuckT: 0, stuckX: 0, stuckY: 0, wanderT: 0, wanderA: 0,
    field: null, fieldCell: -1, fieldT: 0,
  };
  B.strafeDir = B.rng() < 0.5 ? -1 : 1;
  return { id, level, think: (state, dt = DT) => think(B, state, dt) };
}

function pickTarget(B, me, state) {
  let best = null, bestScore = Infinity;
  for (const p of state.players) {
    if (!p.alive || p.id === me.id) continue;
    const d = Math.hypot(p.x - me.x, p.y - me.y);
    const los = segmentSolidsT(me.x, me.y, p.x, p.y, C.BULLET_RADIUS + 1) < 0;
    let score = d - (los ? 260 : 0) + (p.invuln > 0 ? 160 : 0) + B.rng() * 120;
    if (p.id === B.targetId) score -= 90; // a little stickiness
    if (score < bestScore) { bestScore = score; best = p; }
  }
  return best;
}

function pathDirection(B, me, target, dt) {
  const tc = cellCol(target.x), tr = cellRow(target.y);
  const targetCell = tr * COLS + tc;
  B.fieldT -= dt;
  if (!B.field || B.fieldCell !== targetCell || B.fieldT <= 0) {
    B.field = distanceField(tc, tr);
    B.fieldCell = targetCell;
    B.fieldT = 0.5;
  }
  const W = getWalkable();
  const dist = B.field;
  let c = cellCol(me.x), r = cellRow(me.y);
  let best = -1, bestD = 1e9;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
      const ni = nr * COLS + nc;
      if (!W[ni] || dist[ni] < 0) continue;
      if (dr && dc && (!W[r * COLS + nc] || !W[nr * COLS + c])) continue;
      const d = dist[ni] + (dr && dc ? 0.4 : 0);
      if (d < bestD) { bestD = d; best = ni; }
    }
  }
  if (best < 0 || dist[r * COLS + c] === 0) {
    const dx = target.x - me.x, dy = target.y - me.y, l = Math.hypot(dx, dy) || 1;
    return { x: dx / l, y: dy / l };
  }
  // Look one more cell ahead and cut the corner when the way is clear.
  let goal = best;
  const gc = best % COLS, gr = (best - gc) / COLS;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nc = gc + dc, nr = gr + dr;
      if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
      const ni = nr * COLS + nc;
      if (!W[ni] || dist[ni] < 0 || dist[ni] >= dist[goal]) continue;
      const x = nc * CELL + CELL / 2, y = nr * CELL + CELL / 2;
      if (segmentSolidsT(me.x, me.y, x, y, C.PLAYER_RADIUS) < 0) goal = ni;
    }
  }
  const col = goal % COLS, row = (goal - col) / COLS;
  const gx = col * CELL + CELL / 2, gy = row * CELL + CELL / 2;
  const dx = gx - me.x, dy = gy - me.y, l = Math.hypot(dx, dy) || 1;
  return { x: dx / l, y: dy / l };
}

// Sidestep bullets that are about to pass close by.
function dodgeVector(me, state) {
  let ax = 0, ay = 0;
  for (const b of state.bullets) {
    if (b.owner === me.id) continue;
    const rx = me.x - b.x, ry = me.y - b.y;
    const vv = b.vx * b.vx + b.vy * b.vy;
    if (vv < 1) continue;
    const t = (rx * b.vx + ry * b.vy) / vv; // time of closest approach
    if (t < 0 || t > 0.45) continue;
    const cx = b.x + b.vx * t, cy = b.y + b.vy * t;
    let ox = me.x - cx, oy = me.y - cy;
    const d = Math.hypot(ox, oy);
    if (d > 46) continue;
    if (d < 1e-3) { ox = -b.vy; oy = b.vx; } // dead-on: pick a side
    const l = Math.hypot(ox, oy) || 1;
    const w = 1 - t / 0.45;
    ax += (ox / l) * w;
    ay += (oy / l) * w;
  }
  const l = Math.hypot(ax, ay);
  return l > 1e-6 ? { x: ax / l, y: ay / l } : null;
}

// Rotate the wanted direction until the next few pixels are free of walls.
function steerAroundWalls(me, dx, dy) {
  const look = C.PLAYER_RADIUS + 12;
  const tries = [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2.2, -2.2];
  for (const a of tries) {
    const cs = Math.cos(a), sn = Math.sin(a);
    const x = dx * cs - dy * sn, y = dx * sn + dy * cs;
    if (!circleBlocked(me.x + x * look, me.y + y * look, C.PLAYER_RADIUS)) return { x, y };
  }
  return { x: dx, y: dy };
}

function think(B, state, dt) {
  const me = getPlayer(state, B.id);
  const input = { mx: 0, my: 0, aim: me ? me.aim : 0, fire: false, reload: false };
  if (!me || !me.alive) return input;
  if (B.aim === null) B.aim = me.aim;

  // Target selection
  B.retargetT -= dt;
  let target = B.targetId !== null ? getPlayer(state, B.targetId) : null;
  if (!target || !target.alive || B.retargetT <= 0) {
    target = pickTarget(B, me, state);
    B.targetId = target ? target.id : null;
    B.retargetT = 0.7 + B.rng() * 0.9;
  }
  if (!target) { input.aim = B.aim; return input; }

  const dx = target.x - me.x, dy = target.y - me.y;
  const dist = Math.hypot(dx, dy) || 1;
  const los = segmentSolidsT(me.x, me.y, target.x, target.y, C.BULLET_RADIUS + 1) < 0;

  // Aim: lead the target, add a wobbly human-like error, turn at a limited rate.
  B.noiseT -= dt;
  if (B.noiseT <= 0) {
    B.aimNoise = (B.rng() * 2 - 1) * B.cfg.aimError;
    B.noiseT = 0.25 + B.rng() * 0.4;
  }
  let tx = target.x, ty = target.y;
  if (B.cfg.lead > 0) {
    const tvx = (target.x - target.px) / DT, tvy = (target.y - target.py) / DT;
    const tt = dist / C.BULLET_SPEED;
    tx += tvx * tt * B.cfg.lead;
    ty += tvy * tt * B.cfg.lead;
  }
  const desired = Math.atan2(ty - me.y, tx - me.x) + B.aimNoise;
  const diff = wrapAngle(desired - B.aim);
  const maxTurn = B.cfg.turnRate * dt;
  B.aim = wrapAngle(B.aim + Math.max(-maxTurn, Math.min(maxTurn, diff)));
  input.aim = B.aim;

  if (state.phase !== 'playing') return input; // countdown: just aim

  // Fire
  if (los) B.seenT += dt; else B.seenT = 0;
  B.fireT -= dt;
  const aimErr = Math.abs(wrapAngle(desired - B.aim));
  // Only pull the trigger when the gun points at the target's body (scaled per level).
  const aimTol = Math.atan2((C.PLAYER_RADIUS + C.BULLET_RADIUS) * B.cfg.fireTol, dist);
  // Don't waste bullets: hold fire until the target's invulnerability ends when the bullet arrives.
  const waitInvuln = B.cfg.holdOnInvuln && target.invuln > dist / C.BULLET_SPEED - 0.03;
  if (los && !waitInvuln && B.seenT >= B.cfg.reaction && dist < B.cfg.range && aimErr < aimTol &&
      B.fireT <= 0 && me.reload === 0 && me.ammo > 0 && me.cooldown <= 0) {
    input.fire = true;
    const [g0, g1] = B.cfg.fireGap;
    B.fireT = C.FIRE_COOLDOWN + g0 + B.rng() * (g1 - g0);
  }
  if (!los && me.ammo <= 3 && me.reload === 0) input.reload = true; // reload while safe

  // Movement
  let mvx = 0, mvy = 0;
  const ux = dx / dist, uy = dy / dist;
  B.strafeT -= dt;
  if (B.strafeT <= 0) {
    if (B.rng() < 0.65) B.strafeDir = -B.strafeDir;
    B.strafeT = 0.5 + B.rng() * 1.3;
  }
  if (!los || dist > B.cfg.preferDist + 140) {
    const p = pathDirection(B, me, target, dt);
    mvx = p.x; mvy = p.y;
    if (los) { mvx += -uy * B.strafeDir * 0.35 * B.cfg.strafe; mvy += ux * B.strafeDir * 0.35 * B.cfg.strafe; }
  } else {
    let radial = 0;
    if (dist > B.cfg.preferDist + 60) radial = 0.8;
    else if (dist < B.cfg.preferDist - 90) radial = -0.9;
    mvx = ux * radial - uy * B.strafeDir * B.cfg.strafe;
    mvy = uy * radial + ux * B.strafeDir * B.cfg.strafe;
  }
  if (B.cfg.dodge > 0) {
    const d = dodgeVector(me, state);
    if (d) { mvx += d.x * 2 * B.cfg.dodge; mvy += d.y * 2 * B.cfg.dodge; }
  }

  // Unstick: if we wanted to move but barely did, wander for a moment.
  B.stuckT += dt;
  if (B.stuckT >= 0.6) {
    const moved = Math.hypot(me.x - B.stuckX, me.y - B.stuckY);
    if (moved < 8 && Math.hypot(mvx, mvy) > 0.2) { B.wanderT = 0.6; B.wanderA = B.rng() * Math.PI * 2; }
    B.stuckT = 0; B.stuckX = me.x; B.stuckY = me.y;
  }
  if (B.wanderT > 0) {
    B.wanderT -= dt;
    mvx = Math.cos(B.wanderA); mvy = Math.sin(B.wanderA);
  }

  const len = Math.hypot(mvx, mvy);
  if (len > 1e-6) {
    const s = steerAroundWalls(me, mvx / len, mvy / len);
    input.mx = s.x * B.cfg.speed;
    input.my = s.y * B.cfg.speed;
  }
  return input;
}
