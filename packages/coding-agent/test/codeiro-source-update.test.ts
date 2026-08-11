import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	CODEIRO_MANIFEST_FILENAME,
	type CodeiroInstall,
	type CodeiroUpdateDeps,
	loadCodeiroInstall,
	parseCodeiroManifest,
	parsePatchSeries,
	resolveLatestStableRelease,
	resolveManifestCandidates,
	resolvePatchSeriesFiles,
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
	])("adopts the running binary %s", (execPath, expected) => {
		expect(resolveManifestCandidates(execPath)).toEqual(expected);
	});

	it.each(["/opt/homebrew/bin/bun", "/usr/local/bin/node", "/opt/codeiro/bin/omp-wrapper"])(
		"ignores a non-omp host process %s",
		execPath => {
			expect(resolveManifestCandidates(execPath)).toEqual([]);
		},
	);

	it("ignores a missing exec path", () => {
		expect(resolveManifestCandidates(undefined)).toEqual([]);
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

describe("resolvePatchSeriesFiles", () => {
	async function makePatchRepo(series: string, patches: readonly string[]): Promise<string> {
		const repo = await makeTempDir();
		await fs.mkdir(path.join(repo, "codeiro", "patches"), { recursive: true });
		await fs.writeFile(path.join(repo, "codeiro", "patches", "series"), series);
		for (const patch of patches) {
			await fs.writeFile(path.join(repo, "codeiro", "patches", patch), "");
		}
		return repo;
	}

	it("resolves series entries relative to the series file, in order", async () => {
		const repo = await makePatchRepo("0002-b.patch\n0001-a.patch\n", ["0001-a.patch", "0002-b.patch"]);

		const files = await resolvePatchSeriesFiles(repo, "codeiro/patches/series");

		expect(files).toEqual([
			path.join(repo, "codeiro", "patches", "0002-b.patch"),
			path.join(repo, "codeiro", "patches", "0001-a.patch"),
		]);
	});

	it("fails when the series file is missing", async () => {
		const repo = await makeTempDir();

		await expect(resolvePatchSeriesFiles(repo, "codeiro/patches/series")).rejects.toThrow(/Patch series not found/);
	});

	it("fails closed on an empty series instead of building an unpatched binary", async () => {
		const repo = await makePatchRepo("# no patches yet\n", []);

		await expect(resolvePatchSeriesFiles(repo, "codeiro/patches/series")).rejects.toThrow(/lists no patches/);
	});

	it("fails when a listed patch is missing", async () => {
		const repo = await makePatchRepo("0001-a.patch\n0002-b.patch\n", ["0001-a.patch"]);

		await expect(resolvePatchSeriesFiles(repo, "codeiro/patches/series")).rejects.toThrow(/missing/);
	});

	it("fails when an entry escapes the patch repository", async () => {
		const repo = await makePatchRepo("../../../../etc/passwd\n", []);

		await expect(resolvePatchSeriesFiles(repo, "codeiro/patches/series")).rejects.toThrow(/escapes/);
	});

	it("fails when the series path escapes the patch repository", async () => {
		const repo = await makeTempDir();

		await expect(resolvePatchSeriesFiles(repo, "../series")).rejects.toThrow(/escapes/);
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
			currentVersion: "17.2.13",
		});

		expect(seen).toEqual(["https://api.github.com/repos/can1357/oh-my-pi/releases/latest"]);
		await expect(fs.stat(staging)).rejects.toThrow();
	});

	it("stops at the up-to-date check without staging anything", async () => {
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
			fetchImpl: releaseFetch("17.2.13", []),
			currentVersion: "17.2.13",
		});

		expect(logs.some(line => line.includes("Already up to date"))).toBe(true);
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
			currentVersion: "17.2.13",
		});

		expect(logs.some(line => line.includes("Forcing rebuild of 17.2.13"))).toBe(true);
		await expect(fs.stat(staging)).rejects.toThrow();
	});
});
