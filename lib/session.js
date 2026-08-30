/*
 * Session logic shared by the host and the guests.
 *
 * Trust rules, in the order they are applied to every inbound message:
 *
 *   1. It must decrypt under the room key. That proves the sender holds the
 *      join code - nothing more.
 *   2. Its Ed25519 signature must verify against the public key pinned to that
 *      participant id, pinned on first sight (TOFU). A second key claiming an
 *      id already in use is rejected outright.
 *   3. Messages that carry authority - command output, roster, permission
 *      grants - are accepted ONLY from the pinned host identity. Everyone in
 *      the room shares the encryption key, so without this a guest could forge
 *      output or hand themselves run access.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const hc = require('./crypto');
const ws = require('./ws');
const policy = require('./policy');
const { createShell, hostShellSupported } = require('./shell');

const PROTOCOL = 1;
const HOST_ONLY = new Set(['out', 'done', 'started', 'roster', 'sys', 'denied', 'grant', 'revoke', 'kicked']);
const OUTPUT_FLUSH_MS = 60;
const OUTPUT_FLUSH_BYTES = 8192;
const CONFIRM_TIMEOUT_MS = 60000;
const MAX_CHAT = 4000;
const MAX_COMMAND = 8000;

const HOME = path.join(os.homedir(), '.hearth');

class Session extends EventEmitter {
  constructor(opts) {
    super();
    this.relayUrl = opts.relayUrl;
    this.code = opts.code;
    this.key = hc.deriveKey(opts.code);
    this.room = hc.roomIdFor(this.key);
    this.identity = hc.newIdentity(opts.name, opts.role);
    this.role = opts.role;
    this.insecure = opts.insecure === true;

    this.conn = null;
    this.cid = null;
    this.members = new Map();   // participantId -> { id, name, role, pub, cid }
    this.pinned = new Map();    // participantId -> imported public key
    this.pinnedPub = new Map(); // participantId -> the raw base64 we pinned
    this.hostId = null;
    this.closed = false;
  }

  async connect() {
    this.conn = await ws.connect(this.relayUrl, { rejectUnauthorized: !this.insecure });
    this.conn.on('message', (text) => this._onRelay(text));
    this.conn.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.emit('disconnected');
    });
    this.conn.send(JSON.stringify({ t: 'hello', room: this.room }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('relay did not acknowledge the room')), 12000);
      this.once('joined', () => { clearTimeout(timer); resolve(); });
      this.once('relay-error', (reason) => { clearTimeout(timer); reject(new Error('relay: ' + reason)); });
    });
  }

  // --- wire ----------------------------------------------------------------

  send(msg) {
    if (!this.conn || this.closed) return false;
    const full = {
      v: PROTOCOL,
      from: this.identity.id,
      name: this.identity.name,
      ts: Date.now(),
      ...msg,
    };
    const signed = hc.sign(this.identity, full);
    return this.conn.send(JSON.stringify({ t: 'msg', e: hc.seal(this.key, signed) }));
  }

  _onRelay(text) {
    let outer;
    try { outer = JSON.parse(text); } catch (e) { return; }

    if (outer.t === 'joined') {
      this.cid = outer.cid;
      this.emit('joined', outer);
      return;
    }
    if (outer.t === 'error') { this.emit('relay-error', outer.reason); return; }
    if (outer.t === 'peer') { this._onPeerEvent(outer); return; }
    if (outer.t !== 'msg' || typeof outer.e !== 'string') return;

    const msg = hc.open(this.key, outer.e);
    if (!msg) {
      // Someone in the room has a different join code, or the relay is noisy.
      this.emit('undecryptable');
      return;
    }
    if (msg.v !== PROTOCOL || typeof msg.t !== 'string' || typeof msg.from !== 'string') return;
    if (msg.from === this.identity.id) return; // our own echo, if any

    if (!this._authenticate(msg, outer.from)) return;
    this._dispatch(msg, outer.from);
  }

  // Rules 2 and 3 from the header comment.
  _authenticate(msg, cid) {
    if (msg.t === 'hello') {
      const key = hc.importPublicKey(msg.pub);
      if (!key || !hc.verify(key, msg)) return false;
      const pinnedPub = this.pinnedPub.get(msg.from);
      if (pinnedPub !== undefined) {
        // Re-announcing with the SAME key is normal - the host re-greets every
        // time someone new arrives. A DIFFERENT key for a known id is not.
        if (pinnedPub !== msg.pub) {
          this.emit('security', {
            kind: 'key-conflict',
            text: 'Rejected a message claiming to be ' + msg.name + ' with a different signing key.',
          });
          return false;
        }
      } else {
        this.pinned.set(msg.from, key);
        this.pinnedPub.set(msg.from, msg.pub);
      }
      if (msg.role === 'host') {
        if (this.hostId && this.hostId !== msg.from) {
          this.emit('security', {
            kind: 'second-host',
            text: 'Ignored a second participant claiming to be the host.',
          });
          return false;
        }
        this.hostId = msg.from;
      }
      msg._cid = cid;
      return true;
    }

    const key = this.pinned.get(msg.from);
    if (!key) return false;                 // never said hello
    if (!hc.verify(key, msg)) {
      this.emit('security', { kind: 'bad-signature', text: 'Dropped a message with an invalid signature.' });
      return false;
    }
    if (HOST_ONLY.has(msg.t) && msg.from !== this.hostId) {
      this.emit('security', {
        kind: 'forged-authority',
        text: 'Dropped a "' + msg.t + '" message from ' + msg.name + ' - only the host may send that.',
      });
      return false;
    }
    return true;
  }

  _dispatch() { /* overridden */ }
  _onPeerEvent() { /* overridden */ }

  roster() {
    return [...this.members.values()].map((m) => ({ id: m.id, name: m.name, role: m.role }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.send({ t: 'bye' }); } catch (e) {}
    setTimeout(() => { try { this.conn && this.conn.close(); } catch (e) {} }, 60);
  }
}

