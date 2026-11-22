// Room Showdown: networking transport (PeerJS / WebRTC data channels).
//
// Star topology: the room creator is the HOST; every other player connects to the host.
// The rest of the game only uses this small interface, so another transport
// (WebSocket server, BroadcastChannel, ...) could be swapped in later:
//
//   createRoom()        -> Promise<code>           become the host of a new room
//   joinRoom(code)      -> Promise<void>           connect to a host as a client
//   send(msg, [to])     host: to one client id, or broadcast when `to` is omitted
//                       client: always to the host
//   onMessage(fn)       fn(msg, fromId)   fromId is the client id (host) or 'host' (client)
//   onDisconnect(fn)    fn(id, reason)    reason: 'closed' | 'timeout' | 'error'
//   onConnect(fn)       host only: fn(clientId) when a data channel opens
//   kick(id, [msg])     host only: send a final message, then close that connection
//   close()             leave / shut the room down
//
// Heartbeats (ping every 2 s, drop after 8 s of silence) are handled here and never
// reach the game code.

import { CONFIG, ICE_SERVERS } from './config.js';

const C = CONFIG;

export class NetError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code; // 'server' | 'not-found' | 'timeout' | 'unsupported' | 'cancelled'
  }
}

let peer = null;
let role = null; // 'host' | 'client'
let hostConn = null;
let hostLastSeen = 0;
let rtt = null;
const clients = new Map(); // host: clientId -> { conn, lastSeen, rtt }
let hbTimer = null;
let reconnectTimer = null;
let generation = 0; // invalidates callbacks from a previous session

const handlers = {
  message: () => {},
  disconnect: () => {},
  connect: () => {},
  status: () => {},
};

export const onMessage = (fn) => { handlers.message = fn; };
export const onDisconnect = (fn) => { handlers.disconnect = fn; };
export const onConnect = (fn) => { handlers.connect = fn; };
export const onStatus = (fn) => { handlers.status = fn; };

export function getRole() { return role; }
export function getPing() { return rtt; }
export function getClientPing(id) { const c = clients.get(id); return c ? c.rtt : null; }
export function clientCount() { return clients.size; }

function PeerClass() {
  return (typeof window !== 'undefined' && (window.Peer || (window.peerjs && window.peerjs.Peer))) || null;
}

export function isSupported() {
  return !!PeerClass() && typeof RTCPeerConnection === 'function';
}

export function randomCode() {
  const chars = C.ROOM_CODE_CHARS;
  const buf = new Uint32Array(C.ROOM_CODE_LEN);
  crypto.getRandomValues(buf);
  let s = '';
  for (let i = 0; i < buf.length; i++) s += chars[buf[i] % chars.length];
  return s;
}

/** Uppercase and keep only characters that can appear in a room code. */
export function normalizeCode(raw) {
  let s = '';
  for (const ch of String(raw || '').toUpperCase()) if (C.ROOM_CODE_CHARS.includes(ch)) s += ch;
  return s.slice(0, C.ROOM_CODE_LEN);
}

function makePeer(id) {
  const Peer = PeerClass();
  if (!Peer) throw new NetError('unsupported', 'PeerJS failed to load');
  const opts = { config: { iceServers: ICE_SERVERS }, debug: 0 };
  return id ? new Peer(id, opts) : new Peer(opts);
}

function safeSend(conn, msg) {
  if (!conn || !conn.open) return false;
  try {
    conn.send(msg);
    return true;
  } catch {
    return false;
  }
}

const SERVER_ERRORS = new Set(['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected', 'ssl-unavailable']);

function waitForOpen(p, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new NetError('server', 'signaling server timeout'));
    }, timeoutMs);
    const onOpen = (id) => { cleanup(); resolve(id); };
    const onError = (err) => { cleanup(); reject(err); };
    function cleanup() {
      clearTimeout(timer);
      p.off('open', onOpen);
      p.off('error', onError);
    }
    p.on('open', onOpen);
    p.on('error', onError);
  });
}

