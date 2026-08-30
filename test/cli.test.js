// Drives the real CLI binaries end to end: a relay, a host and a guest as
// separate processes, talking to each other exactly as they would in use.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-cli-'));
const PORT = 8795;
const RELAY = 'ws://127.0.0.1:' + PORT + '/ws';
const CODE = 'TEST-CODE-ABCD-1234';
const CLI = path.join(__dirname, '..', 'hearth.js');
const { isWin, tempDir, samePath, cmd } = require('./platform');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond, extra) => {
  assert.ok(cond, 'FAIL: ' + name + (extra ? '\n---- context ----\n' + extra : ''));
  passed++; console.log('  pass  ' + name);
};

function launch(args, env) {
  const p = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, HOME: TMP, USERPROFILE: TMP, NO_COLOR: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  p.buf = '';
  p.stdout.on('data', (d) => { p.buf += d.toString(); });
  p.stderr.on('data', (d) => { p.buf += d.toString(); });
  p.type = (line) => p.stdin.write(line + '\n');
  return p;
}

// The shared shell runs one command at a time and refuses overlapping ones by
// design, so tests must wait for completion, not just for output to appear.
async function waitIdle(proc, ms) {
  const deadline = Date.now() + (ms || 12000);
  let seen = (proc.buf.match(/^  (ok|exit |timed out|stopped)/gm) || []).length;
  const target = seen + 1;
  while (Date.now() < deadline) {
    if ((proc.buf.match(/^  (ok|exit |timed out|stopped)/gm) || []).length >= target) return true;
    await sleep(100);
  }
  return false;
}

async function waitFor(proc, needle, ms) {
  const deadline = Date.now() + (ms || 12000);
  while (Date.now() < deadline) {
    if (proc.buf.indexOf(needle) >= 0) return true;
    await sleep(120);
  }
  return false;
}