// ---------------------------------------------------------------------------
// host
// ---------------------------------------------------------------------------

class HostSession extends Session {
  constructor(opts) {
    super({ ...opts, role: 'host' });
    this.hostId = this.identity.id;
    this.pinned.set(this.identity.id, hc.importPublicKey(this.identity.pub));
    this.pinnedPub.set(this.identity.id, this.identity.pub);
    this.members.set(this.identity.id, {
      id: this.identity.id, name: this.identity.name, role: 'host',
      pub: this.identity.pub, cid: null,
    });

    this.sessionId = crypto.randomBytes(4).toString('hex');
    this.auditPath = path.join(HOME, 'audit-' + this.sessionId + '.jsonl');
    this.pendingConfirm = new Map();
    this.outBuf = new Map(); // rid -> { text, timer }
    this.locked = false;     // panic switch: nobody but the host may run
    this.maxGuests = opts.maxGuests === undefined ? Infinity : opts.maxGuests;

    this.shell = createShell({
      onOutput: (chunk, cmd) => this._streamOut(cmd.rid, chunk),
      onCrash: () => this.announce('shell exited; a fresh one will start on the next command (exported vars are gone)', 'warn'),
    });
  }

  async connect() {
    fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
    this._audit({ event: 'session-start', shell: this.shell.shellPath, cwd: this.shell.cwd });
    await super.connect();
    this._announceSelf();
  }

  _announceSelf() {
    this.send({ t: 'hello', pub: this.identity.pub, role: 'host' });
  }

  _onPeerEvent(evt) {
    if (evt.event === 'leave') {
      for (const m of this.members.values()) {
        if (m.cid === evt.cid) {
          this.members.delete(m.id);
          this.emit('left', m);
          this._broadcastRoster();
          this._audit({ event: 'leave', who: m.name, id: m.id });
          break;
        }
      }
    }
    this.emit('peers', evt.members);
  }

  _dispatch(msg, cid) {
    switch (msg.t) {
      case 'hello': return this._onGuestHello(msg, cid);
      case 'chat': return this._onChat(msg);
      case 'run': return this._onRunRequest(msg);
      case 'kill': return this._onKillRequest(msg);
      case 'bye': return;
      default: return;
    }
  }

