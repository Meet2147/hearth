// Transport + crypto layer: two clients meeting in a relay room, and proof that
// the relay itself learns nothing.
'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const hc = require('../lib/crypto');
const ws = require('../lib/ws');

const PORT = 8791;
const RELAY = 'ws://127.0.0.1:' + PORT + '/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const check = (name, cond) => { assert.ok(cond, 'FAIL: ' + name); passed++; console.log('  pass  ' + name); };

function nextMessage(conn, predicate, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for relay message')), ms || 6000);
    conn.on('message', (text) => {
      const msg = JSON.parse(text);
      if (!predicate || predicate(msg)) { clearTimeout(timer); resolve(msg); }
    });
  });
}

(async function run() {
  const relay = spawn(process.execPath, [path.join(__dirname, '..', 'relay.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let relayLog = '';
  relay.stdout.on('data', (d) => { relayLog += d.toString(); });
  relay.stderr.on('data', (d) => { relayLog += d.toString(); });

  const deadline = Date.now() + 10000;
  while (relayLog.indexOf('listening') < 0 && Date.now() < deadline) await sleep(100);
  check('relay starts', relayLog.indexOf('listening') >= 0);

  const CODE = hc.generateCode();
  const key = hc.deriveKey(CODE);
  const room = hc.roomIdFor(key);
  check('room id is an opaque 32-hex label', /^[0-9a-f]{32}$/.test(room));
  check('room id does not contain the code', room.indexOf(hc.normalizeCode(CODE).toLowerCase()) < 0);

  const host = hc.newIdentity('Meet', 'host');
  const guest = hc.newIdentity('Friend', 'guest');

  const a = await ws.connect(RELAY);
  const b = await ws.connect(RELAY);

  const aJoined = nextMessage(a, (m) => m.t === 'joined');
  a.send(JSON.stringify({ t: 'hello', room }));
  await aJoined;

  const aSeesPeer = nextMessage(a, (m) => m.t === 'peer' && m.event === 'join');
  const bJoined = nextMessage(b, (m) => m.t === 'joined');
  b.send(JSON.stringify({ t: 'hello', room }));
  await bJoined;
  const peerEvent = await aSeesPeer;
  check('host is told when a peer joins', peerEvent.members === 2);

  // host -> guest, sealed and signed
  const signed = hc.sign(host, { v: 1, t: 'chat', from: host.id, name: host.name, ts: Date.now(), text: 'is this thing on?' });
  const bGets = nextMessage(b, (m) => m.t === 'msg');
  a.send(JSON.stringify({ t: 'msg', e: hc.seal(key, signed) }));
  const relayed = await bGets;

  const opened = hc.open(key, relayed.e);
  check('guest decrypts the host message', opened && opened.text === 'is this thing on?');
  check('signature verifies against the host key',
    hc.verify(hc.importPublicKey(host.pub), opened) === true);

  // an impostor cannot forge the host's signature
  const forged = hc.sign(guest, { v: 1, t: 'chat', from: host.id, name: host.name, ts: Date.now(), text: 'trust me' });
  check('a guest cannot forge a message signed as the host',
    hc.verify(hc.importPublicKey(host.pub), forged) === false);

  // tampering with signed content breaks the signature
  const tampered = { ...opened, text: 'rm -rf ~' };
  check('editing a signed message invalidates it',
    hc.verify(hc.importPublicKey(host.pub), tampered) === false);

  // the relay cannot read what it routed
  check('relayed payload is opaque base64, not plaintext',
    relayed.e.indexOf('this thing') < 0 && /^[A-Za-z0-9+/=]+$/.test(relayed.e));
  check('relay logs never contain message content', relayLog.indexOf('this thing') < 0);

  // wrong code cannot decrypt
  const wrongKey = hc.deriveKey('AAAA-BBBB-CCCC-DDDD');
  check('a different join code cannot decrypt', hc.open(wrongKey, relayed.e) === null);
  check('a different join code routes to a different room', hc.roomIdFor(wrongKey) !== room);

  // relay rejects oversized rooms/ids
  const c = await ws.connect(RELAY);
  const cErr = nextMessage(c, (m) => m.t === 'error');
  c.send(JSON.stringify({ t: 'hello', room: 'not-a-valid-room-id' }));
  check('relay rejects a malformed room id', (await cErr).reason === 'invalid room id');

  a.close(); b.close(); c.close();
  await sleep(300);
  relay.kill();
  await sleep(200);
  console.log('\n  ' + passed + ' transport checks passed');
})().catch((e) => { console.error('\n' + e.stack); process.exit(1); });
