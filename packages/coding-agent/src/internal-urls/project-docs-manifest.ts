import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { findRepoRoot } from "../capability/fs";
import { resolveContainedPath } from "../discovery/contained-path";

const MANIFEST_RELATIVE_PATH = path.join(".omp", "project-docs.json");
const SCHEME_RE = /^[a-z][a-z0-9+.-]*$/;
const RESERVED_SCHEMES = new Set(["file", "http", "https", "conflict"]);
const MAX_LABEL_LENGTH = 256;
const MAX_PATH_LENGTH = 1024;
const MAX_EXCLUDE_PATTERNS = 64;

export interface ProjectDocMetadata {
	path: string;
	title?: string;
	description?: string;
}

export interface ProjectDocsManifest {
	version: 1;
	scheme: string;
	root: string;
	description?: string;
	/**
	 * Globs, relative to `root`, whose matches stay out of the generated index and
	 * autocomplete. Curation only — excluded files remain readable through the
	 * scheme and through plain `read`; containment and symlink checks are the
	 * actual security boundary.
	 */
	exclude: string[];
	docs: ProjectDocMetadata[];
	repoRoot: string;
	realRoot: string;
}

function warn(message: string): void {
	console.warn(`[project-docs] ${message}`);
}

function sanitizeText(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	const trimmed = value
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/[<>`]/g, "")
		.trim();
	if (trimmed.length > MAX_LABEL_LENGTH) throw new Error(`${field} exceeds ${MAX_LABEL_LENGTH} characters`);
	return trimmed;
}

function validateRelative(value: string, field: string): string {
	if (
		!value ||
		value.length > MAX_PATH_LENGTH ||
		value.includes("\0") ||
		path.posix.isAbsolute(value) ||
		path.win32.isAbsolute(value)
	) {
		throw new Error(`${field} must be a relative path`);
	}
	const normalized = value.replaceAll("\\", "/");
	const parts = normalized.split("/");
	if (parts.some(part => part === ".." || (part === "" && parts.length > 1))) {
		throw new Error(`${field} must not escape its root`);
	}
	return normalized;
}

/**
 * Parses `exclude`: globs, relative to the docs root, that keep matching files out
 * of the generated index. Patterns are validated as root-relative paths so a glob
 * can never reach above the root, and compiled eagerly so a malformed pattern is a
 * manifest error instead of a silent no-op at walk time. Absent means no exclusion,
 * which keeps every manifest written before this field valid.
 */
function validateExclude(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("exclude must be an array");
	if (value.length > MAX_EXCLUDE_PATTERNS) throw new Error(`exclude exceeds ${MAX_EXCLUDE_PATTERNS} patterns`);
	const patterns: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") throw new Error("exclude patterns must be strings");
		const pattern = validateRelative(entry, "exclude pattern");
		try {
			new Bun.Glob(pattern);
		} catch (error) {
			throw new Error(`exclude pattern is not a valid glob: ${pattern} (${String(error)})`);
		}
		patterns.push(pattern);
	}
	return patterns;
}

async function realPathIfExists(target: string): Promise<string | null> {
	try {
		return await fs.realpath(target);
	} catch {
		return null;
	}
}

async function readManifestFile(manifestPath: string): Promise<unknown> {
	try {
		const stat = await fs.stat(manifestPath);
		if (!stat.isFile()) return undefined;
		const bytes = await fs.readFile(manifestPath);
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`invalid JSON: ${error.message}`);
		if (error instanceof TypeError) throw new Error("manifest is not valid UTF-8");
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`cannot read manifest: ${String(error)}`);
	}
}

async function enumerateMarkdownFiles(realRoot: string, exclude: readonly string[] = []): Promise<string[]> {
	const files: string[] = [];
	const visited = new Set<string>();
	const matchers = exclude.map(pattern => new Bun.Glob(pattern));
	const isExcluded = (realFile: string): boolean => {
		if (matchers.length === 0) return false;
		const relative = path.relative(realRoot, realFile).split(path.sep).join("/");
		return matchers.some(matcher => matcher.match(relative));
	};
	const walk = async (directory: string): Promise<void> => {
		const realDirectory = await realPathIfExists(directory);
		if (!realDirectory || visited.has(realDirectory)) return;
		const containedDirectory = await resolveContainedPath(realRoot, realDirectory);
		if (containedDirectory.status !== "ok")
			throw new Error("docs root contains a symlink outside the repository docs root");
		visited.add(realDirectory);
		let entries: Dirent[];
		try {
			entries = await fs.readdir(realDirectory, { withFileTypes: true });
		} catch (error) {
			throw new Error(`cannot enumerate docs root: ${String(error)}`);
		}
		for (const entry of entries) {
			const candidate = path.join(realDirectory, entry.name);
			const realCandidate = await realPathIfExists(candidate);
			if (!realCandidate) continue;
			const contained = await resolveContainedPath(realRoot, realCandidate);
			if (contained.status === "outside") throw new Error(`docs entry resolves outside root: ${entry.name}`);
			if (contained.status !== "ok") continue;
			const stat = await fs.stat(realCandidate);
			if (stat.isDirectory()) await walk(realCandidate);
			else if (stat.isFile()) {
				// A docs root is allowed to carry the assets its Markdown links to
				// (images, design sources). They are skipped, never indexed, and never
				// resolvable — only `.md` names reach the generated index.
				if (!entry.name.endsWith(".md")) continue;
				if (/[\u0000-\u001f\u007f]/u.test(entry.name)) {
					throw new Error(`docs root contains control character in filename: ${entry.name}`);
				}
				if (isExcluded(realCandidate)) continue;
				files.push(realCandidate);
			}
		}
	};
	await walk(realRoot);
	files.sort((a, b) => a.localeCompare(b));
	return files;
}

export async function loadProjectDocsManifest(cwd: string = getProjectDir()): Promise<ProjectDocsManifest | undefined> {
	const repoRoot = await findRepoRoot(cwd);
	if (!repoRoot) return undefined;
	const realRepoRoot = await realPathIfExists(repoRoot);
	if (!realRepoRoot) return undefined;
	const manifestPath = path.join(realRepoRoot, MANIFEST_RELATIVE_PATH);
	let raw: unknown;
	try {
		raw = await readManifestFile(manifestPath);
	} catch (error) {
		warn(`${String(error)} (${manifestPath})`);
		return undefined;
	}
	if (raw === undefined) return undefined;
	try {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("manifest must be an object");
		const record = raw as Record<string, unknown>;
		if (record.version !== 1) throw new Error("version must be 1");
		if (typeof record.scheme !== "string") throw new Error("scheme must be a string");
		const scheme = record.scheme.trim().toLowerCase();
		if (scheme.length > 64 || !SCHEME_RE.test(scheme)) throw new Error("scheme is invalid");
		if (RESERVED_SCHEMES.has(scheme)) throw new Error(`scheme ${scheme} is reserved`);
		const root = validateRelative(typeof record.root === "undefined" ? "docs" : String(record.root), "root");
		if (record.root !== undefined && typeof record.root !== "string") throw new Error("root must be a string");
		const exclude = validateExclude(record.exclude);
		const rawDocs = record.docs === undefined ? [] : record.docs;
		if (!Array.isArray(rawDocs)) throw new Error("docs must be an array");
		const rootCandidate = path.resolve(realRepoRoot, root);
		const realRoot = await realPathIfExists(rootCandidate);
		if (!realRoot) throw new Error("root does not exist");
		const rootContained = await resolveContainedPath(realRepoRoot, realRoot);
		if (rootContained.status !== "ok") throw new Error("root resolves outside repository");
		const rootStat = await fs.stat(realRoot);
		if (!rootStat.isDirectory()) throw new Error("root must be a directory");
		const files = await enumerateMarkdownFiles(realRoot, exclude);
		const fileSet = new Set(files.map(file => path.relative(realRoot, file).split(path.sep).join("/")));
		const docs: ProjectDocMetadata[] = [];
		const excludeMatchers = exclude.map(pattern => new Bun.Glob(pattern));
		for (const item of rawDocs) {
			if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("docs entries must be objects");
			const doc = item as Record<string, unknown>;
			if (typeof doc.path !== "string") throw new Error("docs entry path must be a string");
			const relativePath = validateRelative(doc.path, "docs entry path");
			if (excludeMatchers.some(matcher => matcher.match(relativePath)))
				throw new Error(`docs entry is excluded by an exclude pattern: ${relativePath}`);
			if (!relativePath.endsWith(".md") || !fileSet.has(relativePath))
				throw new Error(`docs entry does not exist: ${relativePath}`);
			const title = sanitizeText(doc.title, "title");
			const description = sanitizeText(doc.description, "description");
			docs.push({
				path: relativePath,
				...(title === undefined ? {} : { title }),
				...(description === undefined ? {} : { description }),
			});
		}
		const description = sanitizeText(record.description, "description");
		return {
			version: 1,
			scheme,
			root,
			...(description === undefined ? {} : { description }),
			exclude,
			docs,
			repoRoot: realRepoRoot,
			realRoot,
		};
	} catch (error) {
		warn(`${String(error)} (${manifestPath})`);
		return undefined;
	}
}

export async function listProjectDocsFiles(manifest: ProjectDocsManifest): Promise<string[]> {
	return enumerateMarkdownFiles(manifest.realRoot, manifest.exclude);
}

export function projectDocsManifestPath(repoRoot: string): string {
	return path.join(repoRoot, MANIFEST_RELATIVE_PATH);
}

export function projectDocsReservedScheme(scheme: string): boolean {
	return RESERVED_SCHEMES.has(scheme);
}
