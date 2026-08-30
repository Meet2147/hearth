/*
 * A persistent host shell, on macOS/Linux and on Windows.
 *
 * One long-lived shell process handles every command in a session, so `cd`,
 * environment variables and shell state survive from one command to the next -
 * which is the whole point of a shared terminal.
 *
 * Command delimiting is identical on both platforms: after each command the
 * shell prints a record-separator marker carrying a per-session random token,
 * the exit status and the new working directory. The token is generated here and
 * never leaves this process, so output cannot fake a completion.
 *
 * The two platforms differ only in how a command is handed to the shell and how
 * a runaway one is killed, so that lives behind a small driver interface and the
 * fiddly output parsing is shared.
 *
 *   POSIX   - commands go in on stdin, wrapped in a quoted heredoc so the text
 *             is passed to `eval` completely literally. Each runs with stdin
 *             from /dev/null; without that an interactive command like `cat`
 *             would eat the next queued command as its input.
 *
 *   Windows - PowerShell cannot redirect a command's stdin, so commands travel
 *             over a named pipe instead and the helper's own stdin is left
 *             closed. A native command that reads stdin sees EOF rather than
 *             our command channel. Command text is base64'd, which sidesteps
 *             PowerShell quoting entirely.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const RS = '\x1e'; // record separator
const DEFAULT_TIMEOUT_MS = 120000;
const HELPER_PS1 = path.join(__dirname, 'hearth-helper.ps1');

function isWindows() { return process.platform === 'win32'; }

function pickShell() {
  if (isWindows()) {
    if (process.env.HEARTH_SHELL) return process.env.HEARTH_SHELL;
    // powershell.exe ships with every supported Windows; pwsh may not be there.
    return 'powershell.exe';
  }
  for (const candidate of ['/bin/bash', '/usr/bin/bash', '/bin/sh']) {
    try { if (fs.existsSync(candidate)) return candidate; } catch (e) {}
  }
  return '/bin/sh';
}

// Hosting works on macOS, Linux and Windows. On Windows it depends on the
// PowerShell helper being present next to the code, so check rather than assume.
function hostShellSupported() {
  if (!isWindows()) return true;
  try { return fs.existsSync(HELPER_PS1); } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// POSIX driver
// ---------------------------------------------------------------------------

function posixDriver(shellPath) {
  let child = null;

  return {
    label: shellPath,
    get pid() { return child ? child.pid : null; },

    start(cwd, handlers, token) {
      child = spawn(shellPath, [], {
        cwd,
        detached: true, // own process group, so we can signal the whole job
        env: { ...process.env, HEARTH: '1', PS1: '', PROMPT_COMMAND: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', handlers.onData);
      child.stderr.on('data', handlers.onData);
      child.on('exit', handlers.onExit);
      child.on('error', () => handlers.onExit(null));
      // Merge stderr into stdout inside the shell so interleaving matches what a
      // real terminal would show, and disable history expansion surprises.
      try { child.stdin.write('exec 2>&1\nset +H\n'); } catch (e) {}
    },

    sendCommand(command, token) {
      // A quoted heredoc delimiter means the command text reaches eval exactly
      // as typed - no expansion, no quoting hazards, multi-line safe.
      const delim = 'HEARTH_CMD_' + token;
      const script =
        'eval "$(cat <<\'' + delim + '\'\n' + command + '\n' + delim + '\n)" </dev/null\n' +
        "printf '" + '\\036%s\\036%s\\036%s\\036\\n' + "' '" + token + "' \"$?\" \"$PWD\"\n";
      child.stdin.write(script);
    },

    killTree(signal) {
      try { process.kill(-child.pid, signal || 'SIGKILL'); return true; }
      catch (e) {
        try { child.kill(signal || 'SIGKILL'); return true; } catch (e2) { return false; }
      }
    },

    stop() {
      if (!child) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (e) { try { child.kill('SIGKILL'); } catch (e2) {} }
      child = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Windows driver
// ---------------------------------------------------------------------------

function windowsDriver(shellPath, overrides) {
  const o = overrides || {};
  const pipePath = o.pipePath ||
    '\\\\.\\pipe\\hearth-' + crypto.randomBytes(8).toString('hex');

  let child = null;
  let server = null;
  let channel = null;      // the helper's end of the command pipe
  let queued = [];         // commands issued before the helper connected
  let sessionToken = null;

  function makeServer() {
    const srv = net.createServer((sock) => {
      channel = sock;
      sock.on('error', () => {});
      sock.on('close', () => { channel = null; });
      // The token travels over the private pipe, never as a command-line
      // argument - anything on the argv is readable by the very commands we
      // run, which would let them forge a completion marker.
      sock.write(sessionToken + '\n');
      for (const line of queued) sock.write(line);
      queued = [];
    });
    srv.on('error', () => {});
    srv.listen(pipePath);
    return srv;
  }

  return {
    label: shellPath + ' (powershell)',
    pipePath,
    get pid() { return child ? child.pid : null; },

    start(cwd, handlers, token) {
      sessionToken = token;
      // The helper process restarts after a kill or a timeout, but the pipe
      // server must NOT be recreated each time: a second listen on the same
      // name fails, and the abandoned server keeps handles open forever.
      if (!server) server = makeServer();

      const spawnHelper = o.spawnHelper || defaultSpawnHelper;
      child = spawnHelper(shellPath, pipePath, cwd);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', handlers.onData);
      child.stderr.on('data', handlers.onData);
      child.on('exit', handlers.onExit);
      child.on('error', () => handlers.onExit(null));
    },


    sendCommand(command, token) {
      // base64 keeps PowerShell quoting and newlines entirely out of the picture.
      const line = Buffer.from(command, 'utf8').toString('base64') + '\n';
      if (channel) channel.write(line);
      else queued.push(line);
    },

    // Windows has no process groups, so kill the whole tree by pid.
    killTree() {
      if (!child) return false;
      const victim = child;
      let fellBack = false;
      const fallback = () => {
        if (fellBack) return;
        fellBack = true;
        try { victim.kill(); } catch (e) {}
      };
      try {
        const killer = spawn('taskkill', ['/PID', String(victim.pid), '/T', '/F'],
          { stdio: 'ignore', windowsHide: true });
        // spawn reports a missing or blocked binary ASYNCHRONOUSLY - as an
        // 'error' event, not a throw. Unhandled, that takes down the daemon.
        killer.on('error', fallback);
        killer.on('exit', (code) => { if (code !== 0) fallback(); });
      } catch (e) {
        fallback();
      }
      return true;
    },

    stop() {
      if (child) { this.killTree(); child = null; }
      if (server) { try { server.close(); } catch (e) {} server = null; }
      channel = null;
      queued = [];
    },
  };
}

function defaultSpawnHelper(shellPath, pipePath, cwd) {
  return spawn(shellPath, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', HELPER_PS1, '-PipeName', pipePath,
  ], {
    cwd,
    // stdin is deliberately closed: a native command that reads it gets EOF
    // instead of reaching our command channel.
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, HEARTH: '1' },
  });
}

// ---------------------------------------------------------------------------
// shared core
// ---------------------------------------------------------------------------

function createShell(opts) {
  const options = opts || {};
  const shellPath = options.shell || pickShell();
  const token = crypto.randomBytes(12).toString('hex');
  const marker = RS + token;
  const onOutput = options.onOutput || (() => {});
  const onIdle = options.onIdle || (() => {});
  const onCrash = options.onCrash || (() => {});

  const driver = options.driver ||
    (isWindows() ? windowsDriver(shellPath, options.windows) : posixDriver(shellPath));

  let alive = false;
  let buf = '';
  let current = null;   // { command, resolve, startedAt, timer, requester }
  let cwd = options.cwd || process.cwd();
  let stopped = false;

  function start() {
    driver.start(cwd, {
      onData: absorb,
      onExit: (code) => {
        alive = false;
        if (stopped) return;
        // The shell itself died: someone ran `exit`, or we killed the tree to
        // stop a runaway command. Either way the next run() starts a fresh
        // shell in the last known directory.
        if (current) finish(code === null ? 137 : code, cwd);
        onCrash(code);
      },
    }, token);
    alive = true;
  }

  function absorb(chunk) {
    buf += chunk;
    for (;;) {
      const idx = buf.indexOf(RS);
      if (idx < 0) { emit(buf); buf = ''; return; }
      if (idx > 0) { emit(buf.slice(0, idx)); buf = buf.slice(idx); }

      // Not enough bytes yet to tell whether this is our marker.
      if (buf.length < marker.length) return;

      if (!buf.startsWith(marker)) {
        // A stray 0x1e in real output. Pass it through and keep scanning.
        emit(buf[0]);
        buf = buf.slice(1);
        continue;
      }

      const end = buf.indexOf('\n', marker.length);
      if (end < 0) return; // marker still arriving

      const parts = buf.slice(0, end).split(RS); // ['', token, code, pwd, '']
      buf = buf.slice(end + 1);
      const code = Number(parts[2]);
      const pwd = (parts[3] || cwd).replace(/\r$/, '');
      finish(Number.isFinite(code) ? code : -1, pwd);
    }
  }

  function emit(text) {
    if (text && current) onOutput(text, current);
  }

  function finish(code, pwd) {
    if (!current) return;
    const done = current;
    current = null;
    cwd = pwd;
    if (done.timer) clearTimeout(done.timer);
    done.resolve({
      code,
      cwd: pwd,
      ms: Date.now() - done.startedAt,
      timedOut: done.timedOut === true,
      killed: done.killed === true,
    });
    onIdle();
  }

  function run(command, meta) {
    if (stopped) return Promise.resolve({ code: -1, cwd, ms: 0, error: 'shell stopped' });
    if (current) return Promise.resolve({ code: -1, cwd, ms: 0, error: 'a command is already running' });
    if (!alive) start();

    return new Promise((resolve) => {
      current = {
        command,
        resolve,
        startedAt: Date.now(),
        requester: (meta && meta.requester) || 'host',
        rid: (meta && meta.rid) || crypto.randomUUID(),
        timer: null,
      };

      const timeoutMs = (meta && meta.timeoutMs) || options.timeoutMs || DEFAULT_TIMEOUT_MS;
      current.timer = setTimeout(() => {
        if (!current) return;
        current.timedOut = true;
        kill('SIGKILL');
      }, timeoutMs);

      try { driver.sendCommand(command, token); }
      catch (e) { finish(-1, cwd); }
    });
  }

  function kill(signal) {
    if (!current) return false;
    current.killed = true;
    return driver.killTree(signal);
  }

  function stop() {
    stopped = true;
    alive = false;
    try { driver.stop(); } catch (e) {}
  }

  start();

  return {
    run,
    kill,
    stop,
    token,
    get busy() { return current !== null; },
    get running() {
      return current
        ? { command: current.command, requester: current.requester, rid: current.rid, startedAt: current.startedAt }
        : null;
    },
    get cwd() { return cwd; },
    get alive() { return alive; },
    get shellPath() { return driver.label; },
  };
}

module.exports = {
  createShell, hostShellSupported, pickShell,
  posixDriver, windowsDriver, isWindows,
  DEFAULT_TIMEOUT_MS, RS,
};