function mapPeerError(err) {
  if (err instanceof NetError) return err;
  const type = err && err.type;
  if (type === 'browser-incompatible') return new NetError('unsupported', 'WebRTC is not supported');
  if (type === 'peer-unavailable') return new NetError('not-found', 'Room not found');
  if (SERVER_ERRORS.has(type)) return new NetError('server', 'Cannot reach the signaling server');
  return new NetError('server', (err && err.message) || 'Connection error');
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------
export async function createRoom() {
  close();
  const gen = generation;
  role = 'host';
  let lastErr = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode();
    let p;
    try {
      p = makePeer(C.PEER_PREFIX + code);
    } catch (e) {
      role = null;
      throw mapPeerError(e);
    }
    try {
      await waitForOpen(p, 12000);
    } catch (err) {
      try { p.destroy(); } catch { /* ignore */ }
      if (gen !== generation) throw new NetError('cancelled');
      if (err && err.type === 'unavailable-id') { lastErr = err; continue; } // code taken: try another
      role = null;
      throw mapPeerError(err);
    }
    if (gen !== generation) { try { p.destroy(); } catch { /* ignore */ } throw new NetError('cancelled'); }
    peer = p;
    setupHostPeer(p, gen);
    startHeartbeat(gen);
    return code;
  }
  role = null;
  throw mapPeerError(lastErr);
}

function setupHostPeer(p, gen) {
  p.on('connection', (conn) => {
    if (gen !== generation) return;
    const id = conn.peer;
    conn.on('open', () => {
      if (gen !== generation) return;
      clients.set(id, { conn, lastSeen: performance.now(), rtt: null });
      handlers.connect(id);
    });
    conn.on('data', (data) => {
      if (gen !== generation) return;
      const c = clients.get(id);
      if (!c || c.conn !== conn || !data || typeof data !== 'object') return;
      c.lastSeen = performance.now();
      if (data.t === 'ping') { safeSend(conn, { t: 'pong', ts: data.ts }); return; }
      if (data.t === 'pong') { if (typeof data.ts === 'number') c.rtt = Math.max(0, performance.now() - data.ts); return; }
      handlers.message(data, id);
    });
    const drop = (reason) => () => {
      if (gen !== generation) return;
      const c = clients.get(id);
      if (!c || c.conn !== conn) return;
      clients.delete(id);
      handlers.disconnect(id, reason);
    };
    conn.on('close', drop('closed'));
    conn.on('error', drop('error'));
  });
  // Losing the signaling server does not break existing games, but blocks new joins.
  p.on('disconnected', () => {
    if (gen !== generation || p.destroyed) return;
    handlers.status('signal-lost');
    clearTimeout(reconnectTimer);
    const retry = () => {
      if (gen !== generation || p.destroyed || !p.disconnected) return;
      try { p.reconnect(); } catch { /* ignore */ }
      reconnectTimer = setTimeout(retry, 5000);
    };
    reconnectTimer = setTimeout(retry, 1500);
  });
  p.on('open', () => { if (gen === generation) handlers.status('signal-ok'); });
  p.on('error', () => { /* per-connection problems surface as close events */ });
}

