#!/usr/bin/env node
/*
 * Hearth - a shared terminal for friends.
 *
 *   hearth host                 open a session on this machine
 *   hearth join CODE            join a friend's session
 *   hearth relay                run a relay (usually on a small server)
 *
 * Commands run on the HOST's machine, in one persistent shell. Guests join as
 * watchers and can chat; the host grants run access per person with /allow.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const hc = require('./lib/crypto');
const policy = require('./lib/policy');
const { createUI, C } = require('./lib/ui');
const { createLocalUI } = require('./lib/localui');
const license = require('./lib/license');
const { HostSession, GuestSession, hostShellSupported, HOME } = require('./lib/session');

const VERSION = (() => { try { return require('./package.json').version; } catch (e) { return '1.2.0'; } })();
const CONFIG_PATH = path.join(HOME, 'config.json');

// The hosted relay, so host/join/app work with no --relay flag. An explicit
// --relay or a saved config still wins; set HEARTH_RELAY to override.
const DEFAULT_RELAY = process.env.HEARTH_RELAY || 'wss://hearthrelay.onrender.com/ws';

// --- config -----------------------------------------------------------------

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { return {}; }
}
function saveConfig(cfg) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
function defaultName() {
  return (process.env.USER || process.env.USERNAME || os.userInfo().username || 'someone').split('.')[0];
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--relay') out.relay = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--code') out.code = argv[++i];
    else if (a === '--port') out.port = argv[++i];
    else if (a === '--ui') out.ui = true;
    else if (a === '--ui-port') out.uiPort = parseInt(argv[++i], 10);
    else if (a === '--no-open') out.noOpen = true;
    else if (a === '--insecure') out.insecure = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-v' || a === '--version') out.version = true;
    else out._.push(a);
  }
  return out;
}

const HELP = `
  ${C.bold('Hearth')} ${C.grey('v' + VERSION)}  - a shared terminal for friends

  ${C.bold('hearth host')} [--relay URL] [--name YOU]
      Open a session on this machine. Prints a join code to send your friends.
      Commands run here, in one shell, with state kept between them.

  ${C.bold('hearth host --ui')} [--ui-port 7777]
      Same thing with a window instead of a terminal. Opens the app in your
      browser; your friends open the relay's URL and type the code. Nothing to
      install on their side.

  ${C.bold('hearth join')} CODE [--relay URL] [--name YOU]
      Join a friend's session. You start as a watcher: you can read everything
      and chat, and you can run commands once the host grants you access.

  ${C.bold('hearth relay')} [--port 8787]
      Run the relay. Put it on a small server behind TLS and point both ends at
      it. It routes ciphertext and can read none of it.

  ${C.bold('hearth config')} --relay wss://... [--name YOU]
      Remember a default relay and display name.

  ${C.grey('--insecure  accept a self-signed relay certificate (local testing only)')}
`;

// --- shared command handling ------------------------------------------------

function renderRoster(ui, members, myId) {
  ui.print('');
  ui.print(C.bold('  who is here'));
  for (const m of members) {
    const badge = m.role === 'host' ? C.magenta('host')
      : m.role === 'runner' ? C.green('can run')
      : C.grey('watching');
    ui.print('    ' + (m.id === myId ? C.bold(m.name) : m.name).padEnd(20) + badge);
  }
  ui.print('');
}

function commonHelp(isHost) {
  const lines = [
    '',
    C.bold('  talking'),
    '    just type                 send a message to everyone',
    '    /chat <message>           same thing, explicitly',
    '',
    C.bold('  running'),
    '    /run <command>            run on the host machine   ' + C.grey('(alias: /cmd, $ command)'),
    '    /kill                     stop whatever is running',
    '',
    C.bold('  session'),
    '    /who                      list everyone and what they can do',
    '    /help                     this list',
    '    /quit                     leave',
  ];
  if (isHost) {
    lines.push(
      '',
      C.bold('  host controls'),
      '    /allow <name>             let someone run commands',
      '    /deny <name>              take that back',
      '    /kick <name>              remove someone from the session',
      '    /lock                     panic switch: pause all remote commands',
      '    /unlock                   lift it',
      '    /code                     show the join code again',
      '    /audit                    where this session is being logged'
    );
  }
  lines.push('');
  return lines;
}

function splitCommand(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('$ ')) return { cmd: 'run', rest: trimmed.slice(2) };
  if (!trimmed.startsWith('/')) return { cmd: null, rest: trimmed };
  const space = trimmed.indexOf(' ');
  const name = (space < 0 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
  const rest = space < 0 ? '' : trimmed.slice(space + 1).trim();
  return { cmd: name, rest };
}

// --- host -------------------------------------------------------------------

function openInBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    require('child_process')
      .spawn(opener, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' })
      .unref();
  } catch (e) { /* the URL is printed anyway */ }
}

