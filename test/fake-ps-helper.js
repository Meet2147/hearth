#!/usr/bin/env node
/*
 * A stand-in for lib/hearth-helper.ps1, speaking the exact same wire protocol
 * over the exact same pipe. It lets the real Windows driver be exercised on a
 * machine that has no PowerShell: everything on the Node side is genuine, and
 * only the interpreter at the far end is substituted.
 *
 * It is NOT a PowerShell emulator - it runs commands through /bin/sh and fakes
 * `cd` bookkeeping. It exists to test the driver contract, not shell semantics.
 */
'use strict';

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const RS = '\x1e';
const pipePath = process.argv[2];
let token = null;
let cwd = process.cwd();
let active = null;   // the command currently running
const queue = [];
let busy = false;

const sock = net.connect(pipePath);
sock.setEncoding('utf8');

let buf = '';
sock.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (token === null) { token = line; continue; }   // first line is the token
    if (line) { queue.push(line); pump(); }
  }
});
sock.on('error', () => process.exit(1));
sock.on('close', () => process.exit(0));

function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const command = Buffer.from(queue.shift(), 'base64').toString('utf8');

  const cd = command.match(/^\s*cd\s+(\S+)\s*$/);
  if (cd) {
    cwd = path.resolve(cwd, cd[1].replace(/^~/, process.env.HOME || '~'));
    return done(0);
  }

  // stdin is 'ignore' here exactly as the real helper is launched, so a command
  // that reads stdin sees EOF instead of the command channel.
  const child = spawn('/bin/sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  active = child;
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stdout.write(d));
  child.on('error', () => done(127));
  child.on('exit', (code, signal) => { active = null; done(code === null ? (signal ? 137 : -1) : code); });
}

// Real PowerShell dies with its tree under taskkill /T; mimic that so killed
// commands do not leave orphans behind.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    if (active) { try { process.kill(-active.pid, 'SIGKILL'); } catch (e) {} }
    process.exit(0);
  });
}

function done(code) {
  process.stdout.write(RS + token + RS + code + RS + cwd + RS + '\n');
  busy = false;
  setImmediate(pump);
}
