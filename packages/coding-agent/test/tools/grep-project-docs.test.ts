import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter, registerProjectDocSchemes } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resetSelectorSchemesForTests } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { GrepTool } from "../../src/tools/grep";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

describe("GrepTool project-docs URLs", () => {
	let root: string;

	afterEach(async () => {
		InternalUrlRouter.resetForTests();
		resetSelectorSchemesForTests();
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	it("recurses the real Markdown tree and does not manufacture hashlines", async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "grep-project-docs-"));
		await fs.mkdir(path.join(root, ".git"));
		await fs.mkdir(path.join(root, ".omp"));
		await fs.mkdir(path.join(root, "docs", "nested"), { recursive: true });
		await Bun.write(
			path.join(root, ".omp", "project-docs.json"),
			JSON.stringify({ version: 1, scheme: "docs", docs: [] }),
		);
		await Bun.write(path.join(root, "docs", "index.md"), "no match\n");
		await Bun.write(path.join(root, "docs", "nested", "guide.md"), "nested needle\n");
		await registerProjectDocSchemes(root);
		const session: ToolSession = {
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 }),
		};
		const result = await new GrepTool(session).execute("project-docs-grep", { pattern: "needle", path: "docs://" });
		const output = textOf(result);
		expect(output).toContain("guide.md");
		expect(output).toContain("nested needle");
		expect(output).not.toMatch(/\[.*#[0-9A-F]{4}\]/i);
	});
});
