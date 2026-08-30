/*
 * A small RFC 6455 WebSocket implementation - server and client.
 *
 * Hand-rolled so Hearth stays dependency-free: the relay is something you are
 * asked to run on your own box, and a server with no supply chain is a much
 * easier thing to trust. Supports text frames, fragmentation, ping/pong and
 * close; that is the whole of what this protocol needs.
 */

'use strict';

const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 8 * 1024 * 1024;

function frame(opcode, payload, mask) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len % 4294967296, 6);
  }
  header[0] = 0x80 | opcode;
  if (!mask) return Buffer.concat([header, payload]);

  header[1] |= 0x80;
  const maskKey = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ maskKey[i & 3];
  return Buffer.concat([header, maskKey, masked]);
}

// Shared frame parser. `expectMask` is true on the server (clients must mask)
// and false on the client (servers must not).
function wrap(socket, expectMask) {
  const listeners = { message: [], close: [], error: [] };
  let buf = Buffer.alloc(0);
  let fragOpcode = 0;
  let fragParts = [];
  let closed = false;

  const emit = (ev, arg) => { for (const fn of listeners[ev]) { try { fn(arg); } catch (e) {} } };

  const api = {
    socket,
    get closed() { return closed; },
    on(ev, fn) { if (listeners[ev]) listeners[ev].push(fn); return api; },
    send(text) {
      if (closed) return false;
      try { socket.write(frame(0x1, Buffer.from(text, 'utf8'), !expectMask)); return true; }
      catch (e) { return false; }
    },
    ping() {
      if (closed) return;
      try { socket.write(frame(0x9, Buffer.alloc(0), !expectMask)); } catch (e) {}
    },
    close() {
      if (closed) return;
      closed = true;
      try { socket.write(frame(0x8, Buffer.alloc(0), !expectMask)); socket.end(); } catch (e) {}
    },
    destroy() {
      if (closed) return;
      closed = true;
      try { socket.destroy(); } catch (e) {}
    },
  };

  const fail = (why) => {
    if (closed) return;
    closed = true;
    try { socket.destroy(); } catch (e) {}
    emit('error', new Error(why || 'protocol error'));
    emit('close');
  };

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > MAX_FRAME * 2) return fail('frame buffer overflow');

    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        const hi = buf.readUInt32BE(off);
        if (hi !== 0) return fail('frame too large');
        len = buf.readUInt32BE(off + 4); off += 8;
      }
      if (len > MAX_FRAME) return fail('frame too large');
      if (masked !== expectMask) return fail('masking rule violated');

      let maskKey = null;
      if (masked) {
        if (buf.length < off + 4) return;
        maskKey = buf.subarray(off, off + 4); off += 4;
      }
      if (buf.length < off + len) return;

      let payload = buf.subarray(off, off + len);
      if (maskKey) {
        const un = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) un[i] = payload[i] ^ maskKey[i & 3];
        payload = un;
      } else {
        payload = Buffer.from(payload);
      }
      buf = buf.subarray(off + len);

      if (opcode === 0x8) { api.close(); emit('close'); return; }
      if (opcode === 0x9) {
        try { socket.write(frame(0xA, payload, !expectMask)); } catch (e) {}
        continue;
      }
      if (opcode === 0xA) continue;

      if (opcode === 0x0) fragParts.push(payload);
      else { fragOpcode = opcode; fragParts = [payload]; }

      if (fin) {
        const full = Buffer.concat(fragParts);
        fragParts = [];
        if (fragOpcode === 0x1) emit('message', full.toString('utf8'));
      }
    }
  });

  socket.on('error', () => fail('socket error'));
  socket.on('close', () => { if (!closed) { closed = true; emit('close'); } });

  return api;
}

// --- server -----------------------------------------------------------------

function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return null; }
  const acceptKey = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  return wrap(socket, true);
}

// --- client -----------------------------------------------------------------

function connect(url, opts) {
  const options = opts || {};
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (e) { return reject(new Error('invalid relay url: ' + url)); }

    const secure = target.protocol === 'wss:';
    if (target.protocol !== 'ws:' && !secure) {
      return reject(new Error('relay url must start with ws:// or wss://'));
    }
    const port = target.port || (secure ? 443 : 80);
    const key = crypto.randomBytes(16).toString('base64');
    const path = (target.pathname || '/') + (target.search || '');

    const agentless = {
      host: target.hostname,
      port: Number(port),
      servername: target.hostname,
      rejectUnauthorized: options.rejectUnauthorized !== false,
    };

    const socket = secure
      ? tls.connect(agentless, onReady)
      : net.connect({ host: agentless.host, port: agentless.port }, onReady);

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out connecting to relay ' + url));
    }, options.timeout || 12000);

    socket.on('error', (e) => { clearTimeout(timer); reject(e); });

    function onReady() {
      socket.setNoDelay(true);
      let extra = '';
      for (const [name, value] of Object.entries(options.headers || {})) {
        extra += name + ': ' + value + '\r\n';
      }
      socket.write(
        'GET ' + path + ' HTTP/1.1\r\n' +
        'Host: ' + target.host + '\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        extra +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    }

    let head = Buffer.alloc(0);
    const onHandshake = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > 16384) { clearTimeout(timer); socket.destroy(); reject(new Error('handshake too large')); }
        return;
      }
      const text = head.slice(0, end).toString();
      const expect = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (!/^HTTP\/1\.1 101/.test(text) || text.indexOf(expect) < 0) {
        clearTimeout(timer);
        socket.destroy();
        return reject(new Error('relay refused the websocket upgrade:\n' + text.split('\r\n')[0]));
      }
      clearTimeout(timer);
      socket.removeListener('data', onHandshake);
      const rest = head.slice(end + 4);
      const client = wrap(socket, false);
      resolve(client);
      // The server's first frame often arrives in the SAME tcp segment as the
      // handshake response. Replaying it synchronously would fire before the
      // caller - who is still awaiting this promise - can attach a listener,
      // and the message would be lost. Hand it back on the next tick instead.
      if (rest.length) setImmediate(() => { try { socket.emit('data', rest); } catch (e) {} });
    };
    socket.on('data', onHandshake);
  });
}

module.exports = { accept, connect, wrap, frame };
