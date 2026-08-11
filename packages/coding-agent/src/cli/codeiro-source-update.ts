/**
 * Codeiro source-build update backend.
 *
 * Opt-in by file presence: everything here activates only when a
 * `codeiro-omp.json` manifest sits next to the running binary. Without that
 * file the caller never enters this module and the upstream updater behaves
 * byte for byte as before.
 *
 * With a manifest the updater must never install an official release
 * artifact, because the fork's behaviour lives in a patch series rather than
 * in any published binary. So `--check` only reads the upstream GitHub
 * `releases/latest` metadata (no mutation at all), and the install path:
 *
 *   1. stages a pristine checkout of that exact stable tag in a directory
 *      outside the install prefix,
 *   2. checks out the patch repository at the pinned ref and applies the
 *      series fail-closed - a missing, empty or non-applying series aborts the
 *      update instead of silently producing an unpatched binary,
 *   3. installs frozen dependencies and compiles the host binary with the
 *      repository's own release build,
 *   4. validates the built artifact's `--version`, then swaps it in through
 *      the same rollback-guarded replacement the upstream binary flow uses.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $env, $which, APP_NAME, compareVersions, isEnoent, isRecord, VERSION } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { theme } from "../modes/theme/theme";
import { isTimeoutError, withTimeoutSignal } from "../utils/fetch-timeout";
import type { BinaryReplacementOptions, InstalledVersionVerification } from "./update-cli";

/** Manifest file that opts an install into the source-build backend. */
export const CODEIRO_MANIFEST_FILENAME = "codeiro-omp.json";

/** Value `distribution` must carry for the manifest to be honoured. */
export const CODEIRO_DISTRIBUTION = "codeiro-omp";

const GITHUB_API = "https://api.github.com";
const RELEASE_METADATA_TIMEOUT_MS = 30_000;

/**
 * Release build artifacts, keyed by the target id understood by
 * `scripts/ci-release-build-binaries.ts`. Mirrors the `targets` table in that
 * script, which is the source of truth for both the id and the output name.
 */
const SOURCE_BUILD_ARTIFACTS: Readonly<Record<string, string>> = {
	"darwin-arm64": "omp-darwin-arm64",
	"darwin-x64": "omp-darwin-x64",
	"linux-x64": "omp-linux-x64",
	"linux-arm64": "omp-linux-arm64",
	"linux-musl-x64": "omp-linux-musl-x64",
	"linux-musl-arm64": "omp-linux-musl-arm64",
	"win32-x64": "omp-windows-x64.exe",
};

/** Where the release build drops its artifacts, relative to the source root. */
const BUILD_OUTPUT_DIR = path.join("packages", "coding-agent", "binaries");

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Pinned description of how to rebuild this install from source. */
export interface CodeiroManifest {
	readonly distribution: typeof CODEIRO_DISTRIBUTION;
	/** `owner/name` of the upstream repository releases are read from. */
	readonly upstreamRepo: string;
	/** Git URL (or local path) of the repository holding the patch series. */
	readonly patchRepo: string;
	/** Branch, tag or commit of {@link patchRepo} to check out. */
	readonly patchRef: string;
	/** Path of the series file inside {@link patchRepo}. */
	readonly patchSeries: string;
	/** Staging root for the build; must live outside the install prefix. */
	readonly sourceRoot: string;
}

/** A manifest plus the binary it governs. */
export interface CodeiroInstall {
	readonly manifest: CodeiroManifest;
	readonly manifestPath: string;
	readonly binaryPath: string;
}

/** Stable upstream release the source build tracks. */
export interface StableRelease {
	readonly tag: string;
	readonly version: string;
}

/** Bun release target selected for the running host. */
export interface SourceBuildTarget {
	/** `--targets` id for `scripts/ci-release-build-binaries.ts`. */
	readonly id: string;
	/** Artifact file name the build writes into the binaries directory. */
	readonly artifact: string;
}

