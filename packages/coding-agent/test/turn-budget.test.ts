import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { decideBudgetDowngrade, turnSpendUsd } from "@oh-my-pi/pi-coding-agent/session/turn-budget";

function message(role: AgentMessage["role"], cost?: number): AgentMessage {
	if (role === "assistant") return { role, usage: cost === undefined ? ({} as never) : ({ cost: { total: cost } } as never) } as AgentMessage;
	return { role } as AgentMessage;
}

describe("turn budget", () => {
	it("keeps the budget off at zero or below", () => {
		expect(decideBudgetDowngrade(10, 0)).toEqual({ downgrade: false, reason: "turn budget is disabled" });
		expect(decideBudgetDowngrade(10, -1)).toEqual({ downgrade: false, reason: "turn budget is disabled" });
	});

	it("does not downgrade at exact budget equality", () => {
		expect(decideBudgetDowngrade(1.25, 1.25)).toEqual({
			downgrade: false,
			reason: "turn spend is within budget",
		});
	});

	it("downgrades only when spend strictly exceeds the budget", () => {
		expect(decideBudgetDowngrade(1.2501, 1.25)).toEqual({
			downgrade: true,
			reason: "turn spend 1.2501 USD exceeds budget 1.25 USD",
		});
	});

	it("resets spend after the latest user message", () => {
		expect(turnSpendUsd([message("assistant", 4), message("user"), message("assistant", 1.5)])).toBe(1.5);
	});

	it("tolerates missing usage and cost", () => {
		expect(turnSpendUsd([message("user"), message("assistant"), message("assistant", 2)])).toBe(2);
	});

	it("sums assistant-only costs when no user message exists", () => {
		expect(turnSpendUsd([message("assistant", 0.4), message("toolResult"), message("assistant", 0.6)])).toBe(1);
	});
});
