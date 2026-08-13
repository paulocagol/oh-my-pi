/**
 * Lifecycle curator for managed (auto-learn) skills.
 *
 * Auto-learn mints skills but nothing ever retired them, and every managed
 * skill costs `name` + `description` in EVERY system prompt of EVERY future
 * session. This pass is the other end of that pipe: a clock-driven state
 * machine over `skill-usage.ts` telemetry that marks unused skills stale and
 * eventually moves them out of discovery.
 *
 * Scope is authored-skill-safe by construction: it only walks
 * `getManagedSkillsDir()`, so a user's own `SKILL.md` files are unreachable
 * from here. Retirement is a directory move, not a delete.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import curatorReportTemplate from "../prompts/system/autolearn-curator-report.md" with { type: "text" };
import { archiveManagedSkill, getManagedSkillsDir } from "./managed-skills";
import { readAllSkillUsage, updateSkillUsage } from "./skill-usage";

const DAY_MS = 86_400_000;

export interface SkillCuratorOptions {
	/** Days without a recorded use before a skill is flagged stale. */
	staleAfterDays: number;
	/** Days without a recorded use before a skill is moved out of discovery. */
	archiveAfterDays: number;
}

export interface CuratorReport {
	/** Managed skills evaluated in this pass. */
	checked: number;
	markedStale: number;
	/** Names moved under `managed-skills/.archive/`, in pass order. */
	archived: string[];
	reactivated: number;
}

/**
 * Names of managed skills currently visible to discovery: a real directory
 * (never a symlink — the curator must not move anything whose target lives
 * outside the managed root) holding a `SKILL.md`, not dot-prefixed.
 */
async function listActiveManagedSkills(root: string): Promise<string[]> {
	const entries = await fs.readdir(root, { withFileTypes: true }).catch(err => {
		if (isEnoent(err)) return [];
		throw err;
	});
	const names: string[] = [];
	await Promise.all(
		entries.map(async entry => {
			if (entry.name.startsWith(".") || !entry.isDirectory()) return;
			if (await Bun.file(path.join(root, entry.name, "SKILL.md")).exists()) names.push(entry.name);
		}),
	);
	// readdir order plus concurrent stats is nondeterministic; the report names
	// skills to the model, so sort for a stable message.
	names.sort();
	return names;
}

/**
 * Run one clock-driven curation pass over the managed skills.
 *
 * Precedence, per skill:
 *  1. No usage record yet → seed the clock and skip. Without this, enabling the
 *     feature would archive every pre-existing skill on the first pass, since
 *     there is no history from before the store existed.
 *  2. Never used (`useCount === 0`) and younger than `staleAfterDays` → grace
 *     floor. Absence of use is not yet evidence of obsolescence; the trigger may
 *     simply not have come up. This also stops a `archiveAfterDays <
 *     staleAfterDays` misconfiguration from retiring brand-new skills.
 *  3. Anchor (`lastUsedAt ?? createdAt`) older than `archiveAfterDays` → archive.
 *  4. Anchor older than `staleAfterDays` → mark stale (file stays in place).
 *  5. Anchor fresher than `staleAfterDays` while flagged stale → reactivate.
 *
 * No dry-run mode: every action is reversible (archive is a move) and the whole
 * feature is opt-in behind `autolearn.enabled`.
 */
export async function applySkillCuratorTransitions(options: SkillCuratorOptions): Promise<CuratorReport> {
	const report: CuratorReport = { checked: 0, markedStale: 0, archived: [], reactivated: 0 };
	const names = await listActiveManagedSkills(getManagedSkillsDir());
	if (names.length === 0) return report;
	report.checked = names.length;

	const store = await readAllSkillUsage();
	const now = Date.now();
	const staleCutoff = now - options.staleAfterDays * DAY_MS;
	const archiveCutoff = now - options.archiveAfterDays * DAY_MS;
	const nowIso = new Date(now).toISOString();

	const seeded: string[] = [];
	const toArchive: string[] = [];
	const toStale: string[] = [];
	const toReactivate: string[] = [];

	for (const name of names) {
		const record = store[name];
		// Missing or unparseable clock — reseed instead of guessing an anchor.
		const anchor = record ? Date.parse(record.lastUsedAt ?? record.createdAt) : Number.NaN;
		if (!record || Number.isNaN(anchor)) {
			seeded.push(name);
			continue;
		}
		const stale = record.state === "stale";
		if (record.useCount === 0 && anchor > staleCutoff) {
			if (stale) toReactivate.push(name);
			continue;
		}
		if (anchor <= archiveCutoff) {
			toArchive.push(name);
			continue;
		}
		if (anchor <= staleCutoff) {
			if (!stale) toStale.push(name);
			continue;
		}
		if (stale) toReactivate.push(name);
	}

	// Move first, then record: a failed rename must leave the telemetry intact so
	// the next pass retries instead of forgetting the skill exists.
	for (const name of toArchive) {
		try {
			await archiveManagedSkill(name);
			report.archived.push(name);
		} catch (err) {
			logger.warn("Skill curator could not archive a managed skill", {
				name,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	report.markedStale = toStale.length;
	report.reactivated = toReactivate.length;
	if (seeded.length + toStale.length + toReactivate.length + report.archived.length === 0) return report;
	// One read-modify-write for the whole pass. The callback re-reads under the
	// mutation lock, so a `bumpSkillUse` that landed mid-pass keeps its counters;
	// at worst it gets a stale flag it did not earn, which the next pass undoes.
	await updateSkillUsage(current => {
		for (const name of seeded) current[name] = { useCount: 0, createdAt: nowIso };
		for (const name of toStale) {
			const record = current[name];
			if (record) record.state = "stale";
		}
		for (const name of toReactivate) {
			const record = current[name];
			if (record) record.state = undefined;
		}
		// The directory left the active set; keeping its counters would re-archive
		// it the instant a user restores the folder by hand.
		for (const name of report.archived) delete current[name];
		return true;
	});
	return report;
}

/** Session-visible summary of a pass that actually changed something. */
export function renderSkillCuratorReport(report: CuratorReport, options: SkillCuratorOptions): string {
	return prompt
		.render(curatorReportTemplate, {
			archived: report.archived,
			archivedCount: report.archived.length,
			markedStale: report.markedStale,
			staleAfterDays: options.staleAfterDays,
			archiveAfterDays: options.archiveAfterDays,
		})
		.trim();
}