  _onGuestHello(msg, cid) {
    const known = this.members.get(msg.from);

    // Plan limit. Turning someone away has to be explicit and legible - a guest
    // who silently never appears looks like a bug, not a limit.
    if (!known) {
      const guests = [...this.members.values()].filter((m) => m.role !== 'host').length;
      if (guests >= this.maxGuests) {
        // Introduce ourselves first. The refusal is an authority-bearing
        // message, so a guest who has not yet pinned the host key would drop it
        // as unsigned and simply hang, never learning why.
        this._announceSelf();
        this.send({ t: 'kicked', target: msg.from,
                    reason: 'This session is full (' + this.maxGuests + ' guest' +
                            (this.maxGuests === 1 ? '' : 's') + ' on the current plan).' });
        this.emit('guest-refused', { name: msg.name, limit: this.maxGuests });
        this._audit({ event: 'guest-refused', who: msg.name, id: msg.from, limit: this.maxGuests });
        return;
      }
    }

    const member = known || {
      id: msg.from,
      name: String(msg.name || 'guest').slice(0, 32),
      role: 'watcher',        // everyone starts as a spectator
      pub: msg.pub,
      cid,
    };
    member.cid = cid;
    this.members.set(msg.from, member);

    if (known) {
      // Already greeted. Re-send the roster only - NOT another hello, or we and
      // the guest would greet each other back and forth without end.
      this._broadcastRoster();
      return;
    }

    this.emit('joined-guest', member);
    this._audit({ event: 'join', who: member.name, id: member.id, fingerprint: hc.fingerprintOf(msg.pub) });
    // Re-announce ourselves so the newcomer can pin the host key, then publish
    // the roster so everyone agrees on who is present and what they may do.
    this._announceSelf();
    this._broadcastRoster();
  }

  _onChat(msg) {
    const text = String(msg.text || '').slice(0, MAX_CHAT);
    if (!text) return;
    const member = this.members.get(msg.from);
    this.emit('chat', { from: member ? member.name : msg.name, id: msg.from, text, ts: msg.ts });
  }

  async _onRunRequest(msg) {
    const rid = String(msg.rid || crypto.randomUUID());
    const member = this.members.get(msg.from);
    const command = String(msg.cmd || '').slice(0, MAX_COMMAND);
    const who = member ? member.name : msg.name;

    if (!command.trim()) return;

    if (this.locked) return this._deny(rid, who, command, 'the session is locked - the host paused all remote commands');
    if (!member) return this._deny(rid, who, command, 'you are not in the roster');
    if (!policy.abilities(member.role).canRun) {
      return this._deny(rid, who, command, 'you have watch access only - ask the host for /allow ' + member.name);
    }
    if (this.shell.busy) {
      const r = this.shell.running;
      return this._deny(rid, who, command, 'the shell is busy running "' + r.command.split('\n')[0].slice(0, 60) + '" for ' + r.requester);
    }

    const risk = policy.classify(command);
    if (risk.level !== 'ok') {
      const approved = await this._askHost(who, command, risk);
      if (!approved) {
        this._audit({ event: 'blocked', who, id: msg.from, command, risk: risk.level, reasons: risk.reasons });
        return this._deny(rid, who, command, 'the host declined this command (' + risk.reasons.join(', ') + ')');
      }
    }

    return this.execute(command, { rid, requester: who, requesterId: msg.from, risk });
  }

