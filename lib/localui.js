/*
 * The host's own UI server.
 *
 * Serves the web app on loopback and exposes the live session over a local
 * WebSocket. Traffic here is plain JSON: it never leaves the machine, and the
 * relay protocol's encryption would only obscure what the daemon already knows.
 *
 * This socket can start commands on this machine, so it is guarded twice:
 *
 *   1. It binds to 127.0.0.1 only - never a LAN address.
 *   2. It requires a random token, and rejects any Origin that is not its own.
 *      Without that check, ANY website you happened to have open could connect
 *      to ws://localhost and drive your shell. Browsers do not apply the
 *      same-origin policy to WebSockets, so the server has to.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const ws = require('./ws');
const license = require('./license');

// The Electron shell passes its real version in HEARTH_VERSION; the require is a
// fallback for the plain CLI (`hearth host --ui`) running from the repo. Earlier
// builds showed 0.0.0 because package.json was not bundled and neither path was
// available in the packaged app.
const PKG_VERSION = process.env.HEARTH_VERSION || (() => {
  try { return require('../package.json').version; } catch (e) {
    try { return require('../../package.json').version; } catch (e2) { return '0.0.0'; }
  }
})();

// Where the app looks for a newer build, and where it sends people to get it.
const RELEASES_API = process.env.HEARTH_RELEASES_API ||
  'https://api.github.com/repos/Meet2147/hearth/releases/latest';
const DOWNLOAD_URL = process.env.HEARTH_DOWNLOAD_URL || 'https://hearth.dashovia.app/#download';

const APP_HTML = path.join(__dirname, '..', 'web', 'app.html');

function createLocalUI(session, opts) {
  const options = opts || {};
  let plan = options.plan || license.PLANS.free;
  let heldLicense = license.loadLicense();
  const port = options.port || 7777;
  const token = crypto.randomBytes(16).toString('hex');
  const clients = new Set();

  let appHtml = '';
  try { appHtml = fs.readFileSync(APP_HTML, 'utf8'); }
  catch (e) { appHtml = '<!doctype html><title>Hearth</title><p>web/app.html is missing.'; }

  const allowedOrigins = new Set([
    'http://127.0.0.1:' + port,
    'http://localhost:' + port,
  ]);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (url.searchParams.get('token') !== token) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><meta charset="utf-8">' +
          '<body style="font:15px system-ui;background:#12100e;color:#e8e2d9;padding:40px">' +
          '<h2>Wrong or missing token</h2>' +
          '<p>Open the exact URL Hearth printed in your terminal.</p>');
      }
      const body = Buffer.from(appHtml, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        // The app is entirely self-contained; forbid it from reaching anywhere else.
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
          "img-src data:; font-src data:; connect-src ws://127.0.0.1:" + port + " ws://localhost:" + port,
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(body);
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, mode: 'host' }));
    }
    res.writeHead(404).end('not found');
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const origin = req.headers.origin;

    if (url.pathname !== '/ui' ||
        url.searchParams.get('token') !== token ||
        (origin && !allowedOrigins.has(origin))) {
      socket.destroy();
      return;
    }

    const conn = ws.accept(req, socket);
    if (!conn) return;
    clients.add(conn);

    const send = (obj) => conn.send(JSON.stringify(obj));
    send(snapshot());

    conn.on('message', (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch (e) { return; }
      handle(msg, send);
    });
    conn.on('close', () => clients.delete(conn));
  });

  function broadcast(obj) {
    const wire = JSON.stringify(obj);
    for (const c of clients) c.send(wire);
  }

  function snapshot() {
    return {
      t: 'snapshot',
      me: session.identity.name,
      meId: session.identity.id,
      role: 'host',
      code: options.code,
      joinLine: options.joinLine,
      relay: options.relayUrl,
      shell: session.shell.shellPath,
      cwd: session.shell.cwd,
      fingerprint: session.identity.fingerprint,
      auditPath: session.auditPath,
      roster: session.roster(),
      locked: session.locked,
      busy: session.shell.busy,
      version: PKG_VERSION,
      home: os.homedir(),
      license: license.publicView(heldLicense),
      plan: { name: plan.name, maxGuests: plan.maxGuests },
      buyUrl: license.BUY_URL,
    };
  }

  function handle(msg, send) {
    switch (msg.t) {
      case 'chat':
        if (msg.text) {
          session.chat(msg.text);
          broadcast({ t: 'chat', from: session.identity.name, id: session.identity.id, text: msg.text, ts: Date.now(), self: true });
        }
        return;
      case 'run':
        if (msg.command) options.onRun(String(msg.command));
        return;
      case 'kill': {
        const running = session.shell.running;
        if (!running) return broadcast({ t: 'sys', text: 'nothing is running', level: 'warn' });
        session.shell.kill('SIGKILL');
        session.announce(session.identity.name + ' stopped "' + running.command.slice(0, 50) + '"', 'warn');
        return;
      }
      case 'allow': return respond(send, session.grant(msg.name), (m) => m.name + ' can now run commands');
      case 'deny': return respond(send, session.revoke(msg.name), (m) => m.name + ' is back to watching');
      case 'kick': return respond(send, session.kick(msg.name), (m) => m.name + ' was removed');
      case 'lock':
        session.setLocked(!!msg.on);
        broadcast({ t: 'locked', locked: session.locked });
        return;
      case 'confirm':
        session.answerConfirm(msg.id, !!msg.ok);
        broadcast({ t: 'confirm-resolved', id: msg.id, ok: !!msg.ok });
        return;
      case 'refresh': return send(snapshot());

      case 'open-external':
        // Only ever a link we put in front of the user ourselves.
        if (typeof msg.url === 'string' && /^https:\/\//.test(msg.url)) openExternal(msg.url);
        return;

      case 'update.check': return checkForUpdate(send);

      case 'license.activate': return activateLicense(msg.key, send);

      case 'license.remove':
        license.saveLicense(null);
        heldLicense = null;
        plan = license.PLANS.free;
        session.maxGuests = plan.maxGuests;
        broadcast({ t: 'license', ok: true, license: null,
                    plan: { name: plan.name, maxGuests: plan.maxGuests },
                    message: 'License removed from this device.' });
        return;
      default: return;
    }
  }

  async function activateLicense(key, send) {
    try {
      const result = await license.activate(key);
      if (result.ok) {
        heldLicense = result.license;
        plan = result.plan;
        session.maxGuests = plan.maxGuests;
      }
      broadcast({
        t: 'license',
        ok: !!result.ok,
        message: result.message,
        license: license.publicView(heldLicense),
        plan: { name: plan.name, maxGuests: plan.maxGuests },
      });
    } catch (e) {
      send({ t: 'license', ok: false, message: 'Could not reach Polar: ' + e.message });
    }
  }

  // Version comparison, numeric segment by numeric segment. Anything with a
  // pre-release suffix is treated as older than the plain release.
  function isNewer(candidate, current) {
    const parse = (v) => String(v).replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
    const a = parse(candidate), b = parse(current);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  async function checkForUpdate(send) {
    try {
      const res = await fetch(RELEASES_API, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hearth/' + PKG_VERSION },
      });
      if (res.status === 404) {
        return send({ t: 'update', message: 'no releases published yet — you are on ' + PKG_VERSION });
      }
      if (!res.ok) return send({ t: 'update', message: 'update check failed (HTTP ' + res.status + ')' });

      const data = await res.json();
      const latest = String(data.tag_name || '').replace(/^v/, '');
      if (!latest) return send({ t: 'update', message: 'could not read the latest version' });

      if (isNewer(latest, PKG_VERSION)) {
        // The Download button goes to the website, which always links the
        // current build, rather than to a raw GitHub release page.
        send({ t: 'update', message: latest + ' is available (you have ' + PKG_VERSION + ')',
               url: DOWNLOAD_URL });
      } else {
        send({ t: 'update', message: 'up to date (' + PKG_VERSION + ')' });
      }
    } catch (e) {
      send({ t: 'update', message: 'update check failed: ' + e.message });
    }
  }

  function openExternal(url) {
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start' : 'xdg-open';
    try {
      require('child_process')
        .spawn(opener, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' })
        .unref();
    } catch (e) { /* nothing we can do; the link is on screen anyway */ }
  }

  function respond(send, result, message) {
    if (!result.ok) return send({ t: 'sys', text: result.error, level: 'error' });
    broadcast({ t: 'sys', text: message(result.member), level: 'warn' });
    broadcast({ t: 'roster', members: session.roster() });
  }

  // --- mirror session events to the UI --------------------------------------

  session.on('chat', (m) => broadcast({ t: 'chat', from: m.from, id: m.id, text: m.text, ts: m.ts }));
  session.on('command-start', (c) => broadcast({ t: 'command-start', rid: c.rid, requester: c.requester, command: c.command }));
  session.on('output', (o) => broadcast({ t: 'output', rid: o.rid, chunk: o.chunk }));
  session.on('command-done', (r) => broadcast({
    t: 'command-done', rid: r.rid, code: r.code, ms: r.ms,
    timedOut: !!r.timedOut, killed: !!r.killed, cwd: r.cwd,
  }));
  session.on('sys', (s) => broadcast({ t: 'sys', text: s.text, level: s.level }));
  session.on('security', (s) => broadcast({ t: 'sys', text: s.text, level: 'error' }));
  session.on('denied', (d) => broadcast({ t: 'sys', text: 'refused ' + d.who + ': ' + d.reason, level: 'warn' }));
  session.on('roster', (members) => broadcast({ t: 'roster', members }));
  session.on('guest-refused', (g) => broadcast({
    t: 'sys', level: 'warn',
    text: g.name + ' could not join: the plan allows ' + g.limit +
          ' guest' + (g.limit === 1 ? '' : 's') + ' at a time.',
  }));
  session.on('joined-guest', (m) => {
    broadcast({ t: 'sys', text: m.name + ' joined as a watcher', level: 'info' });
    broadcast({ t: 'roster', members: session.roster() });
  });
  session.on('left', (m) => {
    broadcast({ t: 'sys', text: m.name + ' left', level: 'info' });
    broadcast({ t: 'roster', members: session.roster() });
  });
  session.on('confirm', (c) => broadcast({
    t: 'confirm', id: c.id, who: c.who, command: c.command,
    level: c.risk.level, reasons: c.risk.reasons,
    watchers: Math.max(0, session.roster().length - 1),
  }));

  return {
    server,
    token,
    port,
    setPlan(next) { plan = next; session.maxGuests = next.maxGuests; broadcast(snapshot()); },
    get url() { return 'http://127.0.0.1:' + port + '/?token=' + token; },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve); // loopback only, never the LAN
      });
    },
    broadcast,
    close() { try { server.close(); } catch (e) {} for (const c of clients) c.close(); },
  };
}

module.exports = { createLocalUI };
