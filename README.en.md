# Z·SWITCH (zcode-switch)

![Release](https://img.shields.io/github/v/release/hj01857655/zcode-switch?label=release&sort=semver)
![CI](https://github.com/hj01857655/zcode-switch/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/github/license/hj01857655/zcode-switch)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)

[简体中文](README.md) ｜ **English**

> **Provenance**: this repository is a fork of [pjpv/zcode-switch](https://github.com/pjpv/zcode-switch), developed further on top of it (security hardening, the quota system, the local gateway, etc. — see below). The original design and core architecture belong to the upstream author; all additions in this fork are shared back under the same license (MIT).

A Tauri 2 desktop tool for one-click switching between multiple ZCode accounts, with live quota display. Only the login identity changes — projects, sessions, settings and plugins all stay untouched.

![screenshot](docs/screenshot.png)

## Download

Grab the installer for your platform from [Releases](https://github.com/hj01857655/zcode-switch/releases/latest):

| Platform | File |
|---|---|
| Windows x64 | `zcode-switch_<ver>_x64-setup.exe` (NSIS installer) |
| Windows ARM64 | `zcode-switch_<ver>_arm64-setup.exe` (NSIS installer) |
| macOS Apple Silicon | `zcode-switch_<ver>_aarch64.dmg` |
| macOS Intel | `zcode-switch_<ver>_x64.dmg` |
| Linux amd64 | `.deb` (Debian/Ubuntu) or `.AppImage` (universal) |
| Linux arm64 | `.deb` / `.AppImage` |

**Requirements**: Windows 10+; macOS 12+; Ubuntu 22.04 / Debian 12+ (AppImage is universal). If SmartScreen / Gatekeeper warns on first launch, choose "Run anyway" — the binaries are not code-signed, which is expected.

## Updates

Since v1.8.2 the app has built-in updates: it silently checks once after launch and shows a corner toast when a new version is found; you can also open the About page anytime to check, download and install manually. Update packages are verified with a minisign signature and only official releases are accepted.

**Coverage** (depends on how you installed — note this carefully):

| Install form | In-app update |
|---|---|
| Windows `*_x64-setup.exe` / `*_arm64-setup.exe` (NSIS) | ✅ Supported |
| macOS `.dmg` | ✅ Supported (self-update uses the `.app.tar.gz` shipped alongside; `latest.json` lists macOS since v1.8.3, so mac installs made before that update manually once and become automatic afterwards) |
| Linux `.AppImage` | ✅ Supported (replaces the AppImage file in place; the location must be writable) |
| Linux `.deb` | ✅ Supported (a system authorization prompt appears once; installs via `dpkg`, no manual download) |
| Windows portable `*_*_portable.exe` | ❌ Manual download required |

`latest.json` registers four self-update channels — Windows NSIS, macOS (`.app.tar.gz`), Linux AppImage and Linux deb — each with its x64 / ARM64 / Apple Silicon platform variants; only the Windows portable exe is not listed, and those users must fetch new versions from Releases manually.

## Features

- **Save / switch accounts**: one-click login switching; the current login is auto-preserved before any switch — accounts are never lost
- **Add accounts**: OAuth login for new accounts inside the tool (BigModel / z.ai entries), never touching the current login
- **Quota display**: inline plan quota and reset time per account row, multi-plan grouping; a dashboard page summarizes everything
- **Claim promotions**: one-click claim for eligible promotions; "Auto claim" toggle (off by default) checks and claims periodically — manual actions take priority
- **Local gateway**: OpenAI-compatible reverse proxy that translates any OpenAI SDK request into the ZCode model endpoint protocol (`http://127.0.0.1:8081/v1`); multi-account pool with rotation and cooldown, request logs (raw/JSON/body/SSE views), gateway tuning modal, smoke-test modal (protocol switch / system prompt / parameters / streaming / curl preview); see [docs/GATEWAY.md](docs/GATEWAY.md)
- **Gateway quick start**:
  ```bash
  # List available models (model surface follows plan entitlements)
  curl http://127.0.0.1:8081/v1/models -H "Authorization: Bearer sk-..."

  # OpenAI protocol
  curl http://127.0.0.1:8081/v1/chat/completions \
    -H "Authorization: Bearer sk-..." -H "Content-Type: application/json" \
    -d '{"model":"GLM-5.3-Flash","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'

  # Anthropic protocol (native clients like Claude Code connect directly)
  curl http://127.0.0.1:8081/v1/messages \
    -H "Authorization: Bearer sk-..." -H "anthropic-version: 2023-06-01" \
    -H "Content-Type: application/json" \
    -d '{"model":"GLM-5.3-Flash","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'
  ```
- **Referral program**: bind an invite code, view my code with share link (copies the full URL), and track referral task progress
- **Encrypted import / export**: `.zsb` bundle, PBKDF2(600k) + AES-256-GCM password encryption
- **Bilingual UI (中文 / English)**: one-click switch in Settings — main window, tray, error messages and CLI output all covered; first run follows your OS language
- **Tray / autostart / CLI automation**

## Security Design

- **Local first**: all data stays on your machine; no telemetry, no remote storage; quota queries go directly to official endpoints
- **WebView CSP**: main/settings windows use `script-src 'self'` (no eval, no third-party script origins); only the captcha sub-window allows `o.alicdn.com` and `unsafe-eval` for the Aliyun captcha SDK; `img-src` is scoped to Aliyun CDN; local pages add a restrictive meta CSP on top
- **No account loss**: the current login is auto-preserved before switching if not yet saved; file writes go through a temp file + atomic rename
- **Path traversal protection**: account id whitelist (`[A-Za-z0-9-]`); delete/read cannot escape the account store directory
- **Encrypted export**: PBKDF2-HMAC-SHA256 (600k iterations, OWASP 2025 baseline; legacy v1 bundles at 100k remain importable) + AES-256-GCM, random salt/nonce; wrong password simply fails, no plaintext traces
- **Credentials decrypted locally only**: decryption is used solely to display username/email; export files are password-encrypted

## CLI

```
zcode-switch.exe --cli state|list
zcode-switch.exe --cli quota [--id <account-id>]
zcode-switch.exe --cli claim-preview [--id <account-id>]
zcode-switch.exe --cli capture [--name <name>]
zcode-switch.exe --cli switch --id <id> [--force] [--restart|--no-restart] [--hot <bool>|--no-hot]
zcode-switch.exe --cli kill
zcode-switch.exe --cli export --id <id> --out <a.zsb>
zcode-switch.exe --cli export-all --out <all.zsb>
zcode-switch.exe --cli import --file <file.zsb>
zcode-switch.exe --cli rename|delete|update|behavior|setpath|launch
zcode-switch.exe --cli gateway status               # gateway config + port probe (start/stop in the GUI)
zcode-switch.exe --cli gateway logs [--n count]     # tail of gateway.jsonl request log
zcode-switch.exe --cli --lang en state              # English output (--lang takes a space-separated value, works anywhere in the command line; defaults to the GUI/system language)
```

CLI password (export / import): prefer the `ZSW_PASSWORD` environment variable (keeps it out of process lists and command history); `--password <password>` also works.

## FAQ

### macOS asks for Microphone / Accessibility / Screen Recording permission?

Deny all of them — nothing breaks.
The embedded pages (such as the login page) are rendered by the system WebView, which relays their requests as system permission prompts attributed to the app; neither the app itself nor its embedded pages use any of these three capabilities.

## Developer Docs

- [Client version-header strategy](docs/APP-VERSION.md) — every channel follows the locally installed ZCode version (registry detection), nothing is pinned (2026-10-31: version header does not affect preview, 3.17.1 claims succeed with zero 3012)
- [Gateway design doc](docs/GATEWAY.md) — protocol matrix, account pool, module breakdown and milestones

## Build

```bash
npm install
npm run tauri dev      # development (HMR)
npm run tauri build    # NSIS installer
```

Windows-first (path detection / process management / tray are all Win32 semantics).

## License

[MIT](./LICENSE) — copyright lines for both the upstream original work (pjpv) and this fork's enhancements are in LICENSE; derivative distributions should keep both.
