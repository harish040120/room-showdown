// Room Showdown: every gameplay, network and look constant lives here.
// Pure data with no DOM access, so the simulation and tests can import it in Node too.

export const CONFIG = Object.freeze({
  VERSION: '2.0.0',
  PROTOCOL: 2, // bump when the network message format changes

  // ---- Arena (side view, logical units). It grows with the number of players. ----
  ARENA_BASE_W: 1800, // width for 2 players
  ARENA_BASE_H: 1000,
  ARENA_GROW_W: 320,  // extra width per extra player (7 players: 3400)
  ARENA_GROW_H: 100,  // extra height per extra player (7 players: 1500)
  WALL: 28,           // thickness of the floor, ceiling and side walls
  // Floating platforms: rows from the floor up, mirror-symmetric around the middle.
  PLATFORM_ROW_GAP: 230,
  PLATFORM_SPACING: 560,
  PLATFORM_W: 230,
  PLATFORM_H: 26,
  // The camera never shows more than this much of the arena (smaller screens show less).
  VIEW_W: 1500,
  VIEW_H: 860,

  // ---- Players (each player is a pistol) ----
  MAX_PLAYERS: 7,
  LIVES: 5,
  PLAYER_RADIUS: 20, // hit and collision circle

  // ---- Physics ----
  GRAVITY: 1700,        // px/s^2, pulls down
  RECOIL: 570,          // px/s kick per shot, opposite to the aim
  RECOIL_CANCEL: 0.7,   // share of the speed against the kick that a shot cancels first
  MAX_SPEED: 1300,      // px/s
  AIR_DRAG: 0.35,       // exponential slow-down per second in the air
  GROUND_FRICTION: 7,   // exponential slow-down per second while resting on something
  BOUNCE: 0.3,          // share of speed kept when bouncing off a surface

  // ---- Pistol ----
  MAG_SIZE: 6,
  FIRE_COOLDOWN: 0.3,  // seconds between shots
  RELOAD_TIME: 1.1,    // seconds
  BULLET_SPEED: 900,   // px per second
  BULLET_RADIUS: 4,
  BULLET_LIFETIME: 1.3, // seconds (range about 1,170 px)
  MUZZLE_OFFSET: 30,    // distance from the gun's center to its barrel tip

  // ---- Getting hit ----
  INVULN_TIME: 1.5,     // seconds of invulnerability after a hit
  KNOCKBACK_SPEED: 480, // speed a hit adds in the bullet's direction (px/s)

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
  INPUT_STALE_MS: 300,   // host releases a client's trigger if inputs stop arriving
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
