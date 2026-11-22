// Room Showdown: headless logic tests. Run with:  node tests/sim.test.mjs
// Plain Node `assert`, no test framework. sim.js runs here unchanged from the browser.

import assert from 'node:assert/strict';
import { CONFIG } from '../js/config.js';
import * as S from '../js/sim.js';
import { createBot } from '../js/bots.js';

const C = CONFIG;
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(String(err && err.stack ? err.stack : err).split('\n').map((l) => '      ' + l).join('\n'));
  }
}
function section(title) { console.log(`\n${title}`); }

// ---- helpers -------------------------------------------------------------
const roster = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `P${i + 1}`, color: C.COLORS[i], slot: i }));
const newMatch = (n, opts = {}) => S.createMatch(roster(n), { skipCountdown: true, ...opts });
const P = (st, id) => S.getPlayer(st, id);
function put(st, id, x, y, aim) {
  const p = P(st, id);
  p.x = p.px = x;
  p.y = p.py = y;
  if (aim !== undefined) { p.aim = aim; p.input.aim = aim; }
  return p;
}
function steps(st, n) { for (let i = 0; i < n; i++) S.step(st); }
function drain(st) { const e = st.events; st.events = []; return e; }
function fireOnce(st, id, aim) {
  S.setInput(st, id, { mx: 0, my: 0, aim, fire: true });
  S.step(st);
  S.setInput(st, id, { mx: 0, my: 0, aim, fire: false });
}
function stepUntil(st, pred, max = 2000) {
  const evs = [];
  for (let i = 0; i < max; i++) {
    S.step(st);
    const e = drain(st);
    evs.push(...e);
    if (pred(e, st)) return evs;
  }
  throw new Error('condition not reached within ' + max + ' ticks');
}
const hasType = (type) => (evs) => evs.some((e) => e.type === type);
// Park extra players in the bottom corridor so they stay out of the way.
function park(st, id, x) { put(st, id, x, 800, -Math.PI / 2); }

// ---- tests -------------------------------------------------------------------
section('Setup');

test('every player starts with exactly 5 lives, a full magazine and alive', () => {
  const st = S.createMatch(roster(7));
  assert.equal(st.players.length, 7);
  for (const p of st.players) {
    assert.equal(p.lives, 5);
    assert.equal(p.ammo, 6);
    assert.equal(p.alive, true);
    assert.equal(p.hits, 0);
  }
  assert.equal(C.LIVES, 5);
});

test('rosters larger than 7 are capped at 7 players', () => {
  const st = S.createMatch(roster(9).map((r, i) => ({ ...r, slot: i % 7 })));
  assert.equal(st.players.length, 7);
});

test('7 spawn points, clear of walls and cover, facing the center, spread out', () => {
  assert.equal(S.SPAWNS.length, 7);
  for (const sp of S.SPAWNS) {
    assert.ok(!S.circleBlocked(sp.x, sp.y, C.PLAYER_RADIUS + 30), `spawn ${sp.x},${sp.y} too close to a wall`);
    const toCenter = Math.atan2(C.ARENA_H / 2 - sp.y, C.ARENA_W / 2 - sp.x);
    assert.ok(Math.abs(S.wrapAngle(sp.aim - toCenter)) < 1e-9, 'spawn should face the center');
  }
  for (let i = 0; i < 7; i++)
    for (let j = i + 1; j < 7; j++)
      assert.ok(Math.hypot(S.SPAWNS[i].x - S.SPAWNS[j].x, S.SPAWNS[i].y - S.SPAWNS[j].y) > 300);
  // Players are assigned in join order; the first two spawns mirror each other (fair 1v1).
  const a = S.spawnForJoinIndex(0), b = S.spawnForJoinIndex(1);
  assert.ok(Math.abs(a.x + b.x - C.ARENA_W) < 0.2 && Math.abs(a.y - b.y) < 0.2);
  const st = S.createMatch(roster(3));
  assert.deepEqual([st.players[2].x, st.players[2].y], [S.spawnForJoinIndex(2).x, S.spawnForJoinIndex(2).y]);
});

