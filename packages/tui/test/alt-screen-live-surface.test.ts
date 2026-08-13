import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@oh-my-pi/pi-tui";
import { Image, type ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { VirtualTerminal } from "./virtual-terminal";

type MutableTerminalInfo = { id: string; imageProtocol: ImageProtocol | null };
/** Mutable view of the process-wide terminal-capabilities singleton, restored per test. */
const terminal = TERMINAL as unknown as MutableTerminalInfo;
const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

function makeImage(budget: ImageBudget, key: string): Image {
	return new Image(
		BASE64_ONE_PIXEL_PNG,
		"image/png",
		{ fallbackColor: t => t },
		{ maxWidthCells: 4, maxHeightCells: 4, budget, imageKey: key },
	);
}

// Regression coverage for the fullscreen alt-screen surface (`/tui fullscreen`,
// the plan/setup/transcript-viewer modals). Two bugs were reported together
// ("cursor invisible" + "lines out of sync" while streaming) and traced to the
// same code path: `#renderAltFrame`/`#emitAltFrame` rewrote every row of the
// alt buffer whenever ANY row changed (a `#lineRewriteSequence` call per row
// on every frame), and unconditionally discarded `#extractCursorMarkers`'
// result, so the hardware cursor never came back after `hideCursor()` on
// alt-screen entry. The fix adds a per-row diff against `#altPreviousLines`
// (only changed rows are rewritten) and a `cursor?: boolean` opt-in on
// `OverlayOptions` that positions and shows the hardware cursor at the
// focused component's `CURSOR_MARKER`. These tests assert the two contracts
// directly against the bytes the terminal receives and the screen content it
// ends up with, so they fail if either regresses.

class MutableLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {
		// No cached state
	}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

// A focusable overlay that emits CURSOR_MARKER at a fixed row/col while
// focused, and plain text otherwise — mirrors FocusedMutableOverlay in
// overlay-scroll.test.ts but over multiple rows, so the marker's position
// within the fullscreen window is unambiguous.
class FocusedCursorLinesComponent implements Component, Focusable {
	focused = false;
	#lines: string[];
	readonly #cursorRow: number;
	readonly #cursorCol: number;

	constructor(lines: string[], cursorRow: number, cursorCol: number) {
		this.#lines = [...lines];
		this.#cursorRow = cursorRow;
		this.#cursorCol = cursorCol;
	}

	invalidate(): void {
		// No cached state
	}

	render(_width: number): string[] {
		return this.#lines.map((line, i) => {
			if (i !== this.#cursorRow || !this.focused) return line;
			return `${line.slice(0, this.#cursorCol)}${CURSOR_MARKER}${line.slice(this.#cursorCol)}`;
		});
	}
}

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_v, i) => `${prefix}${i}`);
}

// Fills the terminal exactly (width/height match the overlay's line count and
// column width), so `row`/`col` resolve to (0, 0) regardless of anchor — the
// window under test is the whole alt screen, like `/tui fullscreen`.
const FULLSCREEN_FILL = {
	anchor: "bottom-center",
	width: "100%",
	maxHeight: "100%",
	margin: 0,
	fullscreen: true,
} as const;

async function settle(term: VirtualTerminal): Promise<void> {
	// Integration test against TUI's real render scheduler (setImmediate hop
	// then a throttled setTimeout(0) paint), not a fake-timer-friendly unit
	// under test — there is no exposed "render finished" event to await
	// instead, so draining both real macrotasks is the only deterministic
	// signal that the throttled alt-frame paint has fired.
	const immediate = Promise.withResolvers<void>();
	setImmediate(immediate.resolve);
	await immediate.promise;
	await Bun.sleep(1);
	await term.flush();
}

function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