// Host with the web UI instead of the readline transcript. The daemon still does
// all the work; the browser is only a view onto it.
async function runHostUI(args, cfg, relayUrl, code, name) {
  // Never block startup on the network: currentPlan falls back to the last
  // known good answer, and to Free if there has never been one.
  const { plan, problem } = await license.currentPlan();
  const session = new HostSession({
    relayUrl, code, name, insecure: args.insecure, maxGuests: plan.maxGuests,
  });
  const joinLine = 'hearth join ' + code + ' --relay ' + relayUrl;

  try {
    await session.connect();
  } catch (e) {
    console.error('\n  Could not reach the relay: ' + e.message + '\n');
    process.exit(1);
  }

  const local = createLocalUI(session, {
    port: args.uiPort || 7777,
    code, joinLine, relayUrl, plan,
    onRun: async (command) => {
      if (session.shell.busy) {
        const r = session.shell.running;
        return local.broadcast({ t: 'sys', level: 'warn',
          text: 'busy running "' + r.command.split('\n')[0].slice(0, 50) + '" for ' + r.requester });
      }
      const risk = policy.classify(command);
      if (risk.level !== 'ok') {
        const ok = await session.askHostConfirm(name, command, risk);
        if (!ok) return local.broadcast({ t: 'sys', text: 'cancelled', level: 'warn' });
      }
      await session.execute(command, { requester: name, risk });
    },
  });

  try {
    await local.listen();
  } catch (e) {
    console.error('\n  Could not open the UI on port ' + (args.uiPort || 7777) + ': ' + e.message);
    console.error('  Try another one:  hearth host --ui --ui-port 7788\n');
    process.exit(1);
  }

  const guestUrl = relayUrl.replace(/^ws/, 'http').replace(/\/ws$/, '/');
  console.log('');
  console.log('  ' + C.bold(C.green('Hearth')) + C.grey('  v' + VERSION + '  -  hosting as ' + name));
  console.log('  ' + C.grey('-'.repeat(60)));
  console.log('  your window   ' + C.cyan(local.url));
  console.log('  friends open  ' + C.cyan(guestUrl) + C.grey('   code ') + C.bold(code));
  console.log('  shell         ' + C.grey(session.shell.shellPath + '   ' + session.shell.cwd));
  console.log('  audit log     ' + C.grey(session.auditPath));
  console.log('  plan          ' + C.grey(plan.name + '  ·  ' + plan.maxGuests +
    ' guest' + (plan.maxGuests === 1 ? '' : 's') + ' at a time'));
  if (problem) console.log('  ' + C.yellow('license       ' + problem));
  console.log('  ' + C.grey('-'.repeat(60)));
  console.log('  ' + C.grey('Guests join as watchers. Promote them in the People panel.'));
  console.log('  ' + C.grey('Ctrl+C here ends the session.'));
  console.log('');

  session.on('joined-guest', (m) => console.log(C.grey('  + ' + m.name + ' joined')));
  session.on('left', (m) => console.log(C.grey('  - ' + m.name + ' left')));
  session.on('command-start', (c) => console.log(C.grey('  $ ' + c.command.split('\n')[0].slice(0, 70) + '   (' + c.requester + ')')));
  session.on('security', (s) => console.log(C.red('  ! ' + s.text)));
  session.on('disconnected', () => { console.log(C.red('  ! lost the relay connection')); bye(); });

  if (!args.noOpen) openInBrowser(local.url);

  let closing = false;
  function bye() {
    if (closing) return;
    closing = true;
    console.log(C.grey('\n  closing the session'));
    try { local.close(); } catch (e) {}
    try { session.close(); } catch (e) {}
    setTimeout(() => process.exit(0), 250);
  }
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

async function runHost(args) {
  if (!hostShellSupported()) {
    console.error('\n  Cannot host: lib/hearth-helper.ps1 is missing from this install.');
    console.error('  Windows hosting needs it. Re-copy the Hearth folder and try again.\n');
    process.exit(1);
  }

  const cfg = loadConfig();
  const relayUrl = args.relay || cfg.relay || DEFAULT_RELAY;
  if (!relayUrl) {
    console.error('\n  No relay configured. Point Hearth at one:');
    console.error('    hearth config --relay wss://your-relay.example.com/ws');
    console.error('\n  Or run one locally to try it out:');
    console.error('    hearth relay');
    console.error('    hearth host --relay ws://127.0.0.1:8787/ws\n');
    process.exit(1);
  }

  const code = args.code || hc.generateCode();
  const name = args.name || cfg.name || defaultName();

  if (args.ui) return runHostUI(args, cfg, relayUrl, code, name);

  const { plan } = await license.currentPlan();
  const session = new HostSession({
    relayUrl, code, name, insecure: args.insecure, maxGuests: plan.maxGuests,
  });

  const ui = createUI({ prompt: C.green('hearth') + C.grey(' > '), onClose: () => shutdown() });

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    ui.print('');
    ui.print(C.grey('  closing the session'));
    try { session.close(); } catch (e) {}
    setTimeout(() => process.exit(0), 200);
  }

  try {
    await session.connect();
  } catch (e) {
    console.error('\n  Could not reach the relay: ' + e.message + '\n');
    process.exit(1);
  }

  const joinLine = 'hearth join ' + code + ' --relay ' + relayUrl;
  ui.banner([
    '',
    '  ' + C.bold(C.green('Hearth')) + C.grey('  v' + VERSION),
    '  ' + C.grey('-'.repeat(58)),
    '  hosting as   ' + C.bold(name),
    '  shell        ' + C.grey(session.shell.shellPath + '   ' + session.shell.cwd),
    '  relay        ' + C.grey(relayUrl),
    '  key          ' + C.grey(session.identity.fingerprint),
    '  ' + C.grey('-'.repeat(58)),
    '',
    '  plan         ' + C.grey(plan.name + '  ·  ' + plan.maxGuests +
      ' guest' + (plan.maxGuests === 1 ? '' : 's') + ' at a time'),
    '',
    '  ' + C.bold('Send your friends this line:'),
    '     ' + C.cyan(joinLine),
    '',
    '  ' + C.grey('They join as watchers. Give someone run access with /allow <name>.'),
    '  ' + C.grey('Everything is logged to ' + session.auditPath),
    '  ' + C.grey('/help for commands.'),
    '',
  ]);
  ui.setPrompt(C.green('hearth') + C.grey(' > '));

  // --- session events
  session.on('joined-guest', (m) => {
    ui.system(m.name + ' joined as a watcher  ' + C.grey('(key ' + hc.fingerprintOf(m.pub) + ')'), 'info');
    ui.system('give them run access with ' + C.bold('/allow ' + m.name), 'info');
  });
  session.on('left', (m) => ui.system(m.name + ' left'));
  session.on('guest-refused', (g) => ui.system(
    g.name + ' could not join: the plan allows ' + g.limit +
    ' guest' + (g.limit === 1 ? '' : 's') + ' at a time', 'warn'));
  session.on('chat', (m) => ui.chat(m.from, m.text, false));
  session.on('command-start', (c) => ui.commandEcho(c.requester, c.command));
  session.on('output', (o) => ui.output(o.chunk));
  session.on('command-done', (r) => ui.commandDone(r));
  session.on('denied', (d) => ui.system('refused ' + d.who + ': ' + d.reason, 'warn'));
  session.on('security', (s) => ui.system(s.text, 'error'));
  session.on('disconnected', () => { ui.system('lost the relay connection', 'error'); shutdown(); });

  session.on('confirm', async ({ who, command, risk, respond }) => {
    const heading = risk.level === 'destructive'
      ? C.red('  DESTRUCTIVE COMMAND')
      : C.yellow('  THIS WOULD EXPOSE SECRETS');
    const watchers = session.roster().length - 1;
    respond(await ui.confirm([
      '',
      heading,
      '  ' + C.bold(who) + ' wants to run:',
      '    ' + C.bold(command),
      '  why it was flagged: ' + C.grey(risk.reasons.join(', ')),
      risk.level === 'sensitive' && watchers > 0
        ? C.grey('  ' + watchers + ' other ' + (watchers === 1 ? 'person is' : 'people are') + ' watching this output')
        : C.grey('  this runs on YOUR machine'),
    ]));
  });

  async function hostRun(command) {
    if (!command) return ui.system('nothing to run', 'warn');
    if (session.shell.busy) {
      const r = session.shell.running;
      return ui.system('busy running "' + r.command.split('\n')[0].slice(0, 50) + '" for ' + r.requester, 'warn');
    }
    const risk = policy.classify(command);
    if (risk.level !== 'ok') {
      const watchers = session.roster().length - 1;
      const ok = await ui.confirm([
        '',
        risk.level === 'destructive' ? C.red('  DESTRUCTIVE COMMAND') : C.yellow('  THIS WOULD EXPOSE SECRETS'),
        '    ' + C.bold(command),
        '  why it was flagged: ' + C.grey(risk.reasons.join(', ')),
        watchers > 0
          ? C.grey('  ' + watchers + ' other ' + (watchers === 1 ? 'person' : 'people') + ' will see the output')
          : C.grey('  nobody else is watching right now'),
      ]);
      if (!ok) return ui.system('cancelled', 'warn');
    }
    await session.execute(command, { requester: name, risk });
    ui.setPrompt(C.green('hearth') + C.grey(' ' + shortCwd(session.shell.cwd) + ' > '));
  }

  ui.onLine(async (line) => {
    const { cmd, rest } = splitCommand(line);
    if (cmd === null) { if (rest) { session.chat(rest); ui.chat(name, rest, true); } return; }

    switch (cmd) {
      case 'chat': if (rest) { session.chat(rest); ui.chat(name, rest, true); } return;
      case 'run': case 'cmd': case 'command': case 'r': return hostRun(rest);
      case 'kill': {
        const running = session.shell.running;
        if (!running) return ui.system('nothing is running', 'warn');
        session.shell.kill('SIGKILL');
        session.announce(name + ' stopped "' + running.command.slice(0, 50) + '"', 'warn');
        return;
      }
      case 'who': return renderRoster(ui, session.roster(), session.identity.id);
      case 'allow': {
        const r = session.grant(rest);
        return r.ok
          ? ui.system(C.green(r.member.name + ' can now run commands on this machine'), 'warn')
          : ui.system(r.error, 'error');
      }
      case 'deny': {
        const r = session.revoke(rest);
        return r.ok ? ui.system(r.member.name + ' is back to watching') : ui.system(r.error, 'error');
      }
      case 'kick': {
        const r = session.kick(rest);
        return r.ok ? ui.system(r.member.name + ' was removed') : ui.system(r.error, 'error');
      }
      case 'lock': session.setLocked(true); return;
      case 'unlock': session.setLocked(false); return;
      case 'code':
        ui.print('');
        ui.print('  ' + C.bold('join code  ') + C.green(code));
        ui.print('  ' + C.cyan(joinLine));
        ui.print('');
        return;
      case 'audit': return ui.system('logging to ' + session.auditPath);
      case 'clear': console.clear(); return;
      case 'help': return ui.banner(commonHelp(true));
      case 'quit': case 'exit': return shutdown();
      default: return ui.system('no such command: /' + cmd + '   (try /help)', 'warn');
    }
  });

  process.on('SIGINT', () => { ui.cancelConfirm(); shutdown(); });
}