test('6 to 8 obstacles in a mirror-symmetric layout', () => {
  const obs = C.OBSTACLES;
  assert.ok(obs.length >= 6 && obs.length <= 8);
  const has = (x, y, w, h) => obs.some((o) => Math.abs(o.x - x) < 1e-6 && Math.abs(o.y - y) < 1e-6 && o.w === w && o.h === h);
  for (const o of obs) {
    assert.ok(has(C.ARENA_W - o.x - o.w, o.y, o.w, o.h), 'left/right mirror missing');
    assert.ok(has(o.x, C.ARENA_H - o.y - o.h, o.w, o.h), 'top/bottom mirror missing');
  }
});

test('no unreachable pockets: every free spot is reachable from every spawn', () => {
  const G = 6, cols = Math.floor(C.ARENA_W / G), rows = Math.floor(C.ARENA_H / G);
  const free = new Uint8Array(cols * rows);
  let freeCount = 0;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (!S.circleBlocked(c * G + G / 2, r * G + G / 2, C.PLAYER_RADIUS)) { free[r * cols + c] = 1; freeCount++; }
  const seen = new Uint8Array(cols * rows);
  const sp = S.SPAWNS[0];
  const start = Math.floor(sp.y / G) * cols + Math.floor(sp.x / G);
  assert.equal(free[start], 1);
  const q = [start];
  seen[start] = 1;
  let count = 0;
  while (q.length) {
    const cur = q.pop();
    count++;
    const c = cur % cols, r = (cur - c) / cols;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const ni = nr * cols + nc;
      if (free[ni] && !seen[ni]) { seen[ni] = 1; q.push(ni); }
    }
  }
  assert.equal(count, freeCount, `${freeCount - count} free cells are unreachable`);
  for (const s of S.SPAWNS) assert.equal(seen[Math.floor(s.y / G) * cols + Math.floor(s.x / G)], 1);
});

section('Movement');

test('moves at 230 px/s', () => {
  const st = newMatch(2);
  put(st, 1, 100, 120, 0);
  park(st, 2, 1400);
  S.setInput(st, 1, { mx: 1, my: 0, aim: 0 });
  steps(st, 60);
  assert.ok(Math.abs(P(st, 1).x - 330) < 0.5, `x=${P(st, 1).x}`);
});

test('the host clamps movement speed (diagonal and spoofed inputs)', () => {
  const st = newMatch(2);
  put(st, 1, 300, 120, 0);
  park(st, 2, 1400);
  S.setInput(st, 1, { mx: 1, my: 1, aim: 0 });
  steps(st, 30);
  const d1 = Math.hypot(P(st, 1).x - 300, P(st, 1).y - 120);
  assert.ok(Math.abs(d1 - 115) < 0.5, `diagonal moved ${d1}`);
  put(st, 1, 100, 120, 0);
  S.setInput(st, 1, { mx: 50, my: 0, aim: 0 }); // a cheater's input
  steps(st, 60);
  assert.ok(Math.abs(P(st, 1).x - 330) < 0.5, `spoofed moved to ${P(st, 1).x}`);
});

test('walls and obstacles block movement, and players slide along them', () => {
  const st = newMatch(2);
  park(st, 2, 1400);
  put(st, 1, 100, 120, 0);
  S.setInput(st, 1, { mx: -1, my: 0, aim: 0 });
  steps(st, 120);
  assert.ok(Math.abs(P(st, 1).x - (C.WALL + C.PLAYER_RADIUS)) < 0.01, 'stops at the left wall');
  S.setInput(st, 1, { mx: -Math.SQRT1_2, my: Math.SQRT1_2, aim: 0 });
  steps(st, 60);
  assert.ok(Math.abs(P(st, 1).x - (C.WALL + C.PLAYER_RADIUS)) < 0.01, 'stays against the wall');
  assert.ok(P(st, 1).y > 120 + 150, 'slides down along the wall');
  put(st, 1, 650, 450, 0); // left of the center pillar (x = 740)
  S.setInput(st, 1, { mx: 1, my: 0, aim: 0 });
  steps(st, 60);
  assert.ok(Math.abs(P(st, 1).x - (740 - C.PLAYER_RADIUS)) < 0.01, `stopped at ${P(st, 1).x}`);
});

