/**
 * Usage telemetry for managed (auto-learn) skills.
 *
 * A single JSON file (`<managed-skills>/usage.json`) keyed by skill name. It is
 * runtime state, deliberately kept OUT of the `SKILL.md` bodies: the bodies are
 * content a user may want to keep or version, this is a decaying counter the
 * curator reads to decide staleness and archival.
 *
 * Every read is best-effort. A missing store is the normal cold-start case; a
 * corrupt one degrades to "no telemetry" with a warning. Neither ever throws:
 * the write side runs on the skill-injection path, where a telemetry failure
 * must not break a real turn.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";
import { getManagedSkillsDir } from "./managed-skills";

/** Lifecycle state of a managed skill. `active` is represented by the absence of `state`. */
export type SkillUsageState = "active" | "stale";

export interface SkillUsageRecord {
	/** Times the skill body was injected into a turn (explicit invocation or autoload). */
	useCount: number;
	/** ISO timestamp of the most recent injection; absent until the first use. */
	lastUsedAt?: string;
	/** ISO timestamp of the first time this store observed the skill. */
	createdAt: string;
	/** Only the non-default state is persisted; `undefined` means active. */
	state?: "stale";
}

export type SkillUsageStore = Record<string, SkillUsageRecord>;

/**
 * Coerce one on-disk entry into the typed record, or drop it. The store is
 * parsed from a file a user can hand-edit, so shape is not guaranteed; a
 * half-valid record would otherwise reach the curator as `NaN` timestamps and
 * silently disable transitions for that skill.
 */
function normalizeRecord(value: unknown): SkillUsageRecord | undefined {
	if (!isRecord(value)) return undefined;
	const { createdAt, useCount, lastUsedAt, state } = value;
	if (typeof createdAt !== "string") return undefined;
	const record: SkillUsageRecord = {
		useCount: typeof useCount === "number" && Number.isFinite(useCount) ? useCount : 0,
		createdAt,
	};
	if (typeof lastUsedAt === "string") record.lastUsedAt = lastUsedAt;
	if (state === "stale") record.state = "stale";
	return record;
}

/** Read the whole store. Missing or unusable file → `{}`, never a throw. */
export async function readAllSkillUsage(): Promise<SkillUsageStore> {
	let parsed: unknown;
	try {
		parsed = await Bun.file(path.join(getManagedSkillsDir(), "usage.json")).json();
	} catch (err) {
		if (!isEnoent(err)) {
			const error = err instanceof Error ? err.message : String(err);
			logger.warn("Managed-skill usage store unreadable; treating as empty", { error });
		}
		return {};
	}
	if (!isRecord(parsed)) {
		logger.warn("Managed-skill usage store is not an object; treating as empty");
		return {};
	}
	const store: SkillUsageStore = {};
	for (const [name, value] of Object.entries(parsed)) {
		const record = normalizeRecord(value);
		if (record) store[name] = record;
	}
	return store;
}

/** Read one skill's record, or `undefined` when the store has never seen it. */
export async function getSkillUsage(name: string): Promise<SkillUsageRecord | undefined> {
	return (await readAllSkillUsage())[name];
}

async function writeSkillUsageStore(store: SkillUsageStore): Promise<void> {
	const target = path.join(getManagedSkillsDir(), "usage.json");
	// Temp + rename in the same directory: a crash mid-write must never leave a
	// truncated store behind, and the rename is atomic on the same filesystem.
	// The random suffix keeps a concurrent writer in another process from
	// colliding on the temp path. `Bun.write` creates the parent directory.
	const tempPath = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await Bun.write(tempPath, JSON.stringify(store));
		await fs.rename(tempPath, target);
	} catch (err) {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
		throw err;
	}
}

/**
 * Serialize every mutation through one process-local chain.
 *
 * Unlike `serializeSkillMutation` in `managed-skills.ts`, this chain is NOT
 * keyed by skill name: the store is a single file shared by all names, so a
 * per-name chain would still let two different skills interleave their
 * read-modify-write and lose an update. The critical section is a few hundred
 * bytes of JSON, so there is nothing to gain from finer granularity.
 * In-process only; cross-process races are out of scope (the rename keeps the
 * file readable either way, and the loser just loses one increment).
 */
let usageMutationChain: Promise<unknown> = Promise.resolve();

/**
 * Read-modify-write the whole store under the mutation chain. `mutate` receives
 * a fresh snapshot and returns whether it changed anything — a `false` return
 * skips the disk write entirely, which is the common case for the curator.
 *
 * Exported so the curator can apply a whole pass' worth of transitions against
 * one consistent snapshot instead of N read-modify-write cycles.
 */
export function updateSkillUsage(mutate: (store: SkillUsageStore) => boolean): Promise<void> {
	const run = usageMutationChain.then(async () => {
		const store = await readAllSkillUsage();
		if (!mutate(store)) return;
		await writeSkillUsageStore(store);
	});
	usageMutationChain = run.catch(() => {});
	return run;
}

/**
 * Record one injection of a managed skill.
 *
 * Deliberately does NOT clear a `stale` marker: reactivation is a curator
 * decision so the next pass can report it. The counters are the raw signal, the
 * state machine reads them.
 */
export function bumpSkillUse(name: string): Promise<void> {
	const now = new Date().toISOString();
	return updateSkillUsage(store => {
		const record = store[name];
		if (record) {
			record.useCount += 1;
			record.lastUsedAt = now;
		} else {
			store[name] = { useCount: 1, createdAt: now, lastUsedAt: now };
		}
		return true;
	});
}

/**
 * Flip a skill's lifecycle state. No-op when the skill has no record (nothing
 * has observed it yet) or when it is already in the requested state.
 */
export function setSkillUsageState(name: string, state: SkillUsageState): Promise<void> {
	return updateSkillUsage(store => {
		const record = store[name];
		if (!record) return false;
		if (state === "stale") {
			if (record.state === "stale") return false;
			record.state = "stale";
			return true;
		}
		if (record.state === undefined) return false;
		// `undefined` rather than `delete`: JSON.stringify omits it, and the
		// record keeps its hidden class.
		record.state = undefined;
		return true;
	});
}
