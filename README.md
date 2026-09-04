# Hearth

**[Download for macOS or Windows →](https://meet2147.github.io/hearth/)**

A shared terminal for friends. You open a session, they join with a code, and
everyone sees the same shell. Chat inline, run commands together, and the whole
thing is end-to-end encrypted through a relay that can read none of it.

**Zero dependencies.** Node 18+, nothing to install, nothing to build.

```
  Meet (host)                  relay (sees ciphertext only)              Arjun
  ┌──────────────┐                  ┌───────────┐                 ┌──────────────┐
  │ real shell   │◄──── wss ───────►│  routes    │◄──── wss ──────►│ watch, chat, │
  │ cd/env kept  │                  │  opaque    │                 │ run if       │
  └──────────────┘                  │  blobs     │                 │ allowed      │
                                    └───────────┘                 └──────────────┘
```

## Quick start

Try it entirely on one machine first:

```bash
node hearth.js relay
```

In a second terminal:

```bash
node hearth.js host --relay ws://127.0.0.1:8787/ws
```

It prints a line to send your friends. In a third terminal, paste it:

```bash
node hearth.js join DEMO-CODE-1234-5678 --relay ws://127.0.0.1:8787/ws
```

For friends on other networks there's nothing to configure — Hearth ships with a
hosted relay as the default. Just:

```bash
node hearth.js host          # you: share your shell, get a join code
node hearth.js join <CODE>   # them: join from anywhere
```

Prefer your own relay? Point both ends at it (see **Running a relay**):

```bash
node hearth.js config --relay wss://your-relay.example.com/ws --name meet
```

## The desktop app

One Electron codebase produces the macOS and Windows apps.

```bash
cd desktop
npm install
npm start                # run it
npm run dist:mac         # -> desktop/dist/*.dmg, *.zip
npm run dist:win         # -> desktop/dist/*.exe   (must run on Windows)
```

A real application: Dock or taskbar icon, its own window, its own menu bar,
Cmd/Ctrl+C, Cmd/Ctrl+Q. No browser, no tab, no URL bar. Launch it and it starts
everything it needs — the session daemon, and a local relay if you have not
configured one — then shuts them down when you quit.

The daemon runs on Electron's **own bundled Node**, so a packaged Hearth needs
nothing installed on the machine. Windows builds ship `hearth-helper.ps1` inside
the bundle.

It is a native window hosting the same interface the browser shows, rather than
a per-platform UI rewrite — which is deliberate: the Mac app, the Windows app and
a friend's browser can never drift apart, and one fix lands everywhere.

**Private mode** (View → *Private (hide from screen share)*, or ⌘/Ctrl+Shift+P)
excludes the Hearth window from screen capture using the OS's own
content-protection APIs — `WDA_EXCLUDEFROMCAPTURE` on Windows,
`NSWindowSharingNone` on macOS, via Electron's `setContentProtection`. The window
stays visible on your own display but is omitted from what Meet, Zoom, QuickTime
or OBS record. It defeats *software* capture only: a camera pointed at the
screen still sees everything, and it is not a way around exam or interview
monitoring.

**Settings** (`/settings`, or the button in the title bar) shows the version,
checks GitHub for a newer release, and holds your licence key. The daemon does
the update check and the licence calls, so the window keeps a strict CSP and
never talks to anything but loopback.

**Pinned on purpose:** Electron `^33` and electron-builder `^25`. The current
releases of both pull ESM-only dependencies that need Node ≥ 20.19 to
`require()`, which breaks on older Node. This pair builds on Node 18 through 24,
and CI uses the same versions so local and CI builds match.

### A smaller, fully native Mac shell

`mac/` holds an alternative: the same UI in a hand-written AppKit/Swift wrapper.

```bash
./mac/build.sh && open mac/build/Hearth.app
```

| | Electron (`desktop/`) | Swift (`mac/`) |
|---|---|---|
| platforms | macOS + Windows | macOS only |
| size | ~100 MB | **~900 KB** |
| needs Node installed | no | yes |
| window, menus, lifecycle | Chromium + Electron | native AppKit |

Use the Electron build unless the size bothers you.

## The window in a browser (no app needed)

```bash
node hearth.js host --ui
```

Opens the app in your browser and prints two links: **your window**
(`127.0.0.1:7777`, token-protected) and the one you send your friends — the
relay's own address. They open it, type the code, and they are in. **Nothing to
install on their side, on any device.**

The daemon still does all the work; the browser is just a view onto it. You get
a live transcript of chat and command cards, a People panel where you promote or
remove someone with one click, a Lock switch, and a full-screen confirmation when
a command is risky. Guests get the same window minus the host controls.

`hearth host` without `--ui` keeps the terminal client — both are fully
supported, and they interoperate: one person can be in the window while another
is in the terminal.

## What a session looks like

```
  hosting as   Meet
  shell        /bin/bash   ~/Development/api
  key          D4EB-4F88-2195-9C6A

  Send your friends this line:
     hearth join DEMO-CODE-1234-5678

12:19  -       Arjun joined as a watcher  (key 21DF-CF93-BDFF-FEDE)
12:19  Arjun   hey, my tests are failing on this box - can you look?
12:19  Meet    yeah send it over

12:19  $ npm test -- --grep auth   (Meet)
  | 3 passing, 1 failing
  exit 1  2.4s

12:19  !       Arjun can now run commands on this machine

12:19  $ node -e "console.log(process.version)"   (Arjun)
  | v20.15.1
  ok  84ms
```

## Commands

The app and the terminal client take the same commands — the window is a
terminal, with a prompt at the bottom, command history on ↑/↓, Tab completion for
slash commands, and Ctrl+L to clear.

Type plain text to chat. Everything else is a slash command.

| | |
|---|---|
| `/chat <message>` | say something (or just type) |
| `/run <command>` | run on the host machine — aliases `/cmd`, `$ command` |
| `/kill` | stop whatever is running |
| `/who` | everyone present and what they can do |
| `/settings` | version, updates, licence |
| `/clear` | clear the transcript |
| `/help` `/quit` | |

Host only:

| | |
|---|---|
| `/allow <name>` | let someone run commands |
| `/deny <name>` | take it back |
| `/kick <name>` | remove them from the session |
| `/lock` | panic switch — pauses all remote commands and demotes every runner |
| `/unlock` | lift it |
| `/code` | show the join line again |
| `/audit` | where this session is being logged |

## The permission model

This is the part that matters, so it is worth being blunt about it.

**A shared terminal is remote code execution on your machine.** That is the
feature. Everything below exists so that it is *deliberate* remote code
execution rather than accidental.

- **Guests join as watchers.** They see everything and can chat. They cannot run
  anything. A leaked join code costs you a spectator, not a shell.
- **Run access is granted per person** with `/allow`, and revoked instantly with
  `/deny`. `/lock` demotes everyone at once and refuses new commands — the thing
  you reach for when something feels wrong.
- **Risky commands stop and ask you**, even from someone you have already
  trusted, in two categories that are genuinely different problems:
  - *destructive* — `rm -rf`, `mkfs`, `dd of=/dev/…`, `sudo`, piping a download
    into a shell. Could wreck the machine.
  - *sensitive* — `cat ~/.ssh/id_ed25519`, `env`, `.aws/credentials`, `gh auth
    token`. Harmless to the machine, but it would print your secrets into a
    stream several people are watching. Hearth tells you how many.
- **Everything is logged**, whether or not anyone was watching, to
  `~/.hearth/audit-<session>.jsonl` — who ran what, when, the risk verdict, the
  exit code. Commands you blocked are recorded too.

The classifier is a **speed bump, not a sandbox.** Anyone with run access can
trivially step around it (`base64`, a variable, a script file). It is there to
catch the accident and the thoughtless paste, and to make you look before you
nod. The real boundary is who you `/allow`.

## Security

- The join code is stretched with PBKDF2-SHA256 (200k iterations) into a 256-bit
  key. Every message is sealed with AES-256-GCM under it.
- **The relay never receives that key.** It routes on a room id that is a one-way
  hash of the key, so it cannot work backwards to your code. It sees ciphertext,
  message sizes and timing. Nothing else.
- **Every participant signs with Ed25519.** Encryption alone proves only that
  someone holds the join code — it says nothing about *which* person sent a
  message, and everyone in the room shares that key. Signatures are what stop a
  guest forging command output or faking a permission grant from the host.
  Messages carrying authority (output, roster, grants) are accepted **only** from
  the pinned host identity.
- Keys are pinned on first sight. A second participant claiming an id already in
  use is rejected and surfaced to you.
- Both ends print a key fingerprint. If it matters, read it to each other.

**The host's own UI socket** is the one piece that can start commands locally, so
it is guarded separately: it binds to `127.0.0.1` only, requires a random
per-session token in the URL, and rejects any foreign `Origin`. That last one
matters more than it sounds — browsers do **not** apply the same-origin policy to
WebSockets, so without it any website you happened to have open could connect to
`ws://localhost` and drive your shell. The page is served under a strict CSP that
forbids it from talking to anywhere else.

What this does **not** protect against: anyone you hand the join code to, anyone
you `/allow`, or a compromised host machine. Signatures stop impersonation
*within* a session; they do not make an untrustworthy friend trustworthy.

## Running a relay

The relay is ~180 lines and holds no secrets. It needs to be reachable by
everyone in the session, which usually means a small VPS or a free Fly.io app.

```bash
fly launch --no-deploy   # from deploy/
fly deploy
```

Fly terminates TLS, so clients get `wss://` with no certificate work. For a plain
VPS, `deploy/Caddyfile` and `deploy/hearth-relay.service` cover the same ground.

Limits are environment variables with sane defaults: `MAX_ROOMS` (500),
`MAX_PER_ROOM` (16), `MAX_MSG_BYTES` (256KB), `MSG_PER_SEC` (80), `IDLE_MS`.

Use `wss://` for anything real. The payload is encrypted either way, but plain
`ws://` leaks who is talking to whom and gets mangled by corporate proxies.

## How the host shell works

Hosting works on **macOS, Linux and Windows**. One long-lived shell handles the
whole session, so `cd`, environment variables and shell state persist from one
command to the next — including across different *people*. Arjun runs `cd /tmp`,
you run `pwd`, you get `/tmp`.

Both platforms use the same completion protocol: after each command the shell
prints a record-separator marker carrying a per-session random token, the exit
code and the new working directory. The token is generated in the daemon and
never appears on a command line, so a running command cannot read it out of the
process list and forge a completion.

They differ in how a command reaches the shell, because the platforms genuinely
differ:

|  | macOS / Linux | Windows |
|---|---|---|
| shell | `bash` (falls back to `sh`) | `powershell.exe` |
| command channel | stdin, wrapped in a quoted heredoc so `eval` sees the text literally | a **private named pipe**, base64-encoded |
| stdin isolation | each command runs with `</dev/null` | the helper's own stdin is closed |
| stopping a command | signal the process group | `taskkill /PID /T /F` |

The Windows split exists for a concrete reason: PowerShell cannot redirect a
command's stdin. If commands arrived on stdin there, a native command that reads
input — `more`, `sort`, `findstr` — would swallow the next queued command. Moving
the command channel to a named pipe lets the helper's stdin stay closed, so such
a command gets EOF instead. Base64 then removes every PowerShell quoting and
newline hazard from command text.

Details worth knowing:

- **One command at a time.** A second one is refused with a note about what is
  running and who started it, rather than being silently queued. Use `/kill`.
- `/kill` and timeouts (120s default) take down the shell along with the command,
  so it restarts in the same directory and **environment variables are lost**.
  Hearth says so when it happens.
- No PTY. Fully interactive programs — `vim`, `top`, `less` — will not work.
  That is a deliberate trade: a PTY needs a native dependency, and this is a
  chat-plus-commands tool, not a screen share.

## Continuous integration

`.github/workflows/ci.yml` runs the suite on **ubuntu, macOS and Windows**, then
builds the desktop apps and uploads them as artifacts. Tagging `v*` drafts a
release with the installers attached.

The Windows test job matters most: it is the only place `hearth-helper.ps1` is
ever executed, so it is what turns "written" into "verified" for Windows hosting.
The suites pick platform-appropriate commands from `test/platform.js`, so the
Windows run exercises real PowerShell rather than failing on `/tmp`.

## Testing

```bash
npm test
```

201 checks across seven suites on macOS, and **all green on Linux, macOS and
Windows in CI** — 185 of them run on Windows against real PowerShell 7, which is
what verifies `hearth-helper.ps1`:

| suite | what it proves |
|---|---|
| crypto + transport | key derivation, sealing, signature forgery is rejected, the relay routes ciphertext and logs nothing |
| command policy | destructive and sensitive commands are caught in **both POSIX and PowerShell spellings**, and ordinary commands are not — a classifier that cries wolf gets ignored |
| host shell | `cd`/env persist, exit codes, stderr, unicode, multi-line, stdin isolation, timeouts, kills, recovery, forged completion markers |
| windows driver | the real Windows driver — named pipe, token handshake, base64 transport, pre-connect queueing, cwd tracking, stdin isolation, timeout, kill — run against a stand-in for PowerShell so it is covered on any machine |
| session + permissions | watcher refused, promotion, everyone sees output, host approval flow, **an insider cannot forge output or grants**, lock, kick, plan limits, audit trail |
| local ui security | loopback-only binding, token on page and socket, foreign `Origin` refused, CSP present, snapshot leaks no key material, command round-trip |
| live cli | the real binaries as separate processes, driven exactly as a person would |

Nine bugs this suite caught and now guards against permanently. The last four
came from the Windows CI job on its first runs — none of them were reachable
from a Mac:

- An **infinite greeting loop** — host and guest re-greeted each other forever.
  It was hidden behind a broken key-conflict check that happened to break the
  cycle by rejecting a legitimate message. There is now a test asserting an idle
  room generates zero traffic.
- **Missing attribution** — the host saw command *output* without seeing what was
  run or by whom, which is backwards for a shared terminal.
- **A dropped first message.** The WebSocket client replayed leftover bytes
  synchronously, so when a server's handshake response and its first frame
  arrived in one TCP segment, that frame fired before the caller could attach a
  listener and was lost. It only showed up under load, as a flaky test.
- **A crash instead of a fallback.** `spawn` reports a missing binary
  asynchronously, as an `error` event rather than a throw — so the `try/catch`
  around `taskkill` could not see it and an unhandled event would have taken down
  the whole daemon.
- **A leaked pipe server.** The Windows driver recreated its named-pipe server
  every time the helper restarted after a kill. The second listen fails, and the
  abandoned server keeps handles open forever.
- **A failing command reported success.** On Windows, `$?` after a pipeline
  reports whether `ForEach-Object` succeeded, not the command inside it — so a
  cmdlet that failed showed `ok` to everyone watching.
- **Errors vanished entirely.** `2>&1` on `Invoke-Expression` does not reliably
  fold an inner command's error stream into the pipeline, so error text never
  reached the transcript. Now `$Error` is swept afterwards for anything missed.
- **Non-ASCII output was destroyed.** PowerShell writes to the console in the
  legacy OEM code page by default, turning accents, emoji and CJK into `?`
  before the daemon ever saw them.
- **A stale channel after a kill.** The driver's socket reference outlived the
  dead helper by a tick, so the next command was written into a dead pipe and
  silently lost — about one run in three.

## Limitations

- **The Windows app is built by CI but has never been launched.** The suite
  passes on `windows-latest`, so hosting itself is verified against real
  PowerShell — but nobody has yet double-clicked the packaged `.exe`. That is
  the one remaining unknown on Windows.
- **Not load-tested with many participants.** The relay caps a room at 16 and the
  protocol is a full broadcast; it has been exercised with three.
- **No file transfer, no scrollback replay.** A guest joining late sees the room
  from that moment, not what came before.
- **Browser guests need Ed25519 in WebCrypto** (Chrome 137+, Safari 17+, Firefox
  130+). Verified working. On an older browser the join fails with a clear
  message rather than silently dropping to an unsigned, spoofable mode.

- **Reconnect is not automatic.** If the relay connection drops, the session
  ends and you rejoin with the same code.
- **Licence enforcement is client-side only.** It is a polite gate, not a lock,
  and it says so in `lib/license.js`. Real enforcement belongs in the relay —
  see [MONETIZATION.md](MONETIZATION.md).

## Licence and pricing

Source-available — see [LICENSE](LICENSE). Free for personal use; not
redistributable as a product.

Pricing, the tier plan, the Polar setup, and three things worth arguing about
first are in [MONETIZATION.md](MONETIZATION.md).
