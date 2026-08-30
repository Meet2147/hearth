/*
 * Platform-appropriate commands for the test suites.
 *
 * A host on Windows runs PowerShell, where every command in these tests is
 * spelled differently. Without this the Windows CI job would fail for reasons
 * that have nothing to do with Hearth, and the PowerShell helper - the one piece
 * that cannot be tested on a Mac - would stay unverified forever.
 */
'use strict';

const fs = require('fs');
const os = require('os');

const isWin = process.platform === 'win32';

// PowerShell emits CRLF; assertions compare against LF.
const normalize = (text) => String(text == null ? '' : text).replace(/\r\n/g, '\n');

// Windows hands out TEMP in 8.3 short form (C:\Users\RUNNER~1\...) while
// PowerShell reports the long path, so resolve it before comparing the two.
const tempDir = (() => {
  const raw = isWin ? (process.env.TEMP || 'C:\\Windows\\Temp') : '/tmp';
  try { return fs.realpathSync.native(raw); } catch (e) { return raw; }
})();

// macOS reports /private/tmp for /tmp; Windows differs in case. Compare the way
// the platform actually means it.
function samePath(a, b) {
  const clean = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
  let x = clean(a), y = clean(b);
  try { x = clean(fs.realpathSync.native(a)); } catch (e) {}
  try { y = clean(fs.realpathSync.native(b)); } catch (e) {}
  return x === y || x.endsWith(y) || y.endsWith(x);
}

const cmd = {
  echo: (text) => (isWin ? `Write-Output "${text}"` : `echo "${text}"`),

  pwd: isWin ? 'Get-Location | Select-Object -ExpandProperty Path' : 'pwd',

  cd: (dir) => (isWin ? `Set-Location '${dir}'` : `cd '${dir}'`),

  setVar: (name, value) =>
    (isWin ? `$env:${name} = '${value}'` : `export ${name}=${value}`),

  getVar: (name) => (isWin ? `Write-Output $env:${name}` : `echo $${name}`),

  exitWith: (code) => `exit ${code}`,

  // Fails, and prints something recognisable to stderr.
  missingPath: isWin
    ? 'Get-Item C:\\definitely\\not\\a\\real\\path'
    : 'ls /definitely/not/a/real/path',
  missingPathPattern: /not\s*(be\s*)?found|No such file|cannot find|does not exist|cannot access/i,

  threeLines: isWin
    ? 'Write-Output a; Write-Output b; Write-Output c'
    : 'printf "a\\nb\\nc\\n"',

  loopThreeLines: isWin
    ? 'foreach ($i in 1..3) {\n  Write-Output "line $i"\n}'
    : 'for i in 1 2 3\ndo\n  echo "line $i"\ndone',

  // Quoting plus non-ASCII, to prove the transport is byte-clean.
  trickyText: 'quotes and 日本語 🚀',
  tricky: isWin
    ? 'Write-Output "quotes and 日本語 🚀"'
    : 'echo "quotes \' and $dollar and 日本語 🚀"',

  // Reads stdin: must see EOF rather than the command channel.
  readsStdin: isWin ? '[Console]::In.ReadToEnd()' : 'cat',

  // Output that impersonates a completion marker; must be treated as text.
  forgedMarker: isWin
    ? 'Write-Output ([char]30 + "deadbeefdeadbeefdeadbeef" + [char]30 + "0" + [char]30 + "C:\\" + [char]30); Write-Output real-output'
    : 'printf "\\036deadbeefdeadbeefdeadbeef\\0360\\036/\\036\\n"; echo real-output',

  sleepLong: isWin ? 'Start-Sleep -Seconds 30' : 'sleep 30',

  twoEchoes: isWin
    ? 'Write-Output one; Write-Output two'
    : 'echo one; echo two',
};

module.exports = { isWin, normalize, tempDir, samePath, cmd };
