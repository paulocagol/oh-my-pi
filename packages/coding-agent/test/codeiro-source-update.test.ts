import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyPatchSeries,
	buildUpstreamReleaseNotice,
	CODEIRO_LOCK_FILENAME,
	CODEIRO_MANIFEST_FILENAME,
	type CodeiroInstall,
	type CodeiroUpdateDeps,
	describeCodeiroInstall,
	ensureBaseObjects,
	ensureNativeAddonDirectoryChain,
	formatSeriesConflictReport,
	loadCodeiroInstall,
	parseCodeiroManifest,
	parseLsRemote,
	parsePatchFiles,
	parsePatchSeries,
	parsePatchSeriesBase,
	replaceNativeAddonFile,
	resolveLatestStableRelease,
	resolveManifestCandidates,
	resolvePatchSeries,
	resolveSourceBuildTarget,
	resolveStagingLayout,
	runCodeiroSourceUpdate,
	validateNativeArchiveListing,
} from "@oh-my-pi/pi-coding-agent/cli/codeiro-source-update";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// The update command initialises the theme before dispatching; the status
// glyphs printed by the source-build flow read from it.
beforeAll(async () => {
	await initTheme(false);
});

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codeiro-source-update-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

const VALID_MANIFEST = {
	distribution: "codeiro-omp",
	upstreamRepo: "can1357/oh-my-pi",
	patchRepo: "https://github.com/paulocagol/oh-my-pi.git",
	patchRef: "codeiro",
	patchSeries: "codeiro/patches/series",
	sourceRoot: "~/.local/share/codeiro-omp",
} as const;

describe("parseCodeiroManifest", () => {
	it("accepts a complete manifest and ignores unknown keys", () => {
		const manifest = parseCodeiroManifest({ ...VALID_MANIFEST, futureKey: 1 }, "manifest.json");

		expect(manifest).toEqual({
			distribution: "codeiro-omp",
			upstreamRepo: "can1357/oh-my-pi",
			patchRepo: "https://github.com/paulocagol/oh-my-pi.git",
			patchRef: "codeiro",
			patchSeries: "codeiro/patches/series",
			sourceRoot: "~/.local/share/codeiro-omp",
		});
	});

	it("rejects a manifest for another distribution", () => {
		expect(() => parseCodeiroManifest({ ...VALID_MANIFEST, distribution: "other" }, "manifest.json")).toThrow(
			/distribution/,
		);
	});

	it.each(["upstreamRepo", "patchRepo", "patchRef", "patchSeries", "sourceRoot"])(
		"rejects a manifest missing %s",
		key => {
			const incomplete: Record<string, unknown> = { ...VALID_MANIFEST };
			delete incomplete[key];

			expect(() => parseCodeiroManifest(incomplete, "manifest.json")).toThrow(new RegExp(key));
		},
	);

	it("rejects a blank field", () => {
		expect(() => parseCodeiroManifest({ ...VALID_MANIFEST, patchRef: "   " }, "manifest.json")).toThrow(/patchRef/);
	});

	it("rejects an upstream repo that is not owner/name", () => {
		expect(() => parseCodeiroManifest({ ...VALID_MANIFEST, upstreamRepo: "oh-my-pi" }, "manifest.json")).toThrow(
			/owner\/name/,
		);
	});

	it.each([
		["--upload-pack=touch", /must not start with "-"/],
		["feature branch", /whitespace/],
		["refs/../../etc", /plain branch, tag or commit/],
	])("rejects patchRef %s", (patchRef, expected) => {
		expect(() => parseCodeiroManifest({ ...VALID_MANIFEST, patchRef }, "manifest.json")).toThrow(expected);
	});

	it.each(["/etc/series", "../series", "codeiro/../../series"])("rejects patchSeries %s", patchSeries => {
		expect(() => parseCodeiroManifest({ ...VALID_MANIFEST, patchSeries }, "manifest.json")).toThrow(/patchSeries/);
	});

	it("rejects a non-object document", () => {
		expect(() => parseCodeiroManifest("codeiro-omp", "manifest.json")).toThrow(/JSON object/);
	});
});

