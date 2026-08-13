Full-text search over the message content of your own past sessions (BM25, deterministic, no model call).

Use to recover prior work: how a problem was solved before, what was decided and why, which approach already failed. Complements memory recall — this reads the actual transcript, not a summary.

Mode is inferred from the arguments; there is no mode parameter.

- `query` → **discovery**. Best match per session (never several hits from one conversation), each with the matching excerpt, the messages around it, and the session's first/last messages. Start here when you know the subject but not the session.
- `sessionId` + `aroundEntryId` → **scroll**. Reads `window` messages either side of that entry. Re-issue anchored on the first or last entry of the result to keep paging in that direction. Use after discovery to read more of a session that looked right.
- `sessionId` alone → the session's first and last messages, to judge it before scrolling.
- no arguments → **browse**. Recent sessions, newest first. Use when you do not yet know what to search for.

Indexing covers `user` and `assistant` text only, from the point the index was enabled — an older or tool-only session may be absent. Absence is not proof the work never happened.
