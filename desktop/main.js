/*
 * Hearth desktop - one Electron shell that produces the macOS and Windows apps.
 *
 * The app owns the whole lifecycle: on launch it starts the session daemon (and
 * a local relay if none is configured), waits for the daemon to print its
 * loopback UI address, and loads that in the window. Quitting takes them down.
 *
 * The daemon runs on Electron's OWN bundled Node via ELECTRON_RUN_AS_NODE, so a
 * packaged Hearth needs nothing installed on the machine - no system Node, no
 * PowerShell module, nothing.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');

const IS_DEV = !app.isPackaged;

// --- private mode ----------------------------------------------------------
//
// "Private mode" excludes the Hearth window from screen capture, using the OS's
// own content-protection APIs (WDA_EXCLUDEFROMCAPTURE on Windows,
// NSWindowSharingNone on macOS) via Electron's setContentProtection. The window
// stays fully visible on your physical display; it is only omitted from what a
// screen-share or screen-recording tool sees - Meet, Zoom, QuickTime, OBS.
//
// Honest about its limits: this defeats SOFTWARE capture only. It does nothing
// against a camera pointed at the screen, a hardware capture card, or software
// that inspects running processes rather than pixels. It is a privacy feature,
// not an invisibility guarantee.
const PREFS_PATH = path.join(app.getPath('userData'), 'prefs.json');

function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')); } catch (e) { return {}; }
}
function savePrefs(prefs) {
  try { fs.writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2)); } catch (e) { /* best effort */ }
}
let privateMode = loadPrefs().privateMode === true;

function applyPrivateMode() {
  if (win && !win.isDestroyed()) {
    try { win.setContentProtection(privateMode); } catch (e) { /* unsupported OS */ }
  }
}
function setPrivateMode(on) {
  privateMode = !!on;
  const prefs = loadPrefs();
  prefs.privateMode = privateMode;
  savePrefs(prefs);
  applyPrivateMode();
  buildMenu(); // refresh the checkmark
}

// Packaged, the daemon lives in Resources/app; in development it is the repo.
const APP_ROOT = IS_DEV
  ? path.join(__dirname, '..')
  : path.join(process.resourcesPath, 'app');

let win = null;
let hostProc = null;
let relayProc = null;
let resolved = false;
let logBuffer = '';

// --- helpers ---------------------------------------------------------------

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.on('error', () => resolve(0)); // let the daemon pick its own
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function configuredRelay() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.hearth', 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    return cfg.relay && String(cfg.relay).trim() ? String(cfg.relay).trim() : null;
  } catch (e) {
    return null;
  }
}

// Run a bundled script on Electron's own Node runtime.
function runNode(script, args, extraEnv) {
  return spawn(process.execPath, [path.join(APP_ROOT, script), ...args], {
    cwd: os.homedir(),
    env: { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: '1', HEARTH_APP: '1', HEARTH_VERSION: app.getVersion() },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function showStatus(message, isError) {
  if (!win || win.isDestroyed()) return;
  win.loadFile(path.join(__dirname, 'loading.html'), {
    hash: encodeURIComponent(JSON.stringify({ message, error: !!isError })),
  });
}

// --- the daemon ------------------------------------------------------------

async function startDaemon() {
  let relayUrl = configuredRelay();

  if (!relayUrl) {
    // Nothing configured: run a relay locally so the app works on its own.
    // Friends elsewhere need a relay on a reachable host - see the README.
    const relayPort = (await freePort()) || 8787;
    relayUrl = 'ws://127.0.0.1:' + relayPort + '/ws';
    relayProc = runNode('relay.js', [], { PORT: String(relayPort) });
    relayProc.on('error', () => {});
  }

  const uiPort = (await freePort()) || 7777;
  hostProc = runNode('hearth.js', [
    'host', '--ui', '--no-open', '--ui-port', String(uiPort), '--relay', relayUrl,
  ]);

  const absorb = (chunk) => {
    logBuffer += chunk.toString();
    if (resolved) return;
    // The daemon prints its loopback address with a single-use token.
    const found = logBuffer.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+/);
    if (!found) return;
    resolved = true;
    if (win && !win.isDestroyed()) win.loadURL(found[0]);
  };

  hostProc.stdout.on('data', absorb);
  hostProc.stderr.on('data', absorb);

  hostProc.on('error', (err) => {
    if (resolved) return;
    resolved = true;
    showStatus('Could not start the Hearth daemon.\n\n' + err.message, true);
  });

  hostProc.on('exit', (code) => {
    if (resolved) return;
    resolved = true;
    showStatus('The Hearth daemon exited (status ' + code + ').\n\n' + logBuffer.trim(), true);
  });

  // Never leave a blank window if nothing useful arrives.
  setTimeout(() => {
    if (resolved) return;
    resolved = true;
    showStatus('The daemon did not report a window address in time.\n\n' + logBuffer.trim(), true);
  }, 25000);
}

function stopDaemon() {
  for (const proc of [hostProc, relayProc]) {
    if (!proc || proc.killed) continue;
    try {
      if (process.platform === 'win32') {
        // Windows has no process groups; take the tree down by pid.
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'],
          { stdio: 'ignore', windowsHide: true }).on('error', () => proc.kill());
      } else {
        proc.kill();
      }
    } catch (e) { /* going away anyway */ }
  }
  hostProc = null;
  relayProc = null;
}

// --- window ----------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#12100e',
    title: 'Hearth',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: process.platform !== 'darwin',
    icon: process.platform === 'linux' ? path.join(__dirname, 'build', 'icon.png') : undefined,
    show: false,
    webPreferences: {
      // The window shows our own loopback page and needs no privileged APIs.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  applyPrivateMode(); // honour the saved choice from the moment the window exists
  showStatus('Starting your session…', false);

  // The window is for the session and nothing else: keep it there, and send
  // any outside link to the real browser rather than navigating this window.
  const isOurs = (target) => {
    try {
      const u = new URL(target);
      return u.protocol === 'file:' ||
        ((u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.protocol === 'http:');
    } catch (e) { return false; }
  };

  win.webContents.on('will-navigate', (event, target) => {
    if (!isOurs(target)) { event.preventDefault(); shell.openExternal(target); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isOurs(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('render-process-gone', () => {
    if (win && !win.isDestroyed()) showStatus('The window crashed. Quit and reopen Hearth.', true);
  });

  win.on('closed', () => { win = null; });
}

// A trimmed menu - but Edit stays, because copy and paste matter more in a
// window like this than almost anywhere else.
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: 'Hearth',
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Private (hide from screen share)',
          type: 'checkbox',
          checked: privateMode,
          accelerator: 'CommandOrControl+Shift+P',
          click: (item) => setPrivateMode(item.checked),
        },
        { type: 'separator' },
        { role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- lifecycle -------------------------------------------------------------

// Two Hearths would fight over the same session; focus the first instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    buildMenu();
    createWindow();
    try {
      await startDaemon();
    } catch (err) {
      showStatus('Could not start Hearth.\n\n' + err.message, true);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', stopDaemon);
  app.on('will-quit', stopDaemon);
  process.on('exit', stopDaemon);
}
