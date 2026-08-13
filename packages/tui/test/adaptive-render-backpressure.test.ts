/**
 * Regression for oh-my-pi#4145 (TUI busy loop during long-running eval).
 *
 * When a rendered frame exceeded the 33ms cadence budget, the previous
 * scheduler collapsed the cadence delay to zero and scheduled the next frame
 * immediately (`setTimeout(0)`). During a heavy eval that turns the render
 * loop into a busy loop consuming 40–50% CPU with visible frames dropped.
 *
 * The fix adds adaptive backpressure: the next render's delay is inflated to
 * (at minimum) the previous frame's cost, capped so responsiveness never
 * degrades below ~5 fps. A fast frame keeps the ~30 fps cadence untouched;
 * a slow frame idles proportionally.
 *
 * Contract this test defends:
 * 1. Fast frames leave the cadence delay at the plain min-interval floor.
 * 2. A slow frame inflates the following delay to at least its measured cost.
 * 3. The inflated delay is capped so a pathological frame doesn't stall the
 *    UI indefinitely.
 */
import { describe, expect, it } from "bun:test";
import { type Component, type RenderTimer, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

const MIN_RENDER_INTERVAL_MS = 1000 / 30;
const MAX_ADAPTIVE_RENDER_MS = 200;
const RENDER_BURST_INTERVAL_MS = 1000 / 120;
const RENDER_BURST_WINDOW_MS = 150;

class ScriptedFrameCost implements Component {
	#nextCostMs: number | null = null;
	scheduler!: { nowMs: number };

	/** Program the next render() to virtually consume `costMs` on the scheduler clock. */
	scheduleCost(costMs: number): void {
		this.#nextCostMs = costMs;
	}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		if (this.#nextCostMs !== null) {
			this.scheduler.nowMs += this.#nextCostMs;
			this.#nextCostMs = null;
		}
		return ["probe"];
	}
}

class DeferredRenderScheduler {
	nowMs = 0;
	readonly immediates: Array<() => void> = [];
	readonly timers: Array<{ callback: () => void; canceled: boolean; delayMs: number }> = [];

	now(): number {
		return this.nowMs;
	}

	scheduleImmediate(callback: () => void): void {
		this.immediates.push(callback);
	}

	scheduleRender(callback: () => void, delayMs: number): RenderTimer {
		const timer = { callback, canceled: false, delayMs };
		this.timers.push(timer);
		return {
			cancel: () => {
				timer.canceled = true;
			},
		};
	}
}

/** Drain immediates + fire the next scheduled render timer. Returns its `delayMs`. */
function stepRender(scheduler: DeferredRenderScheduler): number | null {
	while (scheduler.immediates.length > 0) scheduler.immediates.shift()!();
	const timer = scheduler.timers.shift();
	if (!timer || timer.canceled) return null;
	scheduler.nowMs += timer.delayMs;
	timer.callback();
	return timer.delayMs;
}

