import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { resetSelectorSchemesForTests } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { GrepOutputMode } from "@oh-my-pi/pi-natives";
import { setProjectDir } from "@oh-my-pi/pi-utils";
import { type GrepCommandArgs, runGrepCommand } from "../../src/cli/grep-cli";
import { runInternalUrlGrep } from "../../src/cli/grep-internal-url";
import { initTheme } from "../../src/modes/theme/theme";

interface Run {
	owned: boolean;
	out: string;
	err: string;
	exits: number[];
}

type Overrides = Partial<GrepCommandArgs> & Pick<GrepCommandArgs, "path">;

function args(overrides: Overrides): GrepCommandArgs {
	return {
		pattern: "needle",
		limit: 20,
		context: 2,
		mode: GrepOutputMode.Content,
		gitignore: true,
		...overrides,
	};
}

async function capture(invoke: () => Promise<boolean | void>): Promise<Run> {
	const out: string[] = [];
	const err: string[] = [];
	const exits: number[] = [];
	const logSpy = spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
		out.push(parts.map(String).join(" "));
	});
	const outSpy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
		out.push(String(chunk));
		return true;
	}) as typeof process.stdout.write);
	const errSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
		err.push(String(chunk));
		return true;
	}) as typeof process.stderr.write);
	// The branch reports failure through `process.exit`, so the stub records
	// instead of terminating. Every rejection case below also asserts that no
	// search output escaped — which is what a real exit would have prevented.
	const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
		exits.push(code ?? 0);
		return undefined as never;
	}) as typeof process.exit);
	try {
		const owned = await invoke();
		return { owned: owned === true, out: out.join("\n"), err: err.join("\n"), exits };
	} finally {
		logSpy.mockRestore();
		outSpy.mockRestore();
		errSpy.mockRestore();
		exitSpy.mockRestore();
	}
}

/** Drives the internal-URL branch directly. */
function run(cmd: GrepCommandArgs): Promise<Run> {
	return capture(() => runInternalUrlGrep(cmd));
}

/** Drives the whole subcommand, hook included, the way `omp grep` does. */
function runCommand(overrides: Overrides): Promise<Run> {
	return capture(() => runGrepCommand(args(overrides)));
}

describe("omp grep internal-URL branch", () => {
	let root = "";

	async function project(scheme: string): Promise<string> {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "grep-internal-url-"));
		await fs.mkdir(path.join(root, ".git"));
		await fs.mkdir(path.join(root, ".omp"));
		await fs.mkdir(path.join(root, "docs", "nested"), { recursive: true });
		await Bun.write(
			path.join(root, ".omp", "project-docs.json"),
			JSON.stringify({ version: 1, scheme, root: "docs", docs: [] }),
		);
		await Bun.write(path.join(root, "docs", "index.md"), "nothing here\n");
		await Bun.write(path.join(root, "docs", "nested", "guide.md"), "nested needle\n");
		await Bun.write(path.join(root, "outside.md"), "needle outside the catalog\n");
		setProjectDir(root);
		await initTheme();
		return root;
	}

	afterEach(async () => {
		InternalUrlRouter.resetForTests();
		resetSelectorSchemesForTests();
		if (root) await fs.rm(root, { recursive: true, force: true });
		root = "";
	});

	it("searches a project-docs URL that the native branch cannot resolve", async () => {
		await project("vitrine.se");
		const result = await run(args({ path: "vitrine.se://" }));

		expect(result.owned).toBe(true);
		expect(result.exits).toEqual([]);
		expect(result.out).toContain("nested needle");
		expect(result.out).toContain("guide.md");
		// `outside.md` sits in the repo but outside the catalog root.
		expect(result.out).not.toContain("outside the catalog");
		// The native summary belongs to the other branch and must not appear.
		expect(result.out).not.toContain("Files searched:");
	});

	it("resolves a single document under the scheme", async () => {
		await project("vitrine.se");
		const result = await run(args({ path: "vitrine.se://nested/guide.md" }));

		expect(result.owned).toBe(true);
		expect(result.out).toContain("nested needle");
	});

	it("declines plain filesystem paths so the native branch keeps them", async () => {
		const dir = await project("vitrine.se");

		for (const target of [".", "docs", path.join(dir, "docs"), `:${path.join(dir, "docs")}`, "docs/index.md:1-2"]) {
			const result = await run(args({ path: target }));
			expect({ target, owned: result.owned }).toEqual({ target, owned: false });
			expect(result.out).toBe("");
		}
	});

	it("declines a scheme no handler claims", async () => {
		await project("vitrine.se");
		const result = await run(args({ path: "nosuchscheme://x.md" }));

		expect(result.owned).toBe(false);
		expect(result.out).toBe("");
	});

	it("claims a semicolon list whose URL is not the first entry", async () => {
		await project("vitrine.se");
		// The router's matcher is `^`-anchored, so testing only the whole string
		// would send this to the native branch and reproduce the original bug.
		const result = await run(args({ path: "docs/index.md; vitrine.se://" }));

		expect(result.owned).toBe(true);
		expect(result.out).toContain("nested needle");
	});

	it("rejects flags the tool cannot honor instead of searching anyway", async () => {
		await project("vitrine.se");

		for (const [label, cmd] of [
			["--glob", args({ path: "vitrine.se://", glob: "*.md" })],
			["--count", args({ path: "vitrine.se://", mode: GrepOutputMode.Count })],
			["--files", args({ path: "vitrine.se://", mode: GrepOutputMode.FilesWithMatches })],
		] as const) {
			const result = await run(cmd);
			expect({ label, owned: result.owned, exits: result.exits }).toEqual({ label, owned: true, exits: [1] });
			expect(result.err).toContain("not supported for internal URLs");
			expect(result.out).not.toContain("nested needle");
		}
	});

	it("rejects out-of-range numeric flags that would silently shrink the result", async () => {
		await project("vitrine.se");

		// `Flags.integer` lets these through; `GrepToolOptions` would clamp them
		// into a one-match search, or a context-free one, and report success.
		for (const [label, cmd] of [
			["limit 0", args({ path: "vitrine.se://", limit: 0 })],
			["limit -5", args({ path: "vitrine.se://", limit: -5 })],
			["limit NaN", args({ path: "vitrine.se://", limit: Number.NaN })],
			["context -1", args({ path: "vitrine.se://", context: -1 })],
		] as const) {
			const result = await run(cmd);
			expect({ label, owned: result.owned, exits: result.exits }).toEqual({ label, owned: true, exits: [1] });
			expect(result.err).toContain("must be an integer");
			expect(result.out).not.toContain("nested needle");
		}
	});

	// The hook lives in `runGrepCommand`, so routing has to be proven through
	// the function the `omp grep` subcommand actually calls.
	it("routes through runGrepCommand without disturbing the native branch", async () => {
		const dir = await project("vitrine.se");

		const routed = await runCommand({ path: "vitrine.se://" });
		expect(routed.exits).toEqual([]);
		expect(routed.out).toContain("nested needle");
		// The native branch prints this summary; the routed one must not.
		expect(routed.out).not.toContain("Files searched:");

		const native = await runCommand({ path: path.join(dir, "docs") });
		expect(native.exits).toEqual([]);
		expect(native.out).toContain("Mode: content");
		expect(native.out).toContain("Files searched:");
		expect(native.out).toContain("nested needle");

		const rejected = await runCommand({ path: "vitrine.se://", limit: 0 });
		expect(rejected.exits).toEqual([1]);
		expect(rejected.err).toContain("must be an integer");
	});
});