/** Staging directories used by one source build. */
export interface StagingLayout {
	readonly root: string;
	readonly sourceDir: string;
	readonly patchDir: string;
}

/**
 * Install-side services borrowed from the upstream updater.
 *
 * Injected rather than imported so this module never forms a runtime import
 * cycle with `update-cli`, and so tests can drive the pipeline without
 * touching a real binary.
 */
export interface CodeiroUpdateDeps {
	isMuslLinux(): boolean;
	verifyBinaryAtPath(binaryPath: string, expectedVersion: string): Promise<InstalledVersionVerification>;
	replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification>;
	sweepStaleBackups(targetPath: string): Promise<void>;
}

function manifestError(source: string, detail: string): Error {
	return new Error(`Invalid ${CODEIRO_MANIFEST_FILENAME} at ${source}: ${detail}`);
}

function requireString(record: Record<string, unknown>, key: string, source: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw manifestError(source, `\`${key}\` must be a non-empty string`);
	}
	return value.trim();
}

/**
 * Reject values that git would read as an option instead of as a repository,
 * ref or path.
 */
function requireNotOptionLike(value: string, key: string, source: string): void {
	if (value.startsWith("-")) {
		throw manifestError(source, `\`${key}\` must not start with "-"`);
	}
	if (/\s/.test(value)) {
		throw manifestError(source, `\`${key}\` must not contain whitespace`);
	}
}

/**
 * Parse and validate a manifest document.
 *
 * Every field is required: a partially specified manifest would leave the
 * build guessing where the fork's code comes from, and the one guess that is
 * always available - the official release binary - is exactly what must never
 * be installed here. Unknown keys are ignored so a newer manifest stays
 * readable by an older binary.
 */
export function parseCodeiroManifest(value: unknown, source: string): CodeiroManifest {
	if (!isRecord(value)) {
		throw manifestError(source, "expected a JSON object");
	}
	if (value.distribution !== CODEIRO_DISTRIBUTION) {
		throw manifestError(source, `\`distribution\` must be "${CODEIRO_DISTRIBUTION}"`);
	}

	const upstreamRepo = requireString(value, "upstreamRepo", source);
	if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(upstreamRepo)) {
		throw manifestError(source, "`upstreamRepo` must be in `owner/name` form");
	}

	const patchRepo = requireString(value, "patchRepo", source);
	requireNotOptionLike(patchRepo, "patchRepo", source);

	const patchRef = requireString(value, "patchRef", source);
	requireNotOptionLike(patchRef, "patchRef", source);
	if (!/^[A-Za-z0-9._\/-]+$/.test(patchRef) || patchRef.includes("..")) {
		throw manifestError(source, "`patchRef` must be a plain branch, tag or commit");
	}

	const patchSeries = requireString(value, "patchSeries", source);
	requireNotOptionLike(patchSeries, "patchSeries", source);
	assertRelativePath(patchSeries, "patchSeries", source);

	const sourceRoot = requireString(value, "sourceRoot", source);

	return { distribution: CODEIRO_DISTRIBUTION, upstreamRepo, patchRepo, patchRef, patchSeries, sourceRoot };
}

function assertRelativePath(value: string, key: string, source: string): void {
	if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
		throw manifestError(source, `\`${key}\` must be a relative path`);
	}
	if (value.split(/[\\/]/).some(segment => segment === "..")) {
		throw manifestError(source, `\`${key}\` must not escape the patch repository`);
	}
}

/**
 * Binaries whose directory may hold a manifest.
 *
 * Only the running executable is considered, and only when it is actually an
 * `omp` binary: a source run (`bun src/cli.ts`) or a random host process must
 * never adopt a manifest that happens to sit next to its interpreter, and the
 * binary that gets replaced must be the one that is running.
 */
export function resolveManifestCandidates(execPath: string | undefined): string[] {
	if (!execPath) return [];
	const base = path.basename(execPath).toLowerCase();
	const stem = base.endsWith(".exe") ? base.slice(0, -".exe".length) : base;
	return stem === APP_NAME ? [execPath] : [];
}

