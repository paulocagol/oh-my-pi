import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { AsyncDrain, getDbBusyTimeoutMs, getSessionSearchDbPath, logger } from "@oh-my-pi/pi-utils";

/** One indexed message of a past session. */
export interface MessageRow {
	/** Monotonic index-local row id; orders messages within a session. */
	id: number;
	sessionId: string;
	role: string;
	text: string;
	/** Session-entry id the message was persisted under; the scroll anchor. */
	entryId?: string;
	createdAt: number;
}

/** First and last messages of a session — enough to tell what it was about. */
export interface SessionBookends {
	start: MessageRow[];
	end: MessageRow[];
}

/** One session that matched a discovery query, with orientation context. */
export interface SessionSearchHit {
	sessionId: string;
	/** Best-ranked matching message in this session. */
	match: MessageRow;
	/** FTS excerpt around the matched terms. */
	snippet: string;
	/** Messages surrounding {@link match}, inclusive of it, in session order. */
	window: MessageRow[];
	bookends: SessionBookends;
}

/** A session present in the index, for chronological browsing. */
export interface RecentIndexedSession {
	sessionId: string;
	messageCount: number;
	/** Epoch seconds of the newest indexed message. */
	lastActivityAt: number;
	/** First user message of the session, when it has one. */
	preview?: string;
}

interface PendingRow {
	sessionId: string;
	role: string;
	text: string;
	entryId?: string;
}

type StoredRow = {
	id: number;
	session_id: string;
	role: string;
	text: string;
	entry_id: string | null;
	created_at: number;
};

type StoredRowWithSnippet = StoredRow & { snippet: string };

type RecentRow = {
	session_id: string;
	message_count: number;
	last_activity_at: number;
	preview: string | null;
};

const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

/**
 * How many FTS rows to pull per requested session. Discovery keeps one hit per
 * session, so a query whose top matches all come from one long conversation
 * would otherwise return a single result; over-fetching gives the dedupe room
 * to reach further down the ranking before it runs out of rows.
 */
const DISCOVERY_OVERSCAN = 8;
const DISCOVERY_MAX_SCAN = 400;
/** Messages kept on each side of a session's bookends. */
const BOOKEND_SIZE = 3;

/**
 * Full-text index over the *content* of past session messages.
 *
 * Distinct from `HistoryStorage`, which indexes typed prompts (the shell-style
 * command history) in its own database:
 * different rows, different lifetime, different consumer. This one is written
 * incrementally by `SessionManager.appendMessage` and read by the
 * `session_search` tool.
 *
 * Only `user` and `assistant` text is stored. Tool results are excluded at the
 * call site: they dominate a transcript by volume and bury the conversation
 * that makes a session findable.
 */
export class SessionSearchIndex {
	#db: Database;
	static #instance?: SessionSearchIndex;
	#drain = new AsyncDrain<PendingRow>(100);
	/** Resolves when every queued write has landed; see {@link flush}. */
	#pending: Promise<void> = Promise.resolve();

	#insertRowStmt: Statement;
	#searchStmt: Statement;
	#beforeStmt: Statement;
	#fromStmt: Statement;
	#anchorStmt: Statement;
	#bookendStartStmt: Statement;
	#bookendEndStmt: Statement;
	#recentStmt: Statement;

	private constructor(dbPath: string) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });

		this.#db = new Database(dbPath);
		// Install the busy handler before any lock-taking statement, as
		// HistoryStorage does: a contended index must not stall the caller.
		this.#db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
		this.#db.run(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	session_id TEXT NOT NULL,
	role TEXT NOT NULL,
	text TEXT NOT NULL,
	entry_id TEXT,
	created_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
	INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
	END;
	`);

		this.#insertRowStmt = this.#db.prepare(
			"INSERT INTO messages (session_id, role, text, entry_id) VALUES (?, ?, ?, ?)",
		);
		// `messages_fts` is not aliased: snippet()'s first argument must name the
		// FTS table itself, and bare `rank` (BM25) is unambiguous with one FTS
		// table in scope.
		this.#searchStmt = this.#db.prepare(`
SELECT m.id, m.session_id, m.role, m.text, m.entry_id, m.created_at,
	snippet(messages_fts, 0, '', '', '…', 24) AS snippet
