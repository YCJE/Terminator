# Terminator UI & Interaction Guide

> Applies to v0.8.11 and later builds with the refactored interface. This guide covers window structure, information hierarchy, status meanings and common workflows; for the feature list see [README_EN](../README_EN.md).

## Design principles

The interface follows a "Quiet Precision" instrument language rather than a generic dashboard:

- **One accent color**: selection, primary actions and focus rings share a single accent; everything else uses semantic colors (success / warning / danger / neutral).
- **Hairline layering**: 1px translucent dividers and subtle surface steps create hierarchy instead of large rounded cards and heavy shadows.
- **Monospaced micro-labels**: group labels, status bar, endpoints and chips use small monospaced type, so information reads like instrument output.
- **Restrained motion**: hover and switching only animate color and opacity briefly; the OS "reduce motion" preference is respected.
- **Actions live nearby**: session-scoped entries (new tab, file panel, broadcast, status) sit where they are used, not buried in settings.

## Layout overview

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Brand (sidebar width)     Tab strip + new tab       Actions │ Window      │
├──────────────┬───────────────────────────────────────────────────────────┤
│ Workspace     │                                                           │
│  Hosts        │                                                           │
│  Keys         │                 Page content / terminal session              │
│  Port fwd.    │                                                           │
│ Tools         │                                                           │
│  Quick conn.  │                                                           │
│ ...           │                                                           │
│ Status card   ├───────────────────────────────────────────────────────────┤
│               │ State │ Endpoint │ Latency │ Broadcast │ Transfers  SSH/… │
└──────────────┴───────────────────────────────────────────────────────────┘
```

Four layers: title bar (including tabs), left rail, main content, and the terminal status bar. The rail width matches the brand area so a single vertical baseline runs through the window.

## Title bar and tabs

The title bar is 40px tall (scaled by density) and drags the window; buttons and tabs are `no-drag` zones.

| Area | Contents | Notes |
|---|---|---|
| Brand | App icon + Terminator, sidebar toggle | In terminal view, collapsing the rail shrinks the brand area to a 48px icon strip |
| Tab strip | Session tabs, trailing `+` | Tabs scroll horizontally; the active tab scrolls into view with edge fades |
| Actions | Resource panel, split, broadcast, file panel, local terminal, window controls | Grouped as status → layout → tools → window, separated by hairlines |

### Tab interactions

| Action | Result |
|---|---|
| Click | Activate the session |
| Double-click title | Rename in place |
| Drag | Reorder tabs |
| Middle click | Close the tab (confirms first when "confirm before closing" is enabled) |
| Right-click | Menu: rename, duplicate, reconnect, copy SSH command, color, close others / right / current |

The dot on the left of a tab shows connection state. A pulsing dot marks hidden sessions with new output; a green check marks finished commands on inactive tabs. Tab colors require "Settings → Terminal → custom tab colors" to be enabled.

### New-tab menu

Click the trailing `+` (or use the "new tab" action in the command palette):

- **Local terminal**: opens the local PowerShell without SSH.
- **Quick connect**: connect with ad-hoc address and credentials without saving a host.
- **Browse hosts**: open the Hosts page and pick a saved host.

## Sidebar

The rail is split into logical groups plus a status card:

- **Workspace**: Hosts, Keys, Port forwarding.
- **Tools**: Quick connect (one-off connection that is not saved).
- **Footer**: update check (only when an update is available), Settings, vault & sync status card.

The status card subtitle prioritizes:

1. "N conflicts pending" when unresolved sync conflicts exist; clicking jumps to Settings → Sync.
2. Otherwise the sync state: local mode / syncing / synced / sync error.
3. The dot follows the state: grey idle, blue syncing, green success, red failure.

In terminal view the rail can be collapsed from the title bar; the Settings page hides the main rail and uses its own category navigation (the back button in its header returns to the page you came from); other pages always show the rail.

## Workspace

### Empty state

With no sessions, the workspace shows a guide instead of a blank canvas:

- **Quick connect** (primary)
- **Browse hosts**
- **Local terminal**

A hint at the bottom points to the `Ctrl+Shift+P` command palette.

### Bottom status bar

The status bar appears only when a session exists and summarizes current session facts:

| Segment | Meaning |
|---|---|
| Connection state | Connected / connecting / disconnected, colored success / warning / danger |
| Endpoint | `user@host:port`; the local terminal shows its name; long values truncate with a tooltip |
| Latency | SSH sessions only, sampled every 10s; failures show a placeholder |
| Broadcast | Shown in warning color when broadcast mode is on |
| Transfers | Number of active SFTP transfers for this session; clicking toggles the file panel |
| Right side | `SSH` / `LOCAL` and `UTF-8` |

### Terminal overlay buttons

Two floating buttons sit at the bottom-right of the terminal column:

- **Compose bar** (`Ctrl+Shift+U`): edit multi-line commands before sending.
- **Snippets**: run grouped snippets.

They are anchored inside the terminal column, so they never cover the SFTP list; when the compose bar opens they move up automatically.

### Split panes

- `Ctrl+Shift+D`: side-by-side.
- `Ctrl+Shift+E`: stacked.
- Drag the divider to resize; each side keeps at least 18%.
- A "close split" button appears in the title bar; the split stays bound to its tabs and comes back when you return.

## Pages

### Hosts

```text
[ Search (name / address / username / group)         Connect now ]
[ New host ⌄ ] [ Local terminal ]

