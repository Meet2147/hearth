#!/usr/bin/env node
/*
 * Hearth relay.
 *
 * A blind switchboard. It routes opaque blobs between the members of a room and
 * knows nothing else: not the join code, not who is in the room, not what was
 * said or run. The room id it routes on is a one-way hash of a key it never
 * receives.
 *
 * Deliberately boring on purpose - this is the one piece you are asked to run on
 * a server, so it should be small enough to read in full before you trust it.
 *
 *   node relay.js                 listen on 0.0.0.0:8787
 *   PORT=9000 node relay.js       pick the port
 *
 * Put it behind a TLS terminator (Caddy, nginx, Fly.io) so clients use wss://.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const ws = require('./lib/ws');

// The relay also hands out the web client, so a guest needs nothing but a link.
// The page is inert on its own: it holds no code, no key and no room id.
let APP_HTML = null;
try { APP_HTML = fs.readFileSync(path.join(__dirname, 'web', 'app.html'), 'utf8'); } catch (e) {}

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

// Guard rails for anything exposed to the internet.
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 500);
const MAX_PER_ROOM = Number(process.env.MAX_PER_ROOM || 16);
const MAX_MSG_BYTES = Number(process.env.MAX_MSG_BYTES || 256 * 1024);
const MSG_PER_SEC = Number(process.env.MSG_PER_SEC || 80);
const IDLE_MS = Number(process.env.IDLE_MS || 120000);

const rooms = new Map(); // roomId -> Map(cid -> conn)
let nextCid = 1;
const started = Date.now();
let totalConnections = 0;
let totalMessages = 0;

const log = (...args) => console.log(new Date().toISOString(), ...args);

const server = http.createServer((req, res) => {
  const pathOnly = req.url.split('?')[0];

  if (APP_HTML && (pathOnly === '/' || pathOnly === '/index.html')) {
    const body = Buffer.from(APP_HTML, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(body);
  }

  if (pathOnly === '/health' || pathOnly === '/') {
    const body = JSON.stringify({
      ok: true,
      service: 'hearth-relay',
      uptimeSeconds: Math.round((Date.now() - started) / 1000),
      rooms: rooms.size,
      connections: totalConnections,
      messages: totalMessages,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(body);
  }
  res.writeHead(404).end('not found');
});

server.on('upgrade', (req, socket) => {
  if (!req.url.startsWith('/ws')) { socket.destroy(); return; }

  const conn = ws.accept(req, socket);
  if (!conn) return;

  const cid = 'c' + (nextCid++);
  totalConnections++;

  let roomId = null;
  let windowStart = Date.now();
  let windowCount = 0;
  let lastSeen = Date.now();

  const send = (obj) => conn.send(JSON.stringify(obj));
  const bye = (reason) => { try { send({ t: 'error', reason }); } catch (e) {} conn.close(); };

  const heartbeat = setInterval(() => {
    if (Date.now() - lastSeen > IDLE_MS) { conn.destroy(); return; }
    conn.ping();
  }, 30000);

  conn.on('message', (text) => {
    lastSeen = Date.now();

    if (text.length > MAX_MSG_BYTES) return bye('message too large');

    // Simple fixed-window rate limit. Generous enough for streaming command
    // output, tight enough that one client cannot flood a room.
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; windowCount = 0; }
    if (++windowCount > MSG_PER_SEC) return bye('rate limit exceeded');

    let msg;
    try { msg = JSON.parse(text); } catch (e) { return bye('malformed json'); }
    if (!msg || typeof msg.t !== 'string') return bye('malformed message');

    if (msg.t === 'hello') {
      if (roomId) return bye('already joined');
      if (typeof msg.room !== 'string' || !/^[0-9a-f]{32}$/.test(msg.room)) {
        return bye('invalid room id');
      }
      let room = rooms.get(msg.room);
      if (!room) {
        if (rooms.size >= MAX_ROOMS) return bye('relay is at capacity');
        room = new Map();
        rooms.set(msg.room, room);
      }
      if (room.size >= MAX_PER_ROOM) return bye('room is full');

      roomId = msg.room;
      room.set(cid, conn);
      log('join', roomId.slice(0, 8), cid, '(' + room.size + ' in room)');

      send({ t: 'joined', cid, members: room.size });
      for (const [otherCid, other] of room) {
        if (otherCid !== cid) other.send(JSON.stringify({ t: 'peer', event: 'join', cid, members: room.size }));
      }
      return;
    }

    if (msg.t === 'msg') {
      if (!roomId) return bye('not in a room');
      if (typeof msg.e !== 'string') return bye('malformed payload');
      const room = rooms.get(roomId);
      if (!room) return;
      totalMessages++;
      // The payload is opaque. We copy bytes and form no opinion about them.
      const wire = JSON.stringify({ t: 'msg', from: cid, e: msg.e });
      for (const [otherCid, other] of room) {
        if (otherCid !== cid) other.send(wire);
      }
      return;
    }

    if (msg.t === 'ping') { send({ t: 'pong' }); return; }

    bye('unknown message type');
  });

  conn.on('close', () => {
    clearInterval(heartbeat);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.delete(cid);
    if (room.size === 0) {
      rooms.delete(roomId);
      log('room closed', roomId.slice(0, 8));
    } else {
      const wire = JSON.stringify({ t: 'peer', event: 'leave', cid, members: room.size });
      for (const other of room.values()) other.send(wire);
      log('leave', roomId.slice(0, 8), cid, '(' + room.size + ' remain)');
    }
  });
});

server.listen(PORT, HOST, () => {
  log('hearth relay listening on ' + HOST + ':' + PORT);
  log('rooms<=' + MAX_ROOMS + ' members<=' + MAX_PER_ROOM +
      ' msg<=' + MAX_MSG_BYTES + 'B rate<=' + MSG_PER_SEC + '/s');
});

const shutdown = () => { log('shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = server;
