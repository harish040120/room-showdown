// Room Showdown: every gameplay, network and look constant lives here.
// Pure data with no DOM access, so the simulation and tests can import it in Node too.

export const CONFIG = Object.freeze({
  VERSION: '1.0.0',
  PROTOCOL: 1, // bump when the network message format changes

  // ---- Arena (logical units; the canvas scales this to fit any screen) ----
  ARENA_W: 1600,
  ARENA_H: 900,
  WALL: 24, // thickness of the border walls

  // Cover blocks (axis-aligned rectangles). The layout is mirror-symmetric on both axes.
  OBSTACLES: [
    { x: 740, y: 390, w: 120, h: 120 }, // center pillar
    { x: 430, y: 330, w: 40, h: 240 },  // left bar
    { x: 1130, y: 330, w: 40, h: 240 }, // right bar
    { x: 560, y: 200, w: 180, h: 36 },  // top-left
    { x: 860, y: 200, w: 180, h: 36 },  // top-right
    { x: 560, y: 664, w: 180, h: 36 },  // bottom-left
    { x: 860, y: 664, w: 180, h: 36 },  // bottom-right
  ],

  // 7 spawn points evenly spaced on an ellipse around the arena edge.
  SPAWN_RX: 680,
  SPAWN_RY: 340,
  SPAWN_START_DEG: 167.142857, // makes spawn 0 and spawn 4 mirror images (fair 1v1)
  // Join order -> spawn point index, chosen so any number of players is spread out.
  SPAWN_ORDER: [0, 4, 2, 6, 1, 5, 3],

  // ---- Players ----
  MAX_PLAYERS: 7,
  LIVES: 5,
  PLAYER_RADIUS: 18,
  PLAYER_SPEED: 230, // px per second

  // ---- Pistol ----
  MAG_SIZE: 6,
  FIRE_COOLDOWN: 0.35, // seconds between shots
  RELOAD_TIME: 1.2,    // seconds
  BULLET_SPEED: 720,   // px per second
  BULLET_RADIUS: 4,
  BULLET_LIFETIME: 1.4, // seconds
  MUZZLE_OFFSET: 32,    // distance from player center to the gun tip

  // ---- Getting hit ----
  INVULN_TIME: 1.5,     // seconds of invulnerability after a hit
  KNOCKBACK_SPEED: 380, // initial knockback velocity (px/s)
  KNOCKBACK_DECAY: 10,  // exponential decay rate (higher = shorter nudge)

  // ---- Match flow ----
  COUNTDOWN: 3,       // "3-2-1-DUEL!"
  MATCH_TIME: 180,    // 3 minutes
  END_DELAY_MS: 2200, // show the final moment before the results screen

  // ---- Simulation and networking ----
  TICK_RATE: 60,         // host simulation steps per second (fixed timestep)
  INPUT_RATE: 30,        // client -> host input messages per second
  SNAPSHOT_RATE: 20,     // host -> client snapshots per second
  INTERP_DELAY_MS: 100,  // remote players are drawn this far in the past
  RECONCILE_SNAP_PX: 60, // client prediction snaps only if the error is bigger
  HEARTBEAT_MS: 2000,    // ping interval
  TIMEOUT_MS: 8000,      // drop a peer after this much silence
  INPUT_STALE_MS: 300,   // host zeroes a client's movement if inputs stop arriving
  CONNECT_TIMEOUT_MS: 15000,

  ROOM_CODE_CHARS: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', // no look-alikes (0/O, 1/I)
  ROOM_CODE_LEN: 4,
  PEER_PREFIX: 'roomshowdown-',
  NAME_MAX: 12,

  // ---- Look ----
  // Okabe-Ito palette: designed to stay distinguishable with common color blindness.
  // Each player also wears a number badge (1-7), so color is never the only cue.
  COLORS: ['#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7'],
  COLOR_NAMES: ['Orange', 'Sky', 'Green', 'Yellow', 'Blue', 'Red', 'Pink'],

  BOT_DIFFICULTIES: ['easy', 'normal', 'hard'],
});

// ---- WebRTC ICE servers ----
// STUN servers let two browsers discover how to reach each other. They are free and public.
// Four or fewer entries keep connection setup fast (Firefox warns when there are more).
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },

  // ---- Optional TURN server ----
  // Some strict networks (schools, offices, some mobile carriers) block direct
  // peer-to-peer traffic. A TURN server relays the traffic so the game still works.
  // See README.md, section "Adding a TURN server". Paste your own entry here, e.g.:
  //
  // {
  //   urls: ['turn:YOUR-TURN-HOST:3478', 'turns:YOUR-TURN-HOST:443?transport=tcp'],
  //   username: 'YOUR-USERNAME',
  //   credential: 'YOUR-PASSWORD',
  // },
  //
  // Never commit paid or private credentials to a public repository. Prefer a free
  // tier with usage limits, or short-lived credentials.
];
