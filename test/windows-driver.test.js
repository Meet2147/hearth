// Exercises the REAL Windows driver - its named-pipe command channel, token
// handshake, base64 command transport, pre-connect queueing, marker parsing and
// tree kill - with a stand-in for the PowerShell interpreter so it can run
// anywhere. The .ps1 itself is the only piece these checks do not cover.
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { createShell, windowsDriver } = require('../lib/shell');

const FAKE = path.join(__dirname, 'fake-ps-helper.js');
// Short path: unix socket paths are capped near 104 bytes.
const PIPE = '/tmp/hearth-test-' + crypto.randomBytes(6).toString('hex') + '.sock';

let passed = 0;
const check = (name, cond, extra) => {
  assert.ok(cond, 'FAIL: ' + name + (extra ? '  -> ' + extra : ''));
  passed++; console.log('  pass  ' + name);
};

(async function run() {
  if (process.platform === 'win32') {
    console.log('  skip  on Windows the real driver is used directly by shell.test.js');
    return;
  }

  let output = '';
  const driver = windowsDriver('node', {
    pipePath: PIPE,
    spawnHelper: (shellPath, pipePath, cwd) =>
      spawn(process.execPath, [FAKE, pipePath], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }),
  });

  const shell = createShell({ driver, onOutput: (t) => { output += t; } });

  const collect = async (cmd, meta) => {
    output = '';
    const r = await shell.run(cmd, meta);
    return { ...r, output };
  };

  // Issued immediately - the helper has not connected yet, so this exercises
  // the queue that holds commands until the pipe is up.
  let r = await collect('echo queued-before-connect');
  check('a command issued before the helper connects is queued, not lost',
    r.output.trim() === 'queued-before-connect', JSON.stringify(r.output));
  check('exit code 0 is reported', r.code === 0);

  r = await collect('exit 3');
  check('a non-zero exit code is reported', r.code === 3, 'code=' + r.code);

  r = await collect('echo "quotes \' and $HOME and 日本語 🚀"');
  check('base64 transport preserves quoting and unicode',
    r.output.indexOf('日本語 🚀') >= 0, r.output.trim());

  r = await collect('printf "a\\nb\\nc\\n"');
  check('multi-line output is intact', r.output === 'a\nb\nc\n', JSON.stringify(r.output));

  r = await collect('for i in 1 2 3; do echo "line $i"; done');
  check('multi-line commands survive the pipe',
    r.output.trim() === 'line 1\nline 2\nline 3', JSON.stringify(r.output));

  r = await collect('cd /tmp');
  check('the working directory is tracked from the marker',
    r.cwd === '/tmp', r.cwd);
  check('the shell reports the new cwd', shell.cwd === '/tmp', shell.cwd);

  // The helper's own stdin is closed, so this must not swallow our channel.
  r = await collect('cat');
  check('a command reading stdin gets EOF instead of the command channel', r.code === 0, 'code=' + r.code);
  r = await collect('echo still-alive');
  check('the session survives a stdin-reading command', r.output.trim() === 'still-alive', r.output.trim());

  // Output impersonating a completion marker must be treated as text.
  r = await collect('printf "\\036deadbeefdeadbeefdeadbeef\\0360\\036/\\036\\n"; echo real-output');
  check('a forged completion marker is passed through as output',
    r.output.indexOf('real-output') >= 0, JSON.stringify(r.output));

  const t0 = Date.now();
  r = await collect('sleep 30', { timeoutMs: 1200 });
  check('a runaway command is timed out', r.timedOut === true && Date.now() - t0 < 9000,
    'elapsed=' + (Date.now() - t0));

  r = await collect('echo alive-after-timeout');
  check('the session recovers after a timeout', r.output.trim() === 'alive-after-timeout', r.output.trim());

  output = '';
  const long = shell.run('sleep 30');
  await new Promise((res) => setTimeout(res, 400));
  check('a running command reports busy', shell.busy === true);
  shell.kill();
  const killed = await long;
  check('kill stops a running command', killed.killed === true);

  r = await collect('echo alive-after-kill');
  check('the session recovers after a kill', r.output.trim() === 'alive-after-kill', r.output.trim());

  shell.stop();
  try { fs.unlinkSync(PIPE); } catch (e) {}
  console.log('\n  ' + passed + ' windows-driver checks passed');
  process.exit(0);
})().catch((e) => {
  try { fs.unlinkSync(PIPE); } catch (e2) {}
  console.error('\n' + e.stack);
  process.exit(1);
});
