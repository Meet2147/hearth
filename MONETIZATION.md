# Selling Hearth

The plan, the tiers, and three things worth deciding before any of it ships.

---

## Read this part first

### 1. You cannot sell MIT code

Hearth was MIT. The repo is public. **Anything published under MIT stays MIT
forever** — anyone may fork it, delete the licence check, and redistribute it,
including commercially. That is not a loophole; it is what the licence grants.

The repo now ships `LICENSE` as source-available (all rights reserved, free for
personal and evaluation use). That keeps every option open:

- proprietary → open source later: trivial, any time.
- open source → proprietary: **impossible** for anything already published.

If you would rather it be open, the usual shape is **open core**: core MIT, paid
features in a separate private module. Say the word and I will split it.

### 2. A licence check inside the app is a polite gate, not a lock

Hearth runs on the customer's machine. Anyone can unpack the bundle and delete
the check. This is true of every desktop app; obfuscation buys hours, not
security. `lib/license.js` says so in its own header.

**So do not sell things the app can grant itself.** Sell the thing you run.

### 3. Which is why the relay should be the product

The relay is the only piece you control. It is also the only real friction for a
customer: nobody wants to rent a VPS to chat with a friend.

| gate | enforceable? | why |
|---|---|---|
| guest limit in the app | no — patchable | runs on their machine |
| features in the app | no — patchable | same |
| **hosted relay access** | **yes** | your server, your rules |
| **seats per room, enforced by the relay** | **yes** | same |

Recommended framing: **the app is free and unlimited on your own relay. Pro is
the hosted relay** — no VPS, no TLS certificates, works from anywhere. That
sells a real convenience, is honestly enforceable, and stays friendly to the
people who would have patched it anyway.

### 4. Lifetime at $49 against a service that costs you monthly

$49 lifetime ÷ $5/month = **~10 months to break even**. Every month after that,
a lifetime customer using the hosted relay costs you money forever. A hundred of
them is a permanent bill with no matching revenue.

Three ways out, in order of preference:

1. **Lifetime = app + self-hosted relay, no hosted relay.** Costs you nothing
   ongoing. Honest, and still attractive to the self-hosting crowd.
2. **Lifetime includes a monthly cap** (say 20 hosted sessions/month), overage
   pauses until next month.
3. Keep it as-is and treat it as paid marketing for the first year. Defensible
   early, painful at scale.

Option 1 is what I would ship.

---

## Tiers

Prices as you specified. The split follows the rule above: everything the app
can do by itself is free, and what you actually run is paid.

| | **Free** | **Pro** |
|---|---|---|
| | $0 | **$5**/mo · **$29**/yr · **$49** lifetime |
| Chat + run together | ✅ | ✅ |
| Per-person run permissions, `/lock`, kick | ✅ | ✅ |
| Destructive & secret-exposure warnings | ✅ | ✅ |
| Local audit log | ✅ | ✅ |
| macOS, Windows, Linux apps | ✅ | ✅ |
| **Self-hosted relay** | ✅ unlimited guests | ✅ unlimited guests |
| **Hosted relay (no server to run)** | — | ✅ |
| Guests per session on the hosted relay | — | **15** |
| Stable named rooms (same code every time) | — | ✅ |
| Session transcript export (Markdown / JSON) | — | ✅ |
| Audit log export | — | ✅ |
| Custom command policy (your own patterns) | — | ✅ |
| Support | issues | direct |

Free is deliberately generous. Someone who will self-host was never going to
pay; making them a happy user costs nothing and they bring the friends who will.

**Yearly at $29 is 52% off monthly.** That is steep — $39 (35% off) is the more
usual anchor and leaves room to discount later. Your call.

### Features worth building next, by tier

**Pro, in rough order of how much they justify the price**

1. **Hosted relay** — the whole proposition. Everything else is a bonus.
2. **Named rooms** — `hearth join meet/debugging` instead of a fresh code each
   time. Small to build, feels premium, needs the relay, so it is enforceable.
3. **Transcript export** — the session log as Markdown. Genuinely useful for
   pair-debugging write-ups. The daemon already keeps the history.
4. **Custom command policy** — teams want their own rules in `lib/policy.js`
   form. Cheap to add, sticky once configured.
5. **Session replay** — scrollback for someone who joins late. Currently a
   listed limitation; it is a real complaint waiting to happen.

**Later, if there is demand**

- **Team plan** — shared licence across a group, SSO, central audit. This is
  where the actual money is if it lands with teams rather than friends.
- **Recording** — an asciinema-style replay file per session.

---

## Polar setup

Nothing here needs code changes; it is all account configuration.

1. **Create the products** at polar.sh — three of them:
   - `Hearth Pro — Monthly`, recurring $5
   - `Hearth Pro — Yearly`, recurring $29
   - `Hearth Pro — Lifetime`, one-time $49
2. **Add the Licence Key benefit** to each. Set:
   - *activation limit* — 3 devices is a fair default,
   - *expiry* — matching the term for monthly and yearly, none for lifetime.
   Polar issues a key automatically on purchase.
3. **Copy your organization ID** from the Polar dashboard.
4. **Create a checkout link** per product.
5. **Point Hearth at them.** Two environment variables, no rebuild:

   ```bash
   export HEARTH_POLAR_ORG_ID="your-organization-id"
   export HEARTH_BUY_URL="https://buy.polar.sh/your-checkout-link"
   ```

   Unset, Hearth runs as Free and says "licensing is not configured in this
   build yet" instead of pretending to check.

### What is already built

- `lib/license.js` — activates and validates against Polar's customer-portal
  endpoints (`/v1/customer-portal/license-keys/{activate,validate}`). Those need
  no API token, which is correct: shipping a secret inside a desktop app would
  hand every customer the keys to your Polar account.
- The key is stored by the **daemon** in `~/.hearth/config.json` (mode 600), not
  in browser storage — the window's origin changes port every launch, so
  anything kept there would vanish.
- **Offline grace.** A validated licence is re-checked daily and trusted for 14
  days without a network. Losing wifi must never downgrade someone mid-session.
- Plan limits are applied at session start and enforced on join, and a refused
  guest is told *why* rather than silently failing to appear.
- Settings shows plan, seats, key status, and a working update check.

### What is not built

- **Relay-side enforcement** — the part that actually matters. The relay
  currently accepts any room. It needs to require a licence token before opening
  a room, and to enforce the seat cap itself. That is the one piece worth doing
  properly, and it only exists once there is a hosted relay to enforce on.
- Hosted relay infrastructure, named rooms, transcript export.
- No Polar products exist yet — the two environment variables above are unset,
  so every build today is Free.
