/**
 * Internal-URL branch of the `omp grep` subcommand.
 *
 * `runGrepCommand` resolves its path with `path.resolve` and calls native grep
 * directly, so an internal URL like `vitrine.se://` turns into the nonexistent
 * disk path `<cwd>/vitrine.se:` and the search fails. This module routes those
 * inputs through the same `GrepTool` the agent uses, so the shell subcommand
 * and the tool agree on which URLs resolve and on what they return.
 */
import { GrepOutputMode } from "@oh-my-pi/pi-natives";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Settings } from "../config/settings";
import { registerProjectDocSchemes } from "../internal-urls/project-docs";
import { InternalUrlRouter } from "../internal-urls/router";
import { discoverAndLoadMCPTools } from "../mcp/loader";
import { MCPManager } from "../mcp/manager";
import { discoverAuthStorage } from "../session/auth-broker-config";
import type { AuthStorage } from "../session/auth-storage";
import type { ToolSession } from "../tools";
import { GrepTool } from "../tools/grep";
import { wrapToolWithMetaNotice } from "../tools/output-meta";
import { renderError, ToolError } from "../tools/tool-errors";
import type { GrepCommandArgs } from "./grep-cli";
import { shouldDiscoverMcp } from "./read-cli";

/**
 * A `scheme://` opening the argument or any semicolon-separated entry. The
 * router's own matcher is `^`-anchored, so scanning entries is what lets
 * `grep pat "src; docs://"` reach the branch that can resolve `docs://`.
 */
const URL_ENTRY_RE = /(?:^|;)\s*[a-z][a-z0-9+.-]*:\/\//i;

/**
 * `Flags.integer` rejects non-numeric input but accepts `--limit=0`,
 * `--limit=-5` and `--context=-1`. `GrepToolOptions` then clamps them —
 * `Math.max(1, limit)`, `Math.max(0, context)` — so a zero or negative flag
 * quietly collapses the search to a single match, or drops the context the
 * native branch would have printed. `NaN`, reachable from a programmatic
 * caller, windows the search down to zero files and reports "No matches
 * found" over real ones. Each is a wrong answer carrying a success exit
 * code, so reject at the edge instead of clamping.
 */
function requireBounded(value: number, flag: string, min: number): number {
	if (!Number.isInteger(value) || value < min) {
		throw new ToolError(`${flag} must be an integer >= ${min} for internal URLs, got: ${value}`);
	}
	return value;
}

/**
 * Greps an internal URL through `GrepTool` and reports whether it owned the
 * input. `false` means the path is not a routable internal URL and the caller
 * must continue down its native filesystem path, unchanged.
 */
export async function runInternalUrlGrep(cmd: GrepCommandArgs): Promise<boolean> {
	// Cheap syntactic gate: a plain filesystem path never pays a manifest read.
	// `canHandle` demands the same `scheme://` shape, so nothing routable is lost.
	if (!URL_ENTRY_RE.test(cmd.path)) return false;

	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });
	// Project-doc schemes are per-cwd and only exist once the manifest loads.
	await registerProjectDocSchemes(cwd);
	// `canHandle` is the same gate `GrepTool` applies to its own paths, so the
	// CLI routes exactly what the tool can search — no more, no less. An
	// unregistered scheme falls through to the native branch as it does today.
	const router = InternalUrlRouter.instance();
	if (!cmd.path.split(";").some(entry => router.canHandle(entry.trim()))) return false;

	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};

	let authStorage: AuthStorage | undefined;
	let mcpManager: MCPManager | undefined;
	let failed = false;

	try {
		// Flags with no `GrepTool` equivalent. Rejecting beats returning a result
		// the flag never shaped; the throw also keeps this check ahead of the
		// search no matter how the function is later reordered.
		if (cmd.glob) throw new ToolError(`--glob is not supported for internal URLs: ${cmd.path}`);
		if (cmd.mode !== GrepOutputMode.Content) {
			throw new ToolError(`--files and --count are not supported for internal URLs: ${cmd.path}`);
		}
		const limit = requireBounded(cmd.limit, "--limit", 1);
		const context = requireBounded(cmd.context, "--context", 0);

		if (shouldDiscoverMcp(cmd.path)) {
			authStorage = await discoverAuthStorage();
			const discovered = await discoverAndLoadMCPTools(cwd, {
				enableProjectConfig: settings.get("mcp.enableProjectConfig") ?? true,
				filterExa: true,
				filterBrowser: settings.get("browser.enabled") ?? false,
				cacheStorage: settings.getStorage(),
				authStorage,
			});
			mcpManager = discovered.manager;
			session.mcpManager = mcpManager;
			MCPManager.setInstance(mcpManager);
		}

		console.log(chalk.dim(`Searching in: ${cmd.path}`));
		console.log(chalk.dim(`Pattern: ${cmd.pattern}`));
		console.log(chalk.dim(`Limit: ${limit}, Context: ${context}, Gitignore: ${cmd.gitignore}`));
		console.log("");

		const tool = wrapToolWithMetaNotice(new GrepTool(session, { context, totalMatchLimit: limit }));
		const result = await tool.execute("omp-grep", {
			pattern: cmd.pattern,
			path: cmd.path,
			gitignore: cmd.gitignore,
		});
		for (const block of result.content) {
			if (block.type !== "text") continue;
			process.stdout.write(block.text);
			if (!block.text.endsWith("\n")) process.stdout.write("\n");
		}
	} catch (err) {
		process.stderr.write(`${chalk.red(renderError(err))}\n`);
		failed = true;
	} finally {
		if (mcpManager) {
			await mcpManager.disconnectAll();
			if (MCPManager.instance() === mcpManager) MCPManager.setInstance(undefined);
		}
		authStorage?.close();
	}

	if (failed) process.exit(1);
	return true;
}
