# Terminator Desktop — Security Review Report

**Scope:** `terminator-desktop-0.3.1` (Go backend + React/TypeScript frontend)
**Date:** 2026-07-05
**Reviewer:** Automated security best-practices review

## Executive Summary

The codebase uses a sound cryptographic foundation (Argon2id key derivation + AES-256-GCM authenticated encryption) and an E2E-encrypted sync model where data is encrypted *before* it leaves the client. **No backdoor, telemetry, or data-exfiltration code was found.** Outbound network calls are limited to (1) a user-configured sync server and (2) the official GitHub releases URL for updates.

One **critical** vulnerability was found and fixed: SSH connections did not verify host keys, exposing every session to man-in-the-middle attacks. Two lower-severity issues are noted below.

---

## Findings

### CRITICAL-1: SSH host key verification disabled (MITM vulnerability)

**Location:** `backend/internal/services/ssh/ssh.go` (original line 68)
**Status:** FIXED in this revision

The original code used `ssh.InsecureIgnoreHostKey()` as the `HostKeyCallback`, with a `// TODO proper host key handling` comment. This means the client accepted **any** SSH server public key without verification. An attacker positioned between the user and the SSH server (e.g. on the same network, a malicious Wi-Fi, or a compromised router) could transparently intercept, decrypt, and relay the entire SSH session — including passwords and private-key authenticated sessions — without the user ever being alerted.

**Fix applied:** Replaced with a **Trust-On-First-Use (TOFU)** verifier. The first connection to a `host:port` records the server's public key to a `known_hosts` file (`%USERCONFIGDIR%/Terminator/known_hosts`). Every subsequent connection compares the presented key against the pinned record; a mismatch is rejected with a clear "possible man-in-the-middle" error. This is the standard secure behavior for interactive SSH clients (same model as OpenSSH's `StrictHostKeyChecking=accept-new`).

### LOW-1: Aggressive default auto-sync interval

**Location:** `backend/internal/services/sync/sync.go` (line 53) + `loop.go`
**Status:** Noted (not a security bug)

The sync service polls the server every **3 seconds** by default. This is unusually aggressive and has two minor downsides:
- Privacy/battery: the client contacts the sync server far more often than necessary for a typical SSH-credential store.
- It amplifies any server-side rate-limiting or logging.

Not a vulnerability, but consider raising the default to 30–60s. The interval is already configurable via the `syncInterval` constructor parameter.

### LOW-2: No local brute-force throttling on master password

**Location:** `backend/internal/services/auth/auth.go` (`Login`)

The vault unlock flow has no rate-limiting or lockout on repeated wrong master passwords. Argon2id (time cost 3, 128 MB memory) makes each guess expensive, which provides meaningful mitigation, but a dedicated offline attacker with the local SQLite DB can still brute-force without any throttle. This is acceptable for a local-first app (the DB is the asset, and Argon2id is the right defense), but a short constant-time delay on failed `Login` attempts would add defense-in-depth.

---

## What was checked and found clean

| Area | Files reviewed | Result |
|---|---|---|
| Crypto primitives | `internal/crypto/crypto.go` | Argon2id + AES-256-GCM, random IV from `crypto/rand`, version byte, correct tag handling. Sound. |
| Key management | `internal/vault/vault.go` | Keys held in memory, cleared on `Lock()` via `clear()`. Concurrency-safe with RWMutex. |
| Authentication | `internal/services/auth/auth.go` | Master key generated with `crypto/rand`; KEK derived from password; login key derived separately. No plaintext password stored. |
| Blob storage | `internal/services/blob/store.go` | All items encrypted with master key before persistence. Soft-delete for sync. |
| API client | `internal/api/client.go` | Uses standard `net/http` with TLS verification (default). Bearer token auth. 15s timeout. |
| Sync | `internal/services/sync/sync.go` | E2E encrypted; only encrypted blobs transit the network. Token cleared on 401. |
| Updater | `internal/services/updater/updater.go` | Checks the official GitHub releases URL only (`https://github.com/terminator-ssh/terminator-desktop/releases/`). |
| Main / startup | `backend/cmd/terminator-desktop/main.go` | No hidden network calls, no telemetry, no hardcoded credentials. |
| Frontend | `lib/defaultServer.ts`, `App.tsx`, `LockScreen.tsx` | Default server is `terminator.sh` (the project's own domain) and is user-changeable. No external analytics scripts. |

**Backdoor conclusion:** No evidence of backdoors, hidden credentials, data exfiltration, or unauthorized network communication was found anywhere in the reviewed code.
