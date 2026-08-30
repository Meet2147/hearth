/*
 * Terminal UI.
 *
 * A scrolling transcript with a live input line pinned at the bottom - the
 * classic IRC shape, because it is the one people already know. Built on
 * readline so history, editing and Ctrl+C all behave the way a terminal should,
 * with no dependency and no full-screen takeover.
 */

'use strict';

const readline = require('readline');

const supportsColor = process.stdout.isTTY && process.env.TERM !== 'dumb' && !process.env.NO_COLOR;
const paint = (open, close) => (s) => (supportsColor ? '\x1b[' + open + 'm' + s + '\x1b[' + close + 'm' : s);

const C = {
  dim: paint(2, 22),
  bold: paint(1, 22),
  red: paint(31, 39),
  green: paint(32, 39),
  yellow: paint(33, 39),
  blue: paint(34, 39),
  magenta: paint(35, 39),
  cyan: paint(36, 39),
  grey: paint(90, 39),
  invert: paint(7, 27),
};

const NAME_COLORS = [C.cyan, C.green, C.yellow, C.magenta, C.blue];
function colorForName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

function createUI(opts) {
  const options = opts || {};
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: options.prompt || '> ',
    historySize: 200,
    terminal: process.stdout.isTTY,
  });

  let pendingConfirm = null;
  let outputTail = '';   // partial line held back until it completes
  const lineHandlers = [];

  // Print above the input line, then put the user's half-typed line back.
  function emit(text) {
    if (process.stdout.isTTY) {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
    }
    process.stdout.write(text + '\n');
    if (process.stdout.isTTY) rl.prompt(true);
  }

  const api = {
    rl,
    C,

    print: emit,

    banner(lines) {
      for (const line of lines) emit(line);
    },

    chat(from, text, isSelf) {
      const colour = isSelf ? C.bold : colorForName(from);
      emit(C.grey(timestamp()) + '  ' + colour(from.padEnd(10)) + ' ' + text);
    },

    system(text, level) {
      const tag = level === 'warn' ? C.yellow('!') : level === 'error' ? C.red('!') : C.grey('-');
      emit(C.grey(timestamp()) + '  ' + tag.padEnd(11) + ' ' + (level === 'error' ? C.red(text) : C.grey(text)));
    },

    commandEcho(who, command) {
      emit('');
      emit(C.grey(timestamp()) + '  ' + C.bold(C.green('$')) + ' ' +
           C.bold(command) + '   ' + C.grey('(' + who + ')'));
    },

    // Command output is reproduced verbatim; only whole lines are printed so a
    // half-arrived line never gets split by an incoming chat message.
    output(chunk) {
      outputTail += chunk;
      const parts = outputTail.split('\n');
      outputTail = parts.pop();
      for (const line of parts) emit(C.grey('  | ') + line);
    },

    flushOutput() {
      if (outputTail) { emit(C.grey('  | ') + outputTail); outputTail = ''; }
    },

    commandDone(result) {
      api.flushOutput();
      const ms = result.ms < 1000 ? result.ms + 'ms' : (result.ms / 1000).toFixed(1) + 's';
      let status;
      if (result.timedOut) status = C.red('timed out');
      else if (result.killed) status = C.yellow('stopped');
      else if (result.code === 0) status = C.green('ok');
      else status = C.red('exit ' + result.code);
      emit(C.grey('  ') + status + C.grey('  ' + ms));
      emit('');
    },

    setPrompt(text) {
      rl.setPrompt(text);
      if (process.stdout.isTTY) rl.prompt(true);
    },

    onLine(fn) { lineHandlers.push(fn); },

    // Ask a yes/no question that jumps the queue. Resolves false on anything
    // that is not an explicit yes, and false if the caller times out first.
    confirm(lines) {
      return new Promise((resolve) => {
        for (const line of lines) emit(line);
        emit(C.bold('  type ') + C.green('yes') + C.bold(' to allow, anything else to refuse'));
        pendingConfirm = (answer) => {
          pendingConfirm = null;
          api.setPrompt(options.prompt || '> ');
          resolve(/^(y|yes)$/i.test(answer.trim()));
        };
        api.setPrompt(C.yellow('allow? '));
      });
    },

    cancelConfirm() {
      if (!pendingConfirm) return;
      const fn = pendingConfirm;
      pendingConfirm = null;
      api.setPrompt(options.prompt || '> ');
      fn('no');
    },

    close() { rl.close(); },
  };

  rl.on('line', (line) => {
    if (pendingConfirm) { pendingConfirm(line); return; }
    for (const fn of lineHandlers) fn(line);
    if (process.stdout.isTTY) rl.prompt();
  });

  rl.on('close', () => { if (options.onClose) options.onClose(); });

  return api;
}

module.exports = { createUI, C, colorForName };