test('countdown: aim works, moving and shooting do not, then 3-2-1-DUEL', () => {
  const st = S.createMatch(roster(2));
  assert.equal(st.phase, 'countdown');
  const sx = P(st, 1).x;
  S.setInput(st, 1, { mx: 1, my: 0, aim: 1.0, fire: true });
  const evs = [];
  for (let i = 0; i < 179; i++) { S.step(st); evs.push(...drain(st)); }
  assert.equal(st.phase, 'countdown');
  assert.equal(P(st, 1).x, sx);
  assert.equal(P(st, 1).aim, 1.0);
  assert.equal(st.bullets.length, 0);
  assert.deepEqual(evs.filter((e) => e.type === 'count').map((e) => e.n), [3, 2, 1]);
  S.step(st);
  assert.ok(drain(st).some((e) => e.type === 'go'));
  assert.equal(st.phase, 'playing');
  S.step(st);
  assert.ok(P(st, 1).x > sx, 'moves after DUEL');
});

section('Pistol, ammo and reload');

test('magazine of 6, 0.35 s cooldown, automatic 1.2 s reload when empty', () => {
  const st = newMatch(2);
  put(st, 1, 800, 120, -Math.PI / 2); // shoot straight into the top wall
  park(st, 2, 1400);
  S.setInput(st, 1, { mx: 0, my: 0, aim: -Math.PI / 2, fire: true }); // hold the trigger
  const shots = [], reloads = [], reloaded = [];
  for (let i = 0; i < 200; i++) {
    S.step(st);
    for (const e of drain(st)) {
      if (e.type === 'shot') shots.push(e.tick);
      if (e.type === 'reload') reloads.push(e.tick);
      if (e.type === 'reloaded') reloaded.push(e.tick);
    }
  }
  // 6 shots, 21 ticks (0.35 s) apart
  const firstMag = shots.slice(0, 6);
  for (let i = 1; i < 6; i++) assert.equal(firstMag[i] - firstMag[i - 1], 21);
  assert.equal(reloads[0], firstMag[5], 'reload starts automatically on the empty shot');
  assert.equal(reloaded[0] - reloads[0], 72, 'reload takes 1.2 s');
  assert.ok(!shots.some((t) => t > reloads[0] && t < reloaded[0]), 'no shots while reloading');
  assert.equal(shots[6], reloaded[0], 'firing resumes right after the reload');
});

test('manual reload: ignored with a full magazine, refills a partial one', () => {
  const st = newMatch(2);
  put(st, 1, 800, 120, -Math.PI / 2);
  park(st, 2, 1400);
  S.setInput(st, 1, { aim: -Math.PI / 2, reload: true });
  S.step(st);
  assert.ok(!drain(st).some((e) => e.type === 'reload'), 'full magazine: no reload');
  fireOnce(st, 1, -Math.PI / 2);
  steps(st, 25);
  fireOnce(st, 1, -Math.PI / 2);
  assert.equal(P(st, 1).ammo, 4);
  drain(st);
  S.setInput(st, 1, { aim: -Math.PI / 2, reload: true });
  S.step(st);
  assert.ok(drain(st).some((e) => e.type === 'reload'));
  S.setInput(st, 1, { aim: -Math.PI / 2, fire: true }); // trying to shoot while reloading
  steps(st, 70);
  assert.equal(P(st, 1).ammo, 4, 'cannot shoot during reload');
  S.setInput(st, 1, { aim: -Math.PI / 2, fire: false });
  steps(st, 1);
  assert.equal(P(st, 1).ammo, 4, 'still reloading after 71 ticks');
  steps(st, 1);
  assert.equal(P(st, 1).ammo, 6, 'refilled after exactly 72 ticks (1.2 s)');
});