/**
 * Load the manifest governing one of {@link resolveManifestCandidates}.
 *
 * A missing manifest is the upstream case and returns `undefined`. A manifest
 * that exists but does not parse throws: falling back to the official flow
 * would install an unpatched binary over a fork install.
 */
export async function loadCodeiroInstall(candidates: readonly string[]): Promise<CodeiroInstall | undefined> {
	for (const binaryPath of candidates) {
		const manifestPath = path.join(path.dirname(binaryPath), CODEIRO_MANIFEST_FILENAME);
		let raw: string;
		try {
			raw = await fs.promises.readFile(manifestPath, "utf8");
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			throw manifestError(manifestPath, `not valid JSON (${err instanceof Error ? err.message : String(err)})`);
		}
		return { manifest: parseCodeiroManifest(parsed, manifestPath), manifestPath, binaryPath };
	}
	return undefined;
}

/**
 * Select the stable release from GitHub `releases/latest` metadata.
 *
 * `releases/latest` already excludes drafts and prereleases; both flags are
 * re-checked because the tag drives a source checkout, and a mislabelled
 * release would silently build something that was never published as stable.
 */
export function resolveLatestStableRelease(payload: unknown, repo: string): StableRelease {
	if (!isRecord(payload)) {
		throw new Error(`Invalid GitHub release metadata for ${repo}`);
	}
	if (payload.draft !== false || payload.prerelease !== false) {
		throw new Error(`Latest GitHub release for ${repo} is not a published stable release`);
	}
	const tag = payload.tag_name;
	if (typeof tag !== "string") {
		throw new Error(`Latest GitHub release for ${repo} has no tag name`);
	}
	const version = /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
	if (!version) {
		throw new Error(`Latest GitHub release tag for ${repo} is not a stable version tag: ${tag}`);
	}
	return { tag, version };
}

async function fetchLatestStableRelease(
	repo: string,
	fetchImpl: Fetch = fetch,
	githubToken: string | undefined = $env.GITHUB_TOKEN || $env.GH_TOKEN,
): Promise<StableRelease> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

	let response: Response;
	try {
		response = await fetchImpl(`${GITHUB_API}/repos/${repo}/releases/latest`, {
			headers,
			signal: withTimeoutSignal(RELEASE_METADATA_TIMEOUT_MS),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error("Timed out fetching GitHub release metadata after 30s", { cause: err });
		}
		throw err;
	}
	if ((response.status === 403 && !githubToken) || response.status === 429) {
		throw new Error(
			"GitHub API rate limit exceeded while fetching release metadata; retry later or set GITHUB_TOKEN or GH_TOKEN",
		);
	}
	if (!response.ok) {
		throw new Error(`Failed to fetch GitHub release metadata: ${response.statusText}`);
	}
	return resolveLatestStableRelease(await response.json(), repo);
}

/**
 * Map the running host onto a release build target.
 *
 * The source build reuses the release pipeline rather than a bespoke compile
 * so the rebuilt binary matches what upstream would have shipped for this
 * platform, down to the baseline/musl variant.
 */
export function resolveSourceBuildTarget(platform: string, arch: string, musl: boolean): SourceBuildTarget {
	let id: string;
	switch (platform) {
		case "darwin":
			id = `darwin-${arch}`;
			break;
		case "linux":
			id = musl ? `linux-musl-${arch}` : `linux-${arch}`;
			break;
		case "win32":
			id = `win32-${arch}`;
			break;
		default:
			throw new Error(`Unsupported platform for source builds: ${platform}`);
	}
	const artifact = SOURCE_BUILD_ARTIFACTS[id];
	if (!artifact) {
		throw new Error(`Unsupported platform for source builds: ${platform}/${arch}`);
	}
	return { id, artifact };
}

