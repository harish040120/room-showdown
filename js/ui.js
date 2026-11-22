// Room Showdown: screens (menu, lobby, results), modals, alerts and toasts.
// All player-provided text is inserted with textContent (never innerHTML).

import { CONFIG } from './config.js';
import { cleanName } from './sim.js';
import { normalizeCode } from './net.js';
import * as audio from './audio.js';

const C = CONFIG;
const NAME_KEY = 'rs_name';
const PRACTICE_KEY = 'rs_practice';
const ADJ = ['Bandit', 'Outlaw', 'Ranger', 'Maverick', 'Rookie', 'Hotshot', 'Rascal', 'Cactus', 'Coyote', 'Buckaroo', 'Drifter', 'Wrangler', 'Sheriff', 'Pistol', 'Tumbleweed'];

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export function randomName() {
  const pick = ADJ.filter((a) => a.length <= C.NAME_MAX - 2);
  return pick[Math.floor(Math.random() * pick.length)] + (10 + Math.floor(Math.random() * 90));
}

const ICON = {
  trophy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v3h3v2a5 5 0 0 1-5 5h-.3A5 5 0 0 1 13 15.8V18h3v3H8v-3h3v-2.2A5 5 0 0 1 9.3 13H9a5 5 0 0 1-5-5V6h3zm0 5V8H6a3 3 0 0 0 1.1 2.3A6.9 6.9 0 0 1 7 8m10 0q0 1.2-.1 2.3A3 3 0 0 0 18 8z"/></svg>',
  heart: '<svg viewBox="0 0 24 22" aria-hidden="true"><path d="M12 21.2 2.6 12.4A6 6 0 0 1 12 4.7a6 6 0 0 1 9.4 7.7z"/></svg>',
  target: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20m0 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m0 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8"/></svg>',
};

