// Room Showdown: the game controller. Wires simulation, networking, input, rendering and UI.
//
// Modes:
//   'menu'     a muted bot demo plays behind the menu
//   'practice' local authority: you + bots, fully offline
//   'host'     local authority + PeerJS host: simulates, broadcasts snapshots and events
//   'client'   predicts its own flight (gravity + recoil), interpolates everyone else ~100 ms in the past,
//              and plays events when that "render time" reaches them (so effects line up)

import { CONFIG } from './config.js';
import * as S from './sim.js';
import { createBot, BOT_NAMES } from './bots.js';
import * as net from './net.js';
import * as audio from './audio.js';
import { createInput } from './input.js';
import { createRenderer, createHud } from './render.js';
import { createUI } from './ui.js';

const C = CONFIG;
const DT = S.DT;
const TICK_MS = DT * 1000;
const HOST_ID = 1;

const canvas = document.getElementById('game');
const renderer = createRenderer(canvas);
const hud = createHud();
const input = createInput(canvas, { onMenu: () => { if (G.screen === 'match') ui.togglePause(); } });

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
const G = {
  mode: 'menu',     // 'menu' | 'practice' | 'host' | 'client'
  screen: 'menu',   // 'menu' | 'lobby' | 'match' | 'results'
  myId: null,
  roster: [],       // [{id, name, color, slot}] of the current match
  arena: null,      // arena of the current match (its size depends on the player count)
  rosterById: new Map(),
  sim: null,        // authority simulation (practice / host)
  demo: null,       // background bot demo
  endTimer: null,
  lastResults: null,
  // practice
  practiceCfg: null,
  practiceWins: {},
  // room (host + client)
  code: '',
  members: new Map(), // host: id -> member; client: id -> lobby entry
  roomPhase: 'lobby', // 'lobby' | 'match' | 'results'
  wins: {},
  nextId: 2,
  peerToId: new Map(),
  pendingEvents: [],
  snapAcc: 0,
  signalOk: true,
  lobbyTimer: null,
  // client
  cl: null,
  welcome: null,
  lastTimerSec: null,
};
// Read-only peek for debugging and automated tests. The host stays authoritative either way.
window.__roomShowdown = G;
G.toScreen = (x, y) => renderer.worldToScreen(x, y);

// ---------------------------------------------------------------------------
// Authority simulation wrapper (practice, host, demo)
// ---------------------------------------------------------------------------
function makeSim(roster, bots, opts = {}) {
  return { state: S.createMatch(roster, opts), bots, acc: 0, last: performance.now(), running: true };
}

/** Advance a sim by real elapsed time with a fixed timestep. Returns the produced events. */
function advance(sim, now, beforeStep) {
  let elapsed = (now - sim.last) / 1000;
  sim.last = now;
  if (!sim.running) return [];
  if (elapsed > 0.25) elapsed = 0.25; // after a long stall, slow down instead of spiralling
  if (elapsed < 0) elapsed = 0;
  sim.acc += elapsed;
  const out = [];
  let n = 0;
  if (sim.acc >= DT && beforeStep) beforeStep(sim.state);
  while (sim.acc >= DT && n < 16) {
    const st = sim.state;
    for (const b of sim.bots) S.setInput(st, b.id, b.think(st, DT));
    if (G.mode === 'host' && sim === G.sim) zeroStaleInputs(st, now);
    S.step(st);
    sim.acc -= DT;
    n++;
    if (st.events.length) { for (const e of st.events) out.push(e); st.events = []; }
  }
  if (n >= 16) sim.acc = 0;
  return out;
}

function simView(sim) {
  const st = sim.state;
  const a = Math.max(0, Math.min(1, sim.acc / DT));
  const players = st.players.map((p) => ({
    id: p.id, name: p.name, color: p.color, slot: p.slot,
    x: p.px + (p.x - p.px) * a, y: p.py + (p.y - p.py) * a,
    aim: p.aim, lives: p.lives, alive: p.alive, invuln: p.invuln,
  }));
  const bullets = st.bullets.map((b) => ({
    owner: b.owner, vx: b.vx, vy: b.vy, x: b.px + (b.x - b.px) * a, y: b.py + (b.y - b.py) * a,
  }));
  return { arena: st.arena, players, bullets };
}

function setRoster(roster) {
  G.roster = roster.map((r) => ({ id: r.id, name: r.name, color: r.color, slot: r.slot }));
  G.rosterById = new Map(G.roster.map((r) => [r.id, r]));
}

// ---------------------------------------------------------------------------
// Menu demo
// ---------------------------------------------------------------------------
function startDemo() {
  const n = 4;
  const seed = (Math.random() * 1e9) | 0;
  const roster = Array.from({ length: n }, (_, i) => ({ id: 100 + i, name: BOT_NAMES[(seed + i) % BOT_NAMES.length], color: C.COLORS[i * 2 % 7], slot: (i * 2) % 7 }));
  const bots = roster.map((r, i) => createBot(r.id, i % 2 ? 'normal' : 'hard', seed + i * 7));
  G.demo = makeSim(roster, bots, { skipCountdown: true });
  G.demo.endAt = 0;
}

