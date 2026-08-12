import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

export interface BudgetDowngradeDecision {
	downgrade: boolean;
	reason: string;
}

/** Sum the completed assistant request costs in the current user turn. */
export function turnSpendUsd(messages: readonly AgentMessage[]): number {
	const latestUser = messages.findLastIndex(message => message.role === "user");
	let spendUsd = 0;
	for (let index = latestUser + 1; index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const cost = message.usage?.cost?.total;
		if (typeof cost === "number" && Number.isFinite(cost)) spendUsd += cost;
	}
	return spendUsd;
}

/** Decide whether a positive turn budget was strictly exceeded. */
export function decideBudgetDowngrade(spendUsd: number, budgetUsd: number): BudgetDowngradeDecision {
	if (!(budgetUsd > 0)) return { downgrade: false, reason: "turn budget is disabled" };
	if (!(spendUsd > budgetUsd)) return { downgrade: false, reason: "turn spend is within budget" };
	return {
		downgrade: true,
		reason: `turn spend ${spendUsd} USD exceeds budget ${budgetUsd} USD`,
	};
}