  // Ask the operator. Returns false if nobody answers in time - the safe default.
  _askHost(who, command, risk) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pendingConfirm.delete(id);
        this.emit('confirm-expired', { id });
        resolve(false);
      }, CONFIRM_TIMEOUT_MS);

      this.pendingConfirm.set(id, (ok) => { clearTimeout(timer); this.pendingConfirm.delete(id); resolve(ok); });
      this.emit('confirm', { id, who, command, risk, respond: (ok) => this.answerConfirm(id, ok) });
    });
  }

  // Same approval gate the guest path uses, for commands the host starts itself.
  askHostConfirm(who, command, risk) {
    return this._askHost(who, command, risk);
  }

  answerConfirm(id, ok) {
    const fn = this.pendingConfirm.get(id);
    if (fn) fn(!!ok);
  }

  _deny(rid, who, command, reason) {
    this.send({ t: 'denied', rid, reason });
    this.emit('denied', { who, command, reason });
  }

  async execute(command, meta) {
    const rid = (meta && meta.rid) || crypto.randomUUID();
    const requester = (meta && meta.requester) || this.identity.name;

    this.emit('command-start', { rid, requester, command });
    this.send({ t: 'started', rid, who: requester, command });

    const started = Date.now();
    const result = await this.shell.run(command, { rid, requester });
    this._flushOut(rid, true);

    this.send({ t: 'done', rid, code: result.code, ms: result.ms, cwd: result.cwd,
                timedOut: !!result.timedOut, killed: !!result.killed });
    this.emit('command-done', { rid, requester, command, ...result });

    this._audit({
      event: 'command',
      who: requester,
      id: (meta && meta.requesterId) || this.identity.id,
      command,
      risk: (meta && meta.risk && meta.risk.level) || 'ok',
      exitCode: result.code,
      ms: Date.now() - started,
      cwd: result.cwd,
    });
    return result;
  }

  // Command output can arrive in a torrent. Batch it so the relay's rate limit
  // is never the reason a build log gets truncated.
  _streamOut(rid, chunk) {
    let entry = this.outBuf.get(rid);
    if (!entry) { entry = { text: '', timer: null }; this.outBuf.set(rid, entry); }
    entry.text += chunk;
    this.emit('output', { rid, chunk });
    if (entry.text.length >= OUTPUT_FLUSH_BYTES) return this._flushOut(rid);
    if (!entry.timer) entry.timer = setTimeout(() => this._flushOut(rid), OUTPUT_FLUSH_MS);
  }

  _flushOut(rid, final) {
    const entry = this.outBuf.get(rid);
    if (!entry) return;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    if (entry.text) { this.send({ t: 'out', rid, chunk: entry.text }); entry.text = ''; }
    if (final) this.outBuf.delete(rid);
  }

  _onKillRequest(msg) {
    const member = this.members.get(msg.from);
    if (!member || !policy.abilities(member.role).canRun) return;
    const running = this.shell.running;
    if (!running) return;
    this.shell.kill('SIGKILL');
    this.announce(member.name + ' stopped "' + running.command.split('\n')[0].slice(0, 60) + '"', 'warn');
    this._audit({ event: 'kill', who: member.name, id: msg.from, command: running.command });
  }

  // --- host controls -------------------------------------------------------

  findMember(nameOrId) {
    const needle = String(nameOrId || '').toLowerCase();
    for (const m of this.members.values()) {
      if (m.id === nameOrId || m.name.toLowerCase() === needle) return m;
    }
    return null;
  }

  grant(nameOrId) {
    const m = this.findMember(nameOrId);
    if (!m) return { ok: false, error: 'no one here called "' + nameOrId + '"' };
    if (m.role === 'host') return { ok: false, error: 'you are the host' };
    m.role = 'runner';
    this._broadcastRoster();
    this.send({ t: 'grant', target: m.id });
    this._audit({ event: 'grant', who: m.name, id: m.id });
    return { ok: true, member: m };
  }

  revoke(nameOrId) {
    const m = this.findMember(nameOrId);
    if (!m) return { ok: false, error: 'no one here called "' + nameOrId + '"' };
    if (m.role === 'host') return { ok: false, error: 'you are the host' };
    m.role = 'watcher';
    this._broadcastRoster();
    this.send({ t: 'revoke', target: m.id });
    this._audit({ event: 'revoke', who: m.name, id: m.id });
    return { ok: true, member: m };
  }

  kick(nameOrId) {
    const m = this.findMember(nameOrId);
    if (!m) return { ok: false, error: 'no one here called "' + nameOrId + '"' };
    if (m.role === 'host') return { ok: false, error: 'you cannot kick yourself' };
    this.members.delete(m.id);
    this.send({ t: 'kicked', target: m.id });
    this._broadcastRoster();
    this._audit({ event: 'kick', who: m.name, id: m.id });
    return { ok: true, member: m };
  }

  setLocked(locked) {
    this.locked = !!locked;
    if (this.locked) {
      for (const m of this.members.values()) if (m.role === 'runner') m.role = 'watcher';
      this._broadcastRoster();
    }
    this.announce(this.locked
      ? 'the host locked the session - remote commands are paused and run access was reset'
      : 'the host unlocked the session', 'warn');
    this._audit({ event: this.locked ? 'lock' : 'unlock' });
    return this.locked;
  }

  announce(text, level) {
    this.send({ t: 'sys', level: level || 'info', text });
    this.emit('sys', { text, level: level || 'info', from: 'host' });
  }

  chat(text) {
    const clean = String(text || '').slice(0, MAX_CHAT);
    if (!clean) return;
    this.send({ t: 'chat', text: clean });
  }

  _broadcastRoster() {
    const members = this.roster();
    this.send({ t: 'roster', members });
    this.emit('roster', members);
  }

  _audit(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), session: this.sessionId, ...entry }) + '\n';
    try { fs.appendFileSync(this.auditPath, line, { mode: 0o600 }); } catch (e) {}
  }

  close() {
    this._audit({ event: 'session-end' });
    try { this.shell.stop(); } catch (e) {}
    super.close();
  }
}