function demoFrame(now) {
  if (!G.demo) startDemo();
  const d = G.demo;
  const evs = advance(d, now);
  if (evs.length) playEvents(evs, { silent: true, rosterOf: (id) => S.getPlayer(d.state, id) });
  if (d.state.phase === 'ended') {
    if (!d.endAt) d.endAt = now + 2500;
    else if (now > d.endAt) startDemo();
  }
}

// ---------------------------------------------------------------------------
// Effects + sounds from simulation events (shared by every mode)
// ---------------------------------------------------------------------------
const panOf = (x) => ((x / (G.arena ? G.arena.w : C.ARENA_BASE_W)) * 2 - 1) * 0.6;
const vibrate = (ms) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch { /* ignore */ } };

function infoOf(id, rosterOf) {
  const r = rosterOf ? rosterOf(id) : G.rosterById.get(id);
  return r || { name: '?', color: '#ffffff', slot: 0 };
}

function playEvents(evs, { silent = false, rosterOf = null, skipMyShot = null } = {}) {
  const fx = renderer.fx;
  const me = G.myId;
  const snd = (name, opts) => { if (!silent) audio.play(name, opts); };
  for (const e of evs) {
    switch (e.type) {
      case 'count':
        if (!silent) { hud.banner(String(e.n)); snd('count'); }
        break;
      case 'go':
        if (!silent) { hud.banner('DUEL!', { cls: 'go' }); snd('go'); }
        break;
      case 'shot':
        if (e.id === me && skipMyShot && skipMyShot()) break; // already shown by client prediction
        fx.muzzle(e.id);
        snd('shot', { pan: panOf(e.x), vol: e.id === me ? 0.9 : 0.55 });
        break;
      case 'wall':
        fx.spark(e.x, e.y);
        if (e.owner === me) snd('wall', { pan: panOf(e.x) });
        break;
      case 'hit': {
        const t = infoOf(e.id, rosterOf);
        const isMe = e.id === me;
        fx.hit(e.x, e.y, e.a, t.color, isMe);
        if (isMe) { snd('hurt'); vibrate(70); }
        else snd('hit', { pan: panOf(e.x), vol: e.by === me ? 1 : 0.6 });
        break;
      }
      case 'elim': {
        const t = infoOf(e.id, rosterOf);
        fx.death(e.id, e.x, e.y, t.color, e.id === me);
        snd('elim', { pan: panOf(e.x) });
        if (!silent) {
          if (e.reason === 'left') hud.feed([{ text: t.name, color: t.color }, { text: ' left the room' }]);
          else if (e.by !== null && e.by !== undefined) {
            const k = infoOf(e.by, rosterOf);
            hud.feed([{ text: k.name, color: k.color }, { text: ' eliminated ' }, { text: t.name, color: t.color }]);
          } else hud.feed([{ text: t.name, color: t.color }, { text: ' is out' }]);
          if (e.id === me) { hud.banner("You're out!", { cls: 'out', ms: 1600 }); vibrate([80, 60, 120]); }
        }
        break;
      }
      case 'end': {
        if (silent) break;
        const names = e.winners.map((id) => infoOf(id, rosterOf).name);
        const iWon = e.winners.includes(me);
        let text = names.length === 1 ? `${names[0]} wins!` : 'Tie!';
        if (iWon && names.length === 1) text = 'You win!';
        hud.banner(text, { cls: 'win', ms: C.END_DELAY_MS });
        snd(iWon ? 'win' : 'lose');
        break;
      }
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
function setScreen(name) {
  G.screen = name;
  const inMatch = name === 'match';
  document.body.classList.toggle('in-match', inMatch);
  hud.show(inMatch);
  if (!inMatch) ui.closeAllModals();
  ui.showScreen(inMatch ? null : name);
  input.setEnabled(inMatch && !ui.paused);
  document.getElementById('host-notice').classList.toggle('hidden', !(inMatch && G.mode === 'host'));
  renderer.setTopInset(inMatch ? hud.height : 0);
  keepAwake(name !== 'menu');
}

function showMenu() {
  G.mode = 'menu';
  G.myId = null;
  setScreen('menu');
}

function enterMatch() {
  renderer.fx.clear();
  hud.reset();
  hud.setRoster(G.roster);
  G.lastTimerSec = null;
  ui.hidePause();
  setScreen('match');
  const me = G.rosterById.get(G.myId);
  if (me && G.arena) {
    const sp = G.arena.spawns[G.roster.indexOf(me)];
    if (sp) input.setAim(sp.aim);
  }
}

function showResults(result, wins, canRestart) {
  G.lastResults = { result, wins };
  ui.renderResults({ results: result, wins, myId: G.myId, canRestart, practice: G.mode === 'practice' });
  setScreen('results');
}

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------
function teardown() {
  clearTimeout(G.endTimer);
  G.endTimer = null;
  clearInterval(G.lobbyTimer);
  G.lobbyTimer = null;
  if (G.welcome) { G.welcome.reject(new net.NetError('cancelled')); G.welcome = null; }
  if (G.mode === 'host' || G.mode === 'client') {
    net.send({ t: 'bye' });
    net.close(400); // let the goodbye arrive
  } else {
    net.close();
  }
  G.sim = null;
  G.cl = null;
  G.members = new Map();
  G.peerToId = new Map();
  G.pendingEvents = [];
  G.wins = {};
  G.code = '';
  G.arena = null;
  setRoster([]);
}

function leave() {
  teardown();
  showMenu();
}

// ---------------------------------------------------------------------------
// Practice
// ---------------------------------------------------------------------------
function startPractice(name, botCount, level) {
  teardown();
  G.mode = 'practice';
  G.myId = HOST_ID;
  if (!G.practiceCfg || G.practiceCfg.name !== name) G.practiceWins = {};
  G.practiceCfg = { name, botCount, level };
  const names = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
  const roster = [{ id: HOST_ID, name, color: C.COLORS[0], slot: 0 }];
  for (let i = 1; i <= botCount; i++) roster.push({ id: HOST_ID + i, name: names[i - 1], color: C.COLORS[i], slot: i });
  const seed = (Math.random() * 1e9) | 0;
  const bots = roster.slice(1).map((r, i) => createBot(r.id, level, seed + i * 101));
  setRoster(roster);
  G.sim = makeSim(roster, bots);
  G.arena = G.sim.state.arena;
  enterMatch();
}

// ---------------------------------------------------------------------------
// Authority (practice + host) per-frame work
// ---------------------------------------------------------------------------
function sampleLocalInto(st) {
  const p = S.getPlayer(st, G.myId);
  if (!p) return;
  const scr = renderer.worldToScreen(p.x, p.y);
  S.setInput(st, G.myId, input.sample({ playerScreen: scr }));
}

function authorityPump(now) {
  const sim = G.sim;
  if (!sim) return;
  const evs = advance(sim, now, G.screen === 'match' ? sampleLocalInto : null);
  if (evs.length) {
    if (G.mode === 'host') for (const e of evs) G.pendingEvents.push(e);
    playEvents(evs);
  }
  if (G.mode === 'host') maybeBroadcast(now);
  if (sim.state.phase === 'ended' && sim.running && !G.endTimer) {
    G.endTimer = setTimeout(finishMatch, C.END_DELAY_MS);
  }
}

function finishMatch() {
  G.endTimer = null;
  const sim = G.sim;
  if (!sim || !sim.state.result) return;
  sim.running = false;
  const result = sim.state.result;
  if (G.mode === 'practice') {
    for (const id of result.winners) G.practiceWins[id] = (G.practiceWins[id] || 0) + 1;
    showResults(result, G.practiceWins, true);
  } else if (G.mode === 'host') {
    for (const id of result.winners) G.wins[id] = (G.wins[id] || 0) + 1;
    for (const m of G.members.values()) m.wins = G.wins[m.id] || 0;
    broadcastSnapshot(); // flush the last events
    G.roomPhase = 'results';
    net.send({ t: 'results', result, wins: G.wins });
    broadcastLobby();
    showResults(result, G.wins, true);
  }
}

function playAgain() {
  if (G.mode === 'practice') {
    const c = G.practiceCfg;
    startPractice(c.name, c.botCount, c.level);
  } else if (G.mode === 'host') {
    hostStart();
  }
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------
function memberList() {
  return [...G.members.values()].sort((a, b) => a.slot - b.slot).map((m) => ({
    id: m.id, name: m.name, color: m.color, slot: m.slot, wins: G.wins[m.id] || 0,
    spectator: !!m.spectator, ping: m.peer ? net.getClientPing(m.peer) : null,
  }));
}

function broadcastLobby() {
  if (G.mode !== 'host') return;
  net.send({ t: 'lobby', members: memberList(), phase: G.roomPhase });
  if (G.screen === 'lobby') renderLobby();
}

function renderLobby() {
  ui.renderLobby({
    code: G.code,
    players: G.mode === 'host' ? memberList() : [...G.members.values()],
    myId: G.myId,
    hostId: HOST_ID,
    isHost: G.mode === 'host',
    status: G.mode === 'client' && G.roomPhase === 'match' ? 'A match is in progress. You will watch it and play in the next one.' : '',
    signalOk: G.signalOk,
  });
}

function uniqueName(name) {
  const taken = new Set([...G.members.values()].map((m) => m.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; n < 20; n++) {
    const suffix = ' ' + n;
    const cand = Array.from(name).slice(0, C.NAME_MAX - suffix.length).join('').trim() + suffix;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return name;
}

function freeSlot() {
  const used = new Set([...G.members.values()].map((m) => m.slot));
  for (let i = 0; i < C.MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return -1;
}

async function createRoom(name) {
  teardown();
  if (!net.isSupported()) return showNetError(new net.NetError('unsupported'));
  let cancelled = false;
  ui.connecting('Creating a room…', () => { cancelled = true; net.close(); });
  let code;
  try {
    setupHostHandlers();
    code = await net.createRoom();
  } catch (err) {
    ui.connecting(null);
    if (cancelled || (err && err.code === 'cancelled')) return;
    const choice = await showNetError(err, true);
    if (choice === 'retry') createRoom(name);
    return;
  }
  ui.connecting(null);
  G.mode = 'host';
  G.myId = HOST_ID;
  G.code = code;
  G.nextId = HOST_ID + 1;
  G.roomPhase = 'lobby';
  G.signalOk = true;
  G.members = new Map([[HOST_ID, { id: HOST_ID, name, color: C.COLORS[0], slot: 0, peer: null, spectator: false, lastSeq: 0, lastInputAt: 0 }]]);
  G.lobbyTimer = setInterval(() => { if (G.roomPhase === 'lobby') broadcastLobby(); }, 2000);
  setScreen('lobby');
  renderLobby();
}

function setupHostHandlers() {
  net.onConnect((peer) => {
    // Drop connections that never introduce themselves.
    setTimeout(() => { if (G.mode === 'host' && !G.peerToId.has(peer)) net.kick(peer); }, 10000);
  });
  net.onMessage((msg, peer) => {
    try { hostMessage(msg, peer); } catch (e) { console.warn('[RoomShowdown] bad message', e); }
  });
  net.onDisconnect((peer) => hostDropPeer(peer));
  net.onStatus((s) => {
    G.signalOk = s !== 'signal-lost';
    if (G.screen === 'lobby') renderLobby();
  });
}

function hostMessage(msg, peer) {
  if (G.mode !== 'host') return;
  if (msg.t === 'hello') {
    if (G.peerToId.has(peer)) return;
    if (msg.v !== C.PROTOCOL) { net.kick(peer, { t: 'reject', reason: 'version' }); return; }
    const slot = freeSlot();
    if (slot < 0) { net.kick(peer, { t: 'reject', reason: 'full' }); return; }
    const id = G.nextId++;
    const name = uniqueName(S.cleanName(msg.name) || 'Player');
    const m = { id, name, color: C.COLORS[slot], slot, peer, spectator: G.roomPhase === 'match', lastSeq: 0, lastInputAt: 0 };
    G.members.set(id, m);
    G.peerToId.set(peer, id);
    net.send({ t: 'welcome', id, code: G.code, v: C.PROTOCOL }, peer);
    if (G.roomPhase === 'match' && G.sim) net.send({ t: 'start', roster: G.roster }, peer);
    if (G.roomPhase === 'results' && G.lastResults) net.send({ t: 'results', result: G.lastResults.result, wins: G.wins }, peer);
    broadcastLobby();
    audio.play('join');
    if (G.screen !== 'lobby') ui.toast(`${name} joined${m.spectator ? ' (watching until the next match)' : ''}`);
    return;
  }
  if (msg.t === 'bye') { hostDropPeer(peer); net.kick(peer); return; }
  const id = G.peerToId.get(peer);
  const m = id !== undefined ? G.members.get(id) : null;
  if (!m) return;
  if (msg.t === 'in') {
    if (!G.sim || G.roomPhase !== 'match') return;
    const s = Number(msg.s);
    if (!Number.isFinite(s) || s <= m.lastSeq) return; // old or duplicate
    m.lastSeq = s;
    m.lastInputAt = performance.now();
    m.lastInputTick = G.sim.state.tick;
    S.setInput(G.sim.state, id, msg);
  }
}

function hostDropPeer(peer) {
  if (G.mode !== 'host') return;
  const id = G.peerToId.get(peer);
  G.peerToId.delete(peer);
  if (id === undefined) return;
  const m = G.members.get(id);
  G.members.delete(id);
  if (G.sim && G.roomPhase === 'match') S.removePlayer(G.sim.state, id);
  broadcastLobby();
  audio.play('leave');
  if (m && G.screen !== 'match') ui.toast(`${m.name} left`);
}

function zeroStaleInputs(st, now) {
  for (const m of G.members.values()) {
    if (!m.peer) continue;
    if (now - m.lastInputAt > C.INPUT_STALE_MS) {
      const p = S.getPlayer(st, m.id);
      if (p && p.input.fire) p.input = { ...p.input, fire: false };
    }
  }
}

function hostStart() {
  if (G.mode !== 'host') return;
  if (G.members.size < 2) { ui.toast('You need at least 2 players'); return; }
  clearTimeout(G.endTimer);
  G.endTimer = null;
  const roster = [...G.members.values()].sort((a, b) => a.slot - b.slot)
    .map((m) => ({ id: m.id, name: m.name, color: m.color, slot: m.slot }));
  const now = performance.now();
  for (const m of G.members.values()) { m.spectator = false; m.lastInputAt = now; m.lastSeq = 0; m.lastInputTick = 0; }
  setRoster(roster);
  G.sim = makeSim(roster, []);
  G.arena = G.sim.state.arena;
  G.pendingEvents = [];
  G.snapAcc = 0;
  G.roomPhase = 'match';
  net.send({ t: 'start', roster });
  broadcastLobby();
  enterMatch();
  broadcastSnapshot();
}

function maybeBroadcast(now) {
  if (!G.sim) return;
  if (now - G.snapAcc >= 1000 / C.SNAPSHOT_RATE) {
    G.snapAcc = now;
    broadcastSnapshot();
  }
}

function broadcastSnapshot() {
  const st = G.sim && G.sim.state;
  if (!st) return;
  const base = {
    t: 'snap', k: st.tick, ph: st.phase, cd: S.r2(st.countdown), tl: S.r1(st.timeLeft),
    p: st.players.map(S.packPlayer), b: st.bullets.map(S.packBullet), e: G.pendingEvents,
  };
  G.pendingEvents = [];
  // a = last input applied, at = host ticks simulated since then (for client reconciliation)
  for (const m of G.members.values()) {
    if (m.peer) net.send({ ...base, a: m.lastSeq, at: Math.max(0, st.tick - (m.lastInputTick || 0)) }, m.peer);
  }
}

function inviteUrl() {
  return `${location.origin}${location.pathname}#${G.code}`;
}

async function copyInvite() {
  const url = inviteUrl();
  try {
    await navigator.clipboard.writeText(url);
    ui.toast('Invite link copied!');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    ui.toast(ok ? 'Invite link copied!' : `Share this link: ${url}`, ok ? 2600 : 6000);
  }
}

async function shareInvite() {
  try {
    await navigator.share({ title: 'Room Showdown', text: `Join my Room Showdown game! Room code: ${G.code}`, url: inviteUrl() });
  } catch { /* cancelled */ }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
function newClientState() {
  return {
    snaps: [],          // [{k, players: Map}]
    offset: null,       // local ms - host tick time
    events: [],         // queued until render time reaches them
    births: new Map(),  // bullet id -> tick fired
    phase: 'countdown', tl: C.MATCH_TIME, cd: C.COUNTDOWN,
    serverMe: null,
    pred: null,         // predicted body of my player {x, y, vx, vy}
    corr: { x: 0, y: 0 },
    pending: [],        // [{seq, ticks: [{aim, fire}, ...]}] sent but not yet acknowledged
    unsent: [],         // predicted ticks not sent yet
    predAcc: 0,
    seq: 0,
    sendAcc: 0,
    fire: false, aim: 0,
    predCd: 0,
    predShots: [],      // local times of shots shown before the host confirmed them
    stats: { n: 0, sum: 0, max: 0, snaps: 0 }, // prediction error, for debugging (window.__roomShowdown)
  };
}

async function joinRoom(name, code) {
  teardown();
  if (!net.isSupported()) return showNetError(new net.NetError('unsupported'));
  let cancelled = false;
  ui.connecting(`Joining room ${code}…`, () => { cancelled = true; teardown(); });
  try {
    net.onMessage((msg) => { try { clientMessage(msg); } catch (e) { console.warn('[RoomShowdown] bad message', e); } });
    net.onDisconnect((_id, reason) => clientLost(reason));
    net.onStatus(() => {});
    await net.joinRoom(code);
    const welcome = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new net.NetError('timeout', 'The host did not answer')), 8000);
      G.welcome = {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
    net.send({ t: 'hello', name, v: C.PROTOCOL });
    const w = await welcome;
    G.welcome = null;
    ui.connecting(null);
    G.mode = 'client';
    G.myId = w.id;
    G.code = code;
    G.roomPhase = 'lobby';
    G.cl = newClientState();
    setScreen('lobby');
    renderLobby();
  } catch (err) {
    G.welcome = null;
    ui.connecting(null);
    if (cancelled || (err && err.code === 'cancelled')) return;
    teardown();
    showMenu();
    const choice = await showNetError(err, true, code);
    if (choice === 'retry') joinRoom(name, code);
  }
}

function clientMessage(m) {
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'welcome') { if (G.welcome) G.welcome.resolve(m); return; }
  if (m.t === 'reject') {
    const err = new net.NetError(m.reason === 'full' ? 'full' : 'version');
    if (G.welcome) { G.welcome.reject(err); return; }
    teardown(); showMenu(); showNetError(err);
    return;
  }
  if (G.mode !== 'client') return;
  switch (m.t) {
    case 'lobby':
      if (!Array.isArray(m.members)) return;
      G.members = new Map(m.members.map((e) => [e.id, e]));
      G.roomPhase = m.phase;
      if (G.screen === 'lobby') renderLobby();
      break;
    case 'start':
      if (!Array.isArray(m.roster)) return;
      setRoster(m.roster);
      G.arena = S.buildArena(Math.min(m.roster.length, C.MAX_PLAYERS));
      G.cl = newClientState();
      G.roomPhase = 'match';
      enterMatch();
      break;
    case 'snap':
      clientSnap(m);
      break;
    case 'bye':
      clientLost('bye');
      break;
    case 'results':
      G.roomPhase = 'results';
      // play any queued events (end banner) right away
      if (G.cl && G.cl.events.length) { playEvents(G.cl.events, { skipMyShot: () => true }); G.cl.events = []; }
      showResults(m.result, m.wins || {}, false);
      break;
    default:
      break;
  }
}

function clientLost(reason) {
  if (G.mode !== 'client') return;
  teardown();
  showMenu();
  const why = reason === 'bye'
    ? 'The host closed the room.'
    : reason === 'timeout'
    ? 'The connection to the host timed out. Their tab may be closed or their screen locked.'
    : 'The host closed the room or lost their connection.';
  ui.alert('Disconnected', why);
}

function clientSnap(m) {
  const cl = G.cl;
  if (!cl || !Array.isArray(m.p)) return;
  const now = performance.now();
  const k = Number(m.k) || 0;
  const off = now - k * TICK_MS;
  if (cl.offset === null || off < cl.offset) cl.offset = off;
  else cl.offset += (off - cl.offset) * 0.02; // drift up slowly: tolerate jitter

  const players = new Map();
  for (const a of m.p) { const u = S.unpackPlayer(a); players.set(u.id, u); }
  const bullets = Array.isArray(m.b) ? m.b.map(S.unpackBullet) : [];
  const last = cl.snaps[cl.snaps.length - 1];
  if (!last || k > last.k) {
    cl.snaps.push({ k, players, bullets });
    if (cl.snaps.length > 40) cl.snaps.shift();
  }
  if (Array.isArray(m.e)) for (const e of m.e) {
    if (e.type === 'shot') cl.births.set(e.b, e.tick);
    cl.events.push(e);
  }
  if (cl.births.size > 300) { const keys = [...cl.births.keys()]; for (let i = 0; i < 150; i++) cl.births.delete(keys[i]); }
  cl.phase = m.ph;
  cl.tl = m.tl;
  cl.cd = m.cd;

  // Reconcile my predicted position with the authoritative one.
  const sm = players.get(G.myId) || null;
  cl.serverMe = sm;
  if (!sm) return;
  if (!sm.alive || cl.phase !== 'playing' || !cl.pred || !G.arena) {
    cl.pred = { x: sm.x, y: sm.y, vx: sm.vx, vy: sm.vy };
    cl.corr.x = cl.corr.y = 0;
    cl.pending = [];
    cl.unsent = [];
    return;
  }
  // Start from the host's state and replay every predicted tick it has not seen yet.
  const ack = Number(m.a) || 0;
  while (cl.pending.length && cl.pending[0].seq <= ack) cl.pending.shift();
  const ticks = [];
  for (const ent of cl.pending) for (const t of ent.ticks) ticks.push(t);
  for (const t of cl.unsent) ticks.push(t);
  // The host already simulated `at` ticks after applying the acknowledged input: they cover
  // our first `at` predicted ticks. Shots in them reach the host later, so keep their kick.
  const skip = Math.min(ticks.length, Math.max(0, Number(m.at) || 0));
  const R = { x: sm.x, y: sm.y, vx: sm.vx, vy: sm.vy };
  for (let i = 0; i < ticks.length; i++) {
    if (ticks[i].fire) S.applyRecoil(R, ticks[i].aim);
    if (i >= skip) S.stepBody(R, DT, G.arena);
  }
  cl.pred.vx = R.vx;
  cl.pred.vy = R.vy;
  const ex = R.x - cl.pred.x, ey = R.y - cl.pred.y;
  const err = Math.hypot(ex, ey);
  cl.stats.n++; cl.stats.sum += err; if (err > cl.stats.max) cl.stats.max = err;
  if (err > C.RECONCILE_SNAP_PX) {
    cl.stats.snaps++;
    cl.pred.x = R.x; cl.pred.y = R.y; cl.corr.x = cl.corr.y = 0;
  } else {
    cl.corr.x = ex; cl.corr.y = ey; // blended in over the next frames
  }
}

function clientFrame(now, dt) {
  const cl = G.cl;
  if (!cl || G.screen !== 'match') return null;
  const sm = cl.serverMe;
  const inRoster = G.rosterById.has(G.myId);
  const alive = !!(sm && sm.alive) && inRoster;
  const canMove = alive && cl.phase === 'playing';

  // --- local input + prediction ---
  if (cl.pred && alive) {
    const k = 1 - Math.exp(-dt * 12);
    cl.pred.x += cl.corr.x * k; cl.pred.y += cl.corr.y * k;
    cl.corr.x -= cl.corr.x * k; cl.corr.y -= cl.corr.y * k;
  }
  const scr = cl.pred ? renderer.worldToScreen(cl.pred.x, cl.pred.y) : null;
  const inp = input.sample({ playerScreen: scr });
  cl.aim = inp.aim;
  if (inRoster) cl.fire = cl.fire || inp.fire;

  // Predict my own flight with the same fixed-step physics as the host. A predicted shot
  // kicks immediately and shows its flash + sound; the host's echo of it is then skipped.
  if (canMove && cl.pred && G.arena) {
    cl.predAcc += dt;
    let n = 0;
    while (cl.predAcc >= DT && n < 8) {
      cl.predAcc -= DT;
      n++;
      cl.predCd = Math.max(0, cl.predCd - DT);
      let fired = false;
      if (inp.fire && cl.predCd <= 1e-6) {
        fired = true;
        cl.predCd = C.FIRE_COOLDOWN;
        S.applyRecoil(cl.pred, cl.aim);
        cl.predShots.push(now);
        renderer.fx.muzzle(G.myId);
        audio.play('shot', { pan: panOf(cl.pred.x), vol: 0.9 });
      }
      S.stepBody(cl.pred, DT, G.arena);
      cl.unsent.push({ aim: cl.aim, fire: fired });
    }
    if (n >= 8) cl.predAcc = 0;
  } else {
    cl.predAcc = 0;
  }

  // --- send input to the host ---
  cl.sendAcc += dt;
  if (inRoster && cl.sendAcc >= 1 / C.INPUT_RATE) {
    cl.sendAcc = 0;
    cl.seq++;
    net.send({ t: 'in', s: cl.seq, aim: S.r3(cl.aim), fire: cl.fire });
    cl.pending.push({ seq: cl.seq, ticks: cl.unsent });
    if (cl.pending.length > 90) cl.pending.shift();
    cl.unsent = [];
    cl.fire = false;
  }

  // --- render time & interpolation ---
  if (!cl.snaps.length || cl.offset === null) return null;
  const rt = (now - cl.offset - C.INTERP_DELAY_MS) / TICK_MS; // in host ticks
  let a = cl.snaps[0], b = cl.snaps[0];
  for (let i = cl.snaps.length - 1; i >= 0; i--) {
    if (cl.snaps[i].k <= rt) { a = cl.snaps[i]; b = cl.snaps[Math.min(i + 1, cl.snaps.length - 1)]; break; }
  }
  const span = b.k - a.k;
  const t = span > 0 ? Math.max(0, Math.min(1, (rt - a.k) / span)) : 0;

  // events whose time has come
  if (cl.events.length) {
    const due = [];
    const keep = [];
    for (const e of cl.events) (e.tick <= rt || cl.events.length > 200 ? due : keep).push(e);
    cl.events = keep;
    if (due.length) playEvents(due, { skipMyShot: () => cl.predShots.shift() !== undefined });
  }
  // A predicted shot the host never confirmed (it rejected it) is forgotten after a while.
  while (cl.predShots.length && now - cl.predShots[0] > C.INTERP_DELAY_MS + 1000) cl.predShots.shift();

  const players = [];
  for (const r of G.roster) {
    const pb = b.players.get(r.id);
    if (!pb) continue;
    const pa = a.players.get(r.id) || pb;
    let x = pa.x + (pb.x - pa.x) * t;
    let y = pa.y + (pb.y - pa.y) * t;
    let aim = pa.aim + S.wrapAngle(pb.aim - pa.aim) * t;
    const latest = cl.snaps[cl.snaps.length - 1].players.get(r.id) || pb;
    let alivePl = pb.alive && (t >= 1 || pa.alive);
    if (r.id === G.myId && cl.pred && latest.alive) {
      x = cl.pred.x; y = cl.pred.y; aim = cl.aim; alivePl = true;
    }
    players.push({ id: r.id, name: r.name, color: r.color, slot: r.slot, x, y, aim, lives: pb.lives, alive: alivePl, invuln: pb.invuln });
  }
  const bullets = [];
  const aIds = new Map(a.bullets.map((x) => [x.id, x]));
  for (const bb of b.bullets) {
    const birth = cl.births.get(bb.id);
    if (birth !== undefined && rt < birth) continue;
    const ba = aIds.get(bb.id);
    let x, y;
    if (ba && span > 0) { x = ba.x + (bb.x - ba.x) * t; y = ba.y + (bb.y - ba.y) * t; }
    else { const back = Math.max(0, b.k - rt) * DT; x = bb.x - bb.vx * back; y = bb.y - bb.vy * back; }
    bullets.push({ owner: bb.owner, vx: bb.vx, vy: bb.vy, x, y });
  }
  return { arena: G.arena, players, bullets };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
function showNetError(err, canRetry = false, code = '') {
  const c = err && err.code;
  const msgs = {
    unsupported: ['Not supported', 'This browser cannot make peer-to-peer connections (WebRTC). Try a recent Chrome, Firefox, Safari or Edge. Practice vs Bots still works!'],
    server: ['No connection', 'Could not reach the connection server. Check your internet connection and try again. Practice vs Bots works offline.'],
    'not-found': ['Room not found', `There is no room${code ? ` with code ${code}` : ''}. Check the code, and make sure the host still has the game open.`],
    timeout: ['Could not connect', 'The room exists, but a direct connection to the host failed. Strict networks (school or office Wi-Fi) can block this: try mobile data, or ask the host to set up a TURN server (see README).'],
    full: ['Room is full', `That room already has ${C.MAX_PLAYERS} players.`],
    version: ['Different versions', 'You and the host are running different versions of the game. Both of you, please refresh the page.'],
  };
  const [title, text] = msgs[c] || ['Connection error', (err && err.message) || 'Something went wrong.'];
  const retry = canRetry && (c === 'server' || c === 'timeout' || c === 'not-found' || !c);
  return ui.alert(title, text, { retry });
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
const ui = createUI({
  create: (name) => createRoom(name),
  join: (name, code) => joinRoom(name, code),
  practice: (name, bots, level) => startPractice(name, bots, level),
  start: () => hostStart(),
  again: () => playAgain(),
  leave: () => leave(),
  copyInvite,
  shareInvite,
  pauseChanged: (paused) => input.setEnabled(G.screen === 'match' && !paused),
});

document.getElementById('hud-menu').addEventListener('click', () => ui.showPause());

// Audio may only start after a user gesture.
for (const ev of ['pointerdown', 'keydown', 'touchstart']) addEventListener(ev, () => audio.unlockAudio(), { passive: true });

// ---------------------------------------------------------------------------
// HUD + render loop
// ---------------------------------------------------------------------------
function myHudState() {
  if (G.mode === 'client') {
    const sm = G.cl && G.cl.serverMe;
    if (!sm || !G.rosterById.has(G.myId)) return null;
    return { lives: sm.lives, alive: sm.alive };
  }
  const p = G.sim && S.getPlayer(G.sim.state, G.myId);
  if (!p) return null;
  return { lives: p.lives, alive: p.alive };
}

function pingInfo() {
  if (G.mode === 'host') return { text: 'HOST', level: 'host' };
  if (G.mode === 'client') {
    const r = net.getPing();
    if (r === null) return { text: '…', level: 'ok' };
    return { text: `${Math.round(r)} ms`, level: r < 80 ? 'good' : r < 160 ? 'ok' : 'bad' };
  }
  return null;
}

function updateHud(view) {
  const me = myHudState();
  let timeLeft = C.MATCH_TIME;
  if (G.mode === 'client' && G.cl) timeLeft = G.cl.tl;
  else if (G.sim) timeLeft = G.sim.state.timeLeft;
  const players = view.players.map((p) => ({ id: p.id, name: p.name, color: p.color, slot: p.slot, lives: p.lives, alive: p.alive }));
  let spectating = null;
  if (!G.rosterById.has(G.myId)) spectating = 'Watching: you will play in the next match';
  else if (me && !me.alive) spectating = "You're out! Watching the rest of the match";
  hud.update({ me, timeLeft, players, ping: pingInfo(), spectating, myId: G.myId });

  // Final-seconds tick
  const phase = G.mode === 'client' ? G.cl && G.cl.phase : G.sim && G.sim.state.phase;
  const sec = Math.ceil(timeLeft);
  if (phase === 'playing' && sec <= 10 && sec >= 1 && G.lastTimerSec !== null && sec < G.lastTimerSec) audio.play('tick');
  G.lastTimerSec = sec;
}

let lastFrame = performance.now();
let lastInset = -1;

function pump(now) {
  if (G.mode === 'practice' || G.mode === 'host') authorityPump(now);
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;

  let view = null;
  const showGame = G.screen === 'match' || G.screen === 'results';
  if (G.mode === 'practice' || G.mode === 'host') {
    pump(now);
    if (showGame && G.sim) view = simView(G.sim);
  } else if (G.mode === 'client' && showGame) {
    view = clientFrame(now, dt) || G.cl?.lastView || null;
    if (G.cl && view) G.cl.lastView = view;
  }
  if (!view) {
    demoFrame(now);
    view = simView(G.demo);
    view.myId = null;
  } else {
    view.myId = G.myId;
  }

  if (G.screen === 'match') {
    const inset = Math.round(hud.height);
    if (inset !== lastInset) { lastInset = inset; renderer.setTopInset(inset); }
    updateHud(view);
    const meView = view.players.find((p) => p.id === G.myId && p.alive);
    const mouseAim = input.aimSource === 'mouse' && !input.touchUI;
    document.body.classList.toggle('mouse-aim', mouseAim && !ui.paused);
    view.crosshair = meView && mouseAim && input.mouse.seen && !ui.paused ? { x: input.mouse.x, y: input.mouse.y } : null;
    view.tap = meView && input.aimSource === 'touch' ? input.lastTap : null;
  } else if (lastInset !== 0) {
    lastInset = 0;
    renderer.setTopInset(0);
  }
  renderer.draw(view, dt);
}

// When the tab is hidden, requestAnimationFrame stops. A worker timer keeps the host's
// simulation (and Practice) running so remote players are not frozen.
function startBackgroundTicker() {
  try {
    const src = 'let t=null;onmessage=(e)=>{clearInterval(t);t=setInterval(()=>postMessage(0),e.data);};';
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = () => { if (document.hidden) pump(performance.now()); };
    w.postMessage(25);
  } catch { /* workers unavailable: the game still runs while visible */ }
}

// ---------------------------------------------------------------------------
// Screen wake lock (keeps phones from sleeping in a lobby or match)
// ---------------------------------------------------------------------------
let wakeLock = null;
let wantAwake = false;
async function keepAwake(on) {
  wantAwake = on;
  try {
    if (on && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      const w = wakeLock;
      wakeLock = null;
      await w.release();
    }
  } catch { /* not supported or denied */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && wantAwake) keepAwake(true); });

// Warn a host before closing the tab with friends connected.
addEventListener('beforeunload', (e) => {
  if (G.mode === 'host' && G.members.size > 1) { e.preventDefault(); e.returnValue = ''; }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function readInviteHash() {
  let raw = '';
  try { raw = decodeURIComponent(location.hash.slice(1)); } catch { /* malformed */ }
  const code = net.normalizeCode(raw);
  if (code.length !== C.ROOM_CODE_LEN) return;
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
  if (G.mode !== 'menu') { ui.toast(`Leave this game first to join room ${code}`, 4000); return; }
  ui.setJoinCode(code);
  ui.focusJoin();
  ui.toast(`Room ${code} filled in. Pick a name and press Join Room!`, 4000);
}

function boot() {
  renderer.resize();
  addEventListener('resize', () => { renderer.resize(); lastInset = -1; });
  addEventListener('orientationchange', () => setTimeout(() => { renderer.resize(); lastInset = -1; }, 200));
  showMenu();

  // Invite links look like https://.../#ABCD (also pasted into an already open tab).
  readInviteHash();
  addEventListener('hashchange', readInviteHash);

  startBackgroundTicker();
  requestAnimationFrame((t) => { lastFrame = t; frame(t); });

  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
}

boot();
