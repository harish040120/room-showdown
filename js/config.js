// Room Showdown: every gameplay, network and look constant lives here.
// Pure data with no DOM access, so the simulation and tests can import it in Node too.

export const CONFIG = Object.freeze({
  VERSION: '3.0.0',
  PROTOCOL: 3, // bump when the network message format changes

  // ---- Arena (side view, logical units). Small, growing a little with each player. ----
  // The whole arena is always on screen.
  ARENA_BASE_W: 1280, // width for 2 players
  ARENA_BASE_H: 720,
  ARENA_GROW_W: 100,  // extra width per extra player (7 players: 1780)
  ARENA_GROW_H: 56,   // extra height per extra player (7 players: 1000)
  WALL: 26,           // thickness of the floor, ceiling and side walls
  // Floating platforms: rows from the floor up, mirror-symmetric around the middle.
  PLATFORM_ROW_GAP: 200,
  PLATFORM_SPACING: 430,
  PLATFORM_W: 190,
  PLATFORM_H: 24,

  // ---- Players (each player is a pistol) ----
  MAX_PLAYERS: 7,
  LIVES: 5,
  PLAYER_RADIUS: 26, // hit and collision circle

  // ---- Physics ----
  GRAVITY: 1500,        // px/s^2, pulls down
  RECOIL: 360,          // px/s kick per shot, opposite to the aim (about 4 taps/s to hover)
  RECOIL_CANCEL: 0.7,   // share of the speed against the kick that a shot cancels first
  MAX_SPEED: 1100,      // px/s
  AIR_DRAG: 0.35,       // exponential slow-down per second in the air
  GROUND_FRICTION: 7,   // exponential slow-down per second while resting on something
  BOUNCE: 0.3,          // share of speed kept when bouncing off a surface

  // ---- Pistol: unlimited bullets, no reload. Every tap fires toward the tap. ----
  FIRE_COOLDOWN: 8 / 60, // seconds between shots (8 ticks: at most 7.5 shots per second)
  BULLET_SPEED: 900,    // px per second
  BULLET_RADIUS: 5,
  BULLET_LIFETIME: 1.2, // seconds (range about 1,080 px)
  MUZZLE_OFFSET: 40,    // distance from the gun's center to its barrel tip

  // ---- Getting hit ----
  INVULN_TIME: 1.5,     // seconds of invulnerability after a hit
  KNOCKBACK_SPEED: 420, // speed a hit adds in the bullet's direction (px/s)

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
