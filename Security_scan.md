# ContextForge — Security Scan Report

**Date:** 2026-08-17 (updated 2026-08-18)
**Scope:** Full project source at `/Users/Vikas.Rai/src/contextforge` (application/source code and build scripts). Vendored dependencies and build artifacts (`node_modules/`, `dist/`, `release/`, `bundle/`, `*.vsix`, compiled binaries) were excluded.
**Method:** Static security review of the source tree — SQLite/knowledge-graph query layer, MCP server, VS Code extension, and build/model scripts.

> **2026-08-18 update:** The centralized-database (Phase 2) code was removed — `packages/server` (standalone auth/routes/config server) and `packages/core/src/sync` (network sync client) no longer exist. Findings and reviewed areas that referenced those components are annotated below as **no longer applicable (code removed)**. ContextForge is now local-only (on-machine SQLite) with file-level backup sync via `scripts/contextforge-backup.sh`.

---

## Summary

| # | Severity | File | Lines | Vulnerability | Confidence |
|---|----------|------|-------|---------------|------------|
| 1 | ⚫ N/A | `packages/server/*` (removed) | — | Insecure server defaults (bind `0.0.0.0` + auth off) — **✅ FIXED 2026-08-17; ⚫ NO LONGER APPLICABLE 2026-08-18 (server package removed)** | 8/10 |
| 2 | ⚪ LOW | `packages/vscode-extension/src/inbox.ts` | 53-56, 69 | Potential path traversal: unsanitized `sessionId` used to build the inbox file path — **✅ FIXED 2026-08-17** | 5/10 |

---

## Findings

### 1. ⚫ N/A — Insecure server defaults (bind-all + auth disabled) — code removed

> **⚫ NO LONGER APPLICABLE (2026-08-18):** The entire `packages/server` central prompt-sync server was removed when the Phase 2 centralized-database design was dropped. There is no longer any network-facing server or listener in the codebase, so this finding is moot. The details below are retained for historical record only (the issue was also already fixed on 2026-08-17 before removal).

- **Files (removed):**
  - `packages/server/src/config.ts:49-55`
  - `packages/server/src/auth.ts:29-33`
  - `packages/server/src/index.ts:11`
- **Category:** Security Misconfiguration / Authentication Failure
- **Confidence:** 8/10

**Problem:**
The central prompt-sync server ships with two insecure defaults that combine dangerously:
- `host` defaults to `0.0.0.0` (binds all network interfaces).
- `apiKey` defaults to `null`. When `apiKey` is null, `apiKeyAuth()` calls `next()` for every request (open mode).

A server started with no environment configuration therefore listens on **all interfaces** with **no authentication**, exposing:
- `POST /prompts` — anyone on the network can inject/write prompt-usage records.
- `GET /prompts/top` — anyone can read back stored prompt content from all clients.

Stored prompt content can contain sensitive internal/business context even after redaction. The only current guard is a single startup `console.warn`.

**Evidence:**
- `loadConfig()` returns `host: env.CONTEXTFORGE_SERVER_HOST || '0.0.0.0'` and `apiKey: env.CONTEXTFORGE_API_KEY || null`.
- `index.ts` calls `app.listen(config.port, config.host)`.
- `apiKeyAuth(null)` unconditionally calls `next()`.
- The `/prompts` router performs no per-client authorization.

**Suggested fix:**
Default `host` to `127.0.0.1` (require explicit opt-in to bind `0.0.0.0`), and/or refuse to bind a non-loopback interface when `apiKey` is unset (fail closed instead of warn-and-continue).

**✅ Remediation applied (2026-08-17):**
- `config.ts` — default `host` changed from `0.0.0.0` to `127.0.0.1` (loopback). Docs/comments updated.
- `index.ts` — added a fail-closed guard: the server now refuses to start (exit 1) when bound to a non-loopback host with no `CONTEXTFORGE_API_KEY` set.
- Verified: exposed host without key → refuses (exit 1); default host → starts on `127.0.0.1`; `0.0.0.0` + API key → starts. Server typecheck + all 15 tests pass. No impact on core memory/MCP or the opt-in sync client.


### 2. ⚪ LOW — Potential path traversal via unsanitized `sessionId` (defense-in-depth)

