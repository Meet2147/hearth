#!/usr/bin/env node
/*
 * Generates every icon the desktop build needs, for whichever platform is
 * building. Keeps generated binaries out of the repository: CI draws them fresh
 * on each run, so the icon can never drift from the generator.
 *
 *   node tools/icons.js [outDir]      default: desktop/build
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const MAKE = path.join(__dirname, 'make-icon.js');
const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'desktop', 'build'));
fs.mkdirSync(out, { recursive: true });

const run = (args) => execFileSync(process.execPath, [MAKE, ...args], { stdio: 'inherit' });

run(['ico', path.join(out, 'icon.ico')]);
run(['png', path.join(out, 'icon.png')]);

// .icns needs iconutil, which only exists on macOS. Everywhere else the mac
// target is not being built anyway.
if (process.platform === 'darwin') {
  const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'hearth-icons-')) + '/Hearth.iconset';
  run(['iconset', iconset]);
  try {
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(out, 'icon.icns')]);
    console.log('icon: wrote ' + path.join(out, 'icon.icns'));
  } finally {
    fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
  }
} else {
  console.log('icon: skipping .icns (iconutil is macOS-only)');
}