test('the host enforces the cooldown even if fire is spammed', () => {
  const st = newMatch(2);
  put(st, 1, 800, 120, -Math.PI / 2);
  park(st, 2, 1400);
  let shots = 0;
  for (let i = 0; i < 60; i++) {
    S.setInput(st, 1, { aim: -Math.PI / 2, fire: i % 2 === 0 });
    S.step(st);
    shots += drain(st).filter((e) => e.type === 'shot').length;
  }
  assert.equal(shots, 3); // t = 0, 0.35, 0.70 within one second
});

test('a quick tap between two ticks still fires (input latch)', () => {
  const st = newMatch(2);
  put(st, 1, 800, 120, -Math.PI / 2);
  park(st, 2, 1400);
  S.setInput(st, 1, { aim: -Math.PI / 2, fire: true });
  S.setInput(st, 1, { aim: -Math.PI / 2, fire: false }); // released before the next tick
  S.step(st);
  assert.equal(drain(st).filter((e) => e.type === 'shot').length, 1);
});

section('Bullets and hits');

test('one hit costs exactly one life and credits the shooter', () => {
  const st = newMatch(2);
  put(st, 1, 200, 120, 0);
  put(st, 2, 500, 120, Math.PI);
  fireOnce(st, 1, 0);
  const evs = stepUntil(st, hasType('hit'));
  const hit = evs.find((e) => e.type === 'hit');
  assert.equal(hit.id, 2);
  assert.equal(hit.by, 1);
  assert.equal(P(st, 2).lives, 4);
  assert.equal(P(st, 1).hits, 1);
  assert.equal(P(st, 1).lives, 5);
  assert.ok(P(st, 2).invuln > 1.4);
});

test('invulnerability: 1.5 s without damage after a hit, damage again afterwards', () => {
  const st = newMatch(2);
  put(st, 1, 200, 120, 0);
  put(st, 2, 420, 120, Math.PI);
  fireOnce(st, 1, 0);
  stepUntil(st, hasType('hit'));
  const hitTick = st.tick;
  // Keep firing early in the window: those bullets pass through without damage.
  S.setInput(st, 1, { aim: 0, fire: true });
  let shotsInWindow = 0, hitsInWindow = 0;
  while (st.tick < hitTick + 40) {
    S.step(st);
    for (const e of drain(st)) { if (e.type === 'shot') shotsInWindow++; if (e.type === 'hit') hitsInWindow++; }
  }
  S.setInput(st, 1, { aim: 0, fire: false });
  while (st.tick < hitTick + 89) { S.step(st); for (const e of drain(st)) if (e.type === 'hit') hitsInWindow++; }
  assert.ok(shotsInWindow >= 1, 'shots were fired during the window');
  assert.equal(hitsInWindow, 0, 'they passed through');
  assert.equal(P(st, 2).lives, 4, 'no damage while invulnerable');
  assert.ok(P(st, 2).invuln > 0);
  S.step(st);
  assert.equal(P(st, 2).invuln, 0, 'window ends after exactly 1.5 s');
  steps(st, 25);
  fireOnce(st, 1, 0);
  stepUntil(st, hasType('hit'));
  assert.equal(P(st, 2).lives, 3);
});

test('a hit gives a knockback nudge', () => {
  const st = newMatch(2);
  put(st, 1, 200, 120, 0);
  put(st, 2, 500, 120, Math.PI);
  fireOnce(st, 1, 0);
  stepUntil(st, hasType('hit'));
  const x0 = P(st, 2).x;
  steps(st, 60);
  const pushed = P(st, 2).x - x0;
  assert.ok(pushed > 20 && pushed < 60, `pushed ${pushed}px`);
});

test('bullets are destroyed by obstacles and walls', () => {
  const st = newMatch(2);
  put(st, 1, 650, 450, 0); // the center pillar is in between
  put(st, 2, 950, 450, Math.PI);
  fireOnce(st, 1, 0);
  const evs = stepUntil(st, hasType('wall'));
  const wall = evs.find((e) => e.type === 'wall');
  assert.ok(Math.abs(wall.x - (740 - C.BULLET_RADIUS)) < 0.6, `hit pillar at x=${wall.x}`);
  assert.equal(st.bullets.length, 0);
  steps(st, 60);
  assert.equal(P(st, 2).lives, 5, 'player behind cover is safe');
  put(st, 1, 800, 120, -Math.PI / 2);
  fireOnce(st, 1, -Math.PI / 2);
  const evs2 = stepUntil(st, hasType('wall'));
  assert.ok(Math.abs(evs2.find((e) => e.type === 'wall').y - (C.WALL + C.BULLET_RADIUS)) < 0.6);
});

