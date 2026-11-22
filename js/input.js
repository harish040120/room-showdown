// Room Showdown: input. There are no joysticks and no movement keys: you TAP (or click)
// anywhere and your gun fires toward that spot. The kick of the shot is how you move.
//   - touch: tap to shoot toward the finger; keep the finger down to keep firing (drag to steer)
//   - mouse: the gun follows the cursor; click (or hold) to fire, Space fires too
// Produces one sample per frame: { aim, fire }.

export function createInput(canvas, { onMenu } = {}) {
  const state = {
    enabled: false,
    aimSource: 'mouse', // 'mouse' | 'touch'
    mouse: { x: innerWidth / 2, y: innerHeight / 2, down: false, seen: false },
    touches: new Map(), // pointerId -> {x, y} (the newest one aims)
    point: null,        // screen point the gun aims at
    fireTap: false,     // a tap/click happened since the last sample
    touchSeen: matchMedia('(pointer: coarse)').matches,
    lastAim: 0,
    space: false,
    lastTap: null,      // {x, y, t} for the tap marker
    padStartWas: false,
  };

  const isTyping = () => {
    const el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  };

  // ---- keyboard: Space fires toward the mouse pointer, Esc opens the menu ----
  addEventListener('keydown', (e) => {
    if (e.code === 'Escape') { if (onMenu) onMenu(); return; }
    if (isTyping() || !state.enabled) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) state.fireTap = true;
      state.space = true;
    }
  });
  addEventListener('keyup', (e) => { if (e.code === 'Space') state.space = false; });
  addEventListener('blur', () => releaseAll());
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

  function releaseAll() {
    state.mouse.down = false;
    state.space = false;
    state.touches.clear();
  }

  // ---- mouse + touch (pointer events handle multi-touch) ----
  addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') {
      state.mouse.x = e.clientX;
      state.mouse.y = e.clientY;
      state.mouse.seen = true;
      if (state.enabled) { state.aimSource = 'mouse'; state.point = { x: e.clientX, y: e.clientY }; }
      return;
    }
    const t = state.touches.get(e.pointerId);
    if (t) { t.x = e.clientX; t.y = e.clientY; state.point = { x: t.x, y: t.y }; e.preventDefault(); }
  }, { passive: false });

  canvas.addEventListener('pointerdown', (e) => {
    if (!state.enabled) return;
    const p = { x: e.clientX, y: e.clientY };
    state.point = p;
    state.fireTap = true;
    state.lastTap = { x: p.x, y: p.y, t: performance.now() };
    if (e.pointerType === 'mouse') {
      if (e.button === 0) state.mouse.down = true;
      state.aimSource = 'mouse';
      return;
    }
    e.preventDefault();
    state.touchSeen = true;
    state.aimSource = 'touch';
    state.touches.delete(e.pointerId);
    state.touches.set(e.pointerId, { ...p }); // newest last
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }, { passive: false });

  const endPointer = (e) => {
    if (e.pointerType === 'mouse') {
      if (e.button === 0 || e.type === 'pointercancel') state.mouse.down = false;
      return;
    }
    state.touches.delete(e.pointerId);
    const rest = [...state.touches.values()];
    if (rest.length) state.point = { ...rest[rest.length - 1] };
  };
  addEventListener('pointerup', endPointer);
  addEventListener('pointercancel', endPointer);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Gamepad: only Start (menu). There is nothing to tap with on a gamepad.
  function pollPadMenu() {
    if (!navigator.getGamepads) return;
    for (const gp of navigator.getGamepads()) {
      if (!gp || !gp.connected) continue;
      const start = !!(gp.buttons[9] && gp.buttons[9].pressed);
      if (start && !state.padStartWas && onMenu) onMenu();
      state.padStartWas = start;
      return;
    }
  }

  /**
   * Sample the current input. `ctx.playerScreen` = {x, y} of the local player on screen:
   * the gun aims from there toward the tapped / pointed spot.
   */
  function sample(ctx = {}) {
    pollPadMenu();
    const out = { aim: state.lastAim, fire: false };
    if (!state.enabled) {
      state.fireTap = false;
      return out;
    }
    const pt = state.point || (state.mouse.seen ? state.mouse : null);
    if (pt && ctx.playerScreen) {
      const dx = pt.x - ctx.playerScreen.x, dy = pt.y - ctx.playerScreen.y;
      if (dx * dx + dy * dy > 4) out.aim = Math.atan2(dy, dx);
    }
    out.fire = state.fireTap || state.mouse.down || state.space || state.touches.size > 0;
    state.fireTap = false;
    state.lastAim = out.aim;
    return out;
  }

  return {
    sample,
    get aimSource() { return state.aimSource; },
    get mouse() { return state.mouse; },
    get touchUI() { return state.touchSeen; },
    get lastTap() { return state.lastTap; },
    setEnabled(on) {
      state.enabled = !!on;
      if (!on) releaseAll();
      state.point = null;
    },
    setAim(a) { state.lastAim = a; },
  };
}