FROM messages_fts
JOIN messages m ON m.id = messages_fts.rowid
WHERE messages_fts MATCH ?
ORDER BY rank, m.id DESC
LIMIT ?`);
		// Windows page by session-local position, never by raw id arithmetic:
		// ids are global, so concurrent sessions interleave them and an
		// `id BETWEEN anchor - n AND anchor + n` range would silently return
		// fewer rows the busier the machine was.
		this.#beforeStmt = this.#db.prepare(
			"SELECT id, session_id, role, text, entry_id, created_at FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
		);
		this.#fromStmt = this.#db.prepare(
			"SELECT id, session_id, role, text, entry_id, created_at FROM messages WHERE session_id = ? AND id >= ? ORDER BY id ASC LIMIT ?",
		);
		this.#anchorStmt = this.#db.prepare("SELECT id FROM messages WHERE session_id = ? AND entry_id = ? LIMIT 1");
		this.#bookendStartStmt = this.#db.prepare(
			"SELECT id, session_id, role, text, entry_id, created_at FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT ?",
		);
		this.#bookendEndStmt = this.#db.prepare(
			"SELECT id, session_id, role, text, entry_id, created_at FROM messages WHERE session_id = ? AND id > ? ORDER BY id DESC LIMIT ?",
		);
		this.#recentStmt = this.#db.prepare(`
SELECT session_id,
	COUNT(*) AS message_count,
	MAX(created_at) AS last_activity_at,
	(SELECT text FROM messages inner_m
		WHERE inner_m.session_id = m.session_id AND inner_m.role = 'user'
		ORDER BY inner_m.id ASC LIMIT 1) AS preview