describe("resolveManifestCandidates", () => {
	it.each([
		["/opt/codeiro/bin/omp", ["/opt/codeiro/bin/omp"]],
		["/opt/codeiro/bin/omp.exe", ["/opt/codeiro/bin/omp.exe"]],
		["/opt/codeiro/bin/OMP", ["/opt/codeiro/bin/OMP"]],
		["/Users/paulo/.local/bin/codeiro-omp", ["/Users/paulo/.local/bin/codeiro-omp"]],
		["/opt/codeiro/bin/codeiro-omp.exe", ["/opt/codeiro/bin/codeiro-omp.exe"]],
	])("adopts the running binary %s", (execPath, expected) => {
		expect(resolveManifestCandidates(execPath)).toEqual(expected);
	});

	it.each([
		"/opt/homebrew/bin/bun",
		"/usr/local/bin/node",
		"/opt/codeiro/bin/omp-wrapper",
		"/opt/codeiro/bin/codeiro",
		"/opt/codeiro/bin/codeiro-omp-wrapper",
	])("ignores a non-omp host process %s", execPath => {
		expect(resolveManifestCandidates(execPath)).toEqual([]);
	});

	it("ignores a missing exec path", () => {
		expect(resolveManifestCandidates(undefined)).toEqual([]);
	});
});

describe("parseLsRemote", () => {
	const TAG = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	const COMMIT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

	it("prefers the dereferenced commit of an annotated tag", () => {
		const stdout = `${TAG}\trefs/tags/codeiro-omp-v17.2.15-c4\n${COMMIT}\trefs/tags/codeiro-omp-v17.2.15-c4^{}\n`;

		expect(parseLsRemote(stdout, "codeiro-omp-v17.2.15-c4")).toBe(COMMIT);
	});

	it("resolves a branch head", () => {
		expect(parseLsRemote(`${COMMIT}\trefs/heads/codeiro\n`, "codeiro")).toBe(COMMIT);
	});

	it("ignores refs that merely share a prefix", () => {
		const stdout = `${TAG}\trefs/heads/codeiro-next\n${COMMIT}\trefs/heads/codeiro\n`;

		expect(parseLsRemote(stdout, "codeiro")).toBe(COMMIT);
	});

	it("throws when the ref is absent", () => {
		expect(() => parseLsRemote(`${TAG}\trefs/heads/main\n`, "codeiro")).toThrow(/not found/);
	});

	it("rejects a row whose first field is not a commit", () => {
		expect(() => parseLsRemote(`not-a-sha\trefs/heads/codeiro\n`, "codeiro")).toThrow(/not found/);
	});
});

describe("loadCodeiroInstall", () => {
	it("returns undefined when no candidate has a manifest", async () => {
		const dir = await makeTempDir();

		expect(await loadCodeiroInstall([path.join(dir, "omp")])).toBeUndefined();
	});

	it("loads the manifest sitting next to the binary", async () => {
		const dir = await makeTempDir();
		const manifestPath = path.join(dir, CODEIRO_MANIFEST_FILENAME);
		await fs.writeFile(manifestPath, JSON.stringify(VALID_MANIFEST));
		const binaryPath = path.join(dir, "omp");

		const install = await loadCodeiroInstall([binaryPath]);

		expect(install?.binaryPath).toBe(binaryPath);
		expect(install?.manifestPath).toBe(manifestPath);
		expect(install?.manifest.patchRef).toBe("codeiro");
	});

	it("skips candidates without a manifest and keeps looking", async () => {
		const empty = await makeTempDir();
		const withManifest = await makeTempDir();
		await fs.writeFile(path.join(withManifest, CODEIRO_MANIFEST_FILENAME), JSON.stringify(VALID_MANIFEST));

		const install = await loadCodeiroInstall([path.join(empty, "omp"), path.join(withManifest, "omp")]);

		expect(install?.binaryPath).toBe(path.join(withManifest, "omp"));
	});

	it("fails instead of falling back to the official flow when a manifest is malformed", async () => {
		const dir = await makeTempDir();
		await fs.writeFile(path.join(dir, CODEIRO_MANIFEST_FILENAME), "{ not json");

		await expect(loadCodeiroInstall([path.join(dir, "omp")])).rejects.toThrow(/not valid JSON/);
	});

	it("fails instead of falling back when a manifest is invalid", async () => {
		const dir = await makeTempDir();
		await fs.writeFile(
			path.join(dir, CODEIRO_MANIFEST_FILENAME),
			JSON.stringify({ ...VALID_MANIFEST, upstreamRepo: "" }),
		);

		await expect(loadCodeiroInstall([path.join(dir, "omp")])).rejects.toThrow(/upstreamRepo/);
	});
});

