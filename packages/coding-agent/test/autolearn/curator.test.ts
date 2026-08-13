import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applySkillCuratorTransitions, renderSkillCuratorReport } from "@oh-my-pi/pi-coding-agent/autolearn/curator";
import { getManagedSkillsDir, writeManagedSkill } from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import { bumpSkillUse, getSkillUsage, updateSkillUsage } from "@oh-my-pi/pi-coding-agent/autolearn/skill-usage";
import "@oh-my-pi/pi-coding-agent/discovery";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

const DAY_MS = 86_400_000;
const DEFAULTS = { staleAfterDays: 30, archiveAfterDays: 90 };

describe("managed-skill curator", () => {
	let tempHome: string;
	let tempCwd: string;
	let managedDir: string;
	let originalAgentDir: string;

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-curator-"));
		// cwd MUST live under the fake home so loadSkills' ancestor walk cannot
		// reach ambient /tmp/.omp fixtures (full-suite safety).
		tempCwd = path.join(tempHome, "work");
		await fs.mkdir(tempCwd, { recursive: true });
		spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		managedDir = getManagedSkillsDir();
	});

	afterEach(async () => {
		spyOn(os, "homedir").mockRestore();
		setAgentDir(originalAgentDir);
		await removeWithRetries(tempHome);
	});

	const skillFile = (name: string) => path.join(managedDir, name, "SKILL.md");
	const archivedFile = (name: string) => path.join(managedDir, ".archive", name, "SKILL.md");

	async function createSkill(name: string): Promise<void> {
		await writeManagedSkill({ action: "create", name, description: `When to ${name}.`, body: `# ${name}` });
	}

	/**
	 * Backdate a skill's usage clock through the store's own mutator, so the test
	 * never encodes the on-disk JSON layout.
	 */
	async function seedUsage(name: string, options: { daysAgo: number; useCount: number }): Promise<void> {
		const iso = new Date(Date.now() - options.daysAgo * DAY_MS).toISOString();
		await updateSkillUsage(store => {
			store[name] =
				options.useCount > 0
					? { useCount: options.useCount, createdAt: iso, lastUsedAt: iso }
					: { useCount: 0, createdAt: iso };
			return true;
		});
	}

	it("seeds the clock on first sight and defers every decision to a later pass", async () => {
		await createSkill("fresh");

		const report = await applySkillCuratorTransitions(DEFAULTS);

		expect(report).toEqual({ checked: 1, markedStale: 0, archived: [], reactivated: 0 });
		expect(await getSkillUsage("fresh")).toMatchObject({ useCount: 0 });
		expect(await Bun.file(skillFile("fresh")).exists()).toBe(true);
	});

	it("holds a never-used skill inside the stale window even when the archive clock is shorter", async () => {
		await createSkill("unused");
		await seedUsage("unused", { daysAgo: 5, useCount: 0 });

		expect(await applySkillCuratorTransitions(DEFAULTS)).toMatchObject({ markedStale: 0, archived: [] });
		// Grace floor: a misconfigured archive clock must not retire a skill whose
		// trigger simply has not come up yet.
		expect(await applySkillCuratorTransitions({ staleAfterDays: 30, archiveAfterDays: 1 })).toMatchObject({
			markedStale: 0,
			archived: [],
		});
		expect(await Bun.file(skillFile("unused")).exists()).toBe(true);
		const unused = await getSkillUsage("unused");
		expect(unused?.useCount).toBe(0);
		expect(unused?.state).toBeUndefined();
	});

	it("marks a skill stale past the stale clock without moving its file", async () => {
		await createSkill("dusty");
		await seedUsage("dusty", { daysAgo: 45, useCount: 3 });

		const report = await applySkillCuratorTransitions(DEFAULTS);

		expect(report).toMatchObject({ checked: 1, markedStale: 1, archived: [], reactivated: 0 });
		expect(await getSkillUsage("dusty")).toMatchObject({ useCount: 3, state: "stale" });
		expect(await Bun.file(skillFile("dusty")).exists()).toBe(true);
		// Already stale: a second pass must not double-count.
		expect(await applySkillCuratorTransitions(DEFAULTS)).toMatchObject({ markedStale: 0, reactivated: 0 });
	});

	it("moves a skill past the archive clock out of the discovered set and drops its counters", async () => {
		await createSkill("gone");
		await seedUsage("gone", { daysAgo: 120, useCount: 7 });

		const report = await applySkillCuratorTransitions(DEFAULTS);

		expect(report).toMatchObject({ checked: 1, markedStale: 0, archived: ["gone"] });
		expect(await Bun.file(archivedFile("gone")).exists()).toBe(true);
		expect(await Bun.file(skillFile("gone")).exists()).toBe(false);
		expect(await getSkillUsage("gone")).toBeUndefined();
	});

	it("keeps the newest body when a name is archived twice", async () => {
		await createSkill("twice");
		await seedUsage("twice", { daysAgo: 120, useCount: 1 });
		await applySkillCuratorTransitions(DEFAULTS);

		await writeManagedSkill({ action: "create", name: "twice", description: "Second take.", body: "# second" });
		await seedUsage("twice", { daysAgo: 120, useCount: 1 });
		const report = await applySkillCuratorTransitions(DEFAULTS);

		expect(report.archived).toEqual(["twice"]);
		expect(await Bun.file(archivedFile("twice")).text()).toContain("# second");
	});

	it("reactivates a stale skill that was used again", async () => {
		await createSkill("revived");
		await seedUsage("revived", { daysAgo: 45, useCount: 2 });
		await applySkillCuratorTransitions(DEFAULTS);
		expect(await getSkillUsage("revived")).toMatchObject({ state: "stale" });

		await bumpSkillUse("revived");
		const report = await applySkillCuratorTransitions(DEFAULTS);

		expect(report).toMatchObject({ markedStale: 0, archived: [], reactivated: 1 });
		const revived = await getSkillUsage("revived");
		expect(revived?.useCount).toBe(3);
		expect(revived?.state).toBeUndefined();
	});

	it("removes an archived skill from discovery while leaving authored skills untouched", async () => {
		await createSkill("retired");
		const authoredFile = path.join(path.dirname(managedDir), "skills", "kept", "SKILL.md");
		await Bun.write(authoredFile, "---\nname: kept\ndescription: Authored and never used.\n---\n\n# kept\n");
		await seedUsage("retired", { daysAgo: 120, useCount: 4 });

		const before = await loadSkills({ cwd: tempCwd });
		expect(before.skills.map(skill => skill.name).sort()).toEqual(["kept", "retired"]);

		await applySkillCuratorTransitions(DEFAULTS);

		const after = await loadSkills({ cwd: tempCwd });
		expect(after.skills.map(skill => skill.name)).toEqual(["kept"]);
		expect(after.warnings).toEqual([]);
	});

	it("names every archived skill and the stale count in the session report", async () => {
		const message = renderSkillCuratorReport(
			{ checked: 5, markedStale: 2, archived: ["alpha", "beta"], reactivated: 0 },
			DEFAULTS,
		);

		expect(message).toContain("alpha");
		expect(message).toContain("beta");
		expect(message).toContain("2 skills");
		expect(message).toContain("90d");
		expect(message).toContain("30d");
	});
});
