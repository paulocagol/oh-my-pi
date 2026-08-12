import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { resolveContainedPath } from "../discovery/contained-path";
import { listProjectDocsFiles, loadProjectDocsManifest } from "./project-docs-manifest";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

function escapeMarkdownText(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll(/([`*_{}[\]()#+!|<>])/g, "\\$1")
		.replaceAll("\n", " ")
		.replaceAll("\r", " ");
}

function encodeDocumentPath(relative: string): string {
	return relative
		.split("/")
		.map(segment =>
			encodeURIComponent(segment).replace(
				/[!'()*]/g,
				character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
			),
		)
		.join("/");
}

function decodedDocumentPath(url: InternalUrl): string {
	const rawHost = url.rawHost ?? url.hostname;
	const rawPathname = url.rawPathname ?? url.pathname;
	let decodedPathname: string;
	try {
		decodedPathname = decodeURIComponent(rawPathname);
	} catch {
		throw new Error("project-docs URL contains malformed percent-encoding");
	}
	const decoded = `${rawHost}${decodedPathname}`;
	if (!decoded || decoded === "/") return "";
	const relative = decoded.replace(/^\/+/, "");
	if (
		decoded.includes("\\") ||
		path.posix.isAbsolute(decoded) ||
		path.win32.isAbsolute(decoded) ||
		relative.split("/").some(part => part === ".." || part === "")
	) {
		throw new Error("project-docs URL path must be a relative document path");
	}
	return relative;
}

async function readUtf8(filePath: string): Promise<string> {
	const bytes = await fs.readFile(filePath);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error(`project-docs document is not valid UTF-8: ${filePath}`);
	}
}

export class ProjectDocsProtocolHandler implements ProtocolHandler {
	readonly immutable = true;
	readonly scheme: string;

	constructor(scheme: string) {
		this.scheme = scheme;
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const cwd = context?.cwd ?? getProjectDir();
		const manifest = await loadProjectDocsManifest(cwd);
		if (!manifest) throw new Error(`project-docs scheme ${this.scheme} is unavailable for this project`);
		if (manifest.scheme !== this.scheme) {
			throw new Error(`project-docs scheme mismatch: expected ${manifest.scheme}://, got ${this.scheme}://`);
		}
		const relativePath = decodedDocumentPath(url);
		if (!relativePath) {
			const files = await listProjectDocsFiles(manifest);
			const metadata = new Map(manifest.docs.map(doc => [doc.path, doc]));
			const lines = [
				"# Project documentation",
				...(manifest.description ? ["", escapeMarkdownText(manifest.description)] : []),
				"",
				...files.map(file => {
					const relative = path.relative(manifest.realRoot, file).split(path.sep).join("/");
					const doc = metadata.get(relative);
					const suffix = [doc?.title, doc?.description]
						.filter(Boolean)
						.map(value => escapeMarkdownText(value as string));
					const label = escapeMarkdownText(relative);
					const target = `${this.scheme}://${encodeDocumentPath(relative)}`;
					return `- [${label}](${target})${suffix.length ? ` — ${suffix.join(" — ")}` : ""}`;
				}),
			];
			const content = lines.join("\n");
			return {
				url: url.href,
				content,
				contentType: "text/markdown",
				size: Buffer.byteLength(content, "utf8"),
				sourcePath: manifest.realRoot,
				isDirectory: true,
				immutable: true,
			};
		}
		if (!relativePath.endsWith(".md")) throw new Error("project-docs documents must use the .md extension");
		const candidate = path.resolve(manifest.realRoot, ...relativePath.split("/"));
		const resolved = await resolveContainedPath(manifest.realRoot, candidate);
		if (resolved.status !== "ok") throw new Error(`project-docs document not found: ${relativePath}`);
		const stat = await fs.stat(resolved.realPath);
		if (!stat.isFile()) throw new Error(`project-docs document is not a file: ${relativePath}`);
		const content = await readUtf8(resolved.realPath);
		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf8"),
			sourcePath: resolved.realPath,
			immutable: true,
		};
	}

	async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		const manifest = await loadProjectDocsManifest(context?.cwd ?? getProjectDir());
		if (!manifest || manifest.scheme !== this.scheme) return [];
		const files = await listProjectDocsFiles(manifest);
		return files.map(file => ({ value: path.relative(manifest.realRoot, file).split(path.sep).join("/") }));
	}
}