export function createUI(h) {
  const $ = (id) => document.getElementById(id);
  const screens = { menu: $('screen-menu'), lobby: $('screen-lobby'), results: $('screen-results') };
  let current = null;
  let pauseOpen = false;
  let alertResolve = null;
  let toastTimer = null;
  let connectCancel = null;
  let deferredInstall = null;

  // ---- generic button feedback ----
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && !b.disabled) audio.play('click');
  });

  // ---- name ----
  const nameInput = $('name-input');
  nameInput.maxLength = C.NAME_MAX;
  nameInput.value = cleanName(store.get(NAME_KEY)) || randomName();
  nameInput.addEventListener('change', () => {
    const v = cleanName(nameInput.value);
    nameInput.value = v || randomName();
    store.set(NAME_KEY, nameInput.value);
  });
  function getName() {
    const v = cleanName(nameInput.value) || randomName();
    nameInput.value = v;
    store.set(NAME_KEY, v);
    return v;
  }

  // ---- room code ----
  const codeInput = $('code-input');
  codeInput.maxLength = C.ROOM_CODE_LEN;
  codeInput.addEventListener('input', () => {
    const pos = codeInput.selectionStart;
    const v = normalizeCode(codeInput.value);
    if (v !== codeInput.value) { codeInput.value = v; try { codeInput.setSelectionRange(pos, pos); } catch { /* ignore */ } }
    $('btn-join').classList.toggle('ready', v.length === C.ROOM_CODE_LEN);
  });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  function join() {
    const code = normalizeCode(codeInput.value);
    if (code.length !== C.ROOM_CODE_LEN) {
      toast(`Enter the ${C.ROOM_CODE_LEN}-character room code`);
      codeInput.focus();
      return;
    }
    h.join(getName(), code);
  }

  // ---- menu buttons ----
  $('btn-create').addEventListener('click', () => h.create(getName()));
  $('btn-join').addEventListener('click', join);
  $('btn-practice').addEventListener('click', () => openModal('modal-practice'));
  $('btn-howto').addEventListener('click', () => openModal('modal-howto'));

  // ---- practice setup ----
  const practice = (() => {
    try { return { bots: 3, level: 'normal', ...JSON.parse(store.get(PRACTICE_KEY) || '{}') }; } catch { return { bots: 3, level: 'normal' }; }
  })();
  const botsRow = $('practice-bots');
  const levelRow = $('practice-level');
  for (let n = 1; n <= C.MAX_PLAYERS - 1; n++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg';
    b.textContent = String(n);
    b.dataset.value = String(n);
    botsRow.appendChild(b);
  }
  function syncPractice() {
    for (const b of botsRow.children) b.classList.toggle('on', Number(b.dataset.value) === practice.bots);
    for (const b of levelRow.children) b.classList.toggle('on', b.dataset.value === practice.level);
  }
  botsRow.addEventListener('click', (e) => {
    const b = e.target.closest('.seg');
    if (b) { practice.bots = Number(b.dataset.value); syncPractice(); }
  });
  levelRow.addEventListener('click', (e) => {
    const b = e.target.closest('.seg');
    if (b) { practice.level = b.dataset.value; syncPractice(); }
  });
  if (!C.BOT_DIFFICULTIES.includes(practice.level)) practice.level = 'normal';
  practice.bots = Math.max(1, Math.min(C.MAX_PLAYERS - 1, Number(practice.bots) || 3));
  syncPractice();
  $('btn-practice-start').addEventListener('click', () => {
    store.set(PRACTICE_KEY, JSON.stringify(practice));
    closeModal('modal-practice');
    h.practice(getName(), practice.bots, practice.level);
  });

  // ---- modals ----
  function openModal(id) { $(id).classList.add('open'); const f = $(id).querySelector('[data-autofocus]'); if (f) f.focus(); }
  function closeModal(id) { $(id).classList.remove('open'); }
  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => closeModal(btn.closest('.modal').id));
  }
  for (const m of document.querySelectorAll('.modal')) {
    m.addEventListener('click', (e) => {
      if (e.target === m && m.id !== 'modal-alert' && m.id !== 'modal-connecting') {
        if (m.id === 'modal-pause') hidePause(); else closeModal(m.id);
      }
    });
  }

  // ---- pause menu (does not pause the match) ----
  $('btn-resume').addEventListener('click', () => hidePause());
  $('btn-pause-howto').addEventListener('click', () => openModal('modal-howto'));
  $('btn-pause-leave').addEventListener('click', () => { hidePause(); h.leave(); });
  function showPause() { pauseOpen = true; openModal('modal-pause'); h.pauseChanged(true); }
  function hidePause() { if (!pauseOpen) return; pauseOpen = false; closeModal('modal-pause'); h.pauseChanged(false); }

  // ---- sound toggles (menu, HUD, pause) ----
  function syncMute() {
    const m = audio.isMuted();
    for (const b of document.querySelectorAll('[data-mute]')) {
      b.classList.toggle('muted', m);
      b.setAttribute('aria-label', m ? 'Sound off' : 'Sound on');
      const label = b.querySelector('.label');
      if (label) label.textContent = m ? 'Sound: off' : 'Sound: on';
    }
  }
  for (const b of document.querySelectorAll('[data-mute]')) {
    b.addEventListener('click', () => { audio.unlockAudio(); audio.toggleMute(); syncMute(); });
  }
  syncMute();

  // ---- lobby ----
  $('btn-copy').addEventListener('click', () => h.copyInvite());
  $('btn-share').addEventListener('click', () => h.shareInvite());
  if (!navigator.share) $('btn-share').classList.add('hidden');
  $('btn-start').addEventListener('click', () => h.start());
  $('btn-leave-lobby').addEventListener('click', () => h.leave());

  function avatar(p) {
    const a = document.createElement('span');
    a.className = 'avatar';
    a.style.setProperty('--c', p.color);
    a.textContent = String(p.slot + 1);
    return a;
  }
  function tag(text, cls) {
    const t = document.createElement('span');
    t.className = 'tag ' + (cls || '');
    t.textContent = text;
    return t;
  }

  function renderLobby({ code, players, myId, hostId, isHost, status, signalOk }) {
    $('lobby-code').textContent = code;
    $('lobby-count').textContent = `${players.length}/${C.MAX_PLAYERS}`;
    const list = $('lobby-list');
    list.textContent = '';
    for (const p of players) {
      const li = document.createElement('li');
      li.className = 'player-row' + (p.id === myId ? ' me' : '');
      li.appendChild(avatar(p));
      const nm = document.createElement('span');
      nm.className = 'pname';
      nm.textContent = p.name;
      li.appendChild(nm);
      if (p.id === hostId) li.appendChild(tag('HOST', 'host'));
      if (p.id === myId) li.appendChild(tag('YOU', 'you'));
      if (p.spectator) li.appendChild(tag('watching', 'dim'));
      const right = document.createElement('span');
      right.className = 'pright';
      if (p.wins > 0) {
        const w = document.createElement('span');
        w.className = 'wins';
        w.innerHTML = ICON.trophy;
        w.appendChild(document.createTextNode(String(p.wins)));
        right.appendChild(w);
      }
      if (typeof p.ping === 'number' && p.id !== hostId) {
        const pg = document.createElement('span');
        pg.className = 'ping';
        pg.textContent = `${Math.round(p.ping)} ms`;
        right.appendChild(pg);
      }
      li.appendChild(right);
      list.appendChild(li);
    }
    for (let i = players.length; i < C.MAX_PLAYERS; i++) {
      const li = document.createElement('li');
      li.className = 'player-row empty';
      li.textContent = 'Waiting for a player…';
      list.appendChild(li);
    }
    const startBtn = $('btn-start');
    startBtn.classList.toggle('hidden', !isHost);
    startBtn.disabled = players.length < 2;
    $('lobby-wait').classList.toggle('hidden', isHost);
    $('lobby-host-note').classList.toggle('hidden', !isHost);
    let st = status || '';
    if (isHost && !st) st = players.length < 2 ? 'Share the code. You need at least 2 players to start.' : 'Ready when you are!';
    if (isHost && signalOk === false) st = 'Lost contact with the connection server: new players cannot join right now (retrying…)';
    $('lobby-status').textContent = st;
  }

  // ---- results ----
  $('btn-again').addEventListener('click', () => h.again());
  $('btn-results-leave').addEventListener('click', () => h.leave());

  function placeLabel(n) {
    return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
  }

  function renderResults({ results, wins, myId, canRestart, practice: isPractice }) {
    const byId = new Map(results.ranking.map((r) => [r.id, r]));
    const winners = results.winners.map((id) => byId.get(id)).filter(Boolean);
    const iWon = results.winners.includes(myId);
    let title;
    if (winners.length === 1) title = iWon ? 'You win!' : `${winners[0].name} wins!`;
    else title = iWon ? 'You share the win!' : `${winners.map((w) => w.name).join(' & ')} share the win!`;
    $('results-title').textContent = title;
    $('results-title').classList.toggle('won', iWon);
    const reasonText = {
      last: 'Last one standing',
      timer: "Time's up! Most lives wins, then most hits.",
      draw: 'Double knockout! Most hits landed wins.',
    };
    $('results-sub').textContent = reasonText[results.reason] || '';
    const list = $('results-list');
    list.textContent = '';
    for (const r of results.ranking) {
      const li = document.createElement('li');
      li.className = 'result-row' + (r.place === 1 ? ' winner' : '') + (r.id === myId ? ' me' : '');
      const pl = document.createElement('span');
      pl.className = 'place p' + Math.min(r.place, 4);
      pl.textContent = placeLabel(r.place);
      li.appendChild(pl);
      li.appendChild(avatar(r));
      const nm = document.createElement('span');
      nm.className = 'pname';
      nm.textContent = r.name;
      li.appendChild(nm);
      if (r.id === myId) li.appendChild(tag('YOU', 'you'));
      if (r.left) li.appendChild(tag('left', 'dim'));
      const stats = document.createElement('span');
      stats.className = 'stats';
      const mk = (icon, value, title2, cls) => {
        const s = document.createElement('span');
        s.className = 'stat ' + cls;
        s.title = title2;
        s.innerHTML = icon;
        const b = document.createElement('b');
        b.textContent = String(value);
        s.appendChild(b);
        return s;
      };
      stats.append(
        mk(ICON.target, r.hits, 'Hits landed', 'hits'),
        mk(ICON.heart, r.lives, 'Lives left', 'lives'),
        mk(ICON.trophy, (wins && wins[r.id]) || 0, isPractice ? 'Wins this session' : 'Wins in this room', 'wins'),
      );
      li.appendChild(stats);
      list.appendChild(li);
    }
    $('btn-again').classList.toggle('hidden', !canRestart);
    $('results-wait').classList.toggle('hidden', canRestart);
    $('btn-results-leave').textContent = isPractice ? 'Menu' : 'Leave';
  }

  // ---- alert dialog ----
  $('btn-alert-ok').addEventListener('click', () => resolveAlert('ok'));
  $('btn-alert-retry').addEventListener('click', () => resolveAlert('retry'));
  function resolveAlert(v) {
    $('modal-alert').classList.remove('open');
    const r = alertResolve;
    alertResolve = null;
    if (r) r(v);
  }
  function alertBox(title, message, { retry = false, okText = 'OK' } = {}) {
    if (alertResolve) resolveAlert('ok');
    $('alert-title').textContent = title;
    $('alert-msg').textContent = message || '';
    $('btn-alert-ok').textContent = okText;
    $('btn-alert-retry').classList.toggle('hidden', !retry);
    $('modal-alert').classList.add('open');
    setTimeout(() => $(retry ? 'btn-alert-retry' : 'btn-alert-ok').focus(), 30);
    return new Promise((res) => { alertResolve = res; });
  }

  // ---- connecting overlay ----
  $('btn-connect-cancel').addEventListener('click', () => {
    const cb = connectCancel;
    connecting(null);
    if (cb) cb();
  });
  function connecting(text, onCancel) {
    connectCancel = onCancel || null;
    if (text) {
      $('connect-text').textContent = text;
      $('modal-connecting').classList.add('open');
    } else {
      $('modal-connecting').classList.remove('open');
    }
  }

  // ---- toast ----
  function toast(msg, ms = 2600) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ---- install as app (PWA) ----
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    $('btn-install').classList.remove('hidden');
  });
  $('btn-install').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch { /* ignore */ }
    deferredInstall = null;
    $('btn-install').classList.add('hidden');
  });

  // ---- screens ----
  function showScreen(name) {
    current = name;
    for (const [k, el] of Object.entries(screens)) el.classList.toggle('active', k === name);
    document.body.dataset.screen = name || 'game';
    if (name === 'menu') setTimeout(() => { if (document.activeElement === document.body && !matchMedia('(pointer: coarse)').matches) $('btn-create').focus(); }, 30);
  }

  return {
    showScreen,
    get screen() { return current; },
    renderLobby,
    renderResults,
    alert: alertBox,
    toast,
    connecting,
    showPause,
    hidePause,
    get paused() { return pauseOpen; },
    togglePause() { if (pauseOpen) hidePause(); else showPause(); },
    closeAllModals() { for (const m of document.querySelectorAll('.modal.open')) if (m.id !== 'modal-alert') m.classList.remove('open'); pauseOpen = false; },
    getName,
    setJoinCode(code) { codeInput.value = normalizeCode(code); codeInput.dispatchEvent(new Event('input')); },
    focusJoin() { $('btn-join').focus(); },
    syncMute,
  };
}
