# Room Showdown

A fast, funny pistol party game for **2 to 7 players** in the browser. **Every player is a
pistol.** Gravity pulls you down, and the only way to move is the kick of your own shots:
shoot at the floor to fly up, shoot sideways to dash the other way. Everyone has **5 lives**.
Each hit costs one life. Lose all five and you're out. **Last one standing wins.**

- The arena grows with the number of players (1800 x 1000 for 2, up to 3400 x 1500 for 7), and the camera follows you
- Plays on phones (landscape, touch sticks), tablets and desktops (keyboard + mouse, or a gamepad)
- Peer-to-peer multiplayer over WebRTC: **no game server to run or pay for**
- **Practice vs Bots** (easy / normal / hard) works fully offline
- No build step, no dependencies, no image or audio files: everything is drawn and synthesized in code
- Installable as an app (PWA)

## How to play

| | Keyboard + mouse | Phone | Gamepad |
|---|---|---|---|
| Aim | mouse, or `WASD` / arrow keys | either thumb stick | either stick |
| Shoot (and move) | left click (hold to keep firing), `Space` | push the right stick past the dashed ring | RT / RB / A |
| Reload | `R` (automatic when empty) | round reload button | X |
| Menu | `Esc` | ☰ button | Start |

Rules:

- Every shot kicks you the opposite way you aim. Shoot down to fly up, shoot right to dash left.
- You can fly up through platforms and land on top of them. Platforms and crates stop bullets.
- 6-shot magazine, 0.3 s between shots, 1.1 s reload. Empty your gun in the air and you fall while you reload.
- Getting hit knocks you in the direction of the bullet
- After a hit you blink for 1.5 s and can't be hit again
- Bullets travel about 1,170 px before fading: no sniping across a big room
- A match lasts 3 minutes. When time runs out, most lives wins, then most hits landed. Anything still tied shares the win.
- The menu does **not** pause the match

## Playing with friends

1. One player presses **Create Room** and becomes the **host**.
2. Share the 4-letter code, or press **Copy invite link** / **Share**. Opening the link fills in the code.
3. Friends press **Join Room**. Once at least 2 players are in, the host presses **Start Match**.

The host's browser runs the game. **The host must keep the tab open and the screen on.** If the
host leaves, the room closes. People who join during a match watch it and play in the next one.

## Running it locally

Any static file server works. ES modules don't load from `file://`, so you can't just open the HTML file.

```sh
npm start                          # npx serve on http://localhost:3000
# or
python3 -m http.server 3000
```

Phones on the same Wi-Fi can open `http://<your-computer-ip>:3000`. Browsers only enable some
features (the service worker, the screen wake lock) on `https://` or `localhost`, but the game itself still works.

## Deploying (free)

Upload the folder to any static host. With **GitHub Pages**: push the repository, then go to
*Settings → Pages → Deploy from a branch* and pick the branch and the root folder. The `.nojekyll` file is already included.

Netlify, Cloudflare Pages and Vercel also work. No settings needed.

When you change any file, bump `CACHE` in `sw.js` so returning players get the new version.
If you change the network message format, also bump `PROTOCOL` in `js/config.js`. Players on
different versions then get a clear "please refresh" message instead of weird bugs.

## Adding a TURN server

Connections normally go directly between browsers, using public STUN servers to find a route.
Some strict networks (school or office Wi-Fi, some mobile carriers) block direct connections.
Players there see *"The room exists, but a direct connection to the host failed."*

A **TURN** server fixes this by relaying the traffic. Get one from a provider with a free tier
(for example Metered or Cloudflare Calls) or run your own with [coturn](https://github.com/coturn/coturn).
Then add it to `ICE_SERVERS` in `js/config.js`:

```js
{
  urls: ['turn:YOUR-TURN-HOST:3478', 'turns:YOUR-TURN-HOST:443?transport=tcp'],
  username: 'YOUR-USERNAME',
  credential: 'YOUR-PASSWORD',
},
```

Anything in this file is visible to every player. Use a free tier with usage limits or
short-lived credentials, and never commit a paid account's password to a public repository.

## How it works

```
index.html          every screen, modal and HUD element
css/style.css       dark responsive theme (phone landscape to desktop)
js/config.js        every gameplay, network and look constant
js/sim.js           PURE simulation: arena builder, gravity + recoil physics, bullets, hits, ranking, packing
js/bots.js          bot AI (produces inputs for the same simulation)
js/net.js           PeerJS transport: rooms, heartbeats, kicking, reconnecting to signaling
js/main.js          the controller: modes, host authority, client prediction, render loop
js/render.js        canvas renderer (follow camera, the pistol players) + effects, DOM HUD
js/input.js         keyboard, mouse, touch sticks, gamepad (aim + fire only)
js/audio.js         WebAudio sound synthesizer
js/ui.js            menu, lobby, results, dialogs, toasts
sw.js               offline cache for the app shell
vendor/peerjs.min.js  PeerJS (MIT), for WebRTC signaling
```

- **Star topology, host authoritative.** The host simulates at a fixed 60 ticks/s and sends
  snapshots 20 times a second. Clients send only their aim and trigger 30 times a second, so a
  modified client can't teleport, fly or fire faster than the host allows. There is no movement
  input at all: the host computes every kick from the shots it accepts.
- **Client-side prediction.** Your own flight (gravity, recoil, collisions) runs immediately with the
  same physics code as the host. Each snapshot says which input the host applied last and how many
  ticks it has simulated since, so the client replays exactly the ticks the host has not seen yet
  and smooths away small errors.
- **Arena from the player count.** The arena is built from the number of players alone, so every
  peer builds the same one from the roster and nothing extra goes over the network.
- **Interpolation.** Other players are drawn ~100 ms in the past, between two snapshots. Hit,
  elimination and shot effects are delayed by the same amount, so they line up with what you see.
- **One simulation.** `sim.js` uses no DOM, network or `Math.random()`, so the same code runs on
  the host, in Practice mode, in client prediction and in the Node tests.
- **Backgrounded host.** Browsers stop animation frames in hidden tabs, so a Web Worker timer keeps
  the host's simulation running. A screen wake lock keeps phones from sleeping in the lobby and in matches.
- **Signaling.** Room codes are PeerJS ids (`roomshowdown-ABCD`) on the free public PeerJS
  server. It only introduces the browsers to each other. Game traffic never passes through it.

## Tests

```sh
npm test
```

39 headless tests of the simulation and bots: arena sizes and symmetry, gravity, recoil, one-way
platforms, client prediction matching the host exactly, lives, cooldowns, reloads, invulnerability,
point-blank shots into cover, timer tie-breaks, same-tick double knockouts, disconnects, input
sanitizing, snapshot packing, and full bot-vs-bot matches (including determinism with a fixed seed).

## Credits and license

Code: MIT. PeerJS: MIT (see `vendor/peerjs-LICENSE`). Player colors use the Okabe-Ito palette, which
stays distinguishable with common color blindness, and every player also wears a number badge.
