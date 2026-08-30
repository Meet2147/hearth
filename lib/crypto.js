/*
 * Hearth crypto.
 *
 * Two independent layers, deliberately separated:
 *
 *   Confidentiality  - AES-256-GCM under a key derived from the join code.
 *                      The relay never has this key, so it only ever routes
 *                      ciphertext.
 *
 *   Authenticity     - Ed25519 signatures per participant. Everyone in the room
 *                      shares the AES key, so encryption alone proves nothing
 *                      about WHO sent a message. Signatures are what stop a
 *                      guest forging command output or faking a permission
 *                      grant from the host.
 */

'use strict';

const crypto = require('crypto');

const KDF_SALT = 'hearth-v1-join-code';
const KDF_ITERS = 200000;

// Unambiguous alphabet - these codes get typed by hand and read out loud.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function generateCode() {
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-');
}

function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function deriveKey(code) {
  const normalized = normalizeCode(code);
  if (normalized.length < 8) throw new Error('join code is too short to be safe');
  return crypto.pbkdf2Sync(normalized, KDF_SALT, KDF_ITERS, 32, 'sha256');
}

// What the relay is allowed to know: an opaque routing label. Derived from the
// key, so the relay cannot walk it backwards to the join code.
function roomIdFor(key) {
  return crypto.createHash('sha256').update(key).update('hearth-room').digest('hex').slice(0, 32);
}

// --- sealed envelopes: iv(12) | ciphertext | tag(16) ------------------------

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const pt = Buffer.from(JSON.stringify(obj), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
}

function open(key, b64) {
  try {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(buf.length - 16));
    const pt = Buffer.concat([
      decipher.update(buf.subarray(12, buf.length - 16)),
      decipher.final(),
    ]);
    return JSON.parse(pt.toString('utf8'));
  } catch (e) {
    return null; // wrong code, tampering, or garbage - all the same to us
  }
}

// --- participant identity ---------------------------------------------------

function newIdentity(name, role) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return {
    id: crypto.randomBytes(8).toString('hex'),
    name,
    role,
    pub,
    publicKey,
    privateKey,
    fingerprint: fingerprintOf(pub),
  };
}

function fingerprintOf(pubB64) {
  const hex = crypto.createHash('sha256').update(Buffer.from(pubB64, 'base64'))
    .digest('hex').toUpperCase().slice(0, 16);
  return hex.match(/.{4}/g).join('-');
}

function importPublicKey(pubB64) {
  try {
    return crypto.createPublicKey({
      key: Buffer.from(pubB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch (e) {
    return null;
  }
}

// Deterministic serialisation, so signer and verifier hash identical bytes.
function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  const keys = Object.keys(obj).filter((k) => k !== 'sig').sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

function sign(identity, msg) {
  const sig = crypto.sign(null, Buffer.from(canonical(msg), 'utf8'), identity.privateKey);
  return { ...msg, sig: sig.toString('base64') };
}

function verify(publicKey, msg) {
  if (!publicKey || !msg || typeof msg.sig !== 'string') return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(canonical(msg), 'utf8'),
      publicKey,
      Buffer.from(msg.sig, 'base64')
    );
  } catch (e) {
    return false;
  }
}

module.exports = {
  generateCode, normalizeCode, deriveKey, roomIdFor,
  seal, open,
  newIdentity, importPublicKey, fingerprintOf,
  canonical, sign, verify,
  KDF_ITERS,
};