test('shooting point-blank into a wall you are hugging does not pass through it', () => {
  const st = newMatch(2);
  put(st, 1, 722, 450, 0); // touching the pillar
  put(st, 2, 880, 450, Math.PI); // right behind it
  fireOnce(st, 1, 0);
  steps(st, 30);
  assert.equal(P(st, 2).lives, 5);
});

test('no self-damage', () => {
  const st = newMatch(2);
  put(st, 1, 400, 120, 0);
  park(st, 2, 1400);
  // A bullet owned by player 1 flying straight through player 1
  st.bullets.push({ id: 999, owner: 1, x: 300, y: 120, px: 300, py: 120, vx: 720, vy: 0, life: 1 });
  steps(st, 30);
  assert.equal(P(st, 1).lives, 5);
  assert.equal(P(st, 1).invuln, 0);
});

test('bullets expire after 1.4 s', () => {
  const st = newMatch(2);
  put(st, 1, 60, 120, 0); // long open corridor to the right
  park(st, 2, 1400);
  fireOnce(st, 1, 0);
  let wallHit = false;
  for (let i = 1; i < 78; i++) { S.step(st); if (drain(st).some((e) => e.type === 'wall')) wallHit = true; }
  assert.equal(st.bullets.length, 1, 'still flying at 1.3 s');
  steps(st, 10);
  assert.equal(st.bullets.length, 0, 'gone by 1.45 s');
  assert.equal(wallHit, false);
});

section('Elimination and winning');

test('at 0 lives a player is eliminated, cannot shoot and cannot be hit', () => {
  const st = newMatch(3);
  put(st, 1, 200, 120, 0);
  put(st, 2, 500, 120, Math.PI);
  park(st, 3, 1400);
  P(st, 2).lives = 1;
  fireOnce(st, 1, 0);
  const evs = stepUntil(st, hasType('elim'));
  const elim = evs.find((e) => e.type === 'elim');
  assert.equal(elim.id, 2);
  assert.equal(elim.by, 1);
  assert.equal(P(st, 2).alive, false);
  assert.equal(P(st, 2).lives, 0);
  assert.equal(st.phase, 'playing', 'two players are still alive');
  // The eliminated player tries to shoot
  S.setInput(st, 2, { aim: Math.PI, fire: true });
  steps(st, 30);
  assert.equal(P(st, 2).shots, 0);
  assert.equal(st.bullets.filter((b) => b.owner === 2).length, 0);
  // Bullets fly through the eliminated player's position
  steps(st, 60);
  const hitsBefore = P(st, 1).hits;
  fireOnce(st, 1, 0);
  steps(st, 30);
  assert.equal(P(st, 1).hits, hitsBefore);
});

test('the last player standing wins; placement is the reverse elimination order', () => {
  const st = newMatch(3);
  put(st, 1, 200, 120, 0);
  put(st, 2, 500, 120, Math.PI);
  put(st, 3, 200, 800, 0);
  P(st, 2).lives = 1;
  P(st, 3).lives = 1;
  fireOnce(st, 1, 0);
  stepUntil(st, hasType('elim')); // player 2 out first
  steps(st, 30);
  put(st, 3, 500, 120, Math.PI);
  fireOnce(st, 1, 0);
  stepUntil(st, hasType('end'));
  assert.equal(st.phase, 'ended');
  assert.equal(st.result.reason, 'last');
  assert.deepEqual(st.result.winners, [1]);
  const place = Object.fromEntries(st.result.ranking.map((r) => [r.id, r.place]));
  assert.deepEqual(place, { 1: 1, 3: 2, 2: 3 });
});

