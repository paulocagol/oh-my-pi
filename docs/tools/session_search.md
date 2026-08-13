# session_search

> Full-text search over the message content of past sessions.

## Source
- Entry: `packages/coding-agent/src/tools/session-search.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/session-search.md`
- Index: `packages/coding-agent/src/session/session-search-index.ts`
- Write hook: `SessionManager.appendMessage` → `#indexForSearch` (`packages/coding-agent/src/session/session-manager.ts`)
- Database path: `getSessionSearchDbPath` (`packages/utils/src/dirs.ts`)

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "discoverable"`. With `tools.xdev` on it mounts under `xd://session_search` rather than shipping its schema every request.
- Registration requires `sessionSearch.enabled = true` (default `true`). The same flag gates the write side: turning it off stops indexing as well as exposing the tool.
- Available at any task depth; subagents may use it like any other read tool.
- Execution is single-shot and emits no progress updates.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `query` | `string` | No | Full-text query. Present ⇒ discovery mode. |
| `sessionId` | `string` | No | Session to read. Present without `query` ⇒ scroll mode. |
| `aroundEntryId` | `string` | No | Session entry to centre the scroll window on. Ignored without `sessionId`. |
| `window` | `number` | No | Messages read either side of the scroll anchor. Default `10`, clamped to `1..50`. |

There is no `mode` parameter: the mode is inferred from which arguments are present.

## Outputs
- Discovery: `details = { mode: "discovery", query, sessions }`. Text lists at most 5 sessions, each with the best-ranked match (`role`, `entry <id>`, FTS excerpt), a ±5-message window around it, and the session's bookends.
- Scroll with an anchor: `details = { mode: "scroll", sessionId, aroundEntryId, messages }`. Text lists the window in session order, each line prefixed `<role> entry <id>:`.
- Scroll without an anchor: `details = { mode: "scroll", sessionId, messages }`. Text lists the session's first and last messages only.
- Browse: `details = { mode: "browse", sessions }`. Text lists up to 20 indexed sessions, most recently active first, with message count, last-activity timestamp, and the session's first user message.
- Empty results are normal results, never `isError`.

## Flow
1. `SessionSearchTool.createIf(...)` exposes the tool only when `sessionSearch.enabled` is true.
2. `execute` opens the `SessionSearchIndex` singleton and awaits `flush()` so writes queued by the current turn are visible.
3. `query` present → `searchDiscovery(query, 5)`: the query is tokenized like FTS5's `unicode61` tokenizer, each token becomes a prefix term, rows come back ordered by BM25 `rank`, and the first hit per `session_id` wins (over-fetch factor 8, capped at 400 rows scanned).
4. `sessionId` + `aroundEntryId` → `getScrollWindow(...)`: the entry id resolves to an index row id, then the window is taken by session-local position.
5. `sessionId` alone → `getBookends(...)`: first 3 and last 3 messages, with no overlap when the session is shorter than 6.
6. No arguments → `listRecentSessions(20)`: one grouped query over `messages`, ordered by newest row id.

## Modes / Variants
- **Discovery** (`query`): find a session by subject. One result per session, so a single long conversation cannot crowd out the rest.
- **Scroll** (`sessionId` + `aroundEntryId`): page through a session after discovery. Re-anchor on the first or last returned entry to keep moving in that direction; windows overlap by the anchor itself.
- **Browse** (no arguments): chronological list when there is nothing specific to search for.

## Side Effects
- Filesystem: reads (and, via `SessionManager`, writes) `<agent-dir>/session-search.db` — a WAL-mode SQLite database with a `messages` table and an external-content FTS5 index `messages_fts`. Default agent directory is `~/.omp/agent`.
- Network: none.
- Session state: none. The tool is read-only with respect to the current session.
- Background work: none from the tool. Indexing happens on the append path through a 100 ms `AsyncDrain` batch.

## Limits & Caps
- Discovery returns at most 5 sessions; browse at most 20; scroll window is clamped to `1..50` per side.
- Rendered message text is collapsed to one line and clipped at 400 characters.
- Only `user` and `assistant` messages are indexed. Tool results, custom, hook, bash and python execution messages are skipped.
- Only persisted sessions are indexed; in-memory managers contribute nothing.
- Coverage starts when the setting is first enabled — there is no backfill of older `session.jsonl` files.

## Errors
- An unindexed `aroundEntryId` returns a normal result with `messages: 0`, not an error.
- A query with no alphanumeric tokens returns no sessions.
- A malformed FTS expression is logged at debug level and returns no sessions.
- Index failures on the write path are logged and swallowed: indexing must never fail a persisted turn.

## Notes
- Distinct from prompt history (`packages/coding-agent/src/session/history-storage.ts`), which indexes typed prompts in `history.db`. Different table, different database, different consumer.
- Search is 100% deterministic BM25; no model is called at any point.
- Absence of a hit is not proof the work never happened — the session may predate indexing.