Recent     [host A] [host B] ...
Groups     [group chips + counts] ...

Hosts      [ card grid ]
```

- **Search** filters as you type; "Connect now" enables once a card is selected.
- **New host**: the main button opens the create panel; the caret menu offers import hosts, export hosts and import from `~/.ssh/config`.
- **Recent**: up to six hosts, one click to connect; stored locally and never synced.
- **Group chips**: click to filter, click again to clear; the count is the number of hosts in that group.
- **Host cards**: name + endpoint + a group tag on the right. Click opens details, double-click connects, right-click shows connect / edit / delete.
- **Details panel**: address, port, authentication, jump host, proxy, agent forwarding, run-on-connect; footer actions Connect and Save.

### Keys

- The toolbar contains only New key and Search, matching the Hosts page rhythm.
- Cards show the key name and inferred type (Ed25519 / RSA / ECDSA, etc.).
- Click a card to edit in the side panel; right-click to edit or delete.
- Saving applies immediately to every host that references the key.

### Port forwarding

- The list is grouped under "Forwarding rules"; rows show a type icon, local → remote address, source session and state.
- "Add forwarding" requires at least one connected, non-local SSH session; otherwise the button is disabled with an explanation.
- The create panel uses a segmented control for local / remote forwarding with an inline description of the traffic direction.
- Deletion is optimistic: the row disappears first, then the backend call runs; failures restore the row.

### Settings

Settings takes the full content area: the main rail is hidden and the title-bar brand area matches the settings navigation width; at narrow window sizes, row labels and controls stack vertically and segmented controls wrap as a whole.

| Group | Category | Highlights |
|---|---|---|
| Preferences | Appearance | Dark/light theme, skin, language, accent color, density, terminal color link |
| Preferences | Terminal | Font, size, line height, cursor style/blink, scrollback, close confirmation, copy-on-select, keyword highlight, broadcast, tab colors, multi-line paste protection, auto reconnect, SFTP follow cwd, workspace restore, completion notifications, snapshots, session logs |
| Preferences | Shortcuts | Editable actions plus fixed shortcuts; recording, conflict detection, per-item/all reset |
| Data & security | Sync | Account, server sync, WebDAV, conflict panel |
| Data & security | Security | Lock vault, auto-lock, wipe vault, known hosts, encrypted backup |
| Data & security | System | Launch at login, close to tray, clear recent hosts |
| — | About | Check for updates, download & verify installer, open release page |

## Overlays and panels

| Component | Behavior |
|---|---|
| Slide-in panel | Create/edit hosts, keys and forwards; title + endpoint subtitle, fixed footer actions |
| Command palette | `Ctrl+Shift+P`; Hosts / Snippets / Actions groups; arrows to move, Enter to run, Esc to close |
| Quick connect | Entry from the rail or empty state; connects immediately without saving |
| Confirmation dialogs | Destructive actions such as deleting hosts/keys, overwriting downloads, closing connected tabs, wiping the vault |
| Toasts | Bottom-right above the status bar; success and failure never cover status information |

## Status and color semantics

| Visual | Meaning |
|---|---|
| Green dot / text | SSH connected, forwarding active, sync succeeded |
| Yellow / warning | Connecting, broadcast mode, high latency |
| Blue | Sync in progress, informational |
| Red / danger | Disconnected, sync failure, transfer failure, conflict banner |
| Grey | Local mode, idle, unknown, no session |
| Pulsing tab dot | Hidden tab has new terminal output |
| Green check on tab | Command finished on an inactive tab |

## Keyboard shortcuts

Shortcuts marked with * are editable in Settings → Shortcuts; fixed ones are not.

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+P` * | Command palette |
| `Ctrl+F` * | In-terminal search |
| `Ctrl+Shift+D` * | Side-by-side split |
| `Ctrl+Shift+E` * | Stacked split |
| `Ctrl+Shift+U` * | Compose bar |
| `Ctrl+Shift+C` | Copy terminal selection |
| `Ctrl+Shift+V` | Paste into terminal |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle tabs |
| `Ctrl+PageUp` / `Ctrl+PageDown` | Previous / next tab |
| `Ctrl+wheel` | Adjust terminal font size |
| `Esc` | Close terminal search / overlays |
| `Enter` | Activate the focused tab |

