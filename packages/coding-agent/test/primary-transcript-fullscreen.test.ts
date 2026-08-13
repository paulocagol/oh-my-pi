import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { PrimaryTranscriptFullscreen } from "../src/modes/components/primary-transcript-fullscreen";
import { TranscriptContainer } from "../src/modes/components/transcript-container";
import { UserMessageComponent } from "../src/modes/components/user-message";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";
import { executeBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

interface FakeEditor {
	getText(): string;
	render(width: number): readonly string[];
	setText(text: string): void;
}

function createEditor(text: string): FakeEditor {
	return {
		getText: () => text,
		render: () => [text],
		setText: value => {
			text = value;
		},
	};
}

/** Transcript block with directly controllable rows, standing in for a streamed body. */
class Rows implements Component {
	#lines: readonly string[];

	constructor(lines: readonly string[]) {
		this.#lines = lines;
	}

	setLines(lines: readonly string[]): void {
		this.#lines = lines;
	}

	invalidate(): void {}

	render(): readonly string[] {
		return this.#lines;
	}
}

function filler(prefix: string, count: number): Rows {
	return new Rows(Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`));
}

type InputListener = (data: string) => { consume?: boolean } | undefined;

function createFakeUi(rows: number): { ui: TUI; send: InputListener; bursts: () => number } {
	const listeners: InputListener[] = [];
	let bursts = 0;
	const fake = {
		terminal: { rows, columns: 50 },
		addInputListener(listener: InputListener): () => void {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		requestRender(): void {},
		beginRenderBurst(): void {
			bursts++;
		},
	};
	return { ui: fake as unknown as TUI, send: data => listeners[0]?.(data), bursts: () => bursts };
}

/** Row of a rendered frame with styling and the scrollbar column removed. */
function row(lines: readonly string[], index: number): string {
	return Bun.stripANSI(lines[index] ?? "")
		.replace(/[│█]$/, "")
		.trimEnd();
}

const WHEEL_UP = "\x1b[<64;1;1M";
const PAGE_UP = "\x1b[5~";
const CTRL_END = "\x1b[1;5F";
const SHIFT_PAGE_UP = "\x1b[5;2~";

function clickRow(index: number): string {
	return `\x1b[<0;1;${index + 1}M`;
}

describe("PrimaryTranscriptFullscreen", () => {
	it("keeps the editor and footer below a transcript that follows the tail", () => {
		const fakeUi = createFakeUi(8);
		const transcript = new TranscriptContainer();
		transcript.addChild(filler("body", 12));
		const component = new PrimaryTranscriptFullscreen({
			ui: fakeUi.ui,
			transcript,
			editor: createEditor("draft"),
			chromeAbove: [],
			chromeBelow: [],
			onClose: () => {},
		});
		const lines = [...component.render(120)];

		expect(lines).toHaveLength(8);
		expect(row(lines, 6)).toBe("draft");
		expect(row(lines, 7)).toContain("PgUp/PgDn");
		// The header row is reserved on every frame, following or paused, so it
		// costs the viewport one row even here: the newest content row is on
		// screen, the oldest is not.
		expect(row(lines, 0)).toContain("início da conversa");
		expect(row(lines, 5)).toContain("body-12");
		expect(row(lines, 1)).toContain("body-8");
		component.dispose();
	});

	it("names the on-screen section in the sticky header at all times, and snaps a scrolled section back to the top on click", () => {
		const fakeUi = createFakeUi(12);
		const transcript = new TranscriptContainer();
		transcript.addChild(new UserMessageComponent("primeira pergunta", false));
		transcript.addChild(filler("resposta-a", 20));
		transcript.addChild(new UserMessageComponent("segunda pergunta\n\ncom detalhe ignorado", false));
		transcript.addChild(filler("resposta-b", 20));
		const component = new PrimaryTranscriptFullscreen({
			ui: fakeUi.ui,
			transcript,
			editor: createEditor(""),
			chromeAbove: [],
			chromeBelow: [],
			onClose: () => {},
		});
		// The header is reserved on every frame, following or paused, so it
		// already names the section under the tail before the reader scrolls.
		expect(component.render(120).join("\n")).toContain("↳ segunda pergunta");

		// Jump to the prompt that owns the tail: it lands exactly at the viewport
		// top, so the header names that prompt itself (a prompt at the boundary
		// row owns the header, matching the anchor's own inclusive boundary) and
		// previews only its first paragraph.
		expect(fakeUi.send(SHIFT_PAGE_UP)?.consume).toBe(true);
		const atSecond = [...component.render(120)];
		expect(row(atSecond, 0)).toContain("segunda pergunta");
		expect(row(atSecond, 0)).not.toContain("com detalhe ignorado");
		expect(row(atSecond, 1)).toContain("segunda pergunta");

		// Clicking the header re-snaps the same prompt: idempotent while it is
		// already the one named, and still routed through the mouse handler.
		expect(fakeUi.send(clickRow(0))?.consume).toBe(true);
		const snapped = [...component.render(120)];
		expect(row(snapped, 1)).toContain("segunda pergunta");
		component.dispose();
	});

	it("holds the reader's position when a block above the viewport grows", () => {
		const fakeUi = createFakeUi(12);
		const transcript = new TranscriptContainer();
		transcript.addChild(new UserMessageComponent("pergunta", false));
		const growing = filler("stream", 10);
		transcript.addChild(growing);
		transcript.addChild(new UserMessageComponent("pergunta seguinte", false));
		transcript.addChild(filler("depois", 20));
		const component = new PrimaryTranscriptFullscreen({
			ui: fakeUi.ui,
			transcript,
			editor: createEditor(""),
			chromeAbove: [],
			chromeBelow: [],
			onClose: () => {},
		});
		component.render(120);
		fakeUi.send(SHIFT_PAGE_UP);
		const before = [...component.render(120)];
		expect(row(before, 1)).toContain("pergunta seguinte");
		const promptRowBefore = transcript.getPromptAnchors().at(-1)?.row;

		growing.setLines(Array.from({ length: 40 }, (_, index) => `stream-${index + 1}`));
		transcript.invalidate();
		const after = [...component.render(120)];

		expect(transcript.getPromptAnchors().at(-1)?.row).toBe(promptRowBefore! + 30);
		// Absolute line offsets moved by 30 rows; the anchored viewport did not.
		expect(row(after, 1)).toBe(row(before, 1));
		expect(row(after, 2)).toBe(row(before, 2));
		component.dispose();
	});

	it("pages by half a screen and resumes following at the bottom", () => {
		const fakeUi = createFakeUi(14);
		const transcript = new TranscriptContainer();
		transcript.addChild(filler("linha", 60));
		const component = new PrimaryTranscriptFullscreen({
			ui: fakeUi.ui,
			transcript,
			editor: createEditor(""),
			chromeAbove: [],
			chromeBelow: [],
			onClose: () => {},
		});
		// 14 rows − 1 header − 1 editor − 1 footer = 11 of viewport (the header is
		// reserved in every state now); the tail shows linha-50..60.
		expect(row([...component.render(120)], 1)).toBe("linha-50");

		// Half of the 11-row viewport, floored, is 5.
		expect(fakeUi.send(PAGE_UP)?.consume).toBe(true);
		expect(row([...component.render(120)], 1)).toBe("linha-45");

		expect(fakeUi.send(CTRL_END)?.consume).toBe(true);
		const followed = [...component.render(120)];
		expect(row(followed, 1)).toBe("linha-50");
		expect(row(followed, 13)).toContain("seguindo o fim");
		component.dispose();
	});

	it("leaves plain keys to the editor and offers a jump-to-bottom footer", () => {
		const fakeUi = createFakeUi(10);
		const transcript = new TranscriptContainer();
		transcript.addChild(filler("linha", 60));
		const component = new PrimaryTranscriptFullscreen({
			ui: fakeUi.ui,
			transcript,
			editor: createEditor(""),
			chromeAbove: [],
			chromeBelow: [],
			onClose: () => {},
		});
		component.render(120);

		// Bare letters and arrows are text and prompt history: they must reach the editor.
		expect(fakeUi.send("g")).toBeUndefined();
		expect(fakeUi.send("\x1b[A")).toBeUndefined();
		expect(fakeUi.send("\x1b[B")).toBeUndefined();

		expect(fakeUi.send(WHEEL_UP)?.consume).toBe(true);
		expect(row([...component.render(120)], 9)).toContain("clique para ir ao fim");

		// The footer doubles as the jump-to-bottom button.
		expect(fakeUi.send(clickRow(9))?.consume).toBe(true);
		const followed = [...component.render(120)];
		expect(row(followed, 7)).toBe("linha-60");
		expect(row(followed, 9)).toContain("seguindo o fim");
		component.dispose();
	});

	it("preserves Ghostty's native wheel burst distance and direction", () => {
		const fakeUi = createFakeUi(30);
		const transcript = new TranscriptContainer();
		transcript.addChild(filler("linha", 400));
		const component = new PrimaryTranscriptFullscreen({
			ui: fakeUi.ui,
			transcript,
			editor: createEditor(""),
			chromeAbove: [],
			chromeBelow: [],
			onClose: () => {},
		});
		component.render(120);

		const lineNumber = () => Number(row([...component.render(120)], 1).replace("linha-", ""));
		const before = lineNumber();
		for (let index = 0; index < 8; index++) fakeUi.send(WHEEL_UP);
		const afterBurst = lineNumber();
		fakeUi.send("\x1b[<65;1;1M");
		const afterDown = lineNumber();

		expect(before - afterBurst).toBe(8 * 3);
		expect(afterDown - afterBurst).toBe(3);
		// Every report opens a display-rate render window; at the idle 30fps
		// cadence the burst would land as one jump instead of nine steps.
		expect(fakeUi.bursts()).toBe(9);
		expect(row([...component.render(120)], 29)).toContain("clique para ir ao fim");
		component.dispose();
	});

	it("renders chromeAbove between the transcript and the editor, and chromeBelow after the editor", () => {
		const fakeUi = createFakeUi(10);
		const transcript = new TranscriptContainer();
		transcript.addChild(filler("body", 3));
		const component = new PrimaryTranscriptFullscreen({
			ui: fakeUi.ui,
			transcript,
			editor: createEditor("draft"),
			chromeAbove: [new Rows(["CHROME-ABOVE"])],
			chromeBelow: [new Rows(["CHROME-BELOW"])],
			onClose: () => {},
		});
		const lines = [...component.render(120)];

		const aboveIndex = lines.findIndex(line => line.includes("CHROME-ABOVE"));
		const editorIndex = lines.indexOf("draft");
		const belowIndex = lines.findIndex(line => line.includes("CHROME-BELOW"));
		expect(aboveIndex).toBeGreaterThanOrEqual(0);
		expect(editorIndex).toBeGreaterThan(aboveIndex);
		expect(belowIndex).toBeGreaterThan(editorIndex);
		component.dispose();
	});

	it("keeps the editor pinned to the same screen row across frames while only the transcript grows (no streaming jitter)", () => {
		const fakeUi = createFakeUi(10);
		const transcript = new TranscriptContainer();
		const growing = filler("stream", 3);
		transcript.addChild(growing);
		const component = new PrimaryTranscriptFullscreen({
			ui: fakeUi.ui,
			transcript,
			editor: createEditor("draft"),
			chromeAbove: [],
			chromeBelow: [],
			onClose: () => {},
		});
		const before = [...component.render(120)];
		const editorRowBefore = before.indexOf("draft");
		expect(editorRowBefore).toBeGreaterThanOrEqual(0);

		growing.setLines(Array.from({ length: 40 }, (_, index) => `stream-${index + 1}`));
		transcript.invalidate();
		const after = [...component.render(120)];
		const editorRowAfter = after.indexOf("draft");

		expect(editorRowAfter).toBe(editorRowBefore);
		component.dispose();
	});
});

describe("TranscriptContainer.getPromptAnchors", () => {
	it("anchors at the first visible text row of the prompt bubble, not its painted top padding", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new UserMessageComponent("qual é a resposta?", false));
		const frame = transcript.render(80);
		const anchors = transcript.getPromptAnchors();

		expect(anchors).toHaveLength(1);
		const anchorRow = anchors[0]!.row;
		const anchorLine = Bun.stripANSI(frame[anchorRow] ?? "");
		expect(anchorLine).toContain("qual é a resposta?");

		// The bubble genuinely paints a background row above the text — confirms
		// the anchor actually skipped it rather than the bubble having no padding
		// to skip in the first place.
		expect(anchorRow).toBeGreaterThan(0);
		expect(Bun.stripANSI(frame[anchorRow - 1] ?? "").trim()).toBe("");
	});
});

describe("/tui fullscreen", () => {
	it("routes fullscreen and default to the interactive context", async () => {
		const editor = createEditor("/tui fullscreen");
		const modes: string[] = [];
		const context = {
			editor,
			collabGuest: undefined,
			setPrimaryTranscriptFullscreen: (mode: string) => modes.push(mode),
		} as unknown as InteractiveModeContext;

		expect(await executeBuiltinSlashCommand("/tui fullscreen", { ctx: context })).toBe(true);
		expect(await executeBuiltinSlashCommand("/tui default", { ctx: context })).toBe(true);
		expect(modes).toEqual(["fullscreen", "default"]);
		expect(editor.getText()).toBe("");
	});
});