describe("resolveLatestStableRelease", () => {
	it("selects the tagged stable version", () => {
		const release = resolveLatestStableRelease(
			{ tag_name: "v17.2.13", draft: false, prerelease: false },
			"can1357/oh-my-pi",
		);

		expect(release).toEqual({ tag: "v17.2.13", version: "17.2.13" });
	});

	it.each([
		[{ tag_name: "v17.2.13", draft: true, prerelease: false }, /not a published stable release/],
		[{ tag_name: "v17.2.13", draft: false, prerelease: true }, /not a published stable release/],
		[{ tag_name: "v17.3.0-rc.1", draft: false, prerelease: false }, /not a stable version tag/],
		[{ tag_name: "nightly", draft: false, prerelease: false }, /not a stable version tag/],
		[{ draft: false, prerelease: false }, /no tag name/],
		["v17.2.13", /Invalid GitHub release metadata/],
	])("rejects %o", (payload, expected) => {
		expect(() => resolveLatestStableRelease(payload, "can1357/oh-my-pi")).toThrow(expected);
	});
});

describe("resolveSourceBuildTarget", () => {
	it.each([
		["darwin", "arm64", false, "darwin-arm64", "omp-darwin-arm64"],
		["darwin", "x64", false, "darwin-x64", "omp-darwin-x64"],
		["linux", "x64", false, "linux-x64", "omp-linux-x64"],
		["linux", "arm64", false, "linux-arm64", "omp-linux-arm64"],
		["linux", "x64", true, "linux-musl-x64", "omp-linux-musl-x64"],
		["linux", "arm64", true, "linux-musl-arm64", "omp-linux-musl-arm64"],
		["win32", "x64", false, "win32-x64", "omp-windows-x64.exe"],
	])("maps %s/%s (musl=%s) to the release target", (platform, arch, musl, id, artifact) => {
		expect(resolveSourceBuildTarget(platform, arch, musl)).toEqual({ id, artifact });
	});

	it.each([
		["freebsd", "x64"],
		["darwin", "ia32"],
		["win32", "arm64"],
	])("rejects unsupported host %s/%s", (platform, arch) => {
		expect(() => resolveSourceBuildTarget(platform, arch, false)).toThrow(/Unsupported platform/);
	});
});

describe("resolveStagingLayout", () => {
	it("expands a home-relative source root into staging directories", () => {
		const layout = resolveStagingLayout("~/.local/share/codeiro-omp", "/opt/codeiro/bin/omp", "/home/paulo");

		expect(layout).toEqual({
			root: "/home/paulo/.local/share/codeiro-omp",
			sourceDir: "/home/paulo/.local/share/codeiro-omp/source",
			patchDir: "/home/paulo/.local/share/codeiro-omp/patches",
		});
	});

	it.each([
		["the install directory itself", "/opt/codeiro/bin"],
		["a directory inside the install prefix", "/opt/codeiro/bin/source"],
		["a parent of the install directory", "/opt/codeiro"],
	])("rejects staging in %s", (_label, sourceRoot) => {
		expect(() => resolveStagingLayout(sourceRoot, "/opt/codeiro/bin/omp", "/home/paulo")).toThrow(/must not overlap/);
	});
});

describe("parsePatchSeries", () => {
	it("keeps order and drops comments and blank lines", () => {
		const entries = parsePatchSeries(
			[
				"# series",
				"",
				"0001-first.patch",
				"  0002-second.patch  ",
				"\t# trailing comment",
				"0003-third.patch",
				"",
			].join("\r\n"),
		);

		expect(entries).toEqual(["0001-first.patch", "0002-second.patch", "0003-third.patch"]);
	});

	it("returns nothing for a comment-only series", () => {
		expect(parsePatchSeries("# nothing here\n\n")).toEqual([]);
	});
});

describe("parsePatchSeriesBase", () => {
	it("reads the base tag from the header", () => {
		expect(parsePatchSeriesBase("# base: v17.2.15\n0001-a.patch\n")).toBe("v17.2.15");
	});

	it("returns nothing when the series states no base", () => {
		expect(parsePatchSeriesBase("# series\n0001-a.patch\n")).toBeUndefined();
	});

	it.each(["../../etc/passwd", "--upload-pack=evil", "refs/tags/v1 v2"])(
		"refuses base %s instead of handing it to git",
		base => {
			expect(parsePatchSeriesBase(`# base: ${base}\n0001-a.patch\n`)).toBeUndefined();
		},
	);
});

describe("parsePatchFiles", () => {
	it("collects post-image paths in diff order and ignores everything else", () => {
		const files = parsePatchFiles(
			[
				"From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001",
				"Subject: [PATCH] feat: something",
				"---",
				" packages/coding-agent/CHANGELOG.md | 2 +-",
				"diff --git a/packages/coding-agent/CHANGELOG.md b/packages/coding-agent/CHANGELOG.md",
				"index 1111111..2222222 100644",
				"--- a/packages/coding-agent/CHANGELOG.md",
				"+++ b/packages/coding-agent/CHANGELOG.md",
				"@@ -1,3 +1,3 @@",
				"diff --git a/old/name.ts b/new/name.ts",
				"similarity index 90%",
				"rename from old/name.ts",
				"rename to new/name.ts",
			].join("\n"),
		);

		expect(files).toEqual(["packages/coding-agent/CHANGELOG.md", "new/name.ts"]);
	});
});

