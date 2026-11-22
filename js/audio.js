// Room Showdown: every sound is synthesized with the WebAudio API (no audio files).
// The AudioContext is created on the first user gesture (browsers block autoplay).

const STORE_KEY = 'rs_muted';
let ctx = null;
let master = null;
let noiseBuf = null;
let voices = 0;
const MAX_VOICES = 40;
let muted = false;
try { muted = localStorage.getItem(STORE_KEY) === '1'; } catch { /* private mode */ }

export function isMuted() { return muted; }

export function setMuted(m) {
  muted = !!m;
  try { localStorage.setItem(STORE_KEY, muted ? '1' : '0'); } catch { /* ignore */ }
  if (master) master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.02);
}

export function toggleMute() { setMuted(!muted); return muted; }

/** Call from a user gesture (click, key, touch). Safe to call repeatedly. */
export function unlockAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    ctx = new AC();
  } catch {
    ctx = null;
    return;
  }
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 12;
  comp.ratio.value = 6;
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.9;
  master.connect(comp);
  comp.connect(ctx.destination);
  // One second of white noise, reused by every noisy sound.
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------
function output(pan, vol) {
  const g = ctx.createGain();
  g.gain.value = vol;
  if (pan && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p);
    p.connect(master);
  } else {
    g.connect(master);
  }
  return g;
}

function track(node, stopAt) {
  voices++;
  node.onended = () => { voices--; };
  node.stop(stopAt);
}

function tone(dest, { type = 'sine', f0, f1, t0 = 0, dur = 0.1, gain = 0.3, attack = 0.004 }) {
  const t = ctx.currentTime + t0;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(dest);
  o.start(t);
  track(o, t + dur + 0.03);
}

function noise(dest, { t0 = 0, dur = 0.1, gain = 0.3, type = 'bandpass', freq = 1000, f1, q = 1, attack = 0.002 }) {
  const t = ctx.currentTime + t0;
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f);
  f.connect(g);
  g.connect(dest);
  s.start(t, Math.random() * 0.5);
  track(s, t + dur + 0.03);
}

const vary = (f, amt = 0.06) => f * (1 + (Math.random() * 2 - 1) * amt);

// ---------------------------------------------------------------------------
// The sound library
// ---------------------------------------------------------------------------
const SOUNDS = {
  shot(o) {
    noise(o, { dur: 0.12, gain: 0.5, freq: vary(1500), f1: 500, q: 0.8 });
    tone(o, { type: 'triangle', f0: vary(230), f1: 55, dur: 0.1, gain: 0.45 });
    tone(o, { type: 'square', f0: vary(1900), f1: 900, dur: 0.025, gain: 0.06 });
  },
  reload(o) {
    tone(o, { type: 'square', f0: 820, dur: 0.025, gain: 0.1 });
    tone(o, { type: 'square', f0: 560, t0: 0.08, dur: 0.03, gain: 0.09 });
  },
  reloaded(o) {
    tone(o, { type: 'square', f0: 640, dur: 0.03, gain: 0.1 });
    tone(o, { type: 'square', f0: 1280, t0: 0.06, dur: 0.045, gain: 0.1 });
  },
  hit(o) {
    noise(o, { dur: 0.1, gain: 0.45, type: 'lowpass', freq: 1400 });
    tone(o, { type: 'triangle', f0: vary(640), f1: 160, dur: 0.15, gain: 0.32 });
  },
  hurt(o) {
    noise(o, { dur: 0.2, gain: 0.6, type: 'lowpass', freq: 900 });
    tone(o, { type: 'sawtooth', f0: 320, f1: 70, dur: 0.26, gain: 0.22 });
    tone(o, { type: 'sine', f0: 110, f1: 45, dur: 0.25, gain: 0.5 });
  },
  elim(o) {
    tone(o, { type: 'sawtooth', f0: 760, f1: 55, dur: 0.55, gain: 0.2 });
    noise(o, { dur: 0.4, gain: 0.5, freq: 600, f1: 120, q: 0.7 });
    tone(o, { type: 'sine', f0: 140, f1: 38, dur: 0.45, gain: 0.55 });
  },
  wall(o) {
    noise(o, { dur: 0.035, gain: 0.08, type: 'highpass', freq: 2800 });
  },
  count(o) {
    tone(o, { type: 'sine', f0: 660, dur: 0.16, gain: 0.32 });
    tone(o, { type: 'square', f0: 660, dur: 0.05, gain: 0.04 });
  },
  go(o) {
    tone(o, { type: 'square', f0: 990, dur: 0.12, gain: 0.08 });
    tone(o, { type: 'sine', f0: 1320, dur: 0.45, gain: 0.28 });
    tone(o, { type: 'triangle', f0: 660, dur: 0.45, gain: 0.22 });
  },
  tick(o) {
    tone(o, { type: 'sine', f0: 1050, dur: 0.06, gain: 0.12 });
  },
  win(o) {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(o, { type: 'triangle', f0: f, t0: i * 0.11, dur: 0.2, gain: 0.26 }));
    [523.25, 659.25, 783.99].forEach((f) => tone(o, { type: 'sine', f0: f, t0: 0.48, dur: 0.9, gain: 0.13, attack: 0.02 }));
  },
  lose(o) {
    [392, 349.23, 311.13, 261.63].forEach((f, i) => tone(o, { type: 'triangle', f0: f, t0: i * 0.16, dur: 0.26, gain: 0.22 }));
  },
  click(o) {
    tone(o, { type: 'sine', f0: 900, dur: 0.045, gain: 0.08 });
  },
  join(o) {
    tone(o, { type: 'sine', f0: 520, f1: 780, dur: 0.14, gain: 0.16 });
    tone(o, { type: 'sine', f0: 780, f1: 1040, t0: 0.09, dur: 0.14, gain: 0.12 });
  },
  leave(o) {
    tone(o, { type: 'sine', f0: 700, f1: 420, dur: 0.18, gain: 0.14 });
  },
};

/**
 * Play a named sound.
 * @param {string} name
 * @param {{pan?: number, vol?: number}} [opts] pan -1 (left) .. 1 (right)
 */
export function play(name, opts = {}) {
  if (!ctx || muted || ctx.state !== 'running' || voices > MAX_VOICES) return;
  const fn = SOUNDS[name];
  if (!fn) return;
  try {
    fn(output(opts.pan || 0, opts.vol ?? 1));
  } catch { /* never let audio break the game */ }
}
