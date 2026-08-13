import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import sessionSearchDescription from "../prompts/tools/session-search.md" with { type: "text" };
import type { MessageRow, SessionBookends } from "../session/session-search-index";
import { SessionSearchIndex } from "../session/session-search-index";
import type { ToolSession } from ".";

const sessionSearchSchema = type({
	"query?": type("string").describe("full-text query over past session messages (discovery mode)"),
	"sessionId?": type("string").describe("session to read, taken from a discovery or browse result"),
	"aroundEntryId?": type("string").describe("entry id to centre the scroll window on; requires sessionId"),
	"window?": type("number").describe("messages read either side of the scroll anchor (default 10)"),
});

export type SessionSearchParams = typeof sessionSearchSchema.infer;

const DEFAULT_SCROLL_WINDOW = 10;
const MAX_SCROLL_WINDOW = 50;
const DISCOVERY_SESSION_LIMIT = 5;
const BROWSE_LIMIT = 20;
/** Per-message clip in rendered output; long turns would otherwise swamp the result. */
const MESSAGE_CLIP = 400;

function clip(text: string, max = MESSAGE_CLIP): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function renderMessage(message: MessageRow, indent: string): string {
	const anchor = message.entryId ? ` entry ${message.entryId}` : "";
	return `${indent}${message.role}${anchor}: ${clip(message.text)}`;
}

function renderBookends(bookends: SessionBookends, indent: string): string[] {
	const lines: string[] = [];
	if (bookends.start.length > 0) {
		lines.push(`${indent}session opens:`);
		for (const message of bookends.start) lines.push(renderMessage(message, `${indent}  `));
	}
	if (bookends.end.length > 0) {
		lines.push(`${indent}session closes:`);
		for (const message of bookends.end) lines.push(renderMessage(message, `${indent}  `));
	}
	return lines;
}

/**
 * Read-only recall over the content of past sessions. Three modes inferred from
 * the arguments — no mode parameter, so the model picks by what it knows rather
 * than by naming a strategy.
 */
export class SessionSearchTool implements AgentTool<typeof sessionSearchSchema> {
	readonly name = "session_search";
	readonly approval = "read" as const;
	readonly label = "Session Search";
	readonly description = sessionSearchDescription;
	readonly parameters = sessionSearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Search the message content of past sessions";

	static createIf(session: ToolSession): SessionSearchTool | null {
		if (!session.settings.get("sessionSearch.enabled")) return null;
		return new SessionSearchTool();
	}

	async execute(_id: string, params: SessionSearchParams): Promise<AgentToolResult> {
		const index = SessionSearchIndex.open();
		// Reads must see writes queued by the turn that just ran; the index
		// batches inserts behind an async drain.
		await index.flush();

		if (params.query) return this.#discovery(index, params.query);
		if (params.sessionId) return this.#scroll(index, params.sessionId, params.aroundEntryId, params.window);
		return this.#browse(index);
	}

	#discovery(index: SessionSearchIndex, query: string): AgentToolResult {
		const hits = index.searchDiscovery(query, DISCOVERY_SESSION_LIMIT);
		if (hits.length === 0) {
			return {
				content: [{ type: "text", text: `No indexed session message matches "${query}".` }],
				details: { mode: "discovery", query, sessions: 0 },
			};
		}

		const lines = [`${hits.length} session${hits.length === 1 ? "" : "s"} match "${query}".`];
		for (const hit of hits) {
			lines.push("", `session ${hit.sessionId}`);
			lines.push(`  match (${hit.match.role}, entry ${hit.match.entryId ?? "unknown"}): ${clip(hit.snippet)}`);
			if (hit.window.length > 0) {
				lines.push("  around the match:");
				for (const message of hit.window) lines.push(renderMessage(message, "    "));
			}
			lines.push(...renderBookends(hit.bookends, "  "));
		}
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { mode: "discovery", query, sessions: hits.length },
		};
	}

	#scroll(
		index: SessionSearchIndex,
		sessionId: string,
		aroundEntryId: string | undefined,
		window: number | undefined,
	): AgentToolResult {
		if (!aroundEntryId) {
			const bookends = index.getBookends(sessionId);
			if (bookends.start.length === 0) {
				return {
					content: [{ type: "text", text: `Session ${sessionId} has no indexed messages.` }],
					details: { mode: "scroll", sessionId, messages: 0 },
				};
			}
			const lines = [`Session ${sessionId} — first and last messages. Pass aroundEntryId to read the middle.`];
			lines.push(...renderBookends(bookends, ""));
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { mode: "scroll", sessionId, messages: bookends.start.length + bookends.end.length },
			};
		}

		const size = Math.min(Math.max(1, Math.floor(window ?? DEFAULT_SCROLL_WINDOW)), MAX_SCROLL_WINDOW);
		const messages = index.getScrollWindow(sessionId, aroundEntryId, size);
		if (messages.length === 0) {
			return {
				content: [{ type: "text", text: `No indexed message ${aroundEntryId} in session ${sessionId}.` }],
				details: { mode: "scroll", sessionId, aroundEntryId, messages: 0 },
			};
		}

		const lines = [`Session ${sessionId} — ${messages.length} messages around entry ${aroundEntryId}.`];
		for (const message of messages) lines.push(renderMessage(message, ""));
		lines.push("", "Re-anchor on the first or last entry above to keep scrolling.");
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { mode: "scroll", sessionId, aroundEntryId, messages: messages.length },
		};
	}

	#browse(index: SessionSearchIndex): AgentToolResult {
		const sessions = index.listRecentSessions(BROWSE_LIMIT);
		if (sessions.length === 0) {
			return {
				content: [{ type: "text", text: "No sessions indexed yet." }],
				details: { mode: "browse", sessions: 0 },
			};
		}

		const lines = [`${sessions.length} indexed session${sessions.length === 1 ? "" : "s"}, newest first.`];
		for (const session of sessions) {
			const when = new Date(session.lastActivityAt * 1000).toISOString();
			lines.push("", `session ${session.sessionId} · ${session.messageCount} messages · last active ${when}`);
			if (session.preview) lines.push(`  opens: ${clip(session.preview)}`);
		}
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { mode: "browse", sessions: sessions.length },
		};
	}
}
