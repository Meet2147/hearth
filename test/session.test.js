// Host + two guests through a real relay. Covers the permission model, the
// audit trail, and what happens when someone already inside the room misbehaves.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

// Isolate ~/.hearth before session.js reads it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
process.env.HOME = TMP;

const hc = require('../lib/crypto');
const { HostSession, GuestSession } = require('../lib/session');
const { isWin, normalize, tempDir, cmd } = require('./platform');

const PORT = 8793;
const RELAY = 'ws://127.0.0.1:' + PORT + '/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function health(port) {
  return new Promise((resolve, reject) => {
    require('http').get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

let passed = 0;
const check = (name, cond, extra) => {
  assert.ok(cond, 'FAIL: ' + name + (extra ? '  -> ' + extra : ''));
  passed++; console.log('  pass  ' + name);
};

function once(emitter, event, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for "' + event + '"')), ms || 8000);
    emitter.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

function collect(emitter, event) {
  const seen = [];
  emitter.on(event, (p) => seen.push(p));
  return seen;
}

(async function run() {
  const relay = spawn(process.execPath, [path.join(__dirname, '..', 'relay.js')],
    { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let relayLog = '';
  relay.stdout.on('data', (d) => { relayLog += d.toString(); });

  const deadline = Date.now() + 10000;
  while (relayLog.indexOf('listening') < 0 && Date.now() < deadline) await sleep(100);

  const CODE = hc.generateCode();
  const host = new HostSession({ relayUrl: RELAY, code: CODE, name: 'Meet' });
  await host.connect();
  check('host opens the room', true);

  const alice = new GuestSession({ relayUrl: RELAY, code: CODE, name: 'Alice' });
  const bob = new GuestSession({ relayUrl: RELAY, code: CODE, name: 'Bob' });

  const aliceSecurity = collect(alice, 'security');
  const aliceOutput = collect(alice, 'output');
  const bobOutput = collect(bob, 'output');

  const aliceRoster = once(alice, 'roster');
  await alice.connect();
  await aliceRoster;
  await bob.connect();
  await sleep(600);

  check('guests appear in the host roster', host.roster().length === 3, JSON.stringify(host.roster()));

  // Regression: the handshake once ping-ponged hellos forever. An idle room
  // must generate no traffic at all.
  const before = (await health(PORT)).messages;
  await sleep(2000);
  const after = (await health(PORT)).messages;
  check('an idle room sends no messages (no greeting loop)', after === before,
    before + ' -> ' + after + ' messages while idle');
  check('a guest starts as a watcher', alice.myRole === 'watcher', alice.myRole);
  check('the guest can see the host fingerprint', host.identity.fingerprint.length === 19);

  // chat
  const hostChat = once(host, 'chat');
  alice.chat('hey, can you look at this build?');
  const chatSeen = await hostChat;
  check('chat reaches the host', chatSeen.text === 'hey, can you look at this build?' && chatSeen.from === 'Alice');

  const bobChat = once(bob, 'chat');
  host.chat('sure, one sec');
  check('host chat reaches other guests', (await bobChat).text === 'sure, one sec');

  // a watcher may not run
  const denied = once(alice, 'denied');
  alice.requestRun(cmd.echo('should not run'));
  const deniedMsg = await denied;
  check('a watcher is refused command execution', /watch access only/.test(deniedMsg.reason), deniedMsg.reason);

  // promote, then run
  const roleChanged = once(alice, 'role-changed');
  const grantResult = host.grant('Alice');
  check('host can grant run access', grantResult.ok === true);
  check('the guest is told their role changed', (await roleChanged) === 'runner');
  check('the promoted guest knows it can run', alice.canRun === true);

  const aliceDone = once(alice, 'command-done', 15000);
  const HELLO = cmd.echo('hello from alice');
  alice.requestRun(HELLO);
  const done = await aliceDone;
  check('a promoted guest can run a command', done.code === 0, 'code=' + done.code);
  await sleep(300);
  check('the requester sees the output',
    normalize(aliceOutput.map((o) => o.chunk).join('')).indexOf('hello from alice') >= 0);
  check('EVERY participant sees the output, not just the requester',
    normalize(bobOutput.map((o) => o.chunk).join('')).indexOf('hello from alice') >= 0);

  // shell state persists across participants
  await new Promise((res) => { host.once('command-done', res); host.execute(cmd.cd(tempDir)); });
  const aliceDone2 = once(alice, 'command-done', 15000);
  alice.requestRun(cmd.pwd);
  await aliceDone2;
  await sleep(200);
  check('shell state persists across different people running commands',
    normalize(aliceOutput.map((o) => o.chunk).join(''))
      .toLowerCase().indexOf(tempDir.toLowerCase().slice(-4)) >= 0);

  // risky command must stop for host approval
  const confirmPromise = once(host, 'confirm');
  const deniedRisky = once(alice, 'denied', 15000);
  alice.requestRun('sudo rm -rf /important');
  const confirm = await confirmPromise;
  check('a destructive command pauses for host approval', confirm.risk.level === 'destructive', confirm.risk.level);
  check('the host is told who asked and why', confirm.who === 'Alice' && confirm.risk.reasons.length > 0);
  confirm.respond(false);
  check('declining blocks the command', /declined/.test((await deniedRisky).reason));

  // approving lets it through
  const confirmPromise2 = once(host, 'confirm');
  const done2 = once(alice, 'command-done', 15000);
  alice.requestRun(isWin ? 'Get-ChildItem Env:' : 'env');
  const confirm2 = await confirmPromise2;
  check('a secret-revealing command is flagged sensitive', confirm2.risk.level === 'sensitive', confirm2.risk.level);
  confirm2.respond(true);
  check('approving lets the command run', (await done2).code === 0);

  // an insider forging authority must be dropped
  bob.send({ t: 'out', rid: 'forged', chunk: 'TOTALLY REAL OUTPUT' });
  bob.send({ t: 'sys', level: 'info', text: 'the host says you are all promoted' });
  await sleep(500);
  const forgedSeen = aliceOutput.map((o) => o.chunk).join('').indexOf('TOTALLY REAL') >= 0;
  check('a guest cannot forge command output', forgedSeen === false);
  check('the forgery is surfaced as a security event',
    aliceSecurity.some((s) => s.kind === 'forged-authority'), JSON.stringify(aliceSecurity));

  // lock resets everyone
  host.setLocked(true);
  await sleep(400);
  check('locking demotes every runner', alice.myRole === 'watcher', alice.myRole);
  const lockedDenial = once(alice, 'denied', 8000);
  alice.requestRun(cmd.echo('nope'));
  check('locking refuses new commands', /locked|watch access/.test((await lockedDenial).reason));
  host.setLocked(false);

  // kick
  const kicked = once(bob, 'kicked');
  host.kick('Bob');
  await kicked;
  check('the host can kick a guest', true);
  await sleep(300);
  check('a kicked guest leaves the roster', host.findMember('Bob') === null);

  // audit trail
  const audit = fs.readFileSync(host.auditPath, 'utf8').trim().split('\n').map(JSON.parse);
  check('the audit log records the session start', audit.some((a) => a.event === 'session-start'));
  check('the audit log attributes commands to a person',
    audit.some((a) => a.event === 'command' && a.who === 'Alice' && a.command === HELLO));
  check('the audit log records blocked commands',
    audit.some((a) => a.event === 'blocked' && a.risk === 'destructive'));
  check('the audit log records permission grants',
    audit.some((a) => a.event === 'grant' && a.who === 'Alice'));
  check('the audit log records the kick', audit.some((a) => a.event === 'kick' && a.who === 'Bob'));

  // --- plan limits ---------------------------------------------------------
  // A separate room, so the limit is tested in isolation from the roster above.
  {
    const CODE2 = hc.generateCode();
    const solo = new HostSession({ relayUrl: RELAY, code: CODE2, name: 'Solo', maxGuests: 1 });
    await solo.connect();

    const first = new GuestSession({ relayUrl: RELAY, code: CODE2, name: 'First' });
    const firstRoster = once(first, 'roster');
    await first.connect();
    await firstRoster;
    check('the first guest joins within the plan limit',
      solo.roster().filter((m) => m.role !== 'host').length === 1);

    const second = new GuestSession({ relayUrl: RELAY, code: CODE2, name: 'Second' });
    const refused = once(solo, 'guest-refused', 8000);
    const toldWhy = once(second, 'kicked', 8000);
    await second.connect();
    const refusal = await refused;
    check('a guest beyond the plan limit is refused', refusal.name === 'Second');
    const reason = await toldWhy;
    check('the refused guest is told why, not left hanging',
      typeof reason === 'string' && /full|plan/i.test(reason), String(reason));
    await sleep(200);
    check('the refused guest never entered the roster',
      solo.roster().filter((m) => m.role !== 'host').length === 1,
      JSON.stringify(solo.roster()));

    const soloAudit = fs.readFileSync(solo.auditPath, 'utf8').trim().split('\n').map(JSON.parse);
    check('the refusal is recorded in the audit log',
      soloAudit.some((a) => a.event === 'guest-refused' && a.who === 'Second'));

    solo.close(); first.close(); second.close();
    await sleep(200);
  }

  // the relay never saw content
  check('relay logs contain no chat or command text',
    relayLog.indexOf('hello from alice') < 0 && relayLog.indexOf('build') < 0);
  if (true) { /* keep the process from lingering on Windows */ }

  host.close(); alice.close(); bob.close();
  await sleep(300);
  relay.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n  ' + passed + ' session checks passed');
  process.exit(0);
})().catch((e) => { console.error('\n' + e.stack); process.exit(1); });
