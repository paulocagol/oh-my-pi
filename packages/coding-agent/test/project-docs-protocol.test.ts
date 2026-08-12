import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	InternalUrlRouter,
	type ProjectDocsProtocolHandler,
	parseInternalUrl,
	registerProjectDocSchemes,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resetSelectorSchemesForTests, splitInternalUrlSel } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

const roots: string[] = [];

async function project(scheme = "vitrine.se"): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "project-docs-"));
	roots.push(root);
	await fs.mkdir(path.join(root, ".git"));
	await fs.mkdir(path.join(root, ".omp"));
	await fs.mkdir(path.join(root, "docs", "nested"), { recursive: true });
	await Bun.write(
		path.join(root, ".omp", "project-docs.json"),
		JSON.stringify({ version: 1, scheme, root: "docs", docs: [] }),
	);
	return root;
}

async function manifest(root: string, value: unknown): Promise<void> {
	await Bun.write(path.join(root, ".omp", "project-docs.json"), JSON.stringify(value));
}

function url(value: string) {
	return parseInternalUrl(value);
}

afterEach(async () => {
	InternalUrlRouter.resetForTests();
	resetSelectorSchemesForTests();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("project-docs protocol", () => {
	it("resolves an index with sourcePath and nested documents", async () => {
		const root = await project();
		await Bun.write(path.join(root, "docs", "architecture.md"), "# Architecture\n");
		await Bun.write(path.join(root, "docs", "nested", "guide.md"), "# Guide\nneedle\n");
		await manifest(root, {
			version: 1,
			scheme: " VITRINE.SE ",
			root: "docs",
			description: "Vitrine docs",
			docs: [{ path: "nested/guide.md", title: "Guide", description: "Nested" }],
		});
		await registerProjectDocSchemes(root);
		const handler = InternalUrlRouter.instance().getHandler("vitrine.se") as ProjectDocsProtocolHandler;
		const index = await handler.resolve(url("vitrine.se://"), { cwd: root });
		expect(index.isDirectory).toBe(true);
		expect(index.sourcePath).toBe(await fs.realpath(path.join(root, "docs")));
		expect(index.content).toContain("Vitrine docs");
		expect(index.content).toContain("[architecture.md](vitrine.se://architecture.md)");
		const nested = await handler.resolve(url("vitrine.se://nested/guide.md"), { cwd: root });
		expect(nested.sourcePath).toBe(await fs.realpath(path.join(root, "docs", "nested", "guide.md")));
		expect(nested.content).toContain("needle");
		expect(nested.immutable).toBe(true);
	});

	it("rejects absolute, encoded, malformed, and symlink traversal", async () => {
		const root = await project();
		await Bun.write(path.join(root, "docs", "safe.md"), "safe\n");
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "project-docs-outside-"));
		roots.push(outside);
		await Bun.write(path.join(outside, "secret.md"), "secret\n");
		await manifest(root, { version: 1, scheme: "docs", docs: [] });
		await registerProjectDocSchemes(root);
		const handler = InternalUrlRouter.instance().getHandler("docs")!;
		await fs.symlink(path.join(outside, "secret.md"), path.join(root, "docs", "link.md"));
		await expect(handler.resolve(url("docs:///etc/passwd"), { cwd: root })).rejects.toThrow(/relative|unavailable/);
		await expect(handler.resolve(url("docs://%2e%2e/%2e%2e/secret.md"), { cwd: root })).rejects.toThrow(
			/relative|unavailable/,
		);
		await expect(handler.resolve(url("docs://safe.md:%ZZ"), { cwd: root })).rejects.toThrow(/percent|unavailable/);
		await expect(handler.resolve(url("docs://link.md"), { cwd: root })).rejects.toThrow(
			/not found|outside|unavailable/,
		);
	});
	it("rejects invalid manifests and scheme collisions", async () => {
		const other = await project("file");
		expect(await registerProjectDocSchemes(other)).toBeUndefined();
		const collision = await project("conflict");
		await fs.rm(path.join(collision, "docs", "nested"), { recursive: true });
		await manifest(collision, { version: 1, scheme: "custom", docs: [{ path: "missing.md" }] });
		expect(await registerProjectDocSchemes(collision)).toBeUndefined();
		InternalUrlRouter.instance().register({
			scheme: "taken",
			immutable: true,
			async resolve() {
				throw new Error("unused");
			},
		});
		const taken = await project("taken");
		expect(await registerProjectDocSchemes(taken)).toBeUndefined();
	});

	it("skips non-Markdown assets, honors exclude globs, and keeps exclusion out of access control", async () => {
		const root = await project();
		await Bun.write(path.join(root, "docs", "architecture.md"), "# Architecture\n");
		await Bun.write(path.join(root, "docs", "nested", "guide.md"), "# Guide\n");
		await fs.mkdir(path.join(root, "docs", "pen"), { recursive: true });
		await Bun.write(path.join(root, "docs", "pen", "draft.md"), "# Draft\n");
		await Bun.write(path.join(root, "docs", "pen", "flow.js"), "// asset\n");
		await Bun.write(path.join(root, "docs", "logo.png"), "not markdown\n");
		await manifest(root, {
			version: 1,
			scheme: "vitrine.se",
			root: "docs",
			exclude: ["pen/**"],
			docs: [{ path: "architecture.md", title: "Arquitetura" }],
		});
		expect(await registerProjectDocSchemes(root)).toBeDefined();
		const handler = InternalUrlRouter.instance().getHandler("vitrine.se")!;
		const index = await handler.resolve(url("vitrine.se://"), { cwd: root });
		expect(index.content).toContain("architecture.md");
		expect(index.content).toContain("nested/guide.md");
		// Assets never reach the index, and `exclude` curates it further.
		expect(index.content).not.toContain("logo.png");
		expect(index.content).not.toContain("flow.js");
		expect(index.content).not.toContain("draft.md");
		const completions = await handler.complete?.(undefined, { cwd: root });
		expect(completions?.map(entry => entry.value).sort()).toEqual(["architecture.md", "nested/guide.md"]);
		// Curation, not access control: an excluded document still resolves.
		expect((await handler.resolve(url("vitrine.se://pen/draft.md"), { cwd: root })).content).toBe("# Draft\n");
		// Assets stay unreachable through the scheme regardless of the walk.
		await expect(handler.resolve(url("vitrine.se://logo.png"), { cwd: root })).rejects.toThrow(/\.md|unavailable/);
	});

	it("fails closed on malformed exclude patterns and on metadata for excluded documents", async () => {
		const root = await project("excl");
		await Bun.write(path.join(root, "docs", "keep.md"), "# Keep\n");
		await fs.mkdir(path.join(root, "docs", "drafts"), { recursive: true });
		await Bun.write(path.join(root, "docs", "drafts", "wip.md"), "# WIP\n");
		const base = { version: 1, scheme: "excl", root: "docs" };
		await manifest(root, { ...base, exclude: "drafts/**" });
		expect(await registerProjectDocSchemes(root)).toBeUndefined();
		await manifest(root, { ...base, exclude: [42] });
		expect(await registerProjectDocSchemes(root)).toBeUndefined();
		await manifest(root, { ...base, exclude: ["../outside/**"] });
		expect(await registerProjectDocSchemes(root)).toBeUndefined();
		await manifest(root, { ...base, exclude: ["/abs/**"] });
		expect(await registerProjectDocSchemes(root)).toBeUndefined();
		// Listing a document the manifest itself excluded is an authoring bug, not a silent drop.
		await manifest(root, { ...base, exclude: ["drafts/**"], docs: [{ path: "drafts/wip.md" }] });
		expect(await registerProjectDocSchemes(root)).toBeUndefined();
		await manifest(root, { ...base, exclude: ["drafts/**"], docs: [{ path: "keep.md" }] });
		expect(await registerProjectDocSchemes(root)).toBeDefined();
	});

	it("isolates same schemes by context and fails closed for mismatch or absent manifests", async () => {
		const first = await project("shared");
		const second = await project("shared");
		await Bun.write(path.join(first, "docs", "same.md"), "first\n");
		await Bun.write(path.join(second, "docs", "same.md"), "second\n");
		await registerProjectDocSchemes(first);
		await registerProjectDocSchemes(second);
		const handler = InternalUrlRouter.instance().getHandler("shared")!;
		expect((await handler.resolve(url("shared://same.md"), { cwd: first })).content).toBe("first\n");
		expect((await handler.resolve(url("shared://same.md"), { cwd: second })).content).toBe("second\n");
		const mismatch = await project("other");
		await expect(handler.resolve(url("shared://"), { cwd: mismatch })).rejects.toThrow(/mismatch/);
		const noRepo = await fs.mkdtemp(path.join(os.tmpdir(), "project-docs-no-repo-"));
		roots.push(noRepo);
		await expect(handler.resolve(url("shared://"), { cwd: noRepo })).rejects.toThrow(/unavailable/);
	});

	it("does not cache document bodies and escapes index names and metadata", async () => {
		const root = await project("docs");
		const filename = "danger`name.md";
		await Bun.write(path.join(root, "docs", filename), "old\n");
		await Bun.write(path.join(root, "docs", "100%-coverage.md"), "percent\n");
		await manifest(root, {
			version: 1,
			scheme: "docs",
			docs: [{ path: filename, title: "[Title]", description: "`description`" }, { path: "100%-coverage.md" }],
		});
		await registerProjectDocSchemes(root);
		const handler = InternalUrlRouter.instance().getHandler("docs")!;
		const first = await handler.resolve(url("docs://"), { cwd: root });
		expect(first.content).toContain("[danger\\`name.md](docs://danger%60name.md)");
		expect(first.content).toContain("\\[Title\\]");
		expect(first.content).toContain("[100%-coverage.md](docs://100%25-coverage.md)");
		await Bun.write(path.join(root, "docs", filename), "new\n");
		expect((await handler.resolve(url("docs://danger%60name.md"), { cwd: root })).content).toBe("new\n");
		expect((await handler.resolve(url("docs://100%25-coverage.md"), { cwd: root })).content).toBe("percent\n");
	});

	it("supports selector registration cleanup and a real line selector endpoint", async () => {
		const root = await project("docs");
		await Bun.write(path.join(root, "docs", "guide.md"), "one\ntwo\nthree\n");
		await manifest(root, { version: 1, scheme: "docs", docs: [] });
		await registerProjectDocSchemes(root);
		expect(splitInternalUrlSel("docs://guide.md:raw:1-2")).toEqual({ path: "docs://guide.md", sel: "raw:1-2" });
		const session: ToolSession = {
			cwd: root,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "fetch.enabled": true }),
		};
		const read = await new ReadTool(session).execute("selector-read", { path: "docs://guide.md:raw:1-2" });
		const readText = read.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(readText).toContain("one");
		expect(readText).toContain("two");
		expect(readText).not.toContain("three");
		resetSelectorSchemesForTests();
		expect(splitInternalUrlSel("docs://guide.md:raw:1-2")).toEqual({ path: "docs://guide.md:raw:1-2" });
	});
});
