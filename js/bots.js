// Room Showdown: bot AI for Practice mode (and the menu's background demo).
// Bots only produce inputs ({aim, fire}) and feed them into the very same
// simulation that multiplayer uses. Like everyone else they can only move with recoil:
// every shot is either an attack (aimed at a target) or a jump (aimed at the floor).
// Pure logic: no DOM, deterministic with a seed.

import { CONFIG } from './config.js';
import { DT, makeRng, wrapAngle, segmentSolidsT, getPlayer } from './sim.js';

const C = CONFIG;

export const BOT_LEVELS = {
  easy: {
    aimError: 0.2, turnRate: 4, reaction: 0.6, fireGap: [0.45, 1.1], range: 700, fireTol: 3,
    lead: 0, hover: 0.35, holdOnInvuln: false,
  },
  normal: {
    aimError: 0.1, turnRate: 6.5, reaction: 0.35, fireGap: [0.2, 0.55], range: 900, fireTol: 1.6,
    lead: 0.5, hover: 0.6, holdOnInvuln: true,
  },
  hard: {
    aimError: 0.03, turnRate: 12, reaction: 0.12, fireGap: [0.08, 0.25], range: 1050, fireTol: 1,
    lead: 1, hover: 0.85, holdOnInvuln: true,
  },
};

export const BOT_NAMES = ['Rusty', 'Dusty', 'Pickles', 'Tumble', 'Sprocket', 'Biscuit', 'Gizmo', 'Noodle', 'Pepper', 'Widget'];

export function createBot(id, level = 'normal', seed = 1) {
  const cfg = BOT_LEVELS[level] || BOT_LEVELS.normal;
  const B = {
    id, cfg, level,
    rng: makeRng(seed),
    targetId: null, retargetT: 0,
    aim: null, aimNoise: 0, noiseT: 0,
    seenT: 0, fireT: 0.3,
    mode: 'attack', modeT: 0,
    homeY: 0.5, // preferred flying height (share of the arena height), changes now and then
    homeT: 0,
  };
  return { id, level, think: (state, dt = DT) => think(B, state, dt) };
}

function pickTarget(B, me, state) {
  let best = null, bestScore = Infinity;
  const solids = state.arena.solids;
  for (const p of state.players) {
    if (!p.alive || p.id === me.id) continue;
    const d = Math.hypot(p.x - me.x, p.y - me.y);
    const los = segmentSolidsT(me.x, me.y, p.x, p.y, C.BULLET_RADIUS + 1, solids) < 0;
    let score = d - (los ? 300 : 0) + (p.invuln > 0 ? 160 : 0) + B.rng() * 120;
    if (p.id === B.targetId) score -= 90; // a little stickiness
    if (score < bestScore) { bestScore = score; best = p; }
  }
  return best;
}

/** Aim for a jump: down, leaning so the kick also pushes sideways toward `towardX`. */
function jumpAim(me, towardX, arena) {
  let lean = Math.max(-0.75, Math.min(0.75, (towardX - me.x) / 600));
  // Stay away from the side walls.
  if (me.x < C.WALL + 140) lean = Math.max(lean, 0.5);
  if (me.x > arena.w - C.WALL - 140) lean = Math.min(lean, -0.5);
  // Shooting down-left kicks up-right, so the aim leans away from where we want to go.
  return Math.PI / 2 + lean;
}

function think(B, state, dt) {
  const me = getPlayer(state, B.id);
  const input = { aim: me ? me.aim : 0, fire: false };
  if (!me || !me.alive) return input;
  if (B.aim === null) B.aim = me.aim;
  const arena = state.arena;
  const solids = arena.solids;

  // Target selection
  B.retargetT -= dt;
  let target = B.targetId !== null ? getPlayer(state, B.targetId) : null;
  if (!target || !target.alive || B.retargetT <= 0) {
    target = pickTarget(B, me, state);
    B.targetId = target ? target.id : null;
    B.retargetT = 0.7 + B.rng() * 0.9;
  }

  B.homeT -= dt;
  if (B.homeT <= 0) { B.homeY = 0.3 + B.rng() * 0.4; B.homeT = 2 + B.rng() * 3; }

  // Where to aim for an attack: lead the target and add a wobbly, human-like error.
  B.noiseT -= dt;
  if (B.noiseT <= 0) {
    B.aimNoise = (B.rng() * 2 - 1) * B.cfg.aimError;
    B.noiseT = 0.25 + B.rng() * 0.4;
  }
  let attackAim = B.aim, dist = Infinity, los = false;
  if (target) {
    dist = Math.hypot(target.x - me.x, target.y - me.y) || 1;
    los = segmentSolidsT(me.x, me.y, target.x, target.y, C.BULLET_RADIUS + 1, solids) < 0;
    let tx = target.x, ty = target.y;
    if (B.cfg.lead > 0) {
      const tt = dist / C.BULLET_SPEED;
      tx += target.vx * tt * B.cfg.lead;
      ty += (target.vy * tt + 0.5 * C.GRAVITY * tt * tt * (target.grounded ? 0 : 1)) * B.cfg.lead;
    }
    attackAim = Math.atan2(ty - me.y, tx - me.x) + B.aimNoise;
  }

  // Decide: attack, or jump to keep height / get closer?
  const floorY = arena.h - C.WALL - C.PLAYER_RADIUS;
  const wantY = arena.h * B.homeY;
  const low = me.y > wantY + 120 || me.y > floorY - 30;
  const falling = me.vy > 420;
  const tooHigh = me.y < C.WALL + 160;
  B.modeT -= dt;
  if (B.modeT <= 0) {
    let jump = false;
    if (!tooHigh) {
      if (!target || !los || dist > B.cfg.range) jump = low || falling || B.rng() < 0.3;
      else jump = (low && B.rng() < B.cfg.hover) || (falling && B.rng() < B.cfg.hover);
    }
    B.mode = jump ? 'jump' : 'attack';
    B.modeT = 0.12 + B.rng() * 0.2;
  }
  // Shooting at a target directly below also works as a jump; up into the ceiling never helps.
  const desired = B.mode === 'jump'
    ? jumpAim(me, target ? target.x : arena.w / 2, arena)
    : attackAim;

  const diff = wrapAngle(desired - B.aim);
  const maxTurn = B.cfg.turnRate * dt;
  B.aim = wrapAngle(B.aim + Math.max(-maxTurn, Math.min(maxTurn, diff)));
  input.aim = B.aim;

  if (state.phase !== 'playing') return input; // countdown: just aim

  if (los) B.seenT += dt; else B.seenT = 0;
  B.fireT -= dt;
  const ready = B.fireT <= 0 && me.cooldown <= 0;
  const aimErr = Math.abs(wrapAngle(desired - B.aim));
  if (ready) {
    if (B.mode === 'jump') {
      if (aimErr < 0.3) {
        input.fire = true;
        B.fireT = C.FIRE_COOLDOWN + 0.05 + B.rng() * 0.15;
      }
    } else if (target && los && dist < B.cfg.range && B.seenT >= B.cfg.reaction) {
      const tol = Math.atan2((C.PLAYER_RADIUS + C.BULLET_RADIUS) * B.cfg.fireTol, dist);
      const waitInvuln = B.cfg.holdOnInvuln && target.invuln > dist / C.BULLET_SPEED - 0.03;
      if (aimErr < tol && !waitInvuln) {
        input.fire = true;
        const [g0, g1] = B.cfg.fireGap;
        B.fireT = C.FIRE_COOLDOWN + g0 + B.rng() * (g1 - g0);
      }
    }
  }
  return input;
}
