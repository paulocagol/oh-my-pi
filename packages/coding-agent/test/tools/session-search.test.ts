import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionSearchIndex } from "@oh-my-pi/pi-coding-agent/session/session-search-index";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SessionSearchTool } from "@oh-my-pi/pi-coding-agent/tools/session-search";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir | null = null;

function makeSession(enabled = true): ToolSession {
	return { settings: Settings.isolated({ "sessionSearch.enabled": enabled }) } as unknown as ToolSession;
}

function freshIndex(): SessionSearchIndex {
	tempDir = TempDir.createSync("@omp-session-search-tool-");
	SessionSearchIndex.resetInstance();
	return SessionSearchIndex.open(tempDir.join("session-search.db"));
}

function resultText(result: AgentToolResult): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

function details(result: AgentToolResult): Record<string, unknown> {
	return (result.details ?? {}) as Record<string, unknown>;
}

/**
 * Two sessions of eight messages each; only `s-docker` talks about docker, and
 * it does so twice so discovery has something to deduplicate.
 */
async function seedTwoSessions(index: SessionSearchIndex): Promise<void> {
	for (let i = 1; i <= 8; i++) {
		const dockerText =
			i === 4 ? "the docker sandbox needs cap-drop" : i === 6 ? "docker again later on" : `docker session line ${i}`;
		index.indexMessage("s-docker", i % 2 === 0 ? "assistant" : "user", dockerText, `d-e${i}`);
	}
	for (let i = 1; i <= 8; i++) {
		index.indexMessage("s-other", i % 2 === 0 ? "assistant" : "user", `unrelated line ${i}`, `o-e${i}`);
	}
	vi.advanceTimersByTime(100);
	await index.flush();
}

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

describe("SessionSearchTool.createIf", () => {
	it("builds the tool when session search is enabled", () => {
		expect(SessionSearchTool.createIf(makeSession(true))).toBeInstanceOf(SessionSearchTool);
	});

	it("returns null when session search is disabled", () => {
		expect(SessionSearchTool.createIf(makeSession(false))).toBeNull();
	});
});

describe("SessionSearchTool mode inference", () => {
	it("takes the discovery path when only a query is given", async () => {
		const index = freshIndex();
		await seedTwoSessions(index);
		const tool = new SessionSearchTool();

		const result = await tool.execute("call-1", { query: "docker" });
		const text = resultText(result);

		expect(details(result).mode).toBe("discovery");
		expect(text).toContain("s-docker");
		expect(text).not.toContain("s-other");
		// One entry per session, with the match plus orientation context.
		expect(details(result).sessions).toBe(1);
		expect(text).toContain("around the match:");
		expect(text).toContain("session opens:");
		expect(text).toContain("session closes:");
	});

	it("takes the scroll path when a session and an anchor entry are given", async () => {
		const index = freshIndex();
		await seedTwoSessions(index);
		const tool = new SessionSearchTool();

		const result = await tool.execute("call-2", { sessionId: "s-docker", aroundEntryId: "d-e4", window: 2 });
		const text = resultText(result);

		expect(details(result).mode).toBe("scroll");
		expect(details(result).messages).toBe(5);
		for (const entryId of ["d-e2", "d-e3", "d-e4", "d-e5", "d-e6"]) expect(text).toContain(entryId);
		expect(text).not.toContain("d-e1");
		expect(text).not.toContain("d-e7");
		// The rendered entry ids are what the model re-anchors on.
		expect(text).toContain("Re-anchor");
	});

	it("takes the browse path when no argument is given", async () => {
		const index = freshIndex();
		await seedTwoSessions(index);
		const tool = new SessionSearchTool();

		const result = await tool.execute("call-3", {});
		const text = resultText(result);

		expect(details(result).mode).toBe("browse");
		expect(details(result).sessions).toBe(2);
		// Newest-active session first: s-other was indexed last.
		expect(text.indexOf("s-other")).toBeLessThan(text.indexOf("s-docker"));
		expect(text).toContain("8 messages");
	});

	it("shows the session bookends when a session is given without an anchor", async () => {
		const index = freshIndex();
		await seedTwoSessions(index);
		const tool = new SessionSearchTool();

		const result = await tool.execute("call-4", { sessionId: "s-docker" });
		const text = resultText(result);

		expect(details(result).mode).toBe("scroll");
		expect(text).toContain("session opens:");
		expect(text).toContain("session closes:");
		expect(text).toContain("d-e1");
		expect(text).toContain("d-e8");
		// The middle of the session is withheld until the model scrolls to it.
		expect(text).not.toContain("d-e5");
	});
});

describe("SessionSearchTool empty results", () => {
	it("reports no match rather than erroring on an unmatched query", async () => {
		const index = freshIndex();
		await seedTwoSessions(index);
		const tool = new SessionSearchTool();

		const result = await tool.execute("call-5", { query: "kubernetes" });

		expect(result.isError).toBeUndefined();
		expect(details(result).sessions).toBe(0);
		expect(resultText(result)).toContain("No indexed session message matches");
	});

	it("reports an unknown scroll anchor instead of returning a silent empty window", async () => {
		const index = freshIndex();
		await seedTwoSessions(index);
		const tool = new SessionSearchTool();

		const result = await tool.execute("call-6", { sessionId: "s-docker", aroundEntryId: "nope" });

		expect(details(result).messages).toBe(0);
		expect(resultText(result)).toContain("nope");
	});

	it("says nothing is indexed when the index is empty", async () => {
		freshIndex();
		const tool = new SessionSearchTool();

		const result = await tool.execute("call-7", {});

		expect(details(result).mode).toBe("browse");
		expect(resultText(result)).toContain("No sessions indexed yet.");
	});
});