(async function run() {
  const relay = spawn(process.execPath, [path.join(__dirname, '..', 'relay.js')],
    { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let relayLog = '';
  relay.stdout.on('data', (d) => { relayLog += d.toString(); });
  const rd = Date.now() + 10000;
  while (relayLog.indexOf('listening') < 0 && Date.now() < rd) await sleep(100);

  const host = launch(['host', '--relay', RELAY, '--name', 'Meet', '--code', CODE]);
  check('host starts and prints the join line',
    await waitFor(host, 'hearth join ' + CODE), host.buf);
  check('host shows its signing key fingerprint', /key\s+[0-9A-F]{4}-/.test(host.buf), host.buf);

  const alice = launch(['join', CODE, '--relay', RELAY, '--name', 'Alice']);
  check('guest connects and identifies the host', await waitFor(alice, 'host is Meet'), alice.buf);
  check('guest is told it is watching only', await waitFor(alice, 'you are watching'), alice.buf);
  check('host announces the new watcher', await waitFor(host, 'Alice joined as a watcher'), host.buf);

  // plain text is chat
  alice.type('can you check the build?');
  check('bare text is sent as chat', await waitFor(host, 'can you check the build?'), host.buf);

  host.type('/chat sure, looking now');
  check('/chat reaches the guest', await waitFor(alice, 'sure, looking now'), alice.buf);

  // watcher cannot run
  alice.type('/run ' + cmd.echo('should-not-run'));
  check('a watcher is refused', await waitFor(alice, 'watching only'), alice.buf);
  check('the refusal never executed anything', alice.buf.indexOf('should-not-run\n') < 0);

  // host runs something itself
  host.type('/run ' + cmd.echo('hello-from-host'));
  check('host can run a command', await waitFor(host, 'hello-from-host'), host.buf);
  await waitIdle(host);
  check('the guest sees the host command output', await waitFor(alice, 'hello-from-host'), alice.buf);

  // promote
  host.type('/allow Alice');
  check('host grants run access', await waitFor(host, 'Alice can now run commands'), host.buf);
  check('guest is told about the promotion', await waitFor(alice, 'gave you run access'), alice.buf);

  alice.type('/run ' + cmd.echo('alice-was-here'));
  check('promoted guest can run', await waitFor(alice, 'alice-was-here'), alice.buf);
  check('host sees who ran it', await waitFor(host, 'alice-was-here'), host.buf);
  check('the host is shown WHO ran it, not just the output',
    /alice-was-here[^\n]*\(Alice\)/.test(host.buf), host.buf.slice(-700));
  check('other participants see the attribution too',
    /alice-was-here[^\n]*\(Alice\)/.test(alice.buf), alice.buf.slice(-700));
  await waitIdle(host);

  // shell state persists across people
  const beforeCd = host.buf.length;
  alice.type('/run ' + cmd.cd(tempDir));
  await waitIdle(host);
  host.type('/run ' + cmd.pwd);
  await waitIdle(host);
  check('shell state persists between different people',
    host.buf.slice(beforeCd).toLowerCase().indexOf(require('path').basename(tempDir).toLowerCase()) >= 0,
    host.buf.slice(-900));

  // $ shorthand
  host.type('$ ' + cmd.echo('shorthand-works'));
  check('the $ shorthand runs a command', await waitFor(host, 'shorthand-works'), host.buf.slice(-900));
  await waitIdle(host);
  check('no false security warnings during a normal session',
    host.buf.indexOf('different signing key') < 0 && alice.buf.indexOf('different signing key') < 0,
    'a legitimate re-greeting was flagged as an attack');

  // dangerous command must stop and ask
  alice.type('/run ' + (isWin ? 'Remove-Item -Recurse -Force C:\\nothing-here' : 'sudo rm -rf /tmp/nothing-here'));
  check('a destructive request pauses for the host', await waitFor(host, 'DESTRUCTIVE COMMAND'), host.buf.slice(-1200));
  check('the host is shown who asked', host.buf.indexOf('Alice wants to run') >= 0, host.buf.slice(-1200));
  host.type('no');
  check('declining refuses the command', await waitFor(alice, 'declined'), alice.buf.slice(-800));

  // roster
  host.type('/who');
  check('/who lists everyone with their access',
    await waitFor(host, 'can run') && host.buf.indexOf('Alice') >= 0, host.buf.slice(-600));

  // lock is a panic switch
  host.type('/lock');
  check('lock is announced to guests', await waitFor(alice, 'locked the session'), alice.buf.slice(-700));
  alice.type('/run ' + cmd.echo('after-lock'));
  await sleep(1000);
  check('lock actually stops execution', alice.buf.indexOf('after-lock\n') < 0);

  host.type('/unlock');
  await sleep(500);

  // kick
  host.type('/kick Alice');
  check('kicked guest is told and exits', await waitFor(alice, 'removed you from the session'), alice.buf.slice(-700));

  // audit trail on disk
  await sleep(500);
  const auditDir = fs.readdirSync(TMP + '/.hearth').filter((f) => f.startsWith('audit-'));
  check('an audit log was written', auditDir.length === 1, JSON.stringify(auditDir));
  const audit = fs.readFileSync(path.join(TMP, '.hearth', auditDir[0]), 'utf8')
    .trim().split('\n').map(JSON.parse);
  check('audit attributes a command to the guest who asked',
    audit.some((a) => a.event === 'command' && a.who === 'Alice' && /alice-was-here/.test(a.command)));
  check('audit records the blocked destructive command',
    audit.some((a) => a.event === 'blocked' && a.risk === 'destructive'));

  check('relay logged no command or chat text',
    relayLog.indexOf('alice-was-here') < 0 && relayLog.indexOf('check the build') < 0);

  host.type('/quit');
  await sleep(400);
  host.kill(); alice.kill(); relay.kill();
  await sleep(200);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log('\n  ' + passed + ' cli checks passed');
  process.exit(0);
})().catch((e) => { console.error('\n' + e.stack); process.exit(1); });