/** Expand a leading `~` and require the result to be absolute. */
export function expandSourceRoot(sourceRoot: string, homedir: string = os.homedir()): string {
	let expanded = sourceRoot;
	if (expanded === "~") expanded = homedir;
	else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
		expanded = path.join(homedir, expanded.slice(2));
	}
	expanded = path.resolve(expanded);
	if (!path.isAbsolute(expanded)) {
		throw new Error(`Manifest \`sourceRoot\` must resolve to an absolute path: ${sourceRoot}`);
	}
	return expanded;
}

function normalizeForCompare(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(parent: string, child: string): boolean {
	const base = normalizeForCompare(parent);
	const target = normalizeForCompare(child);
	return target === base || target.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`);
}

/**
 * Resolve the staging directories and keep them away from the install prefix.
 *
 * The build must not run inside the directory it will later swap a binary in:
 * a stray `git clean` or a half-finished checkout there would take out the
 * installed binary and its manifest.
 */
export function resolveStagingLayout(
	sourceRoot: string,
	binaryPath: string,
	homedir: string = os.homedir(),
): StagingLayout {
	const root = expandSourceRoot(sourceRoot, homedir);
	const installDir = path.dirname(path.resolve(binaryPath));
	if (isInside(installDir, root) || isInside(root, installDir)) {
		throw new Error(`Manifest \`sourceRoot\` (${root}) must not overlap the install directory (${installDir})`);
	}
	return { root, sourceDir: path.join(root, "source"), patchDir: path.join(root, "patches") };
}

/**
 * Parse a quilt-style series file: one patch path per line, `#` comments and
 * blank lines ignored, order preserved.
 */
export function parsePatchSeries(content: string): string[] {
	const entries: string[] = [];
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		entries.push(trimmed);
	}
	return entries;
}

/**
 * Resolve series entries to absolute patch files inside the patch checkout.
 *
 * Fail-closed on every degenerate case - no series file, no entries, an entry
 * pointing outside the checkout, a missing patch - because each of them would
 * otherwise end with an official, unpatched binary installed as the fork.
 */
export async function resolvePatchSeriesFiles(patchRepoDir: string, seriesPath: string): Promise<string[]> {
	const seriesFile = path.resolve(patchRepoDir, seriesPath);
	if (!isInside(patchRepoDir, seriesFile)) {
		throw new Error(`Patch series ${seriesPath} escapes the patch repository`);
	}
	let content: string;
	try {
		content = await fs.promises.readFile(seriesFile, "utf8");
	} catch (err) {
		if (isEnoent(err)) throw new Error(`Patch series not found: ${seriesFile}`);
		throw err;
	}

	const entries = parsePatchSeries(content);
	if (entries.length === 0) {
		throw new Error(`Patch series ${seriesFile} lists no patches; refusing to build an unpatched binary`);
	}

	const seriesDir = path.dirname(seriesFile);
	const files: string[] = [];
	for (const entry of entries) {
		const file = path.resolve(seriesDir, entry);
		if (!isInside(patchRepoDir, file)) {
			throw new Error(`Patch ${entry} escapes the patch repository`);
		}
		if (!fs.existsSync(file)) {
			throw new Error(`Patch listed in ${seriesFile} is missing: ${file}`);
		}
		files.push(file);
	}
	return files;
}

interface CommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Run a command with its output captured; used for git plumbing. */
async function runQuiet(command: string[], cwd: string): Promise<CommandResult> {
	const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

async function runChecked(command: string[], cwd: string): Promise<string> {
	const result = await runQuiet(command, cwd);
	if (result.exitCode !== 0) {
		const detail = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-8).join("\n");
		throw new Error(`Command failed (${result.exitCode}): ${command.join(" ")}${detail ? `\n${detail}` : ""}`);
	}
	return result.stdout;
}

/** Run a long command with its output streamed; used for install and build. */
async function runStreaming(command: string[], cwd: string): Promise<void> {
	const proc = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
	}
}

