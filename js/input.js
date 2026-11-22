// Room Showdown: input from keyboard + mouse, twin virtual joysticks (touch) and gamepads.
// Produces one sample per frame: { mx, my, aim, fire, reload } with |(mx,my)| <= 1.

const MOVE_KEYS = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};
const PAD_DEADZONE = 0.22;
const AIM_ZONE = 0.2;  // right stick: start aiming beyond 20% of its radius
const FIRE_ZONE = 0.45; // right stick: fire while pushed beyond this dead zone

export function createInput(canvas, { onMenu } = {}) {
  const keys = new Set();
  const state = {
    enabled: false,
    aimSource: 'mouse', // 'mouse' | 'touch' | 'pad'
    mouse: { x: innerWidth / 2, y: innerHeight / 2, down: false, seen: false },
    fireTap: false,
    reloadTap: false,
    touchSeen: matchMedia('(pointer: coarse)').matches,
    lastAim: 0,
    sticks: {
      left: { id: null, ox: 0, oy: 0, x: 0, y: 0, vx: 0, vy: 0 },
      right: { id: null, ox: 0, oy: 0, x: 0, y: 0, vx: 0, vy: 0 },
    },
    padStartWas: false,
    padIndex: -1,
  };

  const isTyping = () => {
    const el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  };

  function stickRadius() {
    return Math.max(46, Math.min(78, Math.min(innerWidth, innerHeight) * 0.16));
  }

  // ---- keyboard ----
  addEventListener('keydown', (e) => {
    if (e.code === 'Escape') { if (onMenu) onMenu(); return; }
    if (isTyping()) return;
    if (!state.enabled) return;
    if (MOVE_KEYS[e.code] || e.code === 'Space') e.preventDefault();
    keys.add(e.code);
    if (e.code === 'KeyR' && !e.repeat) state.reloadTap = true;
    if (e.code === 'Space') { state.fireTap = true; }
  });
  addEventListener('keyup', (e) => { keys.delete(e.code); });
  addEventListener('blur', () => releaseAll());
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

  function releaseAll() {
    keys.clear();
    state.mouse.down = false;
    state.sticks.left.id = null;
    state.sticks.right.id = null;
    state.sticks.left.vx = state.sticks.left.vy = 0;
    state.sticks.right.vx = state.sticks.right.vy = 0;
  }

  // ---- mouse + touch (pointer events handle multi-touch) ----
  addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') {
      state.mouse.x = e.clientX;
      state.mouse.y = e.clientY;
      state.mouse.seen = true;
      if (state.aimSource !== 'mouse' && state.enabled) state.aimSource = 'mouse';
      return;
    }
    const s = stickFor(e.pointerId);
    if (s) { updateStick(s, e.clientX, e.clientY); e.preventDefault(); }
  }, { passive: false });

  canvas.addEventListener('pointerdown', (e) => {
    if (!state.enabled) return;
    if (e.pointerType === 'mouse') {
      if (e.button === 0) { state.mouse.down = true; state.fireTap = true; }
      state.aimSource = 'mouse';
      return;
    }
    // touch / pen: left half moves, right half aims and fires
    e.preventDefault();
    state.touchSeen = true;
    state.aimSource = 'touch';
    const left = e.clientX < innerWidth / 2;
    const s = left ? state.sticks.left : state.sticks.right;
    if (s.id !== null) return; // that stick is already held by another finger
    s.id = e.pointerId;
    s.ox = s.x = e.clientX;
    s.oy = s.y = e.clientY;
    s.vx = s.vy = 0;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }, { passive: false });

  const endPointer = (e) => {
    if (e.pointerType === 'mouse') {
      if (e.button === 0 || e.type === 'pointercancel') state.mouse.down = false;
      return;
    }
    const s = stickFor(e.pointerId);
    if (s) { s.id = null; s.vx = s.vy = 0; }
  };
  addEventListener('pointerup', endPointer);
  addEventListener('pointercancel', endPointer);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function stickFor(id) {
    if (state.sticks.left.id === id) return state.sticks.left;
    if (state.sticks.right.id === id) return state.sticks.right;
    return null;
  }

  function updateStick(s, x, y) {
    const R = stickRadius();
    let dx = x - s.ox, dy = y - s.oy;
    const d = Math.hypot(dx, dy);
    if (d > R) {
      // drag the base along so the stick never feels "stuck" at the edge
      const k = (d - R) / d;
      s.ox += dx * k;
      s.oy += dy * k;
      dx = x - s.ox;
      dy = y - s.oy;
    }
    s.x = x;
    s.y = y;
    s.vx = dx / R;
    s.vy = dy / R;
  }

  // ---- gamepad ----
  addEventListener('gamepadconnected', (e) => { state.padIndex = e.gamepad.index; });
  addEventListener('gamepaddisconnected', (e) => { if (state.padIndex === e.gamepad.index) state.padIndex = -1; });

  function readPad() {
    if (state.padIndex < 0 || !navigator.getGamepads) return null;
    const gp = navigator.getGamepads()[state.padIndex];
    if (!gp || !gp.connected) return null;
    const ax = (i) => (gp.axes[i] !== undefined ? gp.axes[i] : 0);
    const btn = (i) => !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.3));
    const dz = (x, y) => (Math.hypot(x, y) < PAD_DEADZONE ? [0, 0] : [x, y]);
    const [lx, ly] = dz(ax(0), ax(1));
    const [rx, ry] = dz(ax(2), ax(3));
    const start = btn(9);
    if (start && !state.padStartWas && onMenu) onMenu();
    state.padStartWas = start;
    return { lx, ly, rx, ry, fire: btn(7) || btn(5) || btn(0), reload: btn(2) };
  }

  /**
   * Sample the current input. `ctx.playerScreen` = {x, y} of the local player on screen
   * (for mouse aiming). `ctx.aim` = current aim used when no device gives a new one.
   */
  function sample(ctx = {}) {
    const out = { mx: 0, my: 0, aim: state.lastAim, fire: false, reload: false };
    if (!state.enabled) {
      state.fireTap = state.reloadTap = false;
      return out;
    }
    // movement: keyboard + left stick + gamepad (summed, clamped)
    for (const k of keys) {
      const v = MOVE_KEYS[k];
      if (v) { out.mx += v[0]; out.my += v[1]; }
    }
    const L = state.sticks.left;
    if (L.id !== null) { out.mx += L.vx; out.my += L.vy; }
    const pad = readPad();
    if (pad) { out.mx += pad.lx; out.my += pad.ly; }
    const len = Math.hypot(out.mx, out.my);
    if (len > 1) { out.mx /= len; out.my /= len; }

    // aim + fire
    const Rs = state.sticks.right;
    let fire = keys.has('Space') || state.fireTap;
    if (pad && Math.hypot(pad.rx, pad.ry) > 0) {
      state.aimSource = 'pad';
      out.aim = Math.atan2(pad.ry, pad.rx);
    }
    if (pad && pad.fire) fire = true;
    if (pad && pad.reload) state.reloadTap = true;

    if (Rs.id !== null) {
      const m = Math.hypot(Rs.vx, Rs.vy);
      if (m > AIM_ZONE) out.aim = Math.atan2(Rs.vy, Rs.vx);
      if (m > FIRE_ZONE) fire = true;
    } else if (state.aimSource === 'mouse' && ctx.playerScreen && state.mouse.seen) {
      out.aim = Math.atan2(state.mouse.y - ctx.playerScreen.y, state.mouse.x - ctx.playerScreen.x);
    }
    if (state.mouse.down) fire = true;

    out.fire = fire;
    out.reload = state.reloadTap;
    state.fireTap = false;
    state.reloadTap = false;
    state.lastAim = out.aim;
    return out;
  }

  return {
    sample,
    get aimSource() { return state.aimSource; },
    get mouse() { return state.mouse; },
    get sticks() { return state.sticks; },
    get touchUI() { return state.touchSeen; },
    stickRadius,
    fireZone: FIRE_ZONE,
    setEnabled(on) {
      state.enabled = !!on;
      if (!on) releaseAll();
    },
    setAim(a) { state.lastAim = a; },
    pressReload() { state.reloadTap = true; },
  };
}
