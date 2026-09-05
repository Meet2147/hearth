# Hearth — marketing kit

Assets in `marketing/assets/`:
- `hearth-demo.mp4` / `hearth-demo.gif` — ~13s screencast: friend joins → granted access → runs a build → tries to read an SSH key → gets stopped.
- `hearth-welcome.png` — the app's onboarding empty-state.
- `hearth-session.png` — a live pair-debugging session.
- `hearth-guard.png` — the safety guard blocking a secret-exposing command.

All copy below is honest to what ships today. No "undetectable / invisible" claims.

---

## One-liners

- A shared terminal for friends.
- Google Docs, but for your terminal.
- Drop into the same shell together — chat, run commands, see the same output.
- Pair-debug without dictating commands over a call.

## The hook (why it exists)

Helping a friend debug over a call means dictating commands one keystroke at a
time — "no, capital D… now cd back… ok type l-s." Hearth just lets them into the
same terminal.

## What it is

One person shares their shell. Everyone else joins with a code and sees the same
session live — chat inline, run commands together. End-to-end encrypted, through
a relay that can read none of it. No account. macOS, Windows, Linux.

## The angle that makes people stop

A shared terminal is remote code execution on your machine — so Hearth makes it
deliberate, not accidental:
- Guests join as **watchers**; you grant run access per person and revoke it instantly.
- **Dangerous commands stop and ask you** — `rm -rf`, `sudo`, and things that
  would print your secrets into a room (`cat ~/.ssh/id_ed25519`), with a note of
  how many people are watching.
- Every payload is **signed and encrypted**; nobody in the room can forge output
  or fake a permission grant.

---

## LinkedIn (long)

> Helping a friend debug used to mean dictating commands over a call — "no,
> capital D… cd back… now type ls." Painful.
>
> So I built **Hearth**: a shared terminal for friends. One person shares their
> shell, everyone else joins with a code and sees the same session live — chat
> inline, run commands together, watch the same output scroll by.
>
> The part I care about most is trust, because a shared terminal is literally
> letting someone run code on your machine:
>
> 🔒 Guests join as watchers — they can't run anything until you allow them, per
> person, revocable instantly.
> 🛡️ Dangerous commands stop and ask you first. If someone runs
> `cat ~/.ssh/id_ed25519`, Hearth flags it — "SSH private key, 2 people watching"
> — before it runs.
> 🔑 End-to-end encrypted; the relay routes ciphertext it can't read, and every
> message is signed so no one can forge output or a permission grant.
>
> No account. macOS, Windows, Linux. Free to try.
>
> 👉 hearth.dashovia.app
>
> What would you use it for — pair debugging, teaching, onboarding?
>
> #buildinpublic #devtools #softwareengineering

## LinkedIn (short)

> Dictating terminal commands to a friend over a call is painful. **Hearth** lets
> them into the same shell instead — chat, run commands, see the same output,
> end-to-end encrypted. Guests can only run what you allow, and risky commands
> (like reading your SSH key) stop and ask you first, in front of everyone
> watching.
>
> macOS · Windows · Linux · free → hearth.dashovia.app
> #buildinpublic #devtools

## X / Twitter

> pair-debugging over a call = dictating commands one keystroke at a time 🫠
>
> built Hearth instead: a shared terminal for friends. same shell, chat + run
> together, e2e encrypted. guests only run what you allow, and risky commands
> stop and ask you first.
>
> hearth.dashovia.app

## X thread opener

> 1/ A shared terminal is remote code execution on your machine. That's the whole
> point of Hearth — so it makes it *deliberate*. Here's how the trust model works 🧵

## Product Hunt tagline

> Hearth — a shared terminal for friends. Chat + run commands together, safely.

## Product Hunt first comment

> Hey PH 👋 Hearth came from the pain of helping friends debug over a call by
> dictating commands. It's a shared terminal: one person hosts their shell,
> others join with a code and see it live. Guests start read-only; you grant run
> access per person; and commands that could wreck the machine or leak secrets
> stop for your approval. End-to-end encrypted, no account, macOS/Windows/Linux.
> Would love your feedback.

---

## Feature bullets (site / deck)

- **One shell, everyone in it** — cd and environment persist across commands and across people.
- **Watchers by default** — run access is granted per person and revoked instantly.
- **Stops you before you leak** — destructive and secret-exposing commands pause for approval.
- **Blind relay** — routes ciphertext, holds no key.
- **Signed, not just encrypted** — no insider can forge output or grants.
- **Everything logged** — who ran what, when, locally.
- **Terminal-native** — `/chat`, `/run`, history, tab-completion.
- **Zero-config for friends** — a hosted relay means `host` and `join` just work.

## Posting tips

- Lead with the **video/GIF** — the guard-modal moment (`cat ~/.ssh/id_ed25519`
  → blocked) is the scroll-stopper.
- Order for a carousel: session → guard → welcome.
- End with the question, not the link, to drive comments.
