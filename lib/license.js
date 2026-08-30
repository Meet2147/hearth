/*
 * Licensing, via Polar.
 *
 * An honest note about what this can and cannot do.
 *
 * Hearth ships as an app the customer runs. A licence check that lives in that
 * app is a POLITE GATE, not a lock: anyone can unpack the bundle and delete it.
 * That is true of every desktop app, and pretending otherwise leads to wasted
 * effort on obfuscation that buys nothing.
 *
 * So this module is deliberately not the security boundary. It:
 *   - keeps honest customers honest and makes upgrading obvious,
 *   - stores the key where the daemon can see it, not in browser storage that
 *     dies with the window's random port,
 *   - and caches the last good validation so a flaky network never locks
 *     someone out of their own machine.
 *
 * The enforceable boundary is the RELAY, because that is the piece we can run.
 * See MONETIZATION.md - anything that must genuinely be paid for belongs there.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const HOME = path.join(os.homedir(), '.hearth');
const CONFIG_PATH = path.join(HOME, 'config.json');

const POLAR_API = process.env.HEARTH_POLAR_API || 'https://api.polar.sh';
// The organization id is safe to ship: license activation and validation use
// Polar's tokenless customer-portal endpoints, which take only this id. It is
// NOT a secret and must not be confused with a Polar API token, which never
// belongs in a client.
const POLAR_ORG_ID = process.env.HEARTH_POLAR_ORG_ID || '36a24ca3-4af7-4c52-8fac-7243fb07019a';
const BUY_URL = process.env.HEARTH_BUY_URL || 'https://hearth.dashovia.app/#pricing';

// How long a cached validation stays trusted when Polar cannot be reached.
const OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;

// Gating is OFF while there is nothing to buy. Selling a limit before the paid
// tier exists would be charging for a promise, and it would make the builds
// people are testing today worse for no reason. When the hosted relay ships,
// maxGuests here goes back to 1 and the limit is enforced there, not in an app
// the customer can patch.
const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    maxGuests: 15,
    transcriptExport: true,
    namedRooms: false,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    maxGuests: 15,          // the relay caps a room at 16 including the host
    transcriptExport: true,
    namedRooms: true,
  },
};

// --- storage ---------------------------------------------------------------

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { return {}; }
}

function writeConfig(cfg) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function loadLicense() {
  const cfg = readConfig();
  return cfg.license || null;
}

function saveLicense(license) {
  const cfg = readConfig();
  if (license) cfg.license = license; else delete cfg.license;
  writeConfig(cfg);
  return license;
}

function maskKey(key) {
  const k = String(key || '');
  if (k.length <= 8) return '••••';
  return k.slice(0, 4) + '••••••••' + k.slice(-4);
}

// --- Polar -----------------------------------------------------------------

function configured() { return !!POLAR_ORG_ID; }

async function polar(pathname, body) {
  const res = await fetch(POLAR_API + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let payload = null;
  try { payload = await res.json(); } catch (e) { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, payload };
}

/*
 * Bind this device to the key, then confirm it. Polar's customer-portal
 * endpoints need no secret, which is exactly right here: shipping an API token
 * inside a desktop app would hand every customer the keys to the account.
 */
async function activate(key, deviceLabel) {
  if (!configured()) {
    return { ok: false, message: 'Licensing is not configured in this build yet.' };
  }
  const trimmed = String(key || '').trim();
  if (!trimmed) return { ok: false, message: 'Enter a license key.' };

  const act = await polar('/v1/customer-portal/license-keys/activate', {
    key: trimmed,
    organization_id: POLAR_ORG_ID,
    label: deviceLabel || (os.hostname() + ' (' + process.platform + ')'),
  });

  if (!act.ok) {
    return { ok: false, message: explain(act, 'That key could not be activated.') };
  }

  const activationId = act.payload && act.payload.id;
  const check = await validateKey(trimmed, activationId);
  if (!check.ok) return check;

  const license = {
    key: trimmed,
    masked: maskKey(trimmed),
    activationId: activationId || null,
    plan: check.plan.id,
    expiresAt: check.expiresAt || null,
    lastCheckedAt: Date.now(),
    lastGoodAt: Date.now(),
  };
  saveLicense(license);
  return { ok: true, license, plan: check.plan, message: 'License activated — ' + check.plan.name + '.' };
}

async function validateKey(key, activationId) {
  const body = { key: String(key).trim(), organization_id: POLAR_ORG_ID };
  if (activationId) body.activation_id = activationId;

  const res = await polar('/v1/customer-portal/license-keys/validate', body);
  if (!res.ok) {
    return { ok: false, message: explain(res, 'That license key is not valid.') };
  }
  const data = res.payload || {};
  if (data.status && data.status !== 'granted') {
    return { ok: false, message: 'This license is ' + data.status + '.' };
  }
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
    return { ok: false, message: 'This license expired on ' + String(data.expires_at).slice(0, 10) + '.' };
  }
  return { ok: true, plan: PLANS.pro, expiresAt: data.expires_at || null, raw: data };
}

function explain(res, fallback) {
  const detail = res.payload && (res.payload.detail || res.payload.error);
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail.length && detail[0].msg) return detail[0].msg;
  if (res.status === 404) return 'That key was not recognised.';
  if (res.status === 403) return 'That key is not valid for this product.';
  return fallback;
}

/*
 * Work out the current plan without ever blocking startup on the network. A
 * stored license is trusted until it is due a recheck; if the recheck cannot
 * happen we keep trusting it for the grace period. Losing wifi should never
 * downgrade someone mid-session.
 */
async function currentPlan(options) {
  const opts = options || {};
  const license = loadLicense();
  if (!license) return { plan: PLANS.free, license: null };

  const age = Date.now() - (license.lastCheckedAt || 0);
  if (!opts.force && age < RECHECK_AFTER_MS) {
    return { plan: PLANS[license.plan] || PLANS.pro, license };
  }
  if (!configured()) return { plan: PLANS[license.plan] || PLANS.pro, license };

  try {
    const check = await validateKey(license.key, license.activationId);
    if (check.ok) {
      license.lastCheckedAt = Date.now();
      license.lastGoodAt = Date.now();
      license.expiresAt = check.expiresAt || null;
      saveLicense(license);
      return { plan: check.plan, license };
    }
    // A definitive rejection is respected; the key is kept so the user can see
    // what happened rather than having it vanish.
    license.lastCheckedAt = Date.now();
    saveLicense(license);
    return { plan: PLANS.free, license, problem: check.message };
  } catch (e) {
    // Network trouble: fall back to the last known good result.
    const since = Date.now() - (license.lastGoodAt || 0);
    if (since < OFFLINE_GRACE_MS) {
      return { plan: PLANS[license.plan] || PLANS.pro, license, offline: true };
    }
    return { plan: PLANS.free, license, problem: 'Could not reach Polar to confirm this license.' };
  }
}

function publicView(license) {
  if (!license) return null;
  // The key itself never leaves the daemon.
  return {
    masked: license.masked || maskKey(license.key),
    plan: license.plan,
    expiresAt: license.expiresAt || null,
    lastCheckedAt: license.lastCheckedAt || null,
  };
}

module.exports = {
  PLANS, BUY_URL,
  configured, activate, validateKey, currentPlan,
  loadLicense, saveLicense, publicView, maskKey,
  CONFIG_PATH,
};
