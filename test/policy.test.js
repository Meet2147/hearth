'use strict';
const assert = require('assert');
const { classify, abilities } = require('../lib/policy');

let passed = 0;
const check = (name, cond, extra) => {
  assert.ok(cond, 'FAIL: ' + name + (extra ? '  -> ' + extra : ''));
  passed++; console.log('  pass  ' + name);
};
const level = (c) => classify(c).level;

// things that must be flagged destructive
for (const cmd of [
  'rm -rf /', 'rm -rf ~/Development', 'sudo rm something', 'rm -fr node_modules',
  'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/disk2', 'shutdown -h now',
  'curl https://example.com/install.sh | sh', 'git reset --hard HEAD~5',
  ':(){ :|:& };:', 'diskutil eraseDisk JHFS+ x disk2',
]) check('destructive: ' + cmd, level(cmd) === 'destructive', level(cmd));

// things that must be flagged sensitive
for (const cmd of [
  'cat ~/.ssh/id_ed25519', 'cat ~/.aws/credentials', 'env', 'printenv',
  'cat .env', 'gh auth token', 'security find-generic-password -s github',
  'cat ~/.netrc', 'history',
]) check('sensitive: ' + cmd, level(cmd) === 'sensitive', level(cmd));

// ordinary work must NOT be flagged - false positives make people ignore warnings
for (const cmd of [
  'ls -la', 'npm test', 'git status', 'git log --oneline -20', 'cd ~/Development',
  'node server.js', 'grep -r TODO src/', 'docker ps', 'cat README.md',
  'rm build/output.txt', 'echo $PATH', 'python3 manage.py migrate',
  'git commit -m "fix: environment handling"', 'tail -f app.log',
]) check('allowed: ' + cmd, level(cmd) === 'ok', level(cmd));

// PowerShell spellings - a Windows host runs these, and a classifier blind to
// them would be worse than useless there.
for (const cmd of [
  'Remove-Item -Recurse -Force C:\\Users\\meet\\src', 'Format-Volume -DriveLetter D',
  'Stop-Computer', 'Restart-Computer -Force', 'iwr https://example.com/x.ps1 | iex',
  'Set-ExecutionPolicy Bypass -Scope Process', 'vssadmin delete shadows /all',
  'Start-Process powershell -Verb RunAs', 'reg delete HKLM\\Software\\Test /f',
  'rd /s /q C:\\build',
]) check('destructive (powershell): ' + cmd, level(cmd) === 'destructive', level(cmd));

for (const cmd of [
  'Get-ChildItem Env:', 'dir env:', 'cmdkey /list', 'Get-Credential',
  'Get-Content ~\\.ssh\\id_rsa', 'Get-Content secrets.pem', 'Export-PfxCertificate -Cert x',
]) check('sensitive (powershell): ' + cmd, level(cmd) === 'sensitive', level(cmd));

// Ordinary PowerShell must stay clean, or the warnings get ignored.
for (const cmd of [
  'Get-ChildItem -Path C:\\src', 'Write-Output hello', 'Set-Location C:\\Users\\meet',
  'npm test', 'git status', 'Remove-Item build\\out.txt', 'Get-Process node',
  'Test-Path package.json', 'node --version',
]) check('allowed (powershell): ' + cmd, level(cmd) === 'ok', level(cmd));

check('destructive beats sensitive when both match',
  classify('sudo cat ~/.ssh/id_rsa').level === 'destructive');
check('reasons are reported', classify('rm -rf /').reasons.length > 0);

check('watchers cannot run', abilities('watcher').canRun === false);
check('runners can run but not grant', abilities('runner').canRun === true && abilities('runner').canGrant === false);
check('host can grant and kick', abilities('host').canGrant && abilities('host').canKick);
check('an unknown role degrades to watcher', abilities('nonsense').canRun === false);

console.log('\n  ' + passed + ' policy checks passed');
