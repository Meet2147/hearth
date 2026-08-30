// The host's local UI socket can start commands on this machine, so it gets its
// own security tests: loopback binding, token, and Origin. Browsers do NOT apply
// the same-origin policy to WebSockets - without an Origin check, any website
// you had open could drive your shell.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-ui-'));
process.env.HOME = TMP;

const hc = require('../lib/crypto');
const ws = require('../lib/ws');
const { HostSession } = require('../lib/session');
const { createLocalUI } = require('../lib/localui');

const RELAY_PORT = 8807;
const UI_PORT = 7781;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const check = (name, cond, extra) => {
  assert.ok(cond, 'FAIL: ' + name + (extra ? '  -> ' + extra : ''));
  passed++; console.log('  pass  ' + name);
};

function get(pathname, port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

async function refused(url, opts) {
  try { await ws.connect(url, { timeout: 3000, ...(opts || {}) }); return false; }
  catch (e) { return true; }
}

(async function run() {
  const relay = spawn(process.execPath, [path.join(__dirname, '..', 'relay.js')],
    { env: { ...process.env, PORT: String(RELAY_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let rl = '';
  relay.stdout.on('data', (d) => { rl += d.toString(); });
  const rd = Date.now() + 10000;
  while (rl.indexOf('listening') < 0 && Date.now() < rd) await sleep(100);

  const CODE = hc.generateCode();
  const session = new HostSession({ relayUrl: 'ws://127.0.0.1:' + RELAY_PORT + '/ws', code: CODE, name: 'Meet' });
  await session.connect();

  let ran = null;
  const local = createLocalUI(session, {
    port: UI_PORT, code: CODE, joinLine: 'hearth join ' + CODE, relayUrl: 'ws://127.0.0.1:' + RELAY_PORT + '/ws',
    onRun: async (cmd) => { ran = cmd; await session.execute(cmd, { requester: 'Meet' }); },
  });
  await local.listen();

  // --- binding
  check('the UI listens on loopback only, never the LAN',
    local.server.address().address === '127.0.0.1', local.server.address().address);

  // --- page token
  check('the page is refused without a token', (await get('/', UI_PORT)).status === 403);
  check('the page is refused with a wrong token', (await get('/?token=deadbeef', UI_PORT)).status === 403);

  const page = await get('/?token=' + local.token, UI_PORT);
  check('the page is served with the right token', page.status === 200 && /Hearth/.test(page.body));
  check('the page carries a restrictive CSP',
    /default-src 'none'/.test(page.headers['content-security-policy'] || ''),
    page.headers['content-security-policy']);

  // --- socket guards
  const base = 'ws://127.0.0.1:' + UI_PORT;
  check('the socket is refused with no token', await refused(base + '/ui'));
  check('the socket is refused with a wrong token', await refused(base + '/ui?token=deadbeef'));
  check('the socket is refused on an unknown path', await refused(base + '/nope?token=' + local.token));
  check('the socket is refused from a foreign Origin',
    await refused(base + '/ui?token=' + local.token, { headers: { Origin: 'https://evil.example.com' } }),
    'a malicious page could otherwise drive the shell');
  check('the socket is accepted from its own Origin',
    !(await refused(base + '/ui?token=' + local.token, { headers: { Origin: 'http://127.0.0.1:' + UI_PORT } })));

  // --- it actually works
  const conn = await ws.connect(base + '/ui?token=' + local.token);
  const seen = [];
  conn.on('message', (t) => { try { seen.push(JSON.parse(t)); } catch (e) {} });

  await sleep(400);
  const snap = seen.find((m) => m.t === 'snapshot');
  check('a valid client receives a snapshot', !!snap && snap.me === 'Meet', JSON.stringify(snap));
  check('the snapshot carries the join line and audit path',
    !!snap.joinLine && !!snap.auditPath && !!snap.fingerprint);
  check('the snapshot never contains key material',
    JSON.stringify(snap).indexOf('PRIVATE') < 0 && snap.key === undefined);

  conn.send(JSON.stringify({ t: 'run', command: 'echo ui-round-trip' }));
  const deadline = Date.now() + 10000;
  while (!seen.some((m) => m.t === 'command-done') && Date.now() < deadline) await sleep(120);

  check('a command sent from the UI runs on the host', ran === 'echo ui-round-trip');
  check('the UI is told the command started',
    seen.some((m) => m.t === 'command-start' && m.command === 'echo ui-round-trip'));
  check('output streams back to the UI',
    seen.filter((m) => m.t === 'output').map((m) => m.chunk).join('').indexOf('ui-round-trip') >= 0);
  check('completion is reported with an exit code',
    seen.some((m) => m.t === 'command-done' && m.code === 0));

  conn.close();
  local.close();
  session.close();
  await sleep(300);
  relay.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n  ' + passed + ' local UI checks passed');
})().catch((e) => { console.error('\n' + e.stack); process.exit(1); });
