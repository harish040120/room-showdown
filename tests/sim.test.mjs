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
const R = C.PLAYER_RADIUS;
const floorY = (st) => st.arena.h - C.WALL - R; // center height of a player resting on the floor
function put(st, id, x, y, aim) {
  const p = P(st, id);
  p.x = p.px = x;
  p.y = p.py = y;
  p.vx = p.vy = 0;
  if (aim !== undefined) { p.aim = aim; p.input.aim = aim; }
  return p;
}
const onFloor = (st, id, x, aim) => put(st, id, x, floorY(st), aim);
function steps(st, n) { for (let i = 0; i < n; i++) S.step(st); }
function drain(st) { const e = st.events; st.events = []; return e; }
function fireOnce(st, id, aim) {
  S.setInput(st, id, { aim, fire: true });
  S.step(st);
  S.setInput(st, id, { aim, fire: false });
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
// Park an extra player on the floor near the right wall, out of the way.
function park(st, id) { onFloor(st, id, st.arena.w - C.WALL - 60, -Math.PI / 2); }
const UP = -Math.PI / 2, DOWN = Math.PI / 2;

// ---- tests -------------------------------------------------------------------
section('Setup and arena');

test('every player starts with exactly 5 lives and alive (bullets are unlimited)', () => {
  const st = S.createMatch(roster(7));
  assert.equal(st.players.length, 7);
  for (const p of st.players) {
    assert.equal(p.lives, 5);
    assert.equal('ammo' in p, false);
    assert.equal(p.alive, true);
    assert.equal(p.hits, 0);
  }
  assert.equal(C.LIVES, 5);
});

test('rosters larger than 7 are capped at 7 players', () => {
  const st = S.createMatch(roster(9).map((r, i) => ({ ...r, slot: i % 7 })));
  assert.equal(st.players.length, 7);
  assert.equal(st.arena.n, 7);
});

test('the arena grows with the number of players', () => {
  let prev = null;
  for (let n = 2; n <= 7; n++) {
    const a = S.buildArena(n);
    if (prev) assert.ok(a.w > prev.w && a.h > prev.h, `arena for ${n} should be bigger`);
    prev = a;
  }
  assert.deepEqual([S.buildArena(2).w, S.buildArena(2).h], [1280, 720]);
  assert.deepEqual([S.buildArena(7).w, S.buildArena(7).h], [1780, 1000]);
  for (let n = 2; n <= 7; n++) { const a = S.buildArena(n); assert.ok(Math.abs(a.w / a.h - 16 / 9) < 0.03, 'fits a 16:9 screen'); }
  assert.equal(S.buildArena(1).w, S.buildArena(2).w, 'practice alone still gets the 2-player room');
  assert.equal(newMatch(5).arena.w, S.buildArena(5).w);
});

test('platforms and crates are mirror-symmetric and inside the walls', () => {
  for (let n = 2; n <= 7; n++) {
    const a = S.buildArena(n);
    const obs = a.solids.filter((s) => !s.wall);
    assert.ok(obs.filter((o) => o.kind === 'platform').length >= 5, 'enough platforms');
    const has = (x, y, w, h) => obs.some((o) => Math.abs(o.x - x) < 0.2 && Math.abs(o.y - y) < 0.2 && o.w === w && o.h === h);
    for (const o of obs) {
      assert.ok(has(a.w - o.x - o.w, o.y, o.w, o.h), `mirror missing for ${n} players`);
      assert.ok(o.x > C.WALL && o.x + o.w < a.w - C.WALL && o.y > C.WALL && o.y + o.h <= a.h - C.WALL);
    }
  }
});

test('spawns: one per player, clear of everything, spread out, first two mirrored', () => {
  for (let n = 2; n <= 7; n++) {
    const a = S.buildArena(n);
    assert.equal(a.spawns.length, n);
    for (const sp of a.spawns) {
      assert.ok(!S.circleBlocked(sp.x, sp.y, R + 10, a.solids), `spawn ${sp.x},${sp.y} blocked`);
      assert.equal(sp.aim, sp.x <= a.w / 2 ? 0 : Math.PI, 'faces the middle');
    }
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        assert.ok(Math.hypot(a.spawns[i].x - a.spawns[j].x, a.spawns[i].y - a.spawns[j].y) > 200);
    assert.ok(Math.abs(a.spawns[0].x + a.spawns[1].x - a.w) < 0.2 && a.spawns[0].y === a.spawns[1].y);
  }
  const st = S.createMatch(roster(3));
  assert.deepEqual([st.players[2].x, st.players[2].y], [st.arena.spawns[2].x, st.arena.spawns[2].y]);
});

section('Gravity and recoil');

test('gravity: players fall and come to rest on the floor', () => {
  const st = newMatch(2);
  put(st, 1, 60, 300, 0); // clear of the platforms above
  park(st, 2);
  steps(st, 180);
  const p = P(st, 1);
  assert.ok(Math.abs(p.y - floorY(st)) < 0.01, `resting at y=${p.y}`);
  assert.equal(p.vy, 0);
  assert.equal(p.grounded, true);
  steps(st, 120);
  assert.ok(Math.abs(p.y - floorY(st)) < 0.01, 'does not sink or jitter');
});

test('no shooting, no moving: there is no movement input', () => {
  const st = newMatch(2);
  onFloor(st, 1, 150, 0);
  park(st, 2);
  S.setInput(st, 1, { mx: 1, my: -1, aim: 0, reload: true }); // an old client or a cheater
  steps(st, 120);
  assert.ok(Math.abs(P(st, 1).x - 150) < 0.01 && Math.abs(P(st, 1).y - floorY(st)) < 0.01);
  assert.equal('mx' in P(st, 1).input, false);
});

test('a shot kicks the gun the opposite way: down = up, right = left', () => {
  const st = newMatch(2);
  onFloor(st, 1, 300, DOWN);
  park(st, 2);
  fireOnce(st, 1, DOWN);
  const p = P(st, 1);
  assert.ok(p.vy < -C.RECOIL * 0.9, `vy=${p.vy}`);
  const y0 = p.y;
  steps(st, 10);
  assert.ok(p.y < y0 - 25, `flies up (${y0 - p.y}px)`);
  steps(st, 30); // wait out the cooldown
  put(st, 1, st.arena.w / 2, 150, 0);
  fireOnce(st, 1, 0);
  assert.ok(p.vx < -C.RECOIL * 0.9, `vx=${p.vx}`);
});

test('fast tapping at the floor climbs, slow tapping sinks, stopping falls', () => {
  const tap = (every) => {
    const st = newMatch(2);
    onFloor(st, 1, 150, DOWN);
    park(st, 2);
    for (let i = 0; i < 120; i++) { S.setInput(st, 1, { aim: DOWN, fire: i % every === 0 }); S.step(st); }
    return st;
  };
  const fast = tap(8); // 7.5 taps per second
  assert.ok(floorY(fast) - P(fast, 1).y > 250, `climbed only ${floorY(fast) - P(fast, 1).y}px`);
  const slow = tap(30); // 2 taps per second
  assert.ok(floorY(slow) - P(slow, 1).y < 60, 'slow taps cannot keep you up');
  S.setInput(fast, 1, { aim: DOWN, fire: false });
  steps(fast, 30);
  assert.ok(P(fast, 1).vy > 0, 'falls when you stop shooting');
});

test('platforms are one-way: fly up through them, land on top', () => {
  const st = newMatch(2);
  park(st, 2);
  const plat = st.arena.solids.find((s) => s.kind === 'platform' && Math.abs(s.x + s.w / 2 - st.arena.w / 2) < 1);
  const cx = plat.x + plat.w / 2;
  put(st, 1, cx, plat.y + plat.h + R + 30, DOWN); // just below the platform
  P(st, 1).vy = -900;
  let passed = false;
  for (let i = 0; i < 200; i++) {
    S.step(st);
    if (P(st, 1).y < plat.y - R) passed = true;
  }
  assert.ok(passed, 'went up through the platform');
  assert.ok(Math.abs(P(st, 1).y - (plat.y - R)) < 0.01, `landed on top (y=${P(st, 1).y})`);
  assert.equal(P(st, 1).grounded, true);
});

test('walls, ceiling and crates are solid and speed is capped', () => {
  const st = newMatch(2);
  park(st, 2);
  put(st, 1, 300, 150, 0);
  P(st, 1).vx = -50000;
  P(st, 1).vy = -50000;
  S.step(st);
  assert.ok(Math.hypot(P(st, 1).vx, P(st, 1).vy) <= C.MAX_SPEED + 1e-6, 'speed capped');
  steps(st, 30);
  assert.ok(P(st, 1).x >= C.WALL + R - 0.01 && P(st, 1).y >= C.WALL + R - 0.01, 'stays inside');
  const crate = st.arena.solids.find((s) => s.kind === 'crate');
  onFloor(st, 1, crate.x - R - 40, 0);
  P(st, 1).vx = 600;
  steps(st, 20);
  assert.ok(P(st, 1).x <= crate.x - R + 0.01, 'stopped by the crate');
});

test('countdown: aim works, falling and shooting do not, then 3-2-1-DUEL', () => {
  const st = S.createMatch(roster(2));
  assert.equal(st.phase, 'countdown');
  const sy = P(st, 1).y;
  S.setInput(st, 1, { aim: 1.0, fire: true });
  const evs = [];
  for (let i = 0; i < 179; i++) { S.step(st); evs.push(...drain(st)); }
  assert.equal(st.phase, 'countdown');
  assert.equal(P(st, 1).y, sy, 'frozen in the air');
  assert.equal(P(st, 1).aim, 1.0);
  assert.equal(st.bullets.length, 0);
  assert.deepEqual(evs.filter((e) => e.type === 'count').map((e) => e.n), [3, 2, 1]);
  S.step(st);
  assert.ok(drain(st).some((e) => e.type === 'go'));
  assert.equal(st.phase, 'playing');
  S.setInput(st, 1, { aim: 1.0, fire: false });
  steps(st, 5);
  assert.ok(P(st, 1).y > sy, 'falls after DUEL');
});

test('client prediction uses the same physics as the host (bit-identical)', () => {
  const st = newMatch(2);
  onFloor(st, 1, 300, DOWN);
  park(st, 2);
  const body = { x: P(st, 1).x, y: P(st, 1).y, vx: 0, vy: 0 };
  const plan = (i) => ({ aim: DOWN + Math.sin(i / 20) * 0.6, fire: i % 23 === 0 });
  for (let i = 0; i < 300; i++) {
    const inp = plan(i);
    S.setInput(st, 1, inp);
    const before = P(st, 1).shots;
    S.step(st);
    S.setInput(st, 1, { aim: inp.aim, fire: false });
    if (P(st, 1).shots > before) S.applyRecoil(body, inp.aim);
    S.stepBody(body, S.DT, st.arena);
    assert.ok(Math.abs(body.x - P(st, 1).x) < 1e-9 && Math.abs(body.y - P(st, 1).y) < 1e-9, `diverged at tick ${i}`);
  }
});

section('Pistol: unlimited bullets');

test('unlimited bullets, no reload, at most 7.5 shots per second', () => {
  const st = newMatch(2);
  onFloor(st, 1, 300, UP); // shooting at the ceiling only pushes us into the floor
  park(st, 2);
  S.setInput(st, 1, { aim: UP, fire: true }); // hold the trigger for 10 s
  const shots = [];
  for (let i = 0; i < 600; i++) {
    S.step(st);
    for (const e of drain(st)) {
      assert.ok(e.type !== 'reload', 'there is no reloading');
      if (e.type === 'shot') shots.push(e.tick);
    }
  }
  assert.equal(shots.length, 75, 'never runs out: 7.5 per second for 10 s');
  for (let i = 1; i < shots.length; i++) assert.equal(shots[i] - shots[i - 1], Math.round(C.FIRE_COOLDOWN * 60));
});

test('the host enforces the fire-rate cap even if taps are spammed', () => {
  const st = newMatch(2);
  onFloor(st, 1, 300, UP);
  park(st, 2);
  let shots = 0;
  for (let i = 0; i < 60; i++) {
    S.setInput(st, 1, { aim: UP, fire: true });
    S.setInput(st, 1, { aim: UP, fire: false });
    S.step(st);
    shots += drain(st).filter((e) => e.type === 'shot').length;
  }
  assert.equal(shots, 8); // one second of tapping on every tick
});

test('a quick tap between two ticks still fires (input latch)', () => {
  const st = newMatch(2);
  onFloor(st, 1, 300, UP);
  park(st, 2);
  S.setInput(st, 1, { aim: UP, fire: true });
  S.setInput(st, 1, { aim: UP, fire: false }); // released before the next tick
  S.step(st);
  assert.equal(drain(st).filter((e) => e.type === 'shot').length, 1);
});

section('Bullets and hits');

test('one hit costs exactly one life and credits the shooter', () => {
  const st = newMatch(2);
  onFloor(st, 1, 60, 0);
  onFloor(st, 2, 300, Math.PI);
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
  onFloor(st, 1, 60, 0);
  onFloor(st, 2, 280, Math.PI);
  fireOnce(st, 1, 0);
  stepUntil(st, hasType('hit'));
  const hitTick = st.tick;
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
  steps(st, 30);
  onFloor(st, 1, 60, 0);
  onFloor(st, 2, 280, Math.PI);
  fireOnce(st, 1, 0);
  stepUntil(st, hasType('hit'));
  assert.equal(P(st, 2).lives, 3);
});

test('a hit knocks the target in the direction of the bullet', () => {
  const st = newMatch(2);
  onFloor(st, 1, 60, 0);
  onFloor(st, 2, 300, Math.PI);
  fireOnce(st, 1, 0);
  stepUntil(st, hasType('hit'));
  assert.ok(P(st, 2).vx > C.KNOCKBACK_SPEED * 0.9, `vx=${P(st, 2).vx}`);
});

test('bullets are destroyed by crates, platforms and walls', () => {
  const st = newMatch(2);
  const crate = st.arena.solids.find((s) => s.kind === 'crate' && s.x < st.arena.w / 2);
  onFloor(st, 1, crate.x - 150, 0);
  onFloor(st, 2, crate.x + crate.w + 100, Math.PI);
  fireOnce(st, 1, 0);
  const evs = stepUntil(st, hasType('wall'));
  const wall = evs.find((e) => e.type === 'wall');
  assert.ok(Math.abs(wall.x - (crate.x - C.BULLET_RADIUS)) < 0.6, `hit crate at x=${wall.x}`);
  assert.equal(st.bullets.length, 0);
  steps(st, 60);
  assert.equal(P(st, 2).lives, 5, 'player behind cover is safe');
  const plat = st.arena.solids.find((s) => s.kind === 'platform');
  put(st, 1, plat.x + plat.w / 2, plat.y + plat.h + 120, UP);
  fireOnce(st, 1, UP);
  const evs2 = stepUntil(st, hasType('wall'));
  assert.ok(Math.abs(evs2.find((e) => e.type === 'wall').y - (plat.y + plat.h + C.BULLET_RADIUS)) < 0.6, 'platforms stop bullets from below too');
});

test('shooting point-blank into a crate you are hugging does not pass through it', () => {
  const st = newMatch(2);
  const crate = st.arena.solids.find((s) => s.kind === 'crate' && s.x < st.arena.w / 2);
  onFloor(st, 1, crate.x - R, 0); // touching the crate
  onFloor(st, 2, crate.x + crate.w + 40, Math.PI); // right behind it
  fireOnce(st, 1, 0);
  steps(st, 30);
  assert.equal(P(st, 2).lives, 5);
});

test('no self-damage', () => {
  const st = newMatch(2);
  onFloor(st, 1, 400, 0);
  park(st, 2);
  const y = P(st, 1).y;
  st.bullets.push({ id: 999, owner: 1, x: 300, y, px: 300, py: y, vx: 900, vy: 0, life: 1 });
  steps(st, 30);
  assert.equal(P(st, 1).lives, 5);
  assert.equal(P(st, 1).invuln, 0);
});

test('bullets expire after 1.2 s', () => {
  const st = newMatch(2);
  put(st, 1, 60, 120, 0); // open strip under the ceiling
  park(st, 2);
  fireOnce(st, 1, 0);
  let wallHit = false;
  for (let i = 1; i < 66; i++) { S.step(st); if (drain(st).some((e) => e.type === 'wall')) wallHit = true; }
  assert.equal(st.bullets.length, 1, 'still flying at 1.1 s');
  steps(st, 10);
  assert.equal(st.bullets.length, 0, 'gone by 1.25 s');
  assert.equal(wallHit, false);
});

section('Elimination and winning');

test('at 0 lives a player is eliminated, cannot shoot and cannot be hit', () => {
  const st = newMatch(3);
  onFloor(st, 1, 60, 0);
  onFloor(st, 2, 300, Math.PI);
  park(st, 3);
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
  onFloor(st, 1, 60, 0);
  const hitsBefore = P(st, 1).hits;
  fireOnce(st, 1, 0);
  steps(st, 30);
  assert.equal(P(st, 1).hits, hitsBefore);
});

test('the last player standing wins; placement is the reverse elimination order', () => {
  const st = newMatch(3);
  onFloor(st, 1, 60, 0);
  onFloor(st, 2, 300, Math.PI);
  park(st, 3);
  P(st, 2).lives = 1;
  P(st, 3).lives = 1;
  fireOnce(st, 1, 0);
  stepUntil(st, hasType('elim')); // player 2 out first
  steps(st, 30);
  onFloor(st, 1, 60, 0);
  onFloor(st, 3, 300, Math.PI);
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
  // Mirror images around the middle of the (mirror-symmetric) arena.
  onFloor(st, 1, st.arena.w / 2 - 140, 0);
  onFloor(st, 2, st.arena.w / 2 + 140, Math.PI);
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
  S.setInput(st, 1, { aim: 0, fire: true });
  steps(st, 30);
  assert.equal(JSON.stringify(st.players.map(S.packPlayer)), snap);
  assert.equal(st.bullets.length, 0);
});

section('Network helpers');

test('untrusted input is sanitized', () => {
  const st = newMatch(2);
  S.setInput(st, 1, { mx: 'a', my: NaN, aim: Infinity, fire: 'yes', reload: {} });
  const inp = P(st, 1).input;
  assert.deepEqual(Object.keys(inp).sort(), ['aim', 'fire']);
  assert.ok(Number.isFinite(inp.aim));
  assert.equal(inp.fire, false);
  S.setInput(st, 1, { aim: 7 });
  assert.ok(Math.abs(P(st, 1).input.aim - (7 - 2 * Math.PI)) < 1e-9);
  S.setInput(st, 99, { mx: 1 }); // unknown player: ignored, no throw
  S.setInput(st, 1, null);
});

test('snapshots pack compactly (1 decimal) and unpack correctly', () => {
  const st = newMatch(2);
  put(st, 1, 123.456, 78.91, 1.23456);
  P(st, 1).invuln = 0.77;
  P(st, 1).vx = -321.06;
  P(st, 1).vy = 12.34;
  const a = S.packPlayer(P(st, 1));
  assert.equal(a.length, 11);
  assert.equal(a[1], 123.5);
  assert.equal(a[2], 78.9);
  assert.equal(a[3], 1.23);
  const u = S.unpackPlayer(a);
  assert.equal(u.alive, true);
  assert.equal(u.left, false);
  assert.equal(u.lives, 5);
  assert.equal(u.vx, -321.1);
  assert.equal(u.vy, 12.3);
  assert.equal(u.invuln, 0.8);
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
      assert.ok(p.x >= C.WALL + R - 0.01 && p.x <= st.arena.w - C.WALL - R + 0.01);
      assert.ok(p.y >= C.WALL + R - 0.01 && p.y <= st.arena.h - C.WALL - R + 0.01);
      // (one-way platforms can be overlapped while flying up through them)
      for (const s of st.arena.solids) if (s.kind !== 'platform') assert.ok(!S.circleHitsRect(p.x, p.y, R - 0.01, s), 'player inside a wall');
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