function git(dir: string, args: string[]): Promise<string> {
	return runChecked(["git", "-c", "advice.detachedHead=false", ...args], dir);
}

function requireTools(needsBazel: boolean): void {
	const missing: string[] = [];
	if (!$which("git")) missing.push("git");
	if (!$which("bun")) missing.push("bun");
	if (needsBazel && !$which("bazelisk") && !$which("bazel")) missing.push("bazelisk (or bazel)");
	if (missing.length > 0) {
		throw new Error(`Source build requires ${missing.join(", ")} on PATH`);
	}
}

/** Point a staging directory at `url`, creating the repository if needed. */
async function ensureGitRepo(dir: string, url: string): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true });
	if (!fs.existsSync(path.join(dir, ".git"))) {
		await git(dir, ["init", "--quiet"]);
		await git(dir, ["remote", "add", "origin", url]);
		return;
	}
	await git(dir, ["remote", "set-url", "origin", url]);
}

/**
 * Reset a staging checkout onto `revision`.
 *
 * `checkout --force` drops patched tracked files and `clean -fd` drops files
 * a previous series added, so every run starts from the pristine revision.
 * Ignored files are deliberately kept: that is where `node_modules` and the
 * native build cache live, and re-downloading them each run would make the
 * update unusable.
 */
async function resetCheckout(dir: string, revision: string): Promise<void> {
	await git(dir, ["checkout", "--force", "--detach", revision]);
	await git(dir, ["clean", "-fd"]);
}