FROM messages m
GROUP BY session_id
ORDER BY MAX(id) DESC
LIMIT ?`);
	}

	static open(dbPath: string = getSessionSearchDbPath()): SessionSearchIndex {
		if (!SessionSearchIndex.#instance) {
			SessionSearchIndex.#instance = new SessionSearchIndex(dbPath);
		}
		return SessionSearchIndex.#instance;
	}

	/** @internal Reset the singleton and close its database — test-only. */
	static resetInstance(): void {
		const instance = SessionSearchIndex.#instance;
		SessionSearchIndex.#instance = undefined;
		if (instance) instance.#close();
	}

	#close(): void {
		this.#insertRowStmt.finalize();
		this.#searchStmt.finalize();
		this.#beforeStmt.finalize();
		this.#fromStmt.finalize();
		this.#anchorStmt.finalize();
		this.#bookendStartStmt.finalize();
		this.#bookendEndStmt.finalize();
		this.#recentStmt.finalize();
		this.#db.close();
	}

	/**
	 * Queue one message for indexing. Never blocks and never throws: the caller
	 * is the session append path, where a search index must not be able to fail
	 * a persisted turn.
	 */
	indexMessage(sessionId: string, role: string, text: string, entryId: string | undefined): void {
		const trimmed = text.trim();
		if (!sessionId || !trimmed) return;
		this.#pending = this.#drain
			.push({ sessionId, role, text: trimmed, entryId }, rows => this.#insertBatch(rows))
			.catch(error => {
				logger.error("SessionSearchIndex insert failed", { error: String(error) });
			});
	}

	/** Resolves once queued {@link indexMessage} writes have landed. */
	flush(): Promise<void> {
		return this.#pending;
	}

	#insertBatch(rows: PendingRow[]): void {
		this.#db.transaction((batch: PendingRow[]) => {
			for (const row of batch) {
				this.#insertRowStmt.run(row.sessionId, row.role, row.text, row.entryId ?? null);
			}
		})(rows);
	}

	/**
	 * Sessions whose message content matches `query`, best match first, at most
	 * one entry per session. Each hit carries the matched excerpt, the messages
	 * around it, and the session's bookends — enough to judge relevance without
	 * loading the transcript.
	 */
	searchDiscovery(query: string, limit: number, windowSize = 5): SessionSearchHit[] {
		const safeLimit = SessionSearchIndex.#normalizeLimit(limit);
		if (safeLimit === 0) return [];

		const tokens = SessionSearchIndex.#tokenize(query);
		if (tokens.length === 0) return [];
		const ftsQuery = tokens.map(token => `"${token.replace(/"/g, '""')}"*`).join(" ");

		let rows: StoredRowWithSnippet[];
		try {
			rows = this.#searchStmt.all(
				ftsQuery,
				Math.min(safeLimit * DISCOVERY_OVERSCAN, DISCOVERY_MAX_SCAN),
			) as StoredRowWithSnippet[];
		} catch (error) {
			logger.debug("SessionSearchIndex FTS query failed", { error: String(error) });
			return [];
		}

		const hits: SessionSearchHit[] = [];
		const seen = new Set<string>();
		for (const row of rows) {
			if (seen.has(row.session_id)) continue;
			seen.add(row.session_id);
			const match = SessionSearchIndex.#toMessage(row);
			hits.push({
				sessionId: row.session_id,
				match,
				snippet: row.snippet || match.text,
				window: this.#windowAround(row.session_id, row.id, windowSize),
				bookends: this.getBookends(row.session_id),
			});
			if (hits.length === safeLimit) break;
		}
		return hits;
	}

	/**
	 * The session's first and last {@link BOOKEND_SIZE} messages. Short sessions
	 * yield fewer: `end` never repeats a message already in `start`.
	 */
	getBookends(sessionId: string): SessionBookends {
		const start = (this.#bookendStartStmt.all(sessionId, BOOKEND_SIZE) as StoredRow[]).map(
			SessionSearchIndex.#toMessage,
		);
		const lastStartId = start.at(-1)?.id ?? 0;
		const end = (this.#bookendEndStmt.all(sessionId, lastStartId, BOOKEND_SIZE) as StoredRow[]).map(
			SessionSearchIndex.#toMessage,
		);
		end.reverse();
		return { start, end };
	}

	/**
	 * Up to `windowSize` messages before and after the message persisted under
	 * `anchorEntryId`, the anchor included. Re-anchoring on the first or last
	 * returned entry pages further in that direction. Empty when the anchor is
	 * not indexed.
	 */
	getScrollWindow(sessionId: string, anchorEntryId: string, windowSize: number): MessageRow[] {
		const size = SessionSearchIndex.#normalizeLimit(windowSize);
		const anchor = this.#anchorStmt.get(sessionId, anchorEntryId) as { id: number } | undefined;
		if (!anchor) return [];
		return this.#windowAround(sessionId, anchor.id, size);
	}

	/** Sessions present in the index, most recently active first. */
	listRecentSessions(limit: number): RecentIndexedSession[] {
		const safeLimit = SessionSearchIndex.#normalizeLimit(limit);
		if (safeLimit === 0) return [];
		const rows = this.#recentStmt.all(safeLimit) as RecentRow[];
		return rows.map(row => ({
			sessionId: row.session_id,
			messageCount: row.message_count,
			lastActivityAt: row.last_activity_at,
			preview: row.preview ?? undefined,
		}));
	}

	#windowAround(sessionId: string, anchorId: number, windowSize: number): MessageRow[] {
		const before = (this.#beforeStmt.all(sessionId, anchorId, windowSize) as StoredRow[]).map(
			SessionSearchIndex.#toMessage,
		);
		before.reverse();
		const fromAnchor = (this.#fromStmt.all(sessionId, anchorId, windowSize + 1) as StoredRow[]).map(
			SessionSearchIndex.#toMessage,
		);
		return [...before, ...fromAnchor];
	}

	static #toMessage(row: StoredRow): MessageRow {
		return {
			id: row.id,
			sessionId: row.session_id,
			role: row.role,
			text: row.text,
			entryId: row.entry_id ?? undefined,
			createdAt: row.created_at,
		};
	}

	static #normalizeLimit(limit: number): number {
		if (!Number.isFinite(limit)) return 0;
		return Math.min(Math.max(0, Math.floor(limit)), 1000);
	}

	/**
	 * Split on non-alphanumeric runs, mirroring FTS5's `unicode61` tokenizer so
	 * query tokens align with how stored text was indexed.
	 */
	static #tokenize(query: string): string[] {
		return query
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter(token => token.length > 0);
	}
}