## Personalization

- **Theme**: dark / light.
- **Skins**: Default, HUD Tactical (always dark, instrument-like), Editorial (always light, paper-like). A skin overrides the light/dark semantics.
- **Accent colors**: default, sky, emerald, violet, amber, rose, cyan.
- **Density**: compact / standard / loose, scaling the title bar, tabs, rail, row heights and status bar.
- All preferences persist across restarts.

## Common workflows

1. **First launch**: create a local vault or connect a cloud account, then enter the workspace.
2. **Connect a host**: double-click a card; or `Ctrl+Shift+P` and search a host; or quick connect.
3. **Open a local terminal**: `+` → Local terminal, or the terminal icon in the title bar.
4. **Open SFTP**: folder button in the title bar, or click the transfer count in the status bar.
5. **Broadcast**: enable the feature in Settings, then toggle the broadcast button in the title bar; input goes to every active session.
6. **Session logs**: Settings → Terminal → Session logs; enable recording, choose retention, then search, preview and export in the same card.
7. **Resolve sync conflicts**: click the rail status card or the top banner → Settings → Sync → choose keep local / keep remote per entry.
8. **Lock the vault**: Settings → Security → Lock vault, or the "lock vault" action in the command palette. Locking clears in-memory credentials and disconnects all sessions.

## Accessibility and details

- Every interactive element has a `focus-visible` ring; Tab traverses and Enter activates.
- Hover-only row actions also appear on keyboard focus and ignore pointer events while hidden.
- Long text truncates and exposes the full value via `title`; the status bar endpoint has its own width cap so right-side attributes are never pushed out.
- Respects the OS "reduce motion" setting: scrolling and transitions complete instantly.
- Color is always paired with text or an icon (connection, sync, transfer states); nothing relies on color alone.

## Implementation notes (developers)

- Design tokens live in `frontend/src/assets/main.css`: surfaces, foregrounds, hairlines, density, motion and status-bar height.
- Shell components: `layout/Sidebar.tsx`, `layout/TitleBar.tsx`, `layout/StatusBar.tsx`, `terminal/TerminalStack.tsx`.
- Pages and panels: `views/HostsPage.tsx`, `views/KeysPage.tsx`, `views/PortForwardingPage.tsx`, `views/SettingsPage.tsx`, `ui/slide-panel.tsx`.
- New UI strings must be added to both `frontend/public/locales/zh` and `en`, then validated with `npm run check:i18n`.
- Before committing, run: `npx tsc --noEmit -p tsconfig.json`, `npm run check:i18n`, `npm run build`.