async function syncTagCheckout(dir: string, url: string, tag: string): Promise<void> {
	await ensureGitRepo(dir, url);
	await git(dir, ["fetch", "--force", "--depth", "1", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
	await resetCheckout(dir, `refs/tags/${tag}`);
}

async function syncRefCheckout(dir: string, url: string, ref: string): Promise<void> {
	await ensureGitRepo(dir, url);
	await git(dir, ["fetch", "--force", "--depth", "1", "origin", ref]);
	await resetCheckout(dir, "FETCH_HEAD");
}

/**
 * Apply the series in order, aborting on the first refusal.
 *
 * `git apply` is used rather than a three-way or fuzzy merge: when the series
 * no longer matches the stable tag the right outcome is a failed update with
 * the old binary still in place, not a silently mismerged build.
 */
async function applyPatchSeries(sourceDir: string, patches: readonly string[]): Promise<void> {
	for (const [index, patch] of patches.entries()) {
		console.log(chalk.dim(`Applying patch ${index + 1}/${patches.length}: ${path.basename(patch)}`));
		const result = await runQuiet(["git", "apply", "--index", "--whitespace=nowarn", "--", patch], sourceDir);
		if (result.exitCode !== 0) {
			throw new Error(
				`Patch ${path.basename(patch)} does not apply to this release; refresh the series against it.\n${result.stderr.trim()}`,
			);
		}
	}
}

/**
 * Rebuild the host binary from the staged, patched source tree.
 *
 * Mirrors the repository's own bootstrap (`bun install` then `build:native`)
 * before delegating to the release build for the single target that matches
 * this host.
 */
async function buildFromSource(sourceDir: string, target: SourceBuildTarget): Promise<string> {
	console.log(chalk.dim("Installing frozen dependencies…"));
	await runStreaming(["bun", "install", "--frozen-lockfile"], sourceDir);

	console.log(chalk.dim("Building native addon…"));
	await runStreaming(["bun", "run", "build:native"], sourceDir);

	console.log(chalk.dim(`Building ${APP_NAME} for ${target.id}…`));
	await runStreaming(["bun", "scripts/ci-release-build-binaries.ts", "--targets", target.id], sourceDir);

	const artifactPath = path.join(sourceDir, BUILD_OUTPUT_DIR, target.artifact);
	if (!fs.existsSync(artifactPath)) {
		throw new Error(`Source build did not produce ${artifactPath}`);
	}
	return artifactPath;
}

/**
 * Install a freshly built artifact over the running binary.
 *
 * The artifact is copied next to the target first so the swap is a rename on
 * the same filesystem, then handed to the upstream replacement helper, which
 * keeps a backup and restores it if the installed binary fails verification.
 */
async function installBuiltBinary(
	artifactPath: string,
	install: CodeiroInstall,
	release: StableRelease,
	deps: CodeiroUpdateDeps,
): Promise<void> {
	const targetPath = install.binaryPath;
	const tempPath = `${targetPath}.new`;
	const backupPath = `${targetPath}.${Date.now()}.${process.pid}.bak`;

	console.log(chalk.dim("Installing update..."));
	try {
		await fs.promises.copyFile(artifactPath, tempPath);
		await fs.promises.chmod(tempPath, 0o755);
	} catch (err) {
		await fs.promises.unlink(tempPath).catch(() => {});
		throw err;
	}

	await deps.replaceBinaryForUpdate({
		targetPath,
		tempPath,
		backupPath,
		expectedVersion: release.version,
		verifyInstalledVersion: expectedVersion => deps.verifyBinaryAtPath(targetPath, expectedVersion),
	});
	await deps.sweepStaleBackups(targetPath);
}

/**
 * Run the source-build update for a manifest-governed install.
 *
 * `check` short-circuits before any staging directory is touched, so
 * `omp update --check` on a fork install is a pure read of upstream release
 * metadata.
 */
export async function runCodeiroSourceUpdate(options: {
	install: CodeiroInstall;
	force: boolean;
	check: boolean;
	deps: CodeiroUpdateDeps;
	fetchImpl?: Fetch;
	githubToken?: string;
	currentVersion?: string;
}): Promise<void> {
	const { install, deps } = options;
	const manifest = install.manifest;
	const currentVersion = options.currentVersion ?? VERSION;

	console.log(chalk.dim(`Source build: ${manifest.upstreamRepo} + ${manifest.patchRepo}@${manifest.patchRef}`));

	const release = await fetchLatestStableRelease(manifest.upstreamRepo, options.fetchImpl, options.githubToken);
	const comparison = compareVersions(release.version, currentVersion);

	if (comparison <= 0 && !options.force) {
		console.log(chalk.green(`${theme.status.success} Already up to date`));
		return;
	}
	if (comparison > 0) {
		console.log(chalk.cyan(`New stable release available: ${release.version}`));
	} else {
		console.log(chalk.yellow(`Forcing rebuild of ${release.version}`));
	}
	if (options.check) return;

	const target = resolveSourceBuildTarget(process.platform, process.arch, deps.isMuslLinux());
	const staging = resolveStagingLayout(manifest.sourceRoot, install.binaryPath);
	requireTools(process.platform !== "win32");

	await fs.promises.mkdir(staging.root, { recursive: true });

	console.log(chalk.dim(`Staging ${manifest.upstreamRepo}@${release.tag} in ${staging.sourceDir}`));
	await syncTagCheckout(staging.sourceDir, `https://github.com/${manifest.upstreamRepo}.git`, release.tag);

	console.log(chalk.dim(`Fetching patches from ${manifest.patchRepo}@${manifest.patchRef}`));
	await syncRefCheckout(staging.patchDir, manifest.patchRepo, manifest.patchRef);

	const patches = await resolvePatchSeriesFiles(staging.patchDir, manifest.patchSeries);
	await applyPatchSeries(staging.sourceDir, patches);

	const artifactPath = await buildFromSource(staging.sourceDir, target);

	const verification = await deps.verifyBinaryAtPath(artifactPath, release.version);
	if (!verification.ok) {
		throw new Error(
			`Built binary reports ${verification.actual ?? "an unreadable version"} (expected ${release.version}); not installing`,
		);
	}

	await installBuiltBinary(artifactPath, install, release, deps);

	console.log(chalk.green(`\n${theme.status.success} Updated to ${release.version} (source build)`));
	console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
}
