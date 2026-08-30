// The host shell on whatever platform this is running on: state persistence,
// exit codes, isolation from our own command channel, timeouts, kills, and
// resistance to output that tries to look like a completion marker.
//
// On Windows this exercises lib/hearth-helper.ps1 for real - the one component
// that cannot be covered from a Mac.
'use strict';

const assert = require('assert');
const { createShell, hostShellSupported } = require('../lib/shell');
const { isWin, normalize, tempDir, cmd } = require('./platform');

let passed = 0;
const check = (name, cond, extra) => {
  assert.ok(cond, 'FAIL: ' + name + (extra ? '  -> ' + extra : ''));
  passed++;
  console.log('  pass  ' + name);
};

(async function run() {
  if (!hostShellSupported()) {
    console.log('  skip  hosting is unavailable on this platform');
    return;
  }
  console.log('  (shell: ' + (isWin ? 'powershell' : 'posix') + ')');

  let output = '';
  const shell = createShell({ onOutput: (text) => { output += text; } });
  const collect = async (command, meta) => {
    output = '';
    const result = await shell.run(command, meta);
    return { ...result, output: normalize(output) };
  };

  let r = await collect(cmd.echo('hello from hearth'));
  check('runs a command and captures stdout', r.output.trim() === 'hello from hearth', JSON.stringify(r.output));
  check('reports exit code 0', r.code === 0);

  r = await collect(cmd.cd(tempDir));
  check('cd is reflected in the reported cwd',
    r.cwd.toLowerCase().indexOf(tempDir.toLowerCase().replace(/\\$/, '')) >= 0 ||
    r.cwd === '/private/tmp', r.cwd);

  r = await collect(cmd.pwd);
  check('working directory PERSISTS to the next command',
    r.output.toLowerCase().indexOf(tempDir.toLowerCase().slice(-4)) >= 0, r.output.trim());

  await collect(cmd.setVar('HEARTH_TEST_VAR', 'persisted'));
  r = await collect(cmd.getVar('HEARTH_TEST_VAR'));
  check('environment persists between commands', r.output.trim() === 'persisted', r.output.trim());

  r = await collect(cmd.exitWith(42));
  check('a shell-killing command still resolves', typeof r.code === 'number');

  r = await collect(cmd.echo('recovered'));
  check('shell restarts after being killed', r.output.trim() === 'recovered', r.output.trim());

  r = await collect(cmd.missingPath);
  check('non-zero exit codes are reported', r.code !== 0, 'code=' + r.code);
  check('stderr is captured alongside stdout', cmd.missingPathPattern.test(r.output), r.output.trim());

  r = await collect(cmd.threeLines);
  check('multi-line output is intact', r.output.trim() === 'a\nb\nc', JSON.stringify(r.output));

  r = await collect(cmd.tricky);
  check('quoting and unicode survive the command channel',
    r.output.indexOf(cmd.trickyText) >= 0 || r.output.indexOf('日本語 🚀') >= 0, r.output.trim());

  r = await collect(cmd.loopThreeLines);
  check('multi-line commands work',
    r.output.trim() === 'line 1\nline 2\nline 3', JSON.stringify(r.output));

  // Without stdin isolation this eats the next queued command and hangs forever.
  r = await collect(cmd.readsStdin);
  check('a command reading stdin does not hang the session', r.code === 0, 'code=' + r.code);

  r = await collect(cmd.echo('still alive'));
  check('the session survives a stdin-reading command', r.output.trim() === 'still alive', r.output.trim());

  r = await collect(cmd.forgedMarker);
  check('forged completion markers are passed through as output, not obeyed',
    r.output.indexOf('real-output') >= 0, JSON.stringify(r.output));

  const t0 = Date.now();
  r = await collect(cmd.sleepLong, { timeoutMs: 1500 });
  check('a runaway command is timed out', r.timedOut === true && Date.now() - t0 < 12000,
    'elapsed=' + (Date.now() - t0));

  r = await collect(cmd.echo('alive after timeout'));
  check('the session recovers after a timeout', r.output.trim() === 'alive after timeout', r.output.trim());

  output = '';
  const longRun = shell.run(cmd.sleepLong);
  await new Promise((res) => setTimeout(res, 600));
  check('a running command is reported as busy', shell.busy === true);
  shell.kill('SIGKILL');
  const killed = await longRun;
  check('kill stops a running command', killed.killed === true);

  r = await collect(cmd.echo('alive after kill'));
  check('the session recovers after a kill', r.output.trim() === 'alive after kill', r.output.trim());

  r = await collect(cmd.twoEchoes);
  check('sequential commands still work at the end', r.output.trim() === 'one\ntwo', JSON.stringify(r.output));

  shell.stop();
  console.log('\n  ' + passed + ' shell checks passed');
  process.exit(0);
})().catch((e) => { console.error('\n' + e.stack); process.exit(1); });