export function kick(id, msg) {
  const c = clients.get(id);
  if (!c) return;
  clients.delete(id);
  if (msg) safeSend(c.conn, msg);
  // Ask the other side to close after delivering the message, then force it.
  try { c.conn.close({ flush: true }); } catch { /* ignore */ }
  setTimeout(() => { try { c.conn.close(); } catch { /* ignore */ } }, 1500);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
export async function joinRoom(code) {
  close();
  const gen = generation;
  role = 'client';
  let p;
  try {
    p = makePeer(null);
  } catch (e) {
    role = null;
    throw mapPeerError(e);
  }
  peer = p;
  try {
    await waitForOpen(p, 12000);
  } catch (err) {
    const cancelled = gen !== generation;
    if (!cancelled) close();
    throw cancelled ? new NetError('cancelled') : mapPeerError(err);
  }
  if (gen !== generation) throw new NetError('cancelled');

  const conn = p.connect(C.PEER_PREFIX + code, { reliable: true, serialization: 'json' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new NetError('timeout', 'Could not reach the host')), C.CONNECT_TIMEOUT_MS);
    const onPeerError = (err) => finish(mapPeerError(err));
    const onConnError = () => finish(new NetError('timeout', 'Connection failed'));
    const onOpen = () => finish(null);
    function finish(err) {
      clearTimeout(timer);
      p.off('error', onPeerError);
      conn.off('error', onConnError);
      conn.off('open', onOpen);
      if (gen !== generation) return reject(new NetError('cancelled'));
      if (err) { close(); reject(err); } else resolve();
    }
    p.on('error', onPeerError);
    conn.on('error', onConnError);
    conn.on('open', onOpen);
  });

  hostConn = conn;
  hostLastSeen = performance.now();
  conn.on('data', (data) => {
    if (gen !== generation || !data || typeof data !== 'object') return;
    hostLastSeen = performance.now();
    if (data.t === 'ping') { safeSend(conn, { t: 'pong', ts: data.ts }); return; }
    if (data.t === 'pong') { if (typeof data.ts === 'number') rtt = Math.max(0, performance.now() - data.ts); return; }
    handlers.message(data, 'host');
  });
  const lost = (reason) => () => {
    if (gen !== generation) return;
    const h = handlers.disconnect;
    close();
    h('host', reason);
  };
  conn.on('close', lost('closed'));
  conn.on('error', lost('error'));
  p.on('error', () => { /* signaling hiccups after connecting are harmless */ });
  startHeartbeat(gen);
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------
export function send(msg, to) {
  if (role === 'host') {
    if (to === undefined) {
      for (const c of clients.values()) safeSend(c.conn, msg);
    } else {
      const c = clients.get(to);
      if (c) safeSend(c.conn, msg);
    }
  } else if (role === 'client') {
    safeSend(hostConn, msg);
  }
}

function startHeartbeat(gen) {
  clearInterval(hbTimer);
  hbTimer = setInterval(() => {
    if (gen !== generation) return;
    const now = performance.now();
    if (role === 'host') {
      for (const [id, c] of clients) {
        if (now - c.lastSeen > C.TIMEOUT_MS) {
          clients.delete(id);
          try { c.conn.close(); } catch { /* ignore */ }
          handlers.disconnect(id, 'timeout');
        } else {
          safeSend(c.conn, { t: 'ping', ts: now });
        }
      }
    } else if (role === 'client' && hostConn) {
      if (now - hostLastSeen > C.TIMEOUT_MS) {
        const h = handlers.disconnect;
        close();
        h('host', 'timeout');
        return;
      }
      safeSend(hostConn, { t: 'ping', ts: now });
    }
  }, C.HEARTBEAT_MS);
}

/**
 * Leave the room (client) or shut it down (host). Safe to call any time.
 * `lingerMs` keeps the old connections alive a moment so a final message (like
 * {t:'bye'}) can be delivered. A new session can start immediately either way.
 */
export function close(lingerMs = 0) {
  generation++; // every callback from the old session now ignores itself
  clearInterval(hbTimer);
  clearTimeout(reconnectTimer);
  hbTimer = null;
  const oldPeer = peer;
  const oldConns = [...clients.values()].map((c) => c.conn);
  if (hostConn) oldConns.push(hostConn);
  clients.clear();
  hostConn = null;
  peer = null;
  role = null;
  rtt = null;
  const destroy = () => {
    for (const c of oldConns) { try { c.close(); } catch { /* ignore */ } }
    if (oldPeer) { try { oldPeer.destroy(); } catch { /* ignore */ } }
  };
  if (lingerMs > 0) setTimeout(destroy, lingerMs);
  else destroy();
}
