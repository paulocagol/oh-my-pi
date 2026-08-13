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
 *      series, healing mechanical drift through a three-way merge against the
 *      series' own base tag and failing closed on anything else - a missing,
 *      empty or genuinely conflicting series aborts the update with a report
 *      instead of silently producing an unpatched or mismerged binary,
 *   3. installs frozen dependencies and compiles the host binary with the
 *      repository's own release build,
 *   4. validates the built artifact's `--version`, then swaps it in through
 *      the same rollback-guarded replacement the upstream binary flow uses.
 */

import { createHash } from "node:crypto";
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

/** Build record written next to an installed binary; see {@link CodeiroInstallLock}. */
export const CODEIRO_LOCK_FILENAME = "codeiro-omp.lock.json";

const GITHUB_API = "https://api.github.com";
const NPM_REGISTRY = "https://registry.npmjs.org";
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
	if (!/^[A-Za-z0-9._/-]+$/.test(patchRef) || patchRef.includes("..")) {
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
 * Only the running executable is considered, and only when its name is one the
 * distribution actually installs: upstream ships `omp`, the fork ships
 * `codeiro-omp`. A source run (`bun src/cli.ts`) or a random host process must
 * never adopt a manifest that happens to sit next to its interpreter, and the
 * binary that gets replaced must be the one that is running. The list stays a
 * whitelist for that reason - an install renamed to anything else keeps the
 * official flow.
 */
export function resolveManifestCandidates(execPath: string | undefined): string[] {
	if (!execPath) return [];
	const base = path.basename(execPath).toLowerCase();
	const stem = base.endsWith(".exe") ? base.slice(0, -".exe".length) : base;
	return stem === APP_NAME || stem === CODEIRO_DISTRIBUTION ? [execPath] : [];
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
 * Read the `# base: <tag>` header a series carries.
 *
 * That header is what makes a three-way fallback possible at all: the
 * pre-image blobs the patches name in their `index` lines live in that tag,
 * and nothing else in this flow knows which tag it is. Anything that is not a
 * plain ref name is treated as absent - a bogus header must not become a git
 * argument, and no base is ever inferred from somewhere else.
 */
export function parsePatchSeriesBase(content: string): string | undefined {
	for (const line of content.split(/\r?\n/)) {
		const match = /^#\s*base:\s*(\S+)$/.exec(line.trim());
		if (!match) continue;
		const base = match[1];
		return /^[\w.\-/]+$/.test(base) && !base.includes("..") ? base : undefined;
	}
	return undefined;
}

/** A series file: the upstream tag it was generated against, plus its patches. */
export interface PatchSeries {
	/** Tag from the `# base: <tag>` header; absent when the series states none. */
	readonly base?: string;
	/** Absolute patch files, in application order. */
	readonly files: readonly string[];
}

/**
 * Read a series file and resolve its entries to absolute patch files inside
 * the patch checkout.
 *
 * Fail-closed on every degenerate case - no series file, no entries, an entry
 * pointing outside the checkout, a missing patch - because each of them would
 * otherwise end with an official, unpatched binary installed as the fork. A
 * missing base header is not degenerate: it only costs the three-way
 * fallback.
 */
export async function resolvePatchSeries(patchRepoDir: string, seriesPath: string): Promise<PatchSeries> {
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
	return { base: parsePatchSeriesBase(content), files };
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
async function runStreaming(command: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<void> {
	const proc = Bun.spawn(command, { cwd, env, stdout: "inherit", stderr: "inherit" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
	}
}

function git(dir: string, args: string[]): Promise<string> {
	return runChecked(["git", "-c", "advice.detachedHead=false", ...args], dir);
}
/**
 * Places a `bun` good enough to build from source can be, beyond `PATH`.
 *
 * The host binary is standalone, so the person running the update has no
 * reason to keep a `bun` on their interactive `PATH` - on this machine it
 * lives under a version manager, and the update died on `requireTools`
 * before touching a single patch. Each candidate is a documented install
 * location, in the order that answers "which bun did the user mean": the
 * explicit env var of the official installer, its default prefix, then the
 * version manager's own answer for this directory.
 */
export async function bunCandidates(cwd: string): Promise<string[]> {
	const found = $which("bun");
	if (found) return [found];

	const candidates: string[] = [];
	const bunInstall = $env.BUN_INSTALL;
	if (bunInstall) candidates.push(path.join(bunInstall, "bin", "bun"));
	const home = $env.HOME;
	if (home) {
		candidates.push(path.join(home, ".bun", "bin", "bun"));
		candidates.push(path.join(home, ".local", "share", "mise", "shims", "bun"));
	}

	// `mise which` answers for a directory, so it resolves the very toolchain
	// the source tree pins - but only when the config is trusted, which is why
	// the plain shim above is asked for too.
	if ($which("mise")) {
		const resolved = await runQuiet(["mise", "which", "bun"], cwd);
		if (resolved.exitCode === 0) {
			const line = resolved.stdout.trim();
			if (line) candidates.push(line);
		}
	}
	return candidates;
}

/**
 * Resolve the toolchain the source build needs, or explain what is missing.
 *
 * Returns the `bun` to invoke: an absolute path when it came from outside
 * `PATH`, so every child process gets the same one this check approved.
 */
export async function requireTools(cwd: string): Promise<string> {
	if (!$which("git")) throw new Error("Source build requires git on PATH");

	const candidates = await bunCandidates(cwd);
	for (const candidate of candidates) {
		if (candidate === "bun" || fs.existsSync(candidate)) return candidate;
	}
	throw new Error(
		[
			"Source build requires bun, which is not on PATH.",
			"  Looked for: PATH, $BUN_INSTALL/bin/bun, ~/.bun/bin/bun, mise shims, `mise which bun`.",
			"  Install it (https://bun.sh) or expose the one you have, e.g. `mise exec bun -- omp update`.",
		].join("\n"),
	);
}

/**
 * Validate the path names emitted by `tar -t` before extraction.
 *
 * The native leaf is published and digest-verified, but archive contents still
 * need a boundary check: a validly signed tarball can contain `../` entries or
 * links that escape the temporary directory.
 */
export function validateNativeArchiveListing(entries: readonly string[]): void {
	for (const entry of entries) {
		if (entry.length === 0) continue;
		const normalized = path.posix.normalize(entry);
		if (
			entry.includes("\\") ||
			path.posix.isAbsolute(entry) ||
			/^[A-Za-z]:[\\/]/.test(entry) ||
			normalized !== entry ||
			(normalized !== "package" && !normalized.startsWith("package/"))
		) {
			throw new Error(`Native archive entry escapes package root: ${entry}`);
		}
	}
}

/**
 * Create and validate every directory between the staging root and the native
 * addon root. A check of only the leaf would still follow a symlink in
 * `packages` or `natives`.
 */
export async function ensureNativeAddonDirectoryChain(rootDir: string, targetDir: string): Promise<void> {
	const relative = path.relative(rootDir, targetDir);
	if (
		relative.length === 0 ||
		path.isAbsolute(relative) ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`)
	) {
		throw new Error(`Native addon root escapes staging root: ${targetDir}`);
	}
	if (!(await fs.promises.lstat(rootDir)).isDirectory()) {
		throw new Error(`Native addon staging root is not a real directory: ${rootDir}`);
	}
	let current = rootDir;
	for (const segment of relative.split(path.sep)) {
		current = path.join(current, segment);
		await fs.promises.mkdir(current, { recursive: true });
		if (!(await fs.promises.lstat(current)).isDirectory()) {
			throw new Error(`Native addon path component is not a real directory: ${current}`);
		}
	}
}

/**
 * Replace an extracted native addon without following a destination symlink.
 *
 * The temporary file and the final rename stay in the checked directory, so
 * the destination is replaced atomically instead of being opened through a
 * pre-existing link.
 */
export async function replaceNativeAddonFile(sourcePath: string, destinationPath: string): Promise<void> {
	const parentDir = path.dirname(destinationPath);
	const parentStat = await fs.promises.lstat(parentDir);
	if (!parentStat.isDirectory()) {
		throw new Error(`Native addon destination directory is not a real directory: ${parentDir}`);
	}
	const sourceStat = await fs.promises.lstat(sourcePath);
	if (!sourceStat.isFile()) {
		throw new Error(`Native addon source is not a regular file: ${sourcePath}`);
	}
	let destinationStat: fs.Stats | undefined;
	try {
		destinationStat = await fs.promises.lstat(destinationPath);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	if (destinationStat?.isSymbolicLink()) {
		throw new Error(`Refusing to overwrite native addon symlink: ${destinationPath}`);
	}
	if (destinationStat && !destinationStat.isFile()) {
		throw new Error(`Native addon destination is not a regular file: ${destinationPath}`);
	}
	const tempDir = await fs.promises.mkdtemp(path.join(parentDir, ".codeiro-native-install-"));
	const tempPath = path.join(tempDir, path.basename(destinationPath));
	try {
		await fs.promises.copyFile(sourcePath, tempPath);
		await fs.promises.rename(tempPath, destinationPath);
	} finally {
		await fs.promises.rm(tempDir, { recursive: true, force: true });
	}
}

async function installPublishedNativeAddon(
	sourceDir: string,
	target: SourceBuildTarget,
	version: string,
): Promise<void> {
	const tag = target.id.startsWith("linux-musl-") ? target.id.slice("linux-musl-".length) : target.id;
	const packageName = `@oh-my-pi/pi-natives-${tag}`;
	const encodedName = encodeURIComponent(packageName);
	const metadataResponse = await fetch(`${NPM_REGISTRY}/${encodedName}/${version}`, {
		signal: withTimeoutSignal(RELEASE_METADATA_TIMEOUT_MS),
	});
	if (!metadataResponse.ok) {
		throw new Error(`Failed to fetch ${packageName}@${version}: ${metadataResponse.statusText}`);
	}
	const metadata = (await metadataResponse.json()) as {
		version?: unknown;
		main?: unknown;
		dist?: { tarball?: unknown; integrity?: unknown };
	};
	if (metadata.version !== version || typeof metadata.dist?.tarball !== "string") {
		throw new Error(`Malformed npm metadata for ${packageName}@${version}`);
	}
	const integrity = metadata.dist.integrity;
	if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+=*$/.test(integrity)) {
		throw new Error(`Missing sha512 integrity for ${packageName}@${version}`);
	}
	const tarballResponse = await fetch(metadata.dist.tarball, {
		signal: withTimeoutSignal(RELEASE_METADATA_TIMEOUT_MS),
	});
	if (!tarballResponse.ok) {
		throw new Error(`Failed to download ${packageName}@${version}: ${tarballResponse.statusText}`);
	}
	const tarball = new Uint8Array(await tarballResponse.arrayBuffer());
	const actualIntegrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
	if (actualIntegrity !== integrity) {
		throw new Error(`Integrity mismatch for ${packageName}@${version}`);
	}

	const nativeRoot = path.join(sourceDir, "packages", "natives", "native");
	const tempDir = path.join(sourceDir, ".codeiro-native");
	await fs.promises.rm(tempDir, { recursive: true, force: true });
	await fs.promises.mkdir(tempDir, { recursive: true });
	const tarballPath = path.join(tempDir, "native.tgz");
	try {
		await fs.promises.writeFile(tarballPath, tarball);
		const listing = await runChecked(["tar", "-tzf", tarballPath], sourceDir);
		validateNativeArchiveListing(listing.split(/\r?\n/));
		const details = await runChecked(["tar", "-tvzf", tarballPath], sourceDir);
		for (const line of details.split(/\r?\n/)) {
			if (line.length > 0 && line[0] !== "-" && line[0] !== "d") {
				throw new Error(`Native archive contains a non-regular entry: ${line}`);
			}
		}
		await runChecked(["tar", "-xzf", tarballPath, "-C", tempDir], sourceDir);
		const packageDir = path.join(tempDir, "package");
		const entries = (await fs.promises.readdir(packageDir)).filter(entry => entry.endsWith(".node"));
		if (entries.length === 0) {
			throw new Error(`Native package ${packageName}@${version} contains no addon`);
		}
		await ensureNativeAddonDirectoryChain(sourceDir, nativeRoot);
		for (const entry of entries) {
			const addonPath = path.join(packageDir, entry);
			if (!(await fs.promises.lstat(addonPath)).isFile()) {
				throw new Error(`Native archive addon is not a regular file: ${entry}`);
			}
			await replaceNativeAddonFile(addonPath, path.join(nativeRoot, entry));
		}
	} finally {
		await fs.promises.rm(tempDir, { recursive: true, force: true });
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
 * Bring the series' base tag objects into the staging repository.
 *
 * The staging checkout is a depth-1 fetch of the *new* tag, so the pre-image
 * blobs the patches name in their `index` lines are absent and
 * `git apply --3way` refuses with `repository lacks the necessary blob to
 * perform 3-way merge` before falling back to a direct apply. Measured against
 * v17.3.0: without this fetch nothing heals; with it the whole CHANGELOG drift
 * of the series absorbs itself. Depth 1 is enough - only the blobs of that one
 * tree are ever read - and the objects are anchored under `refs/codeiro/` so a
 * later run finds them already there.
 *
 * Best-effort by design: a base tag that was deleted upstream, or a network
 * that is down for this one extra fetch, must not fail an update that a direct
 * apply can still complete. Exported so a test can prove the refspec against a
 * real repository - the whole fallback is worthless if it is wrong.
 */
export async function ensureBaseObjects(sourceDir: string, url: string, base: string): Promise<boolean> {
	const result = await runQuiet(
		["git", "fetch", "--no-tags", "--force", "--depth", "1", url, `refs/tags/${base}:refs/codeiro/series-base`],
		sourceDir,
	);
	return result.exitCode === 0;
}

/** A patch of the series that did not apply, with what a decision needs. */
export interface PatchConflict {
	/** Basename of the patch file, e.g. `0009-feat-....patch`. */
	readonly patch: string;
	/** Position in the series, 1-based, and the total. */
	readonly index: number;
	readonly total: number;
	/** Paths the patch touches, in the order the diff names them. */
	readonly files: readonly string[];
	/** Every touched path is documentation (`CHANGELOG.md` or any `*.md`). */
	readonly docOnly: boolean;
	/** The three-way apply was attempted. */
	readonly threeWay: boolean;
	/** Raw git output, for whoever wants to read the hunk. */
	readonly detail: string;
}

/** Outcome of applying the whole series. */
export interface SeriesApplyReport {
	readonly applied: number;
	readonly total: number;
	/** Patches that only applied through a three-way merge - drift absorbed. */
	readonly healed: readonly string[];
	/** Empty when the whole series applied. */
	readonly conflict?: PatchConflict;
}

/**
 * Post-image path of a `diff --git` header, quoted or not.
 *
 * Even a deletion names the real path on both sides, so the `b/` side is
 * always the file the patch is about.
 */
const DIFF_GIT_HEADER = /^diff --git "?a\/.+?"? "?b\/(.+?)"?$/;

/**
 * Paths a patch touches, read from the patch file itself.
 *
 * Parsing the file rather than asking git keeps this available in the only
 * case that needs it: the patch did not apply, so no tree reflects it.
 */
export function parsePatchFiles(content: string): string[] {
	const files: string[] = [];
	for (const line of content.split("\n")) {
		const match = DIFF_GIT_HEADER.exec(line);
		if (match) files.push(match[1]);
	}
	return files;
}

/**
 * Apply the series in order, healing mechanical drift and stopping at the
 * first real conflict.
 *
 * A patch that no longer applies directly gets a second chance through
 * `git apply --3way`, which is only useful once the base tag objects are
 * present; `options.threeWay` is the caller's answer to whether they are. The
 * fallback absorbs drift - a series hunk landing at a different offset, a
 * CHANGELOG the new tag already rewrote - and never a semantic conflict, which
 * still needs a decision.
 *
 * A conflict is returned, not thrown: the caller owns both the report and the
 * fail-closed abort, so the installed binary stays untouched. The refused
 * patch may leave conflict markers in the staging tree, deliberately - that is
 * what an agent following the rebase recipe reads - and the next run's
 * `resetCheckout` discards them.
 */
export async function applyPatchSeries(
	sourceDir: string,
	patches: readonly string[],
	options: { readonly threeWay: boolean },
): Promise<SeriesApplyReport> {
	const total = patches.length;
	const healed: string[] = [];
	for (const [index, patch] of patches.entries()) {
		const name = path.basename(patch);
		console.log(chalk.dim(`Applying patch ${index + 1}/${total}: ${name}`));
		const direct = await runQuiet(["git", "apply", "--index", "--whitespace=nowarn", "--", patch], sourceDir);
		if (direct.exitCode === 0) continue;

		const merged = options.threeWay
			? await runQuiet(["git", "apply", "--index", "--3way", "--whitespace=nowarn", "--", patch], sourceDir)
			: undefined;
		if (merged?.exitCode === 0) {
			healed.push(name);
			// Deliberately sober: in a version bump this is the common outcome
			// for the series' documentation hunks, not an anomaly.
			console.log(chalk.dim("  applied by three-way merge; mechanical drift absorbed"));
			continue;
		}

		const failure = merged ?? direct;
		const files = parsePatchFiles(await fs.promises.readFile(patch, "utf8").catch(() => ""));
		return {
			applied: index,
			total,
			healed,
			conflict: {
				patch: name,
				index: index + 1,
				total,
				files,
				// An unreadable patch yields no paths, and no paths is not
				// documentation: claiming `docOnly` there would understate a
				// conflict nobody has seen.
				docOnly: files.length > 0 && files.every(file => file.toLowerCase().endsWith(".md")),
				threeWay: options.threeWay,
				detail: failure.stderr.trim() || failure.stdout.trim(),
			},
		};
	}
	return { applied: total, total, healed };
}

/** Recipe an agent follows to rebase the series onto a new upstream tag. */
export const REBASE_RECIPE_PATH = "codeiro/docs/rebase-da-serie.md";

/**
 * Slash command that carries out the whole cycle from inside the agent.
 *
 * A rebase needs judgement - reading two versions of a hunk and deciding what
 * the fork meant - which is work, not a step. This command owns that work and
 * calls this very updater at the end, so the mechanical half stays here where
 * it is fail-closed and reversible.
 */
export const SERIES_REBASE_COMMAND = "/omp-update";

/** What a conflict report needs beyond the conflict itself. */
export interface SeriesConflictContext {
	/** Patches that applied before the conflict. */
	readonly applied: number;
	/** How many of those needed the three-way fallback. */
	readonly healed: number;
	/** Upstream tag the series was applied to. */
	readonly upstreamTag: string;
	/** Base tag from the series header, when it has one. */
	readonly base?: string;
	/** Staging tree holding the refused patch. */
	readonly sourceDir: string;
}

/**
 * Compose the report whoever picks this up acts on.
 *
 * Plain text on purpose: this is the handoff to a human or an agent, so it
 * says which patch, which files, whether the drift is only documentation,
 * whether the three-way fallback already had its turn, and where the refused
 * tree is - then closes with a verdict that does not invite a retry, because
 * re-running cannot resolve a conflict.
 */
export function formatSeriesConflictReport(conflict: PatchConflict, context: SeriesConflictContext): string {
	let threeWay: string;
	if (conflict.threeWay) {
		threeWay = `attempted against base ${context.base} and still conflicts`;
	} else if (context.base) {
		threeWay = `not possible - base tag ${context.base} could not be fetched, so only a direct apply was tried`;
	} else {
		threeWay = "not attempted - the series has no `# base: <tag>` header, so the pre-image blobs are unknown";
	}
	const reason = conflict.docOnly
		? `${conflict.patch} rewrites only documentation, but its hunks no longer match ${context.upstreamTag}; they have to be regenerated against that tag.`
		: `${conflict.patch} conflicts with ${context.upstreamTag} in code; the hunks need a human or agent decision before the fork can build on this tag.`;
	const lines = [
		`${theme.status.error} Patch ${conflict.index}/${conflict.total} does not apply: ${conflict.patch}`,
		`  Files (${conflict.files.length}):`,
		...(conflict.files.length > 0 ? conflict.files.map(file => `    ${file}`) : ["    <unreadable patch>"]),
		`  Scope: ${conflict.docOnly ? "documentation only - mechanical text drift" : "code, not only documentation"}`,
		`  Three-way: ${threeWay}`,
		`  Progress: ${context.applied}/${conflict.total} patches applied, ${context.healed} healed by three-way`,
		`  Staging tree: ${context.sourceDir}`,
	];
	if (conflict.detail) {
		lines.push("  git:", ...conflict.detail.split("\n").map(line => `    ${line}`));
	}
	lines.push(
		"",
		`${theme.status.error} Update not applied`,
		`  Reason: ${reason}`,
		`  Recipe: ${REBASE_RECIPE_PATH}`,
		`  Next: ${SERIES_REBASE_COMMAND} inside the agent - it rebases the series, resolves this, and runs the update.`,
		"  Re-running this command cannot change the outcome; the series has to be rebased first.",
	);
	return lines.join("\n");
}

/**
 * Abort whose verdict has already been printed in full.
 *
 * `update-cli` exits non-zero without adding its generic failure line, so the
 * report stays the last thing on screen instead of being buried under a
 * duplicate of its own one-line reason.
 */
export class CodeiroUpdateAborted extends Error {}

/**
 * Rebuild the host binary from the staged, patched source tree.
 *
 * Mirrors the repository's own bootstrap (`bun install` plus the published
 * platform native leaf) before delegating to the release build for the single
 * target that matches this host.
 */
async function buildFromSource(
	sourceDir: string,
	target: SourceBuildTarget,
	version: string,
	bun: string,
): Promise<string> {
	console.log(chalk.dim("Installing frozen dependencies…"));
	await runStreaming([bun, "install", "--frozen-lockfile"], sourceDir);

	console.log(chalk.dim(`Installing native addon ${version}…`));
	await installPublishedNativeAddon(sourceDir, target, version);

	const preservedOutputDir = path.join(sourceDir, ".codeiro-build-output");
	console.log(chalk.dim(`Building ${APP_NAME} for ${target.id}…`));
	await runStreaming([bun, "scripts/ci-release-build-binaries.ts", "--targets", target.id], sourceDir, {
		...Bun.env,
		OMP_BUILD_OUTPUT_DIR: preservedOutputDir,
	});

	const artifactPath = path.join(preservedOutputDir, target.artifact);
	if (!fs.existsSync(artifactPath)) {
		throw new Error(`Source build did not preserve ${artifactPath}`);
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
 * Record of what the installed binary was actually built from.
 *
 * The upstream version alone cannot identify a fork artifact: a new patch
 * series over the same upstream tag produces a different binary carrying the
 * same `--version`. The lock closes that gap by pinning the resolved patch
 * commit, so a series bump rebuilds without `--force`.
 */
interface CodeiroInstallLock {
	readonly version: string;
	readonly upstreamTag: string;
	readonly patchRef: string;
	readonly patchCommit: string;
	readonly builtAt: string;
}

const lockPathFor = (binaryPath: string): string => path.join(path.dirname(binaryPath), CODEIRO_LOCK_FILENAME);

/**
 * Read the lock next to an installed binary.
 *
 * Anything unreadable, malformed or incomplete reads as "unknown build", which
 * forces a rebuild: a stale lock must never suppress one, and the rebuild is
 * idempotent.
 */
async function readInstallLock(binaryPath: string): Promise<CodeiroInstallLock | undefined> {
	let raw: string;
	try {
		raw = await fs.promises.readFile(lockPathFor(binaryPath), "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const fields = ["version", "upstreamTag", "patchRef", "patchCommit", "builtAt"] as const;
	const lock: Record<string, string> = {};
	for (const key of fields) {
		const value = parsed[key];
		if (typeof value !== "string" || value.length === 0) return undefined;
		lock[key] = value;
	}
	return lock as unknown as CodeiroInstallLock;
}

/**
 * Write the lock after a successful swap.
 *
 * Ordered after {@link installBuiltBinary} on purpose: if the swap fails the
 * old binary stays in place and so does the lock describing it. A write
 * failure only costs one redundant rebuild, so it warns instead of aborting an
 * update that already succeeded.
 */
async function writeInstallLock(binaryPath: string, lock: CodeiroInstallLock): Promise<void> {
	const target = lockPathFor(binaryPath);
	const tempPath = `${target}.tmp.${process.pid}`;
	try {
		await fs.promises.writeFile(tempPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
		await fs.promises.rename(tempPath, target);
	} catch (err) {
		await fs.promises.unlink(tempPath).catch(() => {});
		console.warn(chalk.yellow(`Could not record ${CODEIRO_LOCK_FILENAME}: ${err}`));
	}
}

/** What the running install is, when it is a fork install. */
export interface CodeiroInstallIdentity {
	/** Ref of the patch series this binary was provisioned with. */
	readonly patchRef: string;
	/** Upstream tag the installed artifact was built from, when recorded. */
	readonly upstreamTag?: string;
}

/**
 * Identify the running install without touching the network.
 *
 * The startup version check compares the local version against the npm
 * registry, which knows nothing about this distribution. On a fork install
 * that comparison is not actionable: `omp update` rebuilds from the upstream
 * `releases/latest` tag and applies the series fail-closed, so a release the
 * series was never rebased onto aborts the update. Reading the manifest and
 * the lock is enough to say so, and both are local files.
 */
export async function describeCodeiroInstall(
	execPath: string | undefined,
): Promise<CodeiroInstallIdentity | undefined> {
	let install: CodeiroInstall | undefined;
	try {
		install = await loadCodeiroInstall(resolveManifestCandidates(execPath));
	} catch {
		// A manifest that does not parse is fatal for an update, but here it
		// would only cost the notification: fall back to the upstream text.
		return undefined;
	}
	if (!install) return undefined;
	const lock = await readInstallLock(install.binaryPath);
	return { patchRef: install.manifest.patchRef, upstreamTag: lock?.upstreamTag };
}

/** Startup notice text; `command` absent means there is nothing to run. */
export interface UpstreamReleaseNotice {
	readonly title: string;
	readonly body: string;
	readonly command?: string;
}

/**
 * Compose the startup notice for a fork install.
 *
 * It deliberately does not suggest the bare `omp update`: on this distribution
 * that command only produces the new release once the series has been rebased
 * onto its tag, and suggesting it before that turns a working install into a
 * failed command the user has to interpret. What it suggests instead is the
 * agent command that owns the rebase and then runs the update itself, which is
 * the only path that can actually end in a new binary.
 */
export function buildUpstreamReleaseNotice(
	newVersion: string,
	identity: CodeiroInstallIdentity,
): UpstreamReleaseNotice {
	const base = identity.upstreamTag ? ` (${identity.upstreamTag})` : "";
	return {
		title: "Upstream release available",
		body: `${newVersion} upstream. This ${CODEIRO_DISTRIBUTION} install uses series ${identity.patchRef}${base}, which has to be rebased onto the new tag first.`,
		command: SERIES_REBASE_COMMAND,
	};
}

/**
 * Resolve `patchRef` to a commit on the patch remote.
 *
 * Tags are dereferenced (`^{}`) so an annotated tag and its commit compare
 * equal, and a moving branch resolves to whatever it points at right now -
 * which is exactly what makes the lock work for both kinds of ref.
 */
export function parseLsRemote(stdout: string, ref: string): string {
	const rows = stdout
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => line.split(/\s+/, 2) as [string, string])
		.filter(([commit]) => /^[0-9a-f]{40}$/.test(commit));
	const exact = rows.find(([, name]) => name === `refs/tags/${ref}^{}`);
	if (exact) return exact[0];
	const match = rows.find(([, name]) => name === `refs/tags/${ref}` || name === `refs/heads/${ref}` || name === ref);
	if (match) return match[0];
	throw new Error(`Patch ref \`${ref}\` not found on the patch repository`);
}

/** Resolve `patchRef` on the patch remote; `^{}` makes annotated tags compare equal. */
async function resolvePatchCommit(patchRepo: string, patchRef: string): Promise<string> {
	const stdout = await runChecked(["git", "ls-remote", patchRepo, patchRef, `${patchRef}^{}`], os.tmpdir());
	return parseLsRemote(stdout, patchRef);
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
	/** Test seam for {@link resolvePatchCommit}; production always resolves over the network. */
	resolvePatchCommitImpl?: (patchRepo: string, patchRef: string) => Promise<string>;
}): Promise<void> {
	const { install, deps } = options;
	const manifest = install.manifest;
	const currentVersion = options.currentVersion ?? VERSION;

	console.log(chalk.dim(`Source build: ${manifest.upstreamRepo} + ${manifest.patchRepo}@${manifest.patchRef}`));

	const release = await fetchLatestStableRelease(manifest.upstreamRepo, options.fetchImpl, options.githubToken);
	const comparison = compareVersions(release.version, currentVersion);

	// The upstream version is only half of the identity here: the patch series
	// moves independently of it, so a same-version run still has to compare the
	// resolved patch commit against what the installed binary was built from.
	// `ls-remote` is a remote read, which keeps `--check` read-only.
	const patchCommit = await (options.resolvePatchCommitImpl ?? resolvePatchCommit)(
		manifest.patchRepo,
		manifest.patchRef,
	);
	// Only a same-version run can be decided by the series: when the install is
	// ahead of the upstream release, rebuilding would be a downgrade, so it
	// stays up to date unless `--force` asks for that build explicitly.
	const lock = comparison === 0 ? await readInstallLock(install.binaryPath) : undefined;
	const seriesMatches =
		lock?.version === currentVersion &&
		lock.upstreamTag === release.tag &&
		lock.patchRef === manifest.patchRef &&
		lock.patchCommit === patchCommit;

	if (comparison <= 0 && !options.force && (comparison < 0 || seriesMatches)) {
		console.log(chalk.green(`${theme.status.success} Already up to date`));
		return;
	}
	if (comparison > 0) {
		console.log(chalk.cyan(`New version available: ${release.version}`));
	} else if (options.force) {
		console.log(chalk.yellow(`Forcing rebuild of ${release.version}`));
	} else if (lock) {
		console.log(
			chalk.cyan(
				`Patch series moved: ${manifest.patchRef} is ${patchCommit.slice(0, 12)}, installed build used ${lock.patchCommit.slice(0, 12)}`,
			),
		);
	} else {
		console.log(chalk.cyan(`No ${CODEIRO_LOCK_FILENAME} next to the binary; rebuilding to record what is installed`));
	}
	if (options.check) return;

	const target = resolveSourceBuildTarget(process.platform, process.arch, deps.isMuslLinux());
	const staging = resolveStagingLayout(manifest.sourceRoot, install.binaryPath);
	// Before the staging tree exists, so a missing toolchain fails fast; the
	// user's own directory is what resolves their version manager.
	const bun = await requireTools(process.cwd());

	await fs.promises.mkdir(staging.root, { recursive: true });

	const upstreamUrl = `https://github.com/${manifest.upstreamRepo}.git`;
	console.log(chalk.dim(`Staging ${manifest.upstreamRepo}@${release.tag} in ${staging.sourceDir}`));
	await syncTagCheckout(staging.sourceDir, upstreamUrl, release.tag);

	console.log(chalk.dim(`Fetching patches from ${manifest.patchRepo}@${manifest.patchRef}`));
	await syncRefCheckout(staging.patchDir, manifest.patchRepo, manifest.patchRef);

	const series = await resolvePatchSeries(staging.patchDir, manifest.patchSeries);
	let threeWay = false;
	if (series.base) {
		console.log(chalk.dim(`Fetching base ${series.base} for the three-way fallback…`));
		threeWay = await ensureBaseObjects(staging.sourceDir, upstreamUrl, series.base);
		if (!threeWay) {
			console.log(
				chalk.yellow(`${theme.status.warning} Base ${series.base} unavailable; only a direct apply will be tried`),
			);
		}
	}

	const report = await applyPatchSeries(staging.sourceDir, series.files, { threeWay });
	const { conflict } = report;
	if (conflict) {
		console.error(
			formatSeriesConflictReport(conflict, {
				applied: report.applied,
				healed: report.healed.length,
				upstreamTag: release.tag,
				base: series.base,
				sourceDir: staging.sourceDir,
			}),
		);
		throw new CodeiroUpdateAborted(
			`Patch ${conflict.index}/${conflict.total} (${conflict.patch}) does not apply to ${release.tag}`,
		);
	}

	const artifactPath = await buildFromSource(staging.sourceDir, target, release.version, bun);

	const verification = await deps.verifyBinaryAtPath(artifactPath, release.version);
	if (!verification.ok) {
		throw new Error(
			`Built binary reports ${verification.actual ?? "an unreadable version"} (expected ${release.version}); not installing`,
		);
	}

	await installBuiltBinary(artifactPath, install, release, deps);
	await writeInstallLock(install.binaryPath, {
		version: release.version,
		upstreamTag: release.tag,
		patchRef: manifest.patchRef,
		patchCommit,
		builtAt: new Date().toISOString(),
	});

	console.log(chalk.green(`\n${theme.status.success} Updated to ${release.version} (source build)`));
	console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
	console.log(
		chalk.green(
			`${theme.status.success} Update applied: ${release.version} (${release.tag} + ${manifest.patchRef}@${patchCommit.slice(0, 12)}, ${report.applied}/${report.total} patches${report.healed.length > 0 ? `, ${report.healed.length} healed by three-way` : ""})`,
		),
	);
}