function shortCwd(dir) {
  const home = os.homedir();
  return dir.startsWith(home) ? '~' + dir.slice(home.length) : dir;
}

// --- guest ------------------------------------------------------------------

async function runGuest(args) {
  const cfg = loadConfig();
  const code = args._[1] || args.code;
  const relayUrl = args.relay || cfg.relay || DEFAULT_RELAY;

  if (!code) { console.error('\n  Usage: hearth join CODE [--relay URL]\n'); process.exit(1); }
  if (!relayUrl) {
    console.error('\n  No relay configured. Use the full line your friend sent you,');
    console.error('  or save the relay: hearth config --relay wss://...\n');
    process.exit(1);
  }

  const name = args.name || cfg.name || defaultName();
  let session;
  try {
    session = new GuestSession({ relayUrl, code, name, insecure: args.insecure });
  } catch (e) {
    console.error('\n  ' + e.message + '\n');
    process.exit(1);
  }

  const ui = createUI({ prompt: C.cyan('hearth') + C.grey(' > '), onClose: () => shutdown() });

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    ui.print('');
    ui.print(C.grey('  leaving'));
    try { session.close(); } catch (e) {}
    setTimeout(() => process.exit(0), 200);
  }

  try {
    await session.connect();
  } catch (e) {
    console.error('\n  Could not reach the relay: ' + e.message + '\n');
    process.exit(1);
  }

  ui.banner([
    '',
    '  ' + C.bold(C.cyan('Hearth')) + C.grey('  joined as ' + name),
    '  ' + C.grey('waiting for the host...'),
    '',
  ]);

  session.on('host-seen', (h) => {
    ui.system('host is ' + C.bold(h.name) + '  ' + C.grey('(key ' + h.fingerprint + ')'));
    ui.system('you are watching. ask ' + h.name + ' for /allow ' + name + ' to run commands.');
  });
  session.on('chat', (m) => ui.chat(m.from, m.text, false));
  session.on('output', (o) => ui.output(o.chunk));
  session.on('command-done', (r) => ui.commandDone(r));
  session.on('command-start', (c) => { ui.flushOutput(); ui.commandEcho(c.requester, c.command); });
  session.on('sys', (s) => ui.system(s.text, s.level));
  session.on('denied', (d) => ui.system(d.reason, 'warn'));
  session.on('security', (s) => ui.system(s.text, 'error'));
  session.on('role-changed', (role) => {
    ui.system(role === 'runner'
      ? C.green('the host gave you run access - /run <command>')
      : C.yellow('your run access was removed'), 'warn');
  });
  session.on('kicked', () => { ui.system('the host removed you from the session', 'error'); shutdown(); });
  session.on('disconnected', () => { ui.system('lost the relay connection', 'error'); shutdown(); });

  ui.onLine((line) => {
    const { cmd, rest } = splitCommand(line);
    if (cmd === null) { if (rest) { session.chat(rest); ui.chat(name, rest, true); } return; }

    switch (cmd) {
      case 'chat': if (rest) { session.chat(rest); ui.chat(name, rest, true); } return;
      case 'run': case 'cmd': case 'command': case 'r':
        if (!rest) return ui.system('nothing to run', 'warn');
        if (!session.canRun) return ui.system('you are watching only - ask the host for run access', 'warn');
        session.requestRun(rest);
        return;
      case 'kill': session.requestKill(); return;
      case 'who': return renderRoster(ui, session.roster(), session.identity.id);
      case 'help': return ui.banner(commonHelp(false));
      case 'quit': case 'exit': return shutdown();
      default: return ui.system('no such command: /' + cmd + '   (try /help)', 'warn');
    }
  });

  process.on('SIGINT', () => shutdown());
}

// --- entry ------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (args.version) { console.log(VERSION); return; }
  if (args.help || !command) { console.log(HELP); return; }

  if (command === 'host') return runHost(args);
  if (command === 'join') return runGuest(args);
  if (command === 'relay') {
    if (args.port) process.env.PORT = String(args.port);
    require('./relay.js');
    return;
  }
  if (command === 'config') {
    const cfg = loadConfig();
    if (args.relay) cfg.relay = args.relay;
    if (args.name) cfg.name = args.name;
    saveConfig(cfg);
    console.log('\n  saved to ' + CONFIG_PATH);
    console.log('    relay  ' + (cfg.relay || '(none)'));
    console.log('    name   ' + (cfg.name || defaultName()) + '\n');
    return;
  }

  console.log(HELP);
}

if (require.main === module) main();
module.exports = { splitCommand, parseArgs };
