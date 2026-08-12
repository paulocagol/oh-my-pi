import { registerSelectorScheme } from "../tools/path-utils";
import { loadProjectDocsManifest, type ProjectDocsManifest } from "./project-docs-manifest";
import { ProjectDocsProtocolHandler } from "./project-docs-protocol";
import { InternalUrlRouter } from "./router";

export async function registerProjectDocSchemes(cwd: string): Promise<ProjectDocsManifest | undefined> {
	const manifest = await loadProjectDocsManifest(cwd);
	if (!manifest) return undefined;
	const router = InternalUrlRouter.instance();
	const existing = router.getHandler(manifest.scheme);
	if (existing && !(existing instanceof ProjectDocsProtocolHandler)) {
		console.warn(`[project-docs] scheme ${manifest.scheme} is already registered by another handler`);
		return undefined;
	}
	if (!existing) router.register(new ProjectDocsProtocolHandler(manifest.scheme));
	registerSelectorScheme(manifest.scheme);
	return manifest;
}

export async function projectDocsSchemeForCwd(cwd: string): Promise<string | undefined> {
	const manifest = await loadProjectDocsManifest(cwd);
	if (!manifest) return undefined;
	const handler = InternalUrlRouter.instance().getHandler(manifest.scheme);
	if (handler && !(handler instanceof ProjectDocsProtocolHandler)) return undefined;
	return manifest.scheme;
}

export type { ProjectDocMetadata, ProjectDocsManifest } from "./project-docs-manifest";
export { loadProjectDocsManifest } from "./project-docs-manifest";
export { ProjectDocsProtocolHandler } from "./project-docs-protocol";
