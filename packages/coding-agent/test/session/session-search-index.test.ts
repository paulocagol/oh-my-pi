import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionSearchIndex } from "@oh-my-pi/pi-coding-agent/session/session-search-index";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";

let tempDir: TempDir | null = null;

function freshIndex(): SessionSearchIndex {
	tempDir = TempDir.createSync("@omp-session-search-");
	SessionSearchIndex.resetInstance();
	return SessionSearchIndex.open(tempDir.join("session-search.db"));
}

/** Drain the 100ms insert batch window and await the pending writes. */
async function flush(index: SessionSearchIndex): Promise<void> {
	vi.advanceTimersByTime(100);
	await index.flush();
}

interface Seed {
	sessionId: string;
	role: string;
	text: string;
	entryId: string;
}

async function seed(index: SessionSearchIndex, rows: Seed[]): Promise<void> {
	for (const row of rows) index.indexMessage(row.sessionId, row.role, row.text, row.entryId);
	await flush(index);
}

function conversation(sessionId: string, count: number, prefix = "message"): Seed[] {
	return Array.from({ length: count }, (_, i) => ({
		sessionId,
		role: i % 2 === 0 ? "user" : "assistant",
		text: `${prefix} number ${i + 1}`,
		entryId: `${sessionId}-e${i + 1}`,
	}));
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "sessionSearch.enabled": true } });
});

afterAll(() => {
	resetSettingsForTest();
});

beforeEach(() => {
	SessionSearchIndex.resetInstance();
	vi.useFakeTimers();
});

