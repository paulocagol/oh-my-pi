import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getManagedSkillsDir, MANAGED_SKILLS_PROVIDER_ID } from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import {
	bumpSkillUse,
	getSkillUsage,
	readAllSkillUsage,
	setSkillUsageState,
	updateSkillUsage,
} from "@oh-my-pi/pi-coding-agent/autolearn/skill-usage";
import { buildSkillPromptMessage, type Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

/**
 * `buildSkillPromptMessage` bumps fire-and-forget. Every mutation runs on the
 * store's own promise chain, so enqueueing a no-op mutation and awaiting it
 * proves any earlier bump already landed on disk — no polling, no sleeping.
 */
function usageWritesSettled(): Promise<void> {
	return updateSkillUsage(() => false);
}

describe("managed-skill usage telemetry", () => {
	let tempHome: string;
	let originalAgentDir: string;

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-usage-"));
		spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".omp", "agent"));
	});

	afterEach(async () => {
		setSystemTime();
		spyOn(os, "homedir").mockRestore();
		setAgentDir(originalAgentDir);
		await removeWithRetries(tempHome);
	});

	it("records the first use with a creation and last-use timestamp", async () => {
		const before = Date.now();
		await bumpSkillUse("alpha");
		const record = await getSkillUsage("alpha");

		expect(record?.useCount).toBe(1);
		expect(record?.state).toBeUndefined();
		expect(Date.parse(record?.createdAt ?? "")).toBeGreaterThanOrEqual(before);
		expect(Date.parse(record?.lastUsedAt ?? "")).toBeGreaterThanOrEqual(before);
	});

	it("keeps createdAt while advancing the counter and last-use across bumps", async () => {
		setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		await bumpSkillUse("alpha");
		setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
		await bumpSkillUse("alpha");
		const record = await getSkillUsage("alpha");

		expect(record?.useCount).toBe(2);
		expect(record?.createdAt).toBe("2026-01-01T00:00:00.000Z");
		expect(record?.lastUsedAt).toBe("2026-01-02T00:00:00.000Z");
	});

	it("loses no increment when bumps race, on one name or across names", async () => {
		await Promise.all([
			...Array.from({ length: 25 }, () => bumpSkillUse("alpha")),
			...Array.from({ length: 10 }, () => bumpSkillUse("beta")),
		]);

		const store = await readAllSkillUsage();
		expect(store.alpha?.useCount).toBe(25);
		expect(store.beta?.useCount).toBe(10);
	});

	it("treats a corrupt store as empty and recovers on the next write", async () => {
		await Bun.write(path.join(getManagedSkillsDir(), "usage.json"), "{ this is not json");

		expect(await readAllSkillUsage()).toEqual({});

		await bumpSkillUse("alpha");
		expect((await getSkillUsage("alpha"))?.useCount).toBe(1);
	});

	it("flips lifecycle state and leaves unknown skills alone", async () => {
		await bumpSkillUse("alpha");

		await setSkillUsageState("alpha", "stale");
		expect((await getSkillUsage("alpha"))?.state).toBe("stale");

		await setSkillUsageState("alpha", "active");
		expect((await getSkillUsage("alpha"))?.state).toBeUndefined();

		await setSkillUsageState("ghost", "stale");
		expect(await getSkillUsage("ghost")).toBeUndefined();
	});

	it("keeps a stale marker on use so the curator owns reactivation", async () => {
		await bumpSkillUse("alpha");
		await setSkillUsageState("alpha", "stale");

		await bumpSkillUse("alpha");
		const record = await getSkillUsage("alpha");

		expect(record?.useCount).toBe(2);
		expect(record?.state).toBe("stale");
	});

	describe("injection accounting", () => {
		async function createSkill(name: string, provider: string): Promise<Skill> {
			const dir = path.join(tempHome, "skills", name);
			const filePath = path.join(dir, "SKILL.md");
			await Bun.write(filePath, `---\nname: ${name}\ndescription: Test skill\n---\n\nBody of ${name}.\n`);
			return {
				name,
				description: "Test skill",
				filePath,
				baseDir: dir,
				source: `${provider}:user`,
				_source: { provider, providerName: provider, path: filePath, level: "user" },
			};
		}

		it("counts a managed skill injected into a turn", async () => {
			const skill = await createSkill("managed-one", MANAGED_SKILLS_PROVIDER_ID);

			await buildSkillPromptMessage(skill, "");
			await usageWritesSettled();
			expect((await getSkillUsage("managed-one"))?.useCount).toBe(1);

			await buildSkillPromptMessage(skill, "", "autoload");
			await usageWritesSettled();
			expect((await getSkillUsage("managed-one"))?.useCount).toBe(2);
		});

		it("never records an authored skill", async () => {
			const authored = await createSkill("authored-one", "native");

			await buildSkillPromptMessage(authored, "");
			await usageWritesSettled();

			expect(await readAllSkillUsage()).toEqual({});
		});
	});
});