test('timer end: the player with the most lives wins', () => {
  const st = newMatch(3, { matchTime: 0.5 });
  P(st, 1).lives = 3;
  P(st, 2).lives = 4;
  P(st, 3).lives = 2;
  const evs = stepUntil(st, hasType('end'), 100);
  assert.equal(st.result.reason, 'timer');
  assert.deepEqual(st.result.winners, [2]);
  assert.equal(evs.find((e) => e.type === 'end').reason, 'timer');
});

test('timer end: equal lives are broken by most hits landed', () => {
  const st = newMatch(3, { matchTime: 0.5 });
  Object.assign(P(st, 1), { lives: 4, hits: 2 });
  Object.assign(P(st, 2), { lives: 4, hits: 3 });
  Object.assign(P(st, 3), { lives: 1, hits: 9 });
  stepUntil(st, hasType('end'), 100);
  assert.deepEqual(st.result.winners, [2]);
  assert.deepEqual(st.result.ranking.map((r) => r.id), [2, 1, 3]);
});

test('timer end: a remaining tie shares the win', () => {
  const st = newMatch(3, { matchTime: 0.5 });
  Object.assign(P(st, 1), { lives: 4, hits: 2 });
  Object.assign(P(st, 2), { lives: 4, hits: 2 });
  Object.assign(P(st, 3), { lives: 4, hits: 1 });
  stepUntil(st, hasType('end'), 100);
  assert.deepEqual(st.result.winners.slice().sort(), [1, 2]);
  const place = Object.fromEntries(st.result.ranking.map((r) => [r.id, r.place]));
  assert.deepEqual(place, { 1: 1, 2: 1, 3: 3 });
});

function doubleKill(hitsA, hitsB, swapRoster) {
  const r = roster(2);
  const st = S.createMatch(swapRoster ? [r[1], r[0]] : r, { skipCountdown: true });
  put(st, 1, 300, 120, 0);
  put(st, 2, 700, 120, Math.PI);
  Object.assign(P(st, 1), { lives: 1, hits: hitsA });
  Object.assign(P(st, 2), { lives: 1, hits: hitsB });
  S.setInput(st, 1, { aim: 0, fire: true });
  S.setInput(st, 2, { aim: Math.PI, fire: true });
  stepUntil(st, hasType('end'), 200);
  return st;
}

test('same-tick double kill: the higher hit count wins', () => {
  for (const swap of [false, true]) {
    const st = doubleKill(2, 1, swap);
    assert.equal(P(st, 1).alive, false);
    assert.equal(P(st, 2).alive, false);
    assert.equal(P(st, 1).elimTick, P(st, 2).elimTick, 'eliminated in the same tick');
    assert.equal(st.result.reason, 'draw');
    assert.deepEqual(st.result.winners, [1]);
  }
});

test('same-tick double kill with equal hits shares the win', () => {
  const st = doubleKill(1, 1, false);
  assert.deepEqual(st.result.winners.slice().sort(), [1, 2]);
  assert.ok(st.result.ranking.every((r) => r.place === 1));
});

test('a disconnected player is eliminated; the last one left wins', () => {
  const st = newMatch(3);
  S.removePlayer(st, 3);
  assert.equal(P(st, 3).alive, false);
  assert.equal(P(st, 3).left, true);
  S.step(st);
  assert.equal(st.phase, 'playing');
  S.removePlayer(st, 2);
  S.step(st);
  assert.equal(st.phase, 'ended');
  assert.deepEqual(st.result.winners, [1]);
});

test('nothing changes after the match has ended', () => {
  const st = newMatch(2);
  S.removePlayer(st, 2);
  S.step(st);
  const snap = JSON.stringify(st.players.map(S.packPlayer));
  S.setInput(st, 1, { mx: 1, my: 0, aim: 0, fire: true });
  steps(st, 30);
  assert.equal(JSON.stringify(st.players.map(S.packPlayer)), snap);
  assert.equal(st.bullets.length, 0);
});

section('Network helpers');

