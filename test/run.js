#!/usr/bin/env node
// Runs every suite in sequence. Each one owns its own relay port and temp home.
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const SUITES = [
  ['crypto + transport', 'transport.test.js'],
  ['command policy', 'policy.test.js'],
  ['host shell', 'shell.test.js'],
  ['windows driver', 'windows-driver.test.js'],
  ['session + permissions', 'session.test.js'],
  ['local ui security', 'localui.test.js'],
  ['live cli', 'cli.test.js'],
];

let failed = 0;
let total = 0;

for (const [label, file] of SUITES) {
  console.log('\n\x1b[1m' + label + '\x1b[0m  \x1b[2m(' + file + ')\x1b[0m');
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'pipe', encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const passes = (out.match(/^  pass /gm) || []).length;
  total += passes;
  if (r.status !== 0) {
    failed++;
    process.stdout.write(out);
    console.log('\x1b[31m  SUITE FAILED\x1b[0m');
  } else {
    console.log('  \x1b[32m' + passes + ' checks passed\x1b[0m');
  }
}

console.log('\n' + (failed
  ? '\x1b[31m' + failed + ' suite(s) failed\x1b[0m'
  : '\x1b[32mall ' + SUITES.length + ' suites passed - ' + total + ' checks\x1b[0m') + '\n');
process.exit(failed ? 1 : 0);