describe("TUI fullscreen alt-screen live surface", () => {
	// TUI throttles ordinary renders to ~30fps off `performance.now()`. The
	// second paint in these tests lands microseconds after the first, so without
	// a monotonic clock the throttle parks it past the settle window and the
	// assertions read an unpainted screen. Same idiom as render-regressions.
	let monotonicNow = 0;

	beforeEach(() => {
		monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 40;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("repaints only the row that changed, not the whole alt screen (streaming jitter regression)", async () => {
		const term = new VirtualTerminal(40, 6, 200);
		const writes = captureWrites(term);
		const tui = new TUI(term);
		const overlay = new MutableLinesComponent(rows("row-", 6));
		tui.showOverlay(overlay, FULLSCREEN_FILL);

		try {
			tui.start();
			await settle(term);
			expect(visible(term)).toEqual(rows("row-", 6));

			const beforeUpdate = writes.length;
			overlay.setLines(["row-0", "row-1", "row-2-UPDATED", "row-3", "row-4", "row-5"]);
			tui.requestRender();
			await settle(term);

			const diffWrite = writes.slice(beforeUpdate).join("");
			expect(diffWrite).toContain("row-2-UPDATED");
			// Every row that did NOT change must not be retransmitted. The old
			// #emitAltFrame rewrote all `height` rows the moment any single row
			// differed — this is exactly what produced the reported "lines
			// without harmony" flicker while the agent streamed tokens.
			for (const untouchedRow of ["row-0", "row-1", "row-3", "row-4", "row-5"]) {
				expect(diffWrite).not.toContain(untouchedRow);
			}
		} finally {
			tui.stop();
		}
	});

	it("keeps the rendered screen correct after a diffed update — identical to an equivalent full repaint", async () => {
		const initialLines = rows("row-", 6);
		const updatedLines = ["row-0", "row-1", "row-2-UPDATED", "row-3", "row-4", "row-5"];

		const diffedTerm = new VirtualTerminal(40, 6, 200);
		const diffedTui = new TUI(diffedTerm);
		const overlay = new MutableLinesComponent(initialLines);
		diffedTui.showOverlay(overlay, FULLSCREEN_FILL);
		let diffedViewport: string[];
		try {
			diffedTui.start();
			await settle(diffedTerm);
			overlay.setLines(updatedLines);
			diffedTui.requestRender();
			await settle(diffedTerm);
			diffedViewport = visible(diffedTerm);
		} finally {
			diffedTui.stop();
		}

		// Independent TUI/terminal pair that paints the post-update content as
		// its very first (necessarily full) alt frame — the diff path must land
		// on the exact same screen a full repaint would have produced.
		const freshTerm = new VirtualTerminal(40, 6, 200);
		const freshTui = new TUI(freshTerm);
		freshTui.showOverlay(new MutableLinesComponent(updatedLines), FULLSCREEN_FILL);
		let freshViewport: string[];
		try {
			freshTui.start();
			await settle(freshTerm);
			freshViewport = visible(freshTerm);
		} finally {
			freshTui.stop();
		}

		expect(diffedViewport).toEqual(updatedLines);
		expect(diffedViewport).toEqual(freshViewport);
	});

	it("shows and positions the hardware cursor at CURSOR_MARKER when the overlay opts in with cursor:true", async () => {
		const term = new VirtualTerminal(40, 6, 200);
		const writes = captureWrites(term);
		// The alt cursor is gated on the app-level hardware-cursor preference
		// (settings `showHardwareCursor`, default on): with it off the focused
		// component paints an in-band caret instead, and voice mode / live
		// commands switch it off deliberately.
		const tui = new TUI(term, true);
		const overlay = new FocusedCursorLinesComponent(rows("row-", 6), 2, 3);
		tui.showOverlay(overlay, { ...FULLSCREEN_FILL, cursor: true });

		try {
			tui.start();
			// showOverlay() focuses its own component when it becomes the visible
			// overlay, so the marker is emitted from the very first render.
			expect(overlay.focused).toBeTrue();
			await settle(term);

			const payload = writes.join("");
			expect(payload).toContain("\x1b[?25h");
			// The marker is an internal sentinel; it must never reach the
			// terminal, only steer where the hardware cursor is placed.
			expect(payload).not.toContain(CURSOR_MARKER);
			expect(term.getCursor()).toEqual({ row: 2, col: 3 });
		} finally {
			tui.stop();
		}
	});

	it("leaves the hardware cursor hidden for fullscreen overlays that do not opt into cursor:true", async () => {
		const term = new VirtualTerminal(40, 6, 200);
		const writes = captureWrites(term);
		const tui = new TUI(term, true);
		// Focused and marker-emitting exactly like the opt-in case above — only
		// the missing `cursor: true` should differ in observed behavior. Every
		// existing static modal (plan review, setup wizard, transcript viewer)
		// relies on this staying true.
		const overlay = new FocusedCursorLinesComponent(rows("row-", 6), 2, 3);
		tui.showOverlay(overlay, FULLSCREEN_FILL);

		try {
			tui.start();
			expect(overlay.focused).toBeTrue();
			await settle(term);

			const payload = writes.join("");
			expect(payload).not.toContain("\x1b[?25h");
			expect(payload).not.toContain(CURSOR_MARKER);
		} finally {
			tui.stop();
		}
	});

	it("requestRender(true) rewrites every row even when the alt frame is byte-identical to the last paint", async () => {
		const term = new VirtualTerminal(40, 6, 200);
		const writes = captureWrites(term);
		const tui = new TUI(term);
		const overlay = new MutableLinesComponent(rows("row-", 6));
		tui.showOverlay(overlay, FULLSCREEN_FILL);

		try {
			tui.start();
			await settle(term);

			const beforeForce = writes.length;
			// Content is untouched — a per-row diff would normally see zero
			// changed rows and write nothing. The forced-repaint contract must
			// still win, so a corrupted modal (garbled by e.g. a stray host
			// escape sequence) can always be repaired with requestRender(true).
			tui.requestRender(true);
			await settle(term);

			const forcedWrite = writes.slice(beforeForce).join("");
			for (const rowText of rows("row-", 6)) {
				expect(forcedWrite).toContain(rowText);
			}
		} finally {
			tui.stop();
		}
	});

	it("coalesces adjacent changed rows into one jump and writes nothing at all when the frame is identical", async () => {
		const term = new VirtualTerminal(40, 6, 200);
		const writes = captureWrites(term);
		const tui = new TUI(term);
		const overlay = new MutableLinesComponent(rows("row-", 6));
		tui.showOverlay(overlay, FULLSCREEN_FILL);

		try {
			tui.start();
			await settle(term);
			const enterRedraws = tui.fullRedraws;

			const beforeUpdate = writes.length;
			overlay.setLines(["row-0", "row-1", "changed-2", "changed-3", "row-4", "row-5"]);
			tui.requestRender();
			await settle(term);

			const diffWrite = writes.slice(beforeUpdate).join("");
			// Rows 2 and 3 are adjacent: one absolute jump to row 3 (1-based) and a
			// CRLF to reach row 4. A second jump would be dead bytes, and a row-by-row
			// diff is not a full redraw.
			expect(diffWrite.match(/\x1b\[\d+;1H/g)).toEqual(["\x1b[3;1H"]);
			expect(diffWrite).toContain("changed-2");
			expect(diffWrite).toContain("changed-3");
			expect(diffWrite).toContain("\r\n");
			expect(tui.fullRedraws).toBe(enterRedraws);
			expect(visible(term)).toEqual(["row-0", "row-1", "changed-2", "changed-3", "row-4", "row-5"]);

			const beforeIdle = writes.length;
			tui.requestRender();
			await settle(term);
			expect(writes.slice(beforeIdle)).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("rewrites every row after a height change, when the cached frame no longer covers the screen", async () => {
		const term = new VirtualTerminal(40, 6, 200);
		const writes = captureWrites(term);
		const tui = new TUI(term);
		tui.showOverlay(new MutableLinesComponent(rows("row-", 6)), FULLSCREEN_FILL);

		try {
			tui.start();
			await settle(term);

			const beforeResize = writes.length;
			term.resize(40, 9);
			// Integration against the real resize settle window (120 ms of wall
			// clock in the scheduler, not the render throttle the monotonic clock
			// above neutralizes), so this one genuinely has to wait it out.
			await Bun.sleep(160);
			await settle(term);

			const resizeWrite = writes.slice(beforeResize).join("");
			// The diff base describes 6 rows; three more just appeared, so the
			// frame is repainted from home rather than diffed against a shape the
			// screen no longer has.
			expect(resizeWrite).toContain("\x1b[H");
			for (const rowText of rows("row-", 6)) {
				expect(resizeWrite).toContain(rowText);
			}
			expect(visible(term).filter(Boolean)).toEqual(rows("row-", 6));
		} finally {
			tui.stop();
		}
	});

	it("moves the hardware cursor without repainting a row when only the caret moved", async () => {
		const term = new VirtualTerminal(40, 6, 200);
		const writes = captureWrites(term);
		const tui = new TUI(term, true);
		const overlay = new MutableLinesComponent([`ed> ab${CURSOR_MARKER}`, ...rows("row-", 5)]);
		tui.showOverlay(overlay, { ...FULLSCREEN_FILL, cursor: true });

		try {
			tui.start();
			await settle(term);
			expect(term.getCursor()).toEqual({ row: 0, col: 6 });

			const beforeMove = writes.length;
			overlay.setLines([`ed> a${CURSOR_MARKER}b`, ...rows("row-", 5)]);
			tui.requestRender();
			await settle(term);

			// Markers are stripped before the diff, so every row is byte-identical
			// and the caret move must cost one cursor block — no row rewrite.
			const moveWrite = writes.slice(beforeMove).join("");
			expect(moveWrite).not.toContain("ed>");
			expect(moveWrite).toContain("\x1b[1;6H\x1b[?25h");
			expect(term.getCursor()).toEqual({ row: 0, col: 5 });
		} finally {
			tui.stop();
		}
	});

	it("restores the normal screen's cursor tracking when the fullscreen overlay closes", async () => {
		const term = new VirtualTerminal(40, 8, 200);
		const tui = new TUI(term, true);
		// 15 frame rows over an 8-row viewport (windowTop 7) with the marker on
		// frame row 12, i.e. screen row 5. The two rows below it are the point:
		// with the caret parked on the bottom row the terminal's own clamp would
		// swallow a stale cursor origin and hide the regression.
		tui.addChild(new MutableLinesComponent([...rows("base-", 12), `input>${CURSOR_MARKER}`, "tail-0", "tail-1"]));

		try {
			tui.start();
			await settle(term);
			expect(term.getCursor()).toEqual({ row: 5, col: 6 });

			const handle = tui.showOverlay(new MutableLinesComponent([`edit>${CURSOR_MARKER}`, ...rows("modal-", 7)]), {
				...FULLSCREEN_FILL,
				cursor: true,
			});
			await settle(term);
			expect(term.getCursor()).toEqual({ row: 0, col: 5 });

			handle.hide();
			await settle(term);
			// While the overlay was up the tracked cursor row was an ABSOLUTE alt
			// row. `\x1b[?1049l` restores the terminal's own saved cursor, so the
			// tracker has to revert with it; otherwise the first normal-screen
			// cursor move is computed from the wrong origin and the caret lands on
			// the wrong line (the "cursor broken after using fullscreen" report).
			expect(term.getCursor()).toEqual({ row: 5, col: 6 });
			expect(visible(term).at(-1)).toBe("tail-1");
		} finally {
			tui.stop();
		}
	});

	it("hides a visible alt cursor before leaving the alt buffer", async () => {
		const term = new VirtualTerminal(40, 6, 200);
		const tui = new TUI(term, true);
		tui.addChild(new MutableLinesComponent(rows("base-", 6)));

		try {
			tui.start();
			await settle(term);
			// A second overlay keeps the stack non-empty, so hiding the fullscreen
			// one leaves the alt buffer without passing through the stack-empty
			// hideCursor() in removeOverlay — the exit itself has to do it.
			tui.showOverlay(new MutableLinesComponent(["UNDER"]), { width: "50%" });
			const full = tui.showOverlay(new MutableLinesComponent([`edit>${CURSOR_MARKER}`, ...rows("modal-", 5)]), {
				...FULLSCREEN_FILL,
				cursor: true,
			});
			await settle(term);
			expect(term.getCursor()).toEqual({ row: 0, col: 5 });

			const writes = captureWrites(term);
			full.setHidden(true);
			await settle(term);

			const exitWrite = writes.join("");
			// DECTCEM is not part of what `\x1b[?1049l` restores, so a visible alt
			// caret would survive onto the transcript.
			expect(exitWrite).toContain("\x1b[?25l\x1b[?1006l");
			// The kitty pop still sits flush against the buffer switch.
			expect(exitWrite).toContain("\x1b[<u\x1b[?1049l");
			expect(visible(term).some(line => line.includes("UNDER"))).toBeTrue();
		} finally {
			tui.stop();
		}
	});

	it("places the shell prompt on the first free row after content when stop() tears down a fullscreen+cursor:true overlay that never closed", async () => {
		const term = new VirtualTerminal(40, 8, 200);
		const tui = new TUI(term, true);
		// Six rows of ordinary content with the caret on the last one — the
		// normal-screen editor focused before `/tui fullscreen` opens.
		tui.addChild(new MutableLinesComponent([...rows("row-", 5), `edit>${CURSOR_MARKER}`]));

		try {
			tui.start();
			await settle(term);
			expect(term.getCursor()).toEqual({ row: 5, col: 5 });

			// Open the fullscreen editor overlay (mirrors `/tui fullscreen`'s own
			// `cursor: true` opt-in) with its own caret on the alt screen's last row
			// — far from the normal screen's row 5, so a stale tracked cursor row is
			// unmistakable in the teardown math below.
			tui.showOverlay(new MutableLinesComponent([...rows("modal-", 7), `alt-edit>${CURSOR_MARKER}`]), {
				...FULLSCREEN_FILL,
				cursor: true,
			});
			await settle(term);
			expect(term.getCursor()).toEqual({ row: 7, col: 9 });

			// stop() runs with the overlay STILL open — the app quitting
			// mid-session, not the overlay closing first. `#hardwareCursorRow` must
			// still be reverted to the normal screen's tracked row (5) before the
			// "place shell after content" math below runs, or it derives the move
			// from the alt screen's absolute row (7) instead and overshoots upward.
			const writes = captureWrites(term);
			tui.stop();

			const teardown = writes.join("");
			// Without the fix this wrote "\x1b[?1049l\x1b[1A\r" and landed on row 4
			// — one row into the six-line transcript instead of below it.
			expect(teardown).toContain("\x1b[?1049l\x1b[1B\r");
			expect(term.getCursor().row).toBe(6);
			expect(visible(term).slice(0, 6)).toEqual([...rows("row-", 5), "edit>"]);
		} finally {
			tui.stop();
		}
	});

	it("flushes an already-queued alt exit on stop(), even before a deferred Ghostty image repaint gets to run it", () => {
		const originalId = terminal.id;
		const originalProtocol = terminal.imageProtocol;
		const originalGraphics = { ...getKittyGraphics() };
		const term = new VirtualTerminal(40, 12);
		const writes = captureWrites(term);

		let now = 0;
		const scheduled: Array<{ delayMs: number; callback: () => void; canceled: boolean }> = [];
		const renderScheduler = {
			now: () => now,
			scheduleImmediate: (callback: () => void) => callback(),
			scheduleRender: (callback: () => void, delayMs: number) => {
				const entry = { delayMs, callback, canceled: false };
				scheduled.push(entry);
				return {
					cancel: () => {
						entry.canceled = true;
					},
				};
			},
		};

		terminal.id = "ghostty";
		terminal.imageProtocol = ImageProtocol.Kitty;
		setKittyGraphics({ unicodePlaceholders: true });
		const tui = new TUI(term, undefined, { renderScheduler });
		tui.addChild(new Text("old session", 0, 0));

		try {
			tui.start();
			const overlay = tui.showOverlay(new Text("session selector", 0, 0), {
				width: "100%",
				maxHeight: "100%",
				fullscreen: true,
			});
			tui.addChild(makeImage(tui.imageBudget, "resumed-image"));
			tui.requestRender(true, { clearScrollback: true });
			overlay.hide();

			// The ordinary render `hide()` scheduled runs the alt-exit transition —
			// `#altActive` goes false and the exit sequence queues in
			// `#pendingAltExit` — but composing this same frame discovers the new
			// image's pending transmit, which the Ghostty startup-settle window
			// defers: the render returns before it ever gets to flush that queued
			// exit (mirrors "keeps a deferred fullscreen exit..." in
			// image-budget.test.ts, which resolves it via the later repaint instead
			// of stop()).
			const queued = scheduled.find(entry => !entry.canceled);
			expect(queued).toBeDefined();
			now = 40;
			queued!.canceled = true;
			queued!.callback();

			const delayed = scheduled.find(entry => !entry.canceled);
			expect(delayed).toBeDefined();
			expect(writes.some(write => write.includes("\x1b[?1049l"))).toBe(false);
			expect(visible(term).some(line => line.includes("session selector"))).toBeTrue();

			// The app quits before that deferred repaint gets its turn — `#altActive`
			// is already false, so only the `#pendingAltExit` half of stop()'s guard
			// can still flush the buffer restore; dropping that half would leave the
			// terminal parked on the alternate screen forever after the process exits.
			tui.stop();

			const exitWrites = writes.filter(write => write.includes("\x1b[?1049l"));
			expect(exitWrites).toHaveLength(1);
		} finally {
			terminal.id = originalId;
			terminal.imageProtocol = originalProtocol;
			setKittyGraphics(originalGraphics);
		}
	});

	it("re-emits an image row in the alt diff on every changed frame, even when its own text is unchanged", async () => {
		const originalProtocol = terminal.imageProtocol;
		terminal.imageProtocol = ImageProtocol.Kitty;
		try {
			const term = new VirtualTerminal(40, 4, 200);
			const writes = captureWrites(term);
			const tui = new TUI(term);
			// A Kitty direct-placement needle without the strict placement syntax:
			// recognized by `TERMINAL.isImageLine`, but not `parseKittyDirectPlacementLine`,
			// so `#lineRewriteSequence` writes it back verbatim.
			const imageLine = "\x1b_Gimage-placeholder-row\x1b\\";
			const overlay = new MutableLinesComponent(["row-0", "row-1", imageLine, "row-3"]);
			tui.showOverlay(overlay, FULLSCREEN_FILL);

			try {
				tui.start();
				await settle(term);

				const beforeUpdate = writes.length;
				// Only row 0 changes; the image row (row 2) is not adjacent to it,
				// and its own text is byte-identical to the last paint — Kitty and
				// Sixel placements can still be dropped silently by scroll/redraw
				// activity elsewhere, so a repeated placeholder string is no signal
				// that the placement itself survived.
				overlay.setLines(["row-0-updated", "row-1", imageLine, "row-3"]);
				tui.requestRender();
				await settle(term);

				const diffWrite = writes.slice(beforeUpdate).join("");
				const jumps = diffWrite.match(/\x1b\[\d+;1H/g);
				// Two separate runs — row 0 (the real change) and row 2 (the image,
				// forced regardless of its unchanged text) — never coalesced across
				// the untouched row 1 between them.
				expect(jumps).toEqual(["\x1b[1;1H", "\x1b[3;1H"]);
				expect(diffWrite).toContain("row-0-updated");
				// Re-emitted inside its own jump — whatever SGR reset the line
				// rewrite happens to prefix it with.
				expect(diffWrite.slice(diffWrite.indexOf("\x1b[3;1H"))).toContain(imageLine);
				expect(diffWrite).not.toContain("row-1");
				expect(diffWrite).not.toContain("row-3");
			} finally {
				tui.stop();
			}
		} finally {
			terminal.imageProtocol = originalProtocol;
		}
	});
});
