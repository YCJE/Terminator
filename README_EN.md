<h1 align="center">

Terminator

   <img src="build/appicon.png" width=250 alt="Terminator logo"/>

</h1>

<h3 align="center">

Self-hostable SSH client with sync

</h3>

Terminator is a cross-platform SSH client built with [Wails v3](https://v3.wails.io/) and Go. Supports self-hosted servers for sync.

## Features

### Terminal

- Full terminal emulator based on xterm.js 6, 256-color + Unicode 11
- Multi-tab management, each tab has independent SSH session, drag-to-reorder
- Trust-On-First-Use (TOFU) host key verification
- Terminal theme follows app theme (Abyss dark / Frost light) with real-time switching
- Terminal color linked to UI accent color — ANSI blue/cyan/cursor sync on change
- Flow control backpressure (Promise chain + writeQueue) — no data loss on large outputs
- Scroll anchoring — locks scroll position during large outputs
- Tab status indicators (green=connected / yellow=connecting / red=disconnected)
- Session recovery via SerializeAddon after crash
- **Terminal search** — Ctrl+F to search output, prev/next navigation, Esc to close
- **Keyword highlighting** — real-time highlight of ERROR/WARN/INFO/SUCCESS keywords, toggleable in settings
- **Multi-terminal broadcast** — type in one terminal, commands sync to all connected terminals for batch ops

### SSH Connection

- SSH connection multiplexing — multiple sessions share one TCP connection
- Jump Host support — connect through an intermediate host
- Port Forwarding — Local and Remote forward with visual UI management
- Connection pool health check, refCount prevents closing in-use connections
- **SSH Agent Forwarding** — per-host Agent Forwarding config, allows remote server auth via local SSH Agent
- **HTTP/SOCKS5 Proxy** — per-host proxy config for SSH connections via HTTP CONNECT or SOCKS5, with proxy auth

### Host & Key Management

- Netcatty-style slide panel for add/edit — draggable width adjustment
- Host grouping with collapse/expand, search by group name
- OS-specific icons (Linux/Windows/macOS)
- Interactive password input — optionally don't save passwords
- SSH key management — encrypted storage, key-based auth
- Built-in key generation — Ed25519 and RSA, import from file
- **Host import/export** — batch export and import host configs as JSON (passwords excluded)
- **Custom tab colors** — right-click tab to pick from 8 preset colors, toggleable in settings

### Visual File Management

- FinalShell-style side panel, collapsible
- Dual-panel layout: directory tree + file list, draggable width
- Virtual list rendering for 10k+ files
- SFTP over existing SSH connection
- Upload/download with 32KB chunking + real-time progress
- File operations: mkdir, delete, rename, chmod, text preview
- **File search** — current directory filter and full recursive search modes
- **Scroll position memory** — restores browse position after navigating back
- **Remote file editing** — preview dialog supports edit mode, save back to server

### Snippets

- Side panel for managing common command snippets, searchable and groupable
- Click a snippet to execute in the current terminal; broadcasts to all terminals in broadcast mode
- Hover any snippet chip to reveal edit/delete buttons; right-click menu also available
- Add/edit dialog supports group autocomplete from existing groups

### End-to-End Encrypted Sync

Two sync methods, both E2E encrypted, freely switchable:

| Method | Description | Use Case |
|---|---|---|
| **Self-hosted Server** | HTTP API incremental sync, 3s polling | Real-time multi-device sync |
| **WebDAV** | Full encrypted blob upload, 60s interval | Nutstore/Nextcloud/NAS |

### Other

- **Local-first** — no server required
- **Accent color presets** — 7 colors (default/sky/emerald/violet/amber/rose/cyan), independent dark/light palettes
- **UI density** — compact/standard/relaxed, adjusts title bar/sidebar/spacing
- **Terminal color link** — toggleable, terminal ANSI follows UI accent
- **Feature toggles** — keyword highlight, broadcast, tab colors all toggleable in settings
- **Session logging** — SSH output written to log files in real-time, viewable in settings
- **Multi-language** — Chinese/English, Chinese default on first launch
- **Dark/Light themes** — Abyss / Frost
- **RAF batch merge** — high-frequency events merged via requestAnimationFrame
- **Error debouncing** — classified errors + debounce window
- **ConfigProxy** — config file only stores user-modified values
- **Auto-update** — built-in version checker and updater

## Roadmap

- [x] Encryption (Argon2id + AES-256-GCM)
- [x] Multi-device sync (self-hosted + WebDAV)
- [x] SSH keys
- [x] Dark/Light theme switcher
- [x] SFTP visual file management
- [x] 256-color terminal
- [x] Multi-language (Chinese/English)
- [x] Host groups
- [x] Interactive passwords
- [x] SSH connection multiplexing + Jump Host
- [x] Port forwarding (local/remote) + visual UI
- [x] Flow control + scroll anchoring + virtual list
- [x] Accent colors + terminal color link
- [x] UI density adjustment
- [x] Slide panel UI (Netcatty-style, draggable)
- [x] Tab recovery (SerializeAddon)
- [x] RAF batch + error debounce
- [x] ConfigProxy default value erasure
- [x] Snippet management (groups, search, one-click execute, edit/delete)
- [x] Multi-terminal broadcast mode (batch ops)
- [x] Terminal keyword highlighting (ERROR/WARN/INFO/SUCCESS)
- [x] SSH Agent forwarding (per-host config)
- [x] HTTP/SOCKS5 proxy (per-host config)
- [x] Custom tab colors (8 presets)
- [x] Host config import/export (JSON)
- [x] Remote file editing (preview → edit → save)
- [x] Terminal search (Ctrl+F)
- [x] Session logging + settings viewer
- [x] Unified feature toggles (settings → terminal)
- [ ] Multiple profiles (teams)
- [ ] Shortcuts
- [ ] Android client
- [ ] CLI client

Something missing? Suggest more! [Issues](https://github.com/YCJE/Terminator/issues/new)

## Screenshots

<img src="assets/term-en-white.png" width="1600" alt="Terminator main screen"/>
<img src="assets/term-t-white.png" width="1600" alt="Terminator terminal"/>

## Development

### Prerequisites

1. [**Go**](https://go.dev/dl/) (1.25+)
2. [**Node.js**](https://nodejs.org/en/download/current) (v24+)
3. *Preferrably* [**pnpm**](https://pnpm.io/installation#using-corepack)
4. [**Wails3 CLI**](https://v3.wails.io/getting-started/installation/)

### Build

For development:
```
wails3 dev
```

Debug with [delve](https://github.com/go-delve/delve/tree/master/Documentation/installation):
```sh
dlv debug --headless --listen=:2345 ./backend/cmd/terminator-desktop -- dev
```

Package:
```
wails3 task package
```

### Acknowledgements

Inspired by: [Termius](https://termius.com)

Built on: [Wails](https://v3.wails.io)

Beautiful UI: [shadcn](https://ui.shadcn.com)

---

[中文](./README.md)