- **File:** `packages/vscode-extension/src/inbox.ts:53-56, 69`
- **Category:** Broken Access Control (path traversal)
- **Confidence:** 5/10

**Problem:**
`writeToInbox()` builds `filename = ${entry.sessionId}.json` and `path.join(INBOX_DIR, filename)` with no sanitization of `sessionId`. `sessionId` originates from `parseSessionFile()`, which reads it from the `sessionId` field of VS Code Copilot Chat `.jsonl` logs. If that value contained `../` sequences, the write could escape the inbox directory (arbitrary `.json` file write).

**Evidence:**
`sessionId = (v.sessionId as string)` in `sessionParser.ts` flows unvalidated into `path.join`. In practice VS Code generates `sessionId` as a GUID and the JSONL files live in the user's own workspace storage, so exploitation requires an attacker to already have local write access to that directory — hence low confidence. Reported only as defense-in-depth.

**Suggested fix:**
Validate/normalize `sessionId` (e.g. reject anything not matching `^[A-Za-z0-9._-]+$`, or use `path.basename`) before building the file path.

**✅ Remediation applied (2026-08-17):**
- `inbox.ts` — added a `safeSessionId()` sanitizer that strips any character outside `[A-Za-z0-9._-]` and rejects empty/`.`/`..`. Applied it in `writeToInbox`, `isAlreadyProcessed`, and `markProcessed`, using the sanitized value for both the filename and the processed-cache/log key (kept consistent).
- Defense at the filesystem sink, so it protects regardless of caller. The `capture.ts` per-session loop already wraps processing in try/catch, so a rejected malicious `sessionId` is logged and skipped without aborting the capture pass.
- Verified at runtime: legitimate GUID and `manual-<ts>` IDs pass through byte-for-byte unchanged; a `../../` traversal payload stays confined to the inbox dir (no file escaped); empty/`.`/`..`/`/` inputs are rejected. Extension typecheck passes.


## Areas Reviewed and Found Clean

- **SQLite / knowledge-graph query layer** (`db/database.ts`): No SQL injection. Every query uses `?`/`@named` bound parameters. Dynamically assembled `WHERE`/filter clauses concatenate only static column-comparison fragments (`e.type = ?`, etc.) and `?`-placeholder strings for `IN (...)`; all user values go through `.run()/.all()/.get()` parameters. FTS5 `MATCH` queries are also parameterized (and `replace(/['"*]/g,' ')` is applied to entity-name FTS input).
- **Network / outbound:** ⚫ No longer applicable (2026-08-18) — the outbound sync client (`sync/syncClient.ts`) was removed. ContextForge no longer makes any outbound network calls of its own; the only external calls come from the optional, read-only Rally MCP bridge (URL from trusted local env, no attacker-controlled host).
- **Crypto**: `auth.ts` (removed with the server package) previously used `timingSafeEqual` with a length pre-check. No weak-crypto issues remain in security-sensitive paths.
- **Build / model scripts** (`build.js`, `download-model.js`, `copy-model.js`, `fetch-native-deps.js`, `prepare-server.js`): All `fs.rmSync`/`fs.cpSync`/`execSync` operate on static paths or local CLI-arg/env values (dev tooling). `execSync` commands interpolate only pinned versions and CLI-provided platform/arch tokens; no web-facing untrusted input. Dependency versions are pinned (`sqlite-vec@0.1.9`, `@yao-pkg/pkg@5.15.0`).
- **MCP server** (`server/mcp.ts`) **& codebase indexer**: File reads are driven by the local agent's `workspace`/`pathPrefix` tool arguments and execute with the invoking user's own permissions over stdio (no privilege boundary crossed). No `child_process`, `eval`, or dynamic `require` on tool input.
- **Extension setup** (`setup.ts`): Writes MCP registration/instructions to fixed paths under the user profile; no untrusted path or command construction.
- **Secrets**: No hardcoded credentials or secret logging found in the reviewed source.


## Recommended Priority

1. **Finding #1 (server defaults)** — ⚫ No longer applicable; the `packages/server` code was removed on 2026-08-18. No action needed.
2. **Finding #2 (LOW)** — Already fixed; `sessionId` validation is in place as defense-in-depth.