test('untrusted input is sanitized', () => {
  const st = newMatch(2);
  S.setInput(st, 1, { mx: 'a', my: NaN, aim: Infinity, fire: 'yes', reload: {} });
  const inp = P(st, 1).input;
  assert.equal(inp.mx, 0);
  assert.equal(inp.my, 0);
  assert.ok(Number.isFinite(inp.aim));
  assert.equal(inp.fire, false);
  assert.equal(inp.reload, false);
  S.setInput(st, 1, { mx: 3, my: 4, aim: 7 });
  assert.ok(Math.abs(P(st, 1).input.mx - 0.6) < 1e-9 && Math.abs(P(st, 1).input.my - 0.8) < 1e-9);
  assert.ok(Math.abs(P(st, 1).input.aim - (7 - 2 * Math.PI)) < 1e-9);
  S.setInput(st, 99, { mx: 1 }); // unknown player: ignored, no throw
  S.setInput(st, 1, null);
});

test('snapshots pack compactly (1 decimal) and unpack correctly', () => {
  const st = newMatch(2);
  put(st, 1, 123.456, 78.91, 1.23456);
  P(st, 1).invuln = 0.77;
  const a = S.packPlayer(P(st, 1));
  assert.equal(a[1], 123.5);
  assert.equal(a[2], 78.9);
  assert.equal(a[3], 1.23);
  const u = S.unpackPlayer(a);
  assert.equal(u.alive, true);
  assert.equal(u.left, false);
  assert.equal(u.lives, 5);
  const b = S.unpackBullet(S.packBullet({ id: 7, x: 1.26, y: 2.24, vx: 719.99, vy: -0.04, owner: 1 }));
  assert.deepEqual(b, { id: 7, x: 1.3, y: 2.2, vx: 720, vy: -0, owner: 1 });
});

section('Practice vs Bots (headless, full matches)');

function botMatch(level, nBots, seed) {
  const r = roster(nBots + 1);
  const st = S.createMatch(r);
  const bots = r.slice(1).map((p, i) => createBot(p.id, level, seed * 31 + i));
  let totalShots = 0;
  for (let i = 0; i < (C.COUNTDOWN + C.MATCH_TIME + 1) * C.TICK_RATE && st.phase !== 'ended'; i++) {
    // Player 1 is an idle human; every bot thinks each tick.
    for (const b of bots) S.setInput(st, b.id, b.think(st));
    S.step(st);
    totalShots += st.events.filter((e) => e.type === 'shot').length;
    st.events.length = 0;
    for (const p of st.players) {
      assert.ok(p.x >= C.WALL + C.PLAYER_RADIUS - 0.01 && p.x <= C.ARENA_W - C.WALL - C.PLAYER_RADIUS + 0.01);
      assert.ok(p.y >= C.WALL + C.PLAYER_RADIUS - 0.01 && p.y <= C.ARENA_H - C.WALL - C.PLAYER_RADIUS + 0.01);
      for (const s of S.SOLIDS) assert.ok(!S.circleHitsRect(p.x, p.y, C.PLAYER_RADIUS - 0.01, s), 'player inside a wall');
    }
  }
  return { st, totalShots };
}

for (const level of C.BOT_DIFFICULTIES) {
  test(`${level} bots play a full match to a winner`, () => {
    const { st, totalShots } = botMatch(level, 3, 7);
    assert.equal(st.phase, 'ended');
    assert.ok(st.result.winners.length >= 1);
    assert.equal(st.result.ranking.length, 4);
    assert.ok(totalShots > 10, 'bots should actually shoot');
    const hits = st.players.reduce((n, p) => n + p.hits, 0);
    assert.ok(hits >= 5, 'bots should land hits');
    console.log(`      (${level}: ended by "${st.result.reason}" after ${(st.tick / 60).toFixed(1)} s, ${totalShots} shots, ${hits} hits)`);
  });
}

test('six hard bots: the match ends, and it is deterministic with the same seed', () => {
  const a = botMatch('hard', 6, 42).st;
  const b = botMatch('hard', 6, 42).st;
  assert.equal(a.phase, 'ended');
  assert.equal(a.tick, b.tick);
  assert.deepEqual(a.result.ranking, b.result.ranking);
});

// ---- summary -------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