describe("validateNativeArchiveListing", () => {
	it("accepts package-root files and directories", () => {
		expect(() => validateNativeArchiveListing(["package/", "package/pi_natives.darwin-arm64.node"])).not.toThrow();
	});

	it.each(["../outside", "package/../../outside", "/tmp/outside", "C:/outside", "package\\outside"])(
		"rejects archive entry %s",
		entry => {
			expect(() => validateNativeArchiveListing([entry])).toThrow(/escapes package root/);
		},
	);
});

describe("ensureNativeAddonDirectoryChain", () => {
	it("fails closed when an ancestor is a symlink", async () => {
		const dir = await makeTempDir();
		const sourceRoot = path.join(dir, "source");
		const outside = path.join(dir, "outside");
		await fs.mkdir(sourceRoot);
		await fs.mkdir(outside);
		await fs.symlink(outside, path.join(sourceRoot, "packages"));

		await expect(
			ensureNativeAddonDirectoryChain(sourceRoot, path.join(sourceRoot, "packages", "natives", "native")),
		).rejects.toThrow(/not a real directory/);
	});
});

describe("replaceNativeAddonFile", () => {
	it("fails closed when the destination is a symlink", async () => {
		const dir = await makeTempDir();
		const sourcePath = path.join(dir, "source.node");
		const targetPath = path.join(dir, "target.node");
		const destinationPath = path.join(dir, "addon.node");
		await fs.writeFile(sourcePath, "new addon");
		await fs.writeFile(targetPath, "untouched");
		await fs.symlink(targetPath, destinationPath);

		await expect(replaceNativeAddonFile(sourcePath, destinationPath)).rejects.toThrow(/symlink/);
		expect(await fs.readFile(targetPath, "utf8")).toBe("untouched");
	});
});

describe("resolvePatchSeries", () => {
	async function makePatchRepo(series: string, patches: readonly string[]): Promise<string> {
		const repo = await makeTempDir();
		await fs.mkdir(path.join(repo, "codeiro", "patches"), { recursive: true });
		await fs.writeFile(path.join(repo, "codeiro", "patches", "series"), series);
		for (const patch of patches) {
			await fs.writeFile(path.join(repo, "codeiro", "patches", patch), "");
		}
		return repo;
	}

	it("resolves series entries relative to the series file, in order, with the base tag", async () => {
		const repo = await makePatchRepo("# base: v17.2.15\n0002-b.patch\n0001-a.patch\n", [
			"0001-a.patch",
			"0002-b.patch",
		]);

		const series = await resolvePatchSeries(repo, "codeiro/patches/series");

		expect(series).toEqual({
			base: "v17.2.15",
			files: [
				path.join(repo, "codeiro", "patches", "0002-b.patch"),
				path.join(repo, "codeiro", "patches", "0001-a.patch"),
			],
		});
	});

	it("resolves a series with no base header, which only costs the three-way fallback", async () => {
		const repo = await makePatchRepo("0001-a.patch\n", ["0001-a.patch"]);

		const series = await resolvePatchSeries(repo, "codeiro/patches/series");

		expect(series.base).toBeUndefined();
		expect(series.files).toEqual([path.join(repo, "codeiro", "patches", "0001-a.patch")]);
	});

	it("fails when the series file is missing", async () => {
		const repo = await makeTempDir();

		await expect(resolvePatchSeries(repo, "codeiro/patches/series")).rejects.toThrow(/Patch series not found/);
	});

	it("fails closed on an empty series instead of building an unpatched binary", async () => {
		const repo = await makePatchRepo("# no patches yet\n", []);

		await expect(resolvePatchSeries(repo, "codeiro/patches/series")).rejects.toThrow(/lists no patches/);
	});

	it("fails when a listed patch is missing", async () => {
		const repo = await makePatchRepo("0001-a.patch\n0002-b.patch\n", ["0001-a.patch"]);

		await expect(resolvePatchSeries(repo, "codeiro/patches/series")).rejects.toThrow(/missing/);
	});

	it("fails when an entry escapes the patch repository", async () => {
		const repo = await makePatchRepo("../../../../etc/passwd\n", []);

		await expect(resolvePatchSeries(repo, "codeiro/patches/series")).rejects.toThrow(/escapes/);
	});

	it("fails when the series path escapes the patch repository", async () => {
		const repo = await makeTempDir();

		await expect(resolvePatchSeries(repo, "../series")).rejects.toThrow(/escapes/);
	});
});