describe("TUI adaptive render backpressure (#4145)", () => {
	it("keeps the plain min-interval cadence when frames are cheap", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const probe = new ScriptedFrameCost();
		probe.scheduler = scheduler;
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(probe);

		try {
			tui.start();
			// Drain the initial start-time render.
			stepRender(scheduler);
			scheduler.timers.length = 0;

			// Three cheap (1ms) renders back-to-back: each next delay hugs the
			// 33ms floor (not zero — the previous frame ended right before), so
			// they arrive at the throttled cadence.
			for (let i = 0; i < 3; i++) {
				probe.scheduleCost(1);
				tui.requestRender();
				const delay = stepRender(scheduler);
				expect(delay).not.toBeNull();
				// The cadence floor is min-interval; adaptive floor is
				// max(1ms) which is well below it, so delay ≈ min-interval.
				expect(delay!).toBeGreaterThanOrEqual(0);
				expect(delay!).toBeLessThanOrEqual(MIN_RENDER_INTERVAL_MS + 1);
			}
		} finally {
			tui.stop();
		}
	});

	it("inflates the next delay to the previous frame's cost when a slow frame busts the cadence", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const probe = new ScriptedFrameCost();
		probe.scheduler = scheduler;
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(probe);

		try {
			tui.start();
			stepRender(scheduler);
			scheduler.timers.length = 0;

			// One slow frame — 100ms, well over the 33ms cadence.
			const slowFrameCostMs = 100;
			probe.scheduleCost(slowFrameCostMs);
			tui.requestRender();
			stepRender(scheduler);

			// The next requested render should idle proportional to the last
			// frame's cost. Pre-fix this delay collapsed to zero and pinned CPU.
			probe.scheduleCost(1);
			tui.requestRender();
			const delay = stepRender(scheduler);
			expect(delay).not.toBeNull();
			// `elapsed` at scheduling time is 0 (last render just ended), so
			// the adaptive floor equals the recorded 100ms cost directly.
			expect(delay!).toBeGreaterThanOrEqual(slowFrameCostMs);
		} finally {
			tui.stop();
		}
	});

	it("caps the adaptive delay so a pathological frame doesn't stall the UI", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const probe = new ScriptedFrameCost();
		probe.scheduler = scheduler;
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(probe);

		try {
			tui.start();
			stepRender(scheduler);
			scheduler.timers.length = 0;

			// A pathological 5-second frame — the adaptive floor must cap so
			// the follow-up delay doesn't become 5s.
			probe.scheduleCost(5_000);
			tui.requestRender();
			stepRender(scheduler);

			probe.scheduleCost(1);
			tui.requestRender();
			const delay = stepRender(scheduler);
			expect(delay).not.toBeNull();
			expect(delay!).toBeLessThanOrEqual(MAX_ADAPTIVE_RENDER_MS);
		} finally {
			tui.stop();
		}
	});
});

// The same scheduling seam, from the opposite direction: a pointer gesture
// asks for display-rate sampling because the terminal itself moves its
// viewport once per native wheel report. At the idle 30 fps floor a scroll
// burst collapses into a few large jumps; inside the burst window each report
// gets its own frame, and the window lapses on its own.
describe("TUI render burst cadence", () => {
	it("samples at display rate inside a gesture window and returns to the idle cadence after it lapses", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const probe = new ScriptedFrameCost();
		probe.scheduler = scheduler;
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(probe);

		try {
			tui.start();
			stepRender(scheduler);
			scheduler.timers.length = 0;

			probe.scheduleCost(1);
			tui.requestRender();
			const idleDelay = stepRender(scheduler);
			expect(idleDelay).not.toBeNull();
			expect(idleDelay!).toBeGreaterThan(RENDER_BURST_INTERVAL_MS);

			// Each iteration consumes `delay + 1ms cost` of virtual time, so 25 of
			// them span ~383ms and the 150ms window lapses mid-loop. Classify each
			// frame by the clock reading the scheduler saw when it chose the delay.
			const burstStartMs = scheduler.nowMs;
			tui.beginRenderBurst();
			const samples: Array<{ insideWindow: boolean; delayMs: number }> = [];
			for (let index = 0; index < 25; index++) {
				probe.scheduleCost(1);
				const decidedAtMs = scheduler.nowMs;
				tui.requestRender();
				const delay = stepRender(scheduler);
				expect(delay).not.toBeNull();
				samples.push({ insideWindow: decidedAtMs - burstStartMs < RENDER_BURST_WINDOW_MS, delayMs: delay! });
			}

			// The window must actually lapse mid-loop, otherwise the assertions
			// below would only cover one side of the transition.
			const inside = samples.filter(sample => sample.insideWindow);
			const outside = samples.filter(sample => !sample.insideWindow);
			expect(inside.length).toBeGreaterThan(0);
			expect(outside.length).toBeGreaterThan(0);
			// Inside the gesture: display-rate sampling. After it: the idle floor,
			// undisturbed by adaptive backpressure (frames cost 1ms here).
			for (const sample of inside) expect(sample.delayMs).toBeLessThanOrEqual(RENDER_BURST_INTERVAL_MS);
			for (const sample of outside) {
				expect(sample.delayMs).toBeGreaterThan(RENDER_BURST_INTERVAL_MS);
				expect(sample.delayMs).toBeLessThanOrEqual(MIN_RENDER_INTERVAL_MS);
			}
		} finally {
			tui.stop();
		}
	});
});