// ---------------------------------------------------------------------------
// guest
// ---------------------------------------------------------------------------

class GuestSession extends Session {
  constructor(opts) {
    super({ ...opts, role: 'guest' });
    this.myRole = 'watcher';
    this.greetedHost = null;
    this.pendingRuns = new Map();
  }

  async connect() {
    await super.connect();
    this.send({ t: 'hello', pub: this.identity.pub, role: 'guest' });
  }

  _onPeerEvent(evt) { this.emit('peers', evt.members); }

  _dispatch(msg) {
    switch (msg.t) {
      case 'hello':
        if (msg.role === 'host') {
          this.emit('host-seen', { name: msg.name, fingerprint: hc.fingerprintOf(msg.pub) });
          // Greet back exactly once. This covers the case where we joined
          // before the host did; greeting on every host hello would loop.
          if (this.greetedHost !== msg.from) {
            this.greetedHost = msg.from;
            this.send({ t: 'hello', pub: this.identity.pub, role: 'guest' });
          }
        }
        return;
      case 'roster': {
        this.members.clear();
        for (const m of msg.members) this.members.set(m.id, m);
        const me = this.members.get(this.identity.id);
        const before = this.myRole;
        this.myRole = me ? me.role : 'watcher';
        if (before !== this.myRole) this.emit('role-changed', this.myRole);
        this.emit('roster', msg.members);
        return;
      }
      case 'chat':
        return this.emit('chat', { from: msg.name, id: msg.from, text: msg.text, ts: msg.ts });
      case 'started':
        return this.emit('command-start', { rid: msg.rid, requester: msg.who, command: msg.command });
      case 'sys':
        return this.emit('sys', { text: msg.text, level: msg.level, rid: msg.rid });
      case 'out':
        return this.emit('output', { rid: msg.rid, chunk: msg.chunk });
      case 'done':
        return this.emit('command-done', msg);
      case 'denied':
        return this.emit('denied', { rid: msg.rid, reason: msg.reason });
      case 'kicked':
        if (msg.target === this.identity.id) { this.emit('kicked', msg.reason || null); this.close(); }
        return;
      default:
        return;
    }
  }

  chat(text) {
    const clean = String(text || '').slice(0, MAX_CHAT);
    if (!clean) return;
    this.send({ t: 'chat', text: clean });
  }

  requestRun(command) {
    const rid = crypto.randomUUID();
    this.send({ t: 'run', rid, cmd: String(command).slice(0, MAX_COMMAND) });
    return rid;
  }

  requestKill() { this.send({ t: 'kill' }); }

  get canRun() { return policy.abilities(this.myRole).canRun; }
}

module.exports = { Session, HostSession, GuestSession, hostShellSupported, HOME, PROTOCOL };