describe("applyPatchSeries", () => {
	// Real repositories rather than mocks: what is under test is whether git
	// can perform the three-way merge, and only git can answer that.
	const GIT_ENV = {
		...process.env,
		GIT_CONFIG_GLOBAL: os.devNull,
		GIT_CONFIG_SYSTEM: os.devNull,
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.com",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.com",
	};

	async function git(dir: string, ...args: string[]): Promise<void> {
		const proc = Bun.spawn(["git", ...args], { cwd: dir, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
		const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`);
	}

	async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
		for (const [name, content] of Object.entries(files)) {
			const file = path.join(dir, name);
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, content);
		}
	}

	const DOC_BASE = [
		"# Changelog",
		"",
		"## Unreleased",
		"- alpha",
		"- beta",
		"- gamma",
		"- delta",
		"- epsilon",
		"",
	].join("\n");
	// The fork's change; `- alpha` sits at line 4, so its hunk carries lines 1-7
	// as context.
	const DOC_FORKED = DOC_BASE.replace("- alpha", "- alpha (fork)");
	// Drift inside that context but on another line: a direct apply refuses it,
	// a three-way merge absorbs it.
	const DOC_DRIFTED = DOC_BASE.replace("- delta", "- delta (upstream)");
	// The same line rewritten differently: no merge can decide this one.
	const DOC_REWRITTEN = DOC_BASE.replace("- alpha", "- alpha (upstream rewrote it)");
	const SRC_BASE = [
		"export const value = 1;",
		"",
		"export function main(): number {",
		"\treturn value;",
		"}",
		"",
	].join("\n");
	const SRC_FORKED = SRC_BASE.replace("value = 1", "value = 2");

	/**
	 * Build an `origin` repository holding the base tag plus one commit per
	 * patch, and a `stage` checkout the series is applied to. `stage` defaults
	 * to the base content, which is the only case where every patch applies
	 * directly.
	 */
	async function makeSeriesFixture(options: {
		base: Record<string, string>;
		commits: readonly { subject: string; files: Record<string, string> }[];
		stage?: Record<string, string>;
	}): Promise<{ origin: string; stage: string; patches: string[]; baseTag: string }> {
		const origin = await makeTempDir();
		await git(origin, "init", "--quiet", "-b", "main");
		await writeFiles(origin, options.base);
		await git(origin, "add", "-A");
		await git(origin, "commit", "--quiet", "-m", "base");
		await git(origin, "tag", "base-tag");
		for (const commit of options.commits) {
			await writeFiles(origin, commit.files);
			await git(origin, "add", "-A");
			await git(origin, "commit", "--quiet", "-m", commit.subject);
		}

		const patchDir = await makeTempDir();
		await git(origin, "format-patch", "--quiet", `-${options.commits.length}`, "-o", patchDir);
		const patches = (await fs.readdir(patchDir)).sort().map(name => path.join(patchDir, name));

		const stage = await makeTempDir();
		await git(stage, "init", "--quiet", "-b", "main");
		await writeFiles(stage, options.stage ?? options.base);
		await git(stage, "add", "-A");
		await git(stage, "commit", "--quiet", "-m", "staged upstream tag");
		return { origin, stage, patches, baseTag: "base-tag" };
	}

	it("applies a clean series without healing anything", async () => {
		const fixture = await makeSeriesFixture({
			base: { "CHANGELOG.md": DOC_BASE, "src.ts": SRC_BASE },
			commits: [
				{ subject: "docs alpha", files: { "CHANGELOG.md": DOC_FORKED } },
				{ subject: "code value", files: { "src.ts": SRC_FORKED } },
			],
		});

		const report = await applyPatchSeries(fixture.stage, fixture.patches, { threeWay: true });

		expect(report).toEqual({ applied: 2, total: 2, healed: [] });
		expect(report.conflict).toBeUndefined();
	});

	it("heals mechanical drift through a three-way merge against the base tag", async () => {
		const fixture = await makeSeriesFixture({
			base: { "CHANGELOG.md": DOC_BASE },
			commits: [{ subject: "docs alpha", files: { "CHANGELOG.md": DOC_FORKED } }],
			stage: { "CHANGELOG.md": DOC_DRIFTED },
		});

		// Without the base objects there is nothing to merge against, which is
		// the state a fresh depth-1 checkout of the new tag is in.
		const direct = await applyPatchSeries(fixture.stage, fixture.patches, { threeWay: false });
		expect(direct.applied).toBe(0);
		expect(direct.conflict?.threeWay).toBe(false);

		expect(await ensureBaseObjects(fixture.stage, fixture.origin, fixture.baseTag)).toBe(true);
		const report = await applyPatchSeries(fixture.stage, fixture.patches, { threeWay: true });

		expect(report.conflict).toBeUndefined();
		expect(report.applied).toBe(1);
		expect(report.healed).toEqual([path.basename(fixture.patches[0])]);
		// Both sides survived: that is what "drift absorbed" has to mean.
		const merged = await fs.readFile(path.join(fixture.stage, "CHANGELOG.md"), "utf8");
		expect(merged).toContain("- alpha (fork)");
		expect(merged).toContain("- delta (upstream)");
	});

	it("reports a documentation-only conflict no merge can resolve", async () => {
		const fixture = await makeSeriesFixture({
			base: { "CHANGELOG.md": DOC_BASE },
			commits: [{ subject: "docs alpha", files: { "CHANGELOG.md": DOC_FORKED } }],
			stage: { "CHANGELOG.md": DOC_REWRITTEN },
		});
		expect(await ensureBaseObjects(fixture.stage, fixture.origin, fixture.baseTag)).toBe(true);

		const report = await applyPatchSeries(fixture.stage, fixture.patches, { threeWay: true });
		const { conflict } = report;
		if (!conflict) throw new Error("expected the series to conflict");

		expect(conflict).toMatchObject({
			patch: path.basename(fixture.patches[0]),
			index: 1,
			total: 1,
			files: ["CHANGELOG.md"],
			docOnly: true,
			threeWay: true,
		});
		expect(conflict.detail).toContain("CHANGELOG.md");
		expect(report.applied).toBe(0);

		const text = formatSeriesConflictReport(conflict, {
			applied: report.applied,
			healed: report.healed.length,
			upstreamTag: "v17.3.0",
			base: fixture.baseTag,
			sourceDir: fixture.stage,
		});
		expect(text).toContain(`Patch 1/1 does not apply: ${conflict.patch}`);
		expect(text).toContain("Scope: documentation only");
		expect(text).toContain("Three-way: attempted against base base-tag");
		expect(text).toContain("Update not applied");
		expect(text).toContain("Recipe: codeiro/docs/rebase-da-serie.md");
	});

	it("does not call a conflict documentation-only when the patch also touches code", async () => {
		const fixture = await makeSeriesFixture({
			base: { "CHANGELOG.md": DOC_BASE, "src.ts": SRC_BASE },
			commits: [{ subject: "feat mixed", files: { "CHANGELOG.md": DOC_FORKED, "src.ts": SRC_FORKED } }],
			stage: { "CHANGELOG.md": DOC_REWRITTEN, "src.ts": SRC_BASE },
		});
		expect(await ensureBaseObjects(fixture.stage, fixture.origin, fixture.baseTag)).toBe(true);

		const report = await applyPatchSeries(fixture.stage, fixture.patches, { threeWay: true });
		const { conflict } = report;
		if (!conflict) throw new Error("expected the series to conflict");

		expect(conflict.files).toEqual(["CHANGELOG.md", "src.ts"]);
		expect(conflict.docOnly).toBe(false);

		const text = formatSeriesConflictReport(conflict, {
			applied: report.applied,
			healed: report.healed.length,
			upstreamTag: "v17.3.0",
			base: fixture.baseTag,
			sourceDir: fixture.stage,
		});
		expect(text).toContain("Scope: code, not only documentation");
		expect(text).toContain("the hunks need a human or agent decision");
	});

	it("treats an unreachable base tag as a run without the three-way fallback", async () => {
		const stage = await makeTempDir();
		await git(stage, "init", "--quiet", "-b", "main");

		expect(await ensureBaseObjects(stage, path.join(stage, "missing-remote.git"), "v0.0.0")).toBe(false);
	});
});

describe("runCodeiroSourceUpdate --check", () => {
	function unusableDeps(): CodeiroUpdateDeps {
		return {
			isMuslLinux: () => {
				throw new Error("check must not inspect the build host");
			},
			verifyBinaryAtPath: () => {
				throw new Error("check must not run a binary");
			},
			replaceBinaryForUpdate: () => {
				throw new Error("check must not replace the binary");
			},
			sweepStaleBackups: () => {
				throw new Error("check must not touch the install directory");
			},
		};
	}

	async function makeInstall(sourceRoot: string): Promise<CodeiroInstall> {
		const dir = await makeTempDir();
		return {
			manifest: { ...VALID_MANIFEST, sourceRoot },
			manifestPath: path.join(dir, CODEIRO_MANIFEST_FILENAME),
			binaryPath: path.join(dir, "omp"),
		};
	}

	function releaseFetch(version: string, seen: string[]) {
		return async (input: string | URL | Request): Promise<Response> => {
			seen.push(String(input));
			return Response.json({ tag_name: `v${version}`, draft: false, prerelease: false });
		};
	}

	const SERIES_HEAD = "1111111111111111111111111111111111111111";
	const stubPatchCommit = async () => SERIES_HEAD;

	async function recordLock(install: CodeiroInstall, patchCommit: string): Promise<void> {
		await fs.writeFile(
			path.join(path.dirname(install.binaryPath), CODEIRO_LOCK_FILENAME),
			JSON.stringify({
				version: "17.2.13",
				upstreamTag: "v17.2.13",
				patchRef: VALID_MANIFEST.patchRef,
				patchCommit,
				builtAt: "2026-08-12T00:00:00.000Z",
			}),
		);
	}

	it("reads the upstream releases/latest endpoint and mutates nothing", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const staging = path.join(await makeTempDir(), "staging");
		const install = await makeInstall(staging);
		const seen: string[] = [];

		await runCodeiroSourceUpdate({
			install,
			force: false,
			check: true,
			deps: unusableDeps(),
			fetchImpl: releaseFetch("999.0.0", seen),
			resolvePatchCommitImpl: stubPatchCommit,
			currentVersion: "17.2.13",
		});

		expect(seen).toEqual(["https://api.github.com/repos/can1357/oh-my-pi/releases/latest"]);
		await expect(fs.stat(staging)).rejects.toThrow();
	});

	it("stops at the up-to-date check when the lock matches the resolved series", async () => {
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		const staging = path.join(await makeTempDir(), "staging");
		const install = await makeInstall(staging);
		await recordLock(install, SERIES_HEAD);

		await runCodeiroSourceUpdate({
			install,
			force: false,
			check: false,
			deps: unusableDeps(),
			fetchImpl: releaseFetch("17.2.13", []),
			resolvePatchCommitImpl: stubPatchCommit,
			currentVersion: "17.2.13",
		});

		expect(logs.some(line => line.includes("Already up to date"))).toBe(true);
		await expect(fs.stat(staging)).rejects.toThrow();
	});

	it("rebuilds when the lock records a different patch ref", async () => {
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		const staging = path.join(await makeTempDir(), "staging");
		const install = await makeInstall(staging);
		await fs.writeFile(
			path.join(path.dirname(install.binaryPath), CODEIRO_LOCK_FILENAME),
			JSON.stringify({
				version: "17.2.13",
				upstreamTag: "v17.2.13",
				patchRef: "codeiro-omp-v17.2.13-c1",
				patchCommit: SERIES_HEAD,
				builtAt: "2026-08-12T00:00:00.000Z",
			}),
		);

		await runCodeiroSourceUpdate({
			install,
			force: false,
			check: true,
			deps: unusableDeps(),
			fetchImpl: releaseFetch("17.2.13", []),
			resolvePatchCommitImpl: stubPatchCommit,
			currentVersion: "17.2.13",
		});

		expect(logs.some(line => line.includes("Already up to date"))).toBe(false);
		await expect(fs.stat(staging)).rejects.toThrow();
	});

	it("stays up to date when the install is ahead of the upstream release", async () => {
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		const staging = path.join(await makeTempDir(), "staging");
		const install = await makeInstall(staging);

		await runCodeiroSourceUpdate({
			install,
			force: false,
			check: false,
			deps: unusableDeps(),
			fetchImpl: releaseFetch("17.2.12", []),
			resolvePatchCommitImpl: stubPatchCommit,
			currentVersion: "17.2.13",
		});

		expect(logs.some(line => line.includes("Already up to date"))).toBe(true);
		await expect(fs.stat(staging)).rejects.toThrow();
	});

	it("rebuilds on the same version when the patch series moved", async () => {
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		const staging = path.join(await makeTempDir(), "staging");
		const install = await makeInstall(staging);
		await recordLock(install, "2222222222222222222222222222222222222222");

		await runCodeiroSourceUpdate({
			install,
			force: false,
			check: true,
			deps: unusableDeps(),
			fetchImpl: releaseFetch("17.2.13", []),
			resolvePatchCommitImpl: stubPatchCommit,
			currentVersion: "17.2.13",
		});

		expect(logs.some(line => line.includes("Patch series moved"))).toBe(true);
		expect(logs.some(line => line.includes("Already up to date"))).toBe(false);
		await expect(fs.stat(staging)).rejects.toThrow();
	});

	it("rebuilds when no lock records what is installed", async () => {
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		const staging = path.join(await makeTempDir(), "staging");
		const install = await makeInstall(staging);

		await runCodeiroSourceUpdate({
			install,
			force: false,
			check: true,
			deps: unusableDeps(),
			fetchImpl: releaseFetch("17.2.13", []),
			resolvePatchCommitImpl: stubPatchCommit,
			currentVersion: "17.2.13",
		});

		expect(logs.some(line => line.includes(CODEIRO_LOCK_FILENAME))).toBe(true);
		expect(logs.some(line => line.includes("Already up to date"))).toBe(false);
		await expect(fs.stat(staging)).rejects.toThrow();
	});

	it("keeps --check read-only even when --force is set", async () => {
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.join(" "));
		});
		const staging = path.join(await makeTempDir(), "staging");
		const install = await makeInstall(staging);

		await runCodeiroSourceUpdate({
			install,
			force: true,
			check: true,
			deps: unusableDeps(),
			fetchImpl: releaseFetch("17.2.13", []),
			resolvePatchCommitImpl: stubPatchCommit,
			currentVersion: "17.2.13",
		});

		expect(logs.some(line => line.includes("Forcing rebuild of 17.2.13"))).toBe(true);
		await expect(fs.stat(staging)).rejects.toThrow();
	});
});

describe("startup notice on a fork install", () => {
	async function stageInstall(options: { name?: string; lock?: unknown; manifest?: unknown }): Promise<string> {
		const dir = await makeTempDir();
		const binaryPath = path.join(dir, options.name ?? "codeiro-omp");
		await fs.writeFile(binaryPath, "#!/bin/sh\n");
		if (options.manifest !== null) {
			await fs.writeFile(
				path.join(dir, CODEIRO_MANIFEST_FILENAME),
				JSON.stringify(options.manifest ?? { ...VALID_MANIFEST, patchRef: "codeiro-omp-v17.2.15-c8" }),
			);
		}
		if (options.lock !== undefined) {
			await fs.writeFile(path.join(dir, CODEIRO_LOCK_FILENAME), JSON.stringify(options.lock));
		}
		return binaryPath;
	}

	it("reads the series ref and the tag the artifact was built from", async () => {
		const binaryPath = await stageInstall({
			lock: {
				version: "17.2.15",
				upstreamTag: "v17.2.15",
				patchRef: "codeiro-omp-v17.2.15-c8",
				patchCommit: "2222222222222222222222222222222222222222",
				builtAt: "2026-08-13T00:00:00.000Z",
			},
		});

		expect(await describeCodeiroInstall(binaryPath)).toEqual({
			patchRef: "codeiro-omp-v17.2.15-c8",
			upstreamTag: "v17.2.15",
		});
	});

	it("still identifies the install when the lock is absent or corrupt", async () => {
		const noLock = await stageInstall({});
		expect(await describeCodeiroInstall(noLock)).toEqual({
			patchRef: "codeiro-omp-v17.2.15-c8",
			upstreamTag: undefined,
		});

		const badLock = await stageInstall({ lock: { version: "17.2.15" } });
		expect((await describeCodeiroInstall(badLock))?.upstreamTag).toBeUndefined();
	});

	it("leaves an upstream install to the upstream text", async () => {
		// No manifest at all, and a manifest next to a foreign executable name:
		// neither may adopt the fork notice.
		expect(await describeCodeiroInstall(await stageInstall({ manifest: null }))).toBeUndefined();
		expect(await describeCodeiroInstall(await stageInstall({ name: "other-tool" }))).toBeUndefined();
		expect(await describeCodeiroInstall(undefined)).toBeUndefined();
	});

	it("does not fail the notice over a manifest that does not parse", async () => {
		const broken = await stageInstall({ manifest: { distribution: "someone-else" } });

		expect(await describeCodeiroInstall(broken)).toBeUndefined();
	});

	it("names the series instead of suggesting a command that cannot work yet", () => {
		const notice = buildUpstreamReleaseNotice("17.3.0", {
			patchRef: "codeiro-omp-v17.2.15-c8",
			upstreamTag: "v17.2.15",
		});

		expect(notice.command).toBeUndefined();
		expect(notice.title).not.toContain("Update Available");
		expect(notice.body).toContain("17.3.0");
		expect(notice.body).toContain("codeiro-omp-v17.2.15-c8");
		expect(notice.body).toContain("(v17.2.15)");
		expect(notice.body).not.toContain("omp update");
		// The distribution name must not read as part of the series name.
		expect(notice.body).not.toContain("codeiro-omp codeiro-omp");
	});

	it("omits the built-from tag when no lock recorded it", () => {
		const notice = buildUpstreamReleaseNotice("17.3.0", { patchRef: "codeiro" });

		expect(notice.body).toContain("series codeiro;");
		expect(notice.body).not.toContain("(");
	});
});