afterEach(async () => {
	SessionSearchIndex.resetInstance();
	vi.useRealTimers();
	if (tempDir) {
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
});

describe("SessionSearchIndex.searchDiscovery", () => {
	it("finds the session whose message content matches, with the term in the snippet", async () => {
		const index = freshIndex();
		await seed(index, [
			{ sessionId: "s-alpha", role: "user", text: "how do we wire the postgres migration", entryId: "a1" },
			{ sessionId: "s-beta", role: "user", text: "unrelated chatter about lunch", entryId: "b1" },
		]);

		const hits = index.searchDiscovery("postgres", 5);

		expect(hits.map(hit => hit.sessionId)).toEqual(["s-alpha"]);
		expect(hits[0]?.snippet).toContain("postgres");
		expect(hits[0]?.match.entryId).toBe("a1");
	});

	it("returns one entry per session even when several of its messages match", async () => {
		const index = freshIndex();
		await seed(index, [
			{ sessionId: "s-alpha", role: "user", text: "the docker sandbox keeps dying", entryId: "a1" },
			{ sessionId: "s-alpha", role: "assistant", text: "the docker sandbox needs cap-drop", entryId: "a2" },
			{ sessionId: "s-alpha", role: "user", text: "docker again, third time", entryId: "a3" },
			{ sessionId: "s-beta", role: "user", text: "docker compose in another session", entryId: "b1" },
		]);

		const hits = index.searchDiscovery("docker", 5);

		expect(hits.map(hit => hit.sessionId).sort()).toEqual(["s-alpha", "s-beta"]);
		expect(hits.filter(hit => hit.sessionId === "s-alpha")).toHaveLength(1);
	});

	it("carries the surrounding messages and the session bookends on each hit", async () => {
		const index = freshIndex();
		const rows = conversation("s-long", 20);
		rows[9] = { sessionId: "s-long", role: "user", text: "the elusive kryptonite detail", entryId: "s-long-e10" };
		await seed(index, rows);

		const [hit] = index.searchDiscovery("kryptonite", 5);

		expect(hit?.window.map(m => m.entryId)).toEqual([
			"s-long-e5",
			"s-long-e6",
			"s-long-e7",
			"s-long-e8",
			"s-long-e9",
			"s-long-e10",
			"s-long-e11",
			"s-long-e12",
			"s-long-e13",
			"s-long-e14",
			"s-long-e15",
		]);
		expect(hit?.bookends.start.map(m => m.entryId)).toEqual(["s-long-e1", "s-long-e2", "s-long-e3"]);
		expect(hit?.bookends.end.map(m => m.entryId)).toEqual(["s-long-e18", "s-long-e19", "s-long-e20"]);
	});

	it("honours the session limit", async () => {
		const index = freshIndex();
		await seed(
			index,
			["s1", "s2", "s3", "s4"].map(sessionId => ({
				sessionId,
				role: "user",
				text: "shared needle term",
				entryId: `${sessionId}-e1`,
			})),
		);

		expect(index.searchDiscovery("needle", 2)).toHaveLength(2);
	});

	it("returns nothing for a query with no alphanumeric tokens", async () => {
		const index = freshIndex();
		await seed(index, [{ sessionId: "s1", role: "user", text: "anything", entryId: "e1" }]);

		expect(index.searchDiscovery("???", 5)).toEqual([]);
	});
});

describe("SessionSearchIndex.getBookends", () => {
	it("returns the first three and last three messages of a long session", async () => {
		const index = freshIndex();
		await seed(index, conversation("s-long", 8));

		const bookends = index.getBookends("s-long");

		expect(bookends.start.map(m => m.entryId)).toEqual(["s-long-e1", "s-long-e2", "s-long-e3"]);
		expect(bookends.end.map(m => m.entryId)).toEqual(["s-long-e6", "s-long-e7", "s-long-e8"]);
	});

	it("never repeats a message when the session is shorter than six", async () => {
		const index = freshIndex();
		await seed(index, conversation("s-short", 4));

		const bookends = index.getBookends("s-short");

		expect(bookends.start.map(m => m.entryId)).toEqual(["s-short-e1", "s-short-e2", "s-short-e3"]);
		expect(bookends.end.map(m => m.entryId)).toEqual(["s-short-e4"]);
	});

	it("puts every message in start and leaves end empty below the bookend size", async () => {
		const index = freshIndex();
		await seed(index, conversation("s-tiny", 2));

		const bookends = index.getBookends("s-tiny");

		expect(bookends.start.map(m => m.entryId)).toEqual(["s-tiny-e1", "s-tiny-e2"]);
		expect(bookends.end).toEqual([]);
	});
});

describe("SessionSearchIndex.getScrollWindow", () => {
	it("returns messages before and after a mid-session anchor", async () => {
		const index = freshIndex();
		await seed(index, conversation("s-long", 20));

		const window = index.getScrollWindow("s-long", "s-long-e10", 3);

		expect(window.map(m => m.entryId)).toEqual([
			"s-long-e7",
			"s-long-e8",
			"s-long-e9",
			"s-long-e10",
			"s-long-e11",
			"s-long-e12",
			"s-long-e13",
		]);
	});

	it("keeps scrolling forward when re-anchored on the last entry it returned", async () => {
		const index = freshIndex();
		await seed(index, conversation("s-long", 20));

		const first = index.getScrollWindow("s-long", "s-long-e10", 3);
		const lastEntryId = first.at(-1)?.entryId;
		const next = index.getScrollWindow("s-long", lastEntryId ?? "", 3);

		expect(next.map(m => m.entryId)).not.toEqual(first.map(m => m.entryId));
		expect(next.at(-1)?.entryId).toBe("s-long-e16");
		// Progress: the follow-up window reaches messages the first one never showed.
		expect(next.filter(m => !first.some(prev => prev.entryId === m.entryId))).not.toHaveLength(0);
	});

	it("keeps scrolling backward when re-anchored on the first entry it returned", async () => {
		const index = freshIndex();
		await seed(index, conversation("s-long", 20));

		const first = index.getScrollWindow("s-long", "s-long-e10", 3);
		const next = index.getScrollWindow("s-long", first[0]?.entryId ?? "", 3);

		expect(next[0]?.entryId).toBe("s-long-e4");
	});

	it("counts the window in session-local positions, not raw row ids", async () => {
		const index = freshIndex();
		// Two sessions interleaved: raw row ids of s-a are 1,3,5,… so an id-range
		// window would silently return half as many messages.
		const rows: Seed[] = [];
		for (let i = 1; i <= 10; i++) {
			rows.push({ sessionId: "s-a", role: "user", text: `a${i}`, entryId: `a-e${i}` });
			rows.push({ sessionId: "s-b", role: "user", text: `b${i}`, entryId: `b-e${i}` });
		}
		await seed(index, rows);

		const window = index.getScrollWindow("s-a", "a-e5", 2);

		expect(window.map(m => m.entryId)).toEqual(["a-e3", "a-e4", "a-e5", "a-e6", "a-e7"]);
		expect(window.every(m => m.sessionId === "s-a")).toBe(true);
	});

	it("returns nothing for an anchor that is not indexed", async () => {
		const index = freshIndex();
		await seed(index, conversation("s-long", 5));

		expect(index.getScrollWindow("s-long", "no-such-entry", 3)).toEqual([]);
	});
});

describe("SessionSearchIndex.listRecentSessions", () => {
	it("lists indexed sessions newest first with counts and the opening prompt", async () => {
		const index = freshIndex();
		await seed(index, [
			{ sessionId: "s-old", role: "user", text: "first thing we discussed", entryId: "o1" },
			{ sessionId: "s-old", role: "assistant", text: "reply", entryId: "o2" },
			{ sessionId: "s-new", role: "assistant", text: "resumed context", entryId: "n1" },
			{ sessionId: "s-new", role: "user", text: "second session opener", entryId: "n2" },
		]);

		const sessions = index.listRecentSessions(10);

		expect(sessions.map(s => s.sessionId)).toEqual(["s-new", "s-old"]);
		expect(sessions[0]?.messageCount).toBe(2);
		// Preview is the first *user* message, even when an assistant turn came first.
		expect(sessions[0]?.preview).toBe("second session opener");
		expect(sessions[1]?.preview).toBe("first thing we discussed");
	});

	it("is empty before anything is indexed", () => {
		const index = freshIndex();
		expect(index.listRecentSessions(10)).toEqual([]);
	});
});

describe("SessionSearchIndex.indexMessage", () => {
	it("ignores blank text so empty turns never occupy the index", async () => {
		const index = freshIndex();
		index.indexMessage("s1", "user", "   \n  ", "e1");
		index.indexMessage("s1", "user", "real content", "e2");
		await flush(index);

		expect(index.listRecentSessions(10)[0]?.messageCount).toBe(1);
	});
});

describe("SessionManager message indexing", () => {
	it("indexes user and assistant turns but never tool results", async () => {
		const index = freshIndex();
		const root = tempDir?.path() ?? "";
		const manager = SessionManager.create(root, `${root}/sessions`);

		manager.appendMessage({ role: "user", content: "the kryptonite refactor question", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("the kryptonite refactor answer"));
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "bash",
			isError: false,
			content: [{ type: "text", text: "the kryptonite refactor tool output" }],
			timestamp: Date.now(),
		});
		await flush(index);

		const hits = index.searchDiscovery("kryptonite", 5);
		expect(hits.map(hit => hit.sessionId)).toEqual([manager.getSessionId()]);
		const bookends = index.getBookends(manager.getSessionId());
		expect(bookends.start.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(bookends.start.map(message => message.text)).toEqual([
			"the kryptonite refactor question",
			"the kryptonite refactor answer",
		]);
	});

	it("makes the appended entry id a usable scroll anchor", async () => {
		const index = freshIndex();
		const root = tempDir?.path() ?? "";
		const manager = SessionManager.create(root, `${root}/sessions`);

		manager.appendMessage({ role: "user", content: "anchor me", timestamp: Date.now() });
		const entryId = manager.appendMessage(createAssistantMessage("anchored reply"));
		manager.appendMessage({ role: "user", content: "after the anchor", timestamp: Date.now() });
		await flush(index);

		const window = index.getScrollWindow(manager.getSessionId(), entryId, 1);
		expect(window.map(message => message.text)).toEqual(["anchor me", "anchored reply", "after the anchor"]);
	});

	it("skips indexing when the setting is off", async () => {
		const index = freshIndex();
		const root = tempDir?.path() ?? "";
		const manager = SessionManager.create(root, `${root}/sessions`);

		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "sessionSearch.enabled": false } });
		try {
			manager.appendMessage({ role: "user", content: "should not be indexed", timestamp: Date.now() });
			await flush(index);
			expect(index.listRecentSessions(10)).toEqual([]);
		} finally {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { "sessionSearch.enabled": true } });
		}
	});
});
