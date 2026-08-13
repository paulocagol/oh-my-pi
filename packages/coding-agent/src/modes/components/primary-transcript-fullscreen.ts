import {
	type Component,
	Ellipsis,
	matchesKey,
	type OverlayFocusOwner,
	routeSgrMouseInput,
	ScrollView,
	type SgrMouseEvent,
	type TUI,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import type { CustomEditor } from "./custom-editor";
import type { TranscriptContainer, TranscriptPromptAnchor } from "./transcript-container";

/** Single-line cap for the sticky prompt header. */
const STICKY_TEXT_CAP = 240;
/**
 * Footer hint sets, widest first. A narrow terminal steps down to the next one
 * instead of dropping every hint at once.
 */
const FOOTER_HINTS = [
	"Esc: sair · PgUp/PgDn: rolar · Shift+PgUp/PgDn: prompt · Ctrl+Home/End: início/fim",
	"Esc: sair · PgUp/PgDn · Shift+PgUp/PgDn · Ctrl+Home/End",
	"Esc: sair · PgUp/PgDn · Ctrl+Home/End",
	"Esc: sair",
	"",
] as const;

export interface PrimaryTranscriptFullscreenDeps {
	ui: TUI;
	transcript: TranscriptContainer;
	editor: Pick<CustomEditor, "getText" | "render">;
	/**
	 * Live chrome that sits between the transcript and the editor in the normal
	 * component tree — pending messages, the todo and subagent HUDs, error
	 * banners, the working loader and the status line. The fullscreen frame
	 * composes over an empty base, so whatever is not listed here is simply not
	 * on screen while the surface is up.
	 */
	chromeAbove: readonly Component[];
	/** Chrome rendered below the editor (hook widgets), same tree order. */
	chromeBelow: readonly Component[];
	onClose: () => void;
}

/** Where the viewport is pinned while auto-follow is paused. */
interface ScrollAnchor {
	/** The prompt block itself: a rebuild reorders indices, but identity survives. */
	prompt: Component;
	/** Rows between that prompt's first row and the viewport top. */
	rowsBelow: number;
}

/**
 * Collapse a prompt to the single line shown in the sticky header: first
 * paragraph only, whitespace flattened. A prompt like `"still broken:\n\n1. a"`
 * previews as just its lead-in, matching Claude Code's header.
 */
function collapsePrompt(text: string): string {
	const trimmed = text.trimStart();
	const paragraphEnd = trimmed.search(/\n\s*\n/);
	return (paragraphEnd >= 0 ? trimmed.slice(0, paragraphEnd) : trimmed)
		.slice(0, STICKY_TEXT_CAP)
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Index of the last prompt starting strictly above `top` — the prompt whose
 * section the reader is inside. `anchors` is ascending by row, so binary search.
 */
function promptAbove(anchors: readonly TranscriptPromptAnchor[], top: number): number {
	let low = 0;
	let high = anchors.length - 1;
	let found = -1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (anchors[mid]!.row < top) {
			found = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return found;
}

/** Append each component's rows to `out`, in tree order. */
function renderInto(components: readonly Component[], width: number, out: string[]): void {
	for (const component of components) {
		const lines = component.render(width);
		for (let i = 0; i < lines.length; i++) out.push(lines[i]!);
	}
}

/**
 * Claude-style fullscreen surface for the live primary transcript.
 *
 * It deliberately reuses the existing transcript renderer and editor instead of
 * changing the append-only native-scrollback engine. The alternate-screen host
 * gives this component its own viewport; ScrollView keeps the editor fixed below
 * it and owns manual transcript scrolling.
 *
 * Scroll position is stored as a *prompt anchor* (which prompt, how many rows
 * below it) rather than a line offset, so a block above the viewport that
 * reflows or grows mid-stream does not slide text out from under the reader.
 * A one-line sticky header names the prompt whose section is on screen —
 * reserved in both states so the geometry never shifts — and clicking it snaps
 * that prompt to the viewport top.
 *
 * The editor, the live chrome around it and the footer are anchored to the
 * bottom of the screen; the transcript viewport absorbs every size change, so
 * the prompt never moves under the user's hands when the working loader or a
 * HUD appears mid-stream.
 */
export class PrimaryTranscriptFullscreen implements Component, OverlayFocusOwner {
	readonly #deps: PrimaryTranscriptFullscreenDeps;
	readonly #scrollView: ScrollView;
	#followBottom = true;
	#anchor: ScrollAnchor | undefined;
	/** Prompt anchors of the last render; owned here because the container recycles its buffer. */
	readonly #prompts: TranscriptPromptAnchor[] = [];
	/** Rendered chrome rows of the current frame; reused to keep streaming allocation-free. */
	readonly #chromeAboveLines: string[] = [];
	readonly #chromeBelowLines: string[] = [];
	/** The frame buffer handed to the compositor, which copies it before we touch it again. */
	readonly #frame: string[] = [];
	/** Transcript row the sticky header points at, or -1 when it names no prompt. */
	#stickyRow = -1;
	/** Transcript height when auto-follow was paused, for the "new rows" indicator. */
	#rowsAtPause = 0;
	#totalRows = 0;
	#viewportHeight = 1;
	/** Screen row of the jump-to-bottom footer, or -1 when the screen is too short for one. */
	#footerRow = -1;
	#removeInputListener: (() => void) | undefined;
	#closed = false;

	constructor(deps: PrimaryTranscriptFullscreenDeps) {
		this.#deps = deps;
		this.#scrollView = new ScrollView([], {
			height: 1,
			// Reserve the bar column even when the content fits: the transcript is
			// rendered one column narrower to match, so passing the one-screen mark
			// no longer reflows every line by a column.
			scrollbar: "always",
			// Rows arrive already wrapped to the content width; only trailing
			// padding can overflow, and an ellipsis there would land on every line.
			ellipsis: Ellipsis.Omit,
			theme: {
				track: text => theme.fg("dim", text),
				thumb: text => theme.fg("accent", text),
			},
		});
		this.#removeInputListener = deps.ui.addInputListener(data => {
			if (this.#closed) return undefined;
			if (data.startsWith("\x1b[<")) {
				return routeSgrMouseInput(data, event => this.#handleMouse(event)) ? { consume: true } : undefined;
			}
			return this.#handleKey(data) ? { consume: true } : undefined;
		});
	}

	ownsOverlayFocusTarget(component: Component): boolean {
		return component === this.#deps.editor;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#removeInputListener?.();
		this.#removeInputListener = undefined;
		this.#deps.onClose();
	}

	dispose(): void {
		this.#removeInputListener?.();
		this.#removeInputListener = undefined;
	}

	invalidate(): void {
		this.#scrollView.invalidate();
	}

	/**
	 * Scroll keys are consumed ahead of the focused editor (input listeners run
	 * first). Only chords the editor cannot use for text are bound: no bare
	 * letters, no bare arrows, so typing and prompt history keep working while
	 * the transcript stays navigable.
	 */
	#handleKey(data: string): boolean {
		// Esc closes only on an empty draft; with text it keeps its clear-draft meaning.
		if (matchesKey(data, "escape") && this.#deps.editor.getText().trim() === "") {
			this.close();
			return true;
		}
		if (matchesKey(data, "shift+pageUp")) return this.#jumpPrompt(-1);
		if (matchesKey(data, "shift+pageDown")) return this.#jumpPrompt(1);
		// Half-screen paging, matching Claude Code's PgUp/PgDn.
		const half = Math.max(1, Math.floor(this.#viewportHeight / 2));
		if (matchesKey(data, "pageUp")) return this.#scrollBy(-half);
		if (matchesKey(data, "pageDown")) return this.#scrollBy(half);
		if (matchesKey(data, "ctrl+home")) return this.#scrollTo(0);
		if (matchesKey(data, "ctrl+end")) return this.#follow();
		return false;
	}

	#handleMouse(event: SgrMouseEvent): boolean {
		// Ghostty's acceleration arrives as a burst of native wheel reports, one
		// per three-row step of its own viewport. Keep that delta and ask the
		// engine to sample at display rate for the length of the gesture:
		// coalescing the burst into 30 fps frames is what turns a smooth scroll
		// into ~9-row jumps.
		if (event.wheel !== null) {
			this.#deps.ui.beginRenderBurst();
			return this.#scrollBy(event.wheel * 3);
		}
		if (!event.leftClick) return false;
		// The fullscreen frame paints from screen row 0, so mouse rows index the
		// lines this component returned: row 0 is the sticky header when present,
		// and the footer doubles as the jump-to-bottom button.
		if (event.row === 0 && this.#stickyRow >= 0) return this.#scrollTo(this.#stickyRow);
		if (event.row === this.#footerRow && !this.#followBottom) return this.#follow();
		return false;
	}

	#scrollBy(delta: number): boolean {
		return this.#scrollTo(this.#scrollView.getScrollOffset() + delta);
	}

	/** Pin the viewport at an absolute transcript row, pausing auto-follow. */
	#scrollTo(offset: number): boolean {
		this.#scrollView.setScrollOffset(offset);
		const settled = this.#scrollView.getScrollOffset();
		// Reaching the bottom by any means resumes following, like every chat view.
		if (settled >= this.#scrollView.getMaxScrollOffset()) return this.#follow();
		if (this.#followBottom) {
			this.#followBottom = false;
			this.#rowsAtPause = this.#totalRows;
		}
		this.#anchor = this.#deriveAnchor(settled);
		this.#deps.ui.requestRender();
		return true;
	}

	/** Resume auto-follow and jump to the newest output. */
	#follow(): boolean {
		this.#followBottom = true;
		this.#anchor = undefined;
		this.#rowsAtPause = this.#totalRows;
		this.#scrollView.scrollToBottom();
		this.#deps.ui.requestRender();
		return true;
	}

	/** Snap to the previous (-1) or next (+1) prompt relative to the viewport top. */
	#jumpPrompt(direction: -1 | 1): boolean {
		if (this.#prompts.length === 0) return false;
		const top = this.#scrollView.getScrollOffset();
		if (direction < 0) {
			const index = promptAbove(this.#prompts, top);
			return this.#scrollTo(index < 0 ? 0 : this.#prompts[index]!.row);
		}
		const next = this.#prompts.find(prompt => prompt.row > top);
		return next === undefined ? this.#follow() : this.#scrollTo(next.row);
	}

	#deriveAnchor(top: number): ScrollAnchor | undefined {
		const index = promptAbove(this.#prompts, top + 1);
		if (index < 0) return undefined;
		const prompt = this.#prompts[index]!;
		return { prompt: prompt.component, rowsBelow: top - prompt.row };
	}

	/**
	 * Absolute row the stored anchor resolves to against the current render, or
	 * `undefined` once its prompt is gone (a rebuild, `/clear`, or a replaced
	 * optimistic message), in which case the viewport keeps its last offset
	 * rather than snapping to an unrelated prompt.
	 */
	#resolveAnchor(): number | undefined {
		if (this.#anchor === undefined) return undefined;
		const prompt = this.#prompts.find(candidate => candidate.component === this.#anchor?.prompt);
		if (prompt === undefined) return undefined;
		return Math.max(0, prompt.row + this.#anchor.rowsBelow);
	}

	/**
	 * The reserved header row: the prompt whose section is on screen, or a
	 * start-of-conversation marker when the reader is above the first prompt.
	 */
	#headerLine(stickyIndex: number): string {
		const text = stickyIndex < 0 ? "" : collapsePrompt(this.#prompts[stickyIndex]!.text);
		return text === "" ? theme.fg("dim", "↑ início da conversa") : theme.fg("accent", `↳ ${text}`);
	}

	/** Right-edge status, long form first. */
	#footerStatus(long: boolean): string {
		if (this.#followBottom) return long ? "seguindo o fim" : "no fim";
		const newRows = Math.max(0, this.#totalRows - this.#rowsAtPause);
		if (newRows === 0) return long ? "↓ clique para ir ao fim" : "↓ ir ao fim";
		const label = `↓ ${newRows} ${newRows === 1 ? "linha nova" : "linhas novas"}`;
		return long ? `${label} · clique para ir ao fim` : label;
	}

	/** Hints, gap, right-anchored status — or `undefined` when the status alone overflows. */
	#composeFooter(width: number, status: string): string | undefined {
		const statusWidth = visibleWidth(status);
		if (statusWidth > width) return undefined;
		for (const hints of FOOTER_HINTS) {
			const gap = width - visibleWidth(hints) - statusWidth;
			// A visible hint set needs at least one blank column before the status.
			if (gap < (hints === "" ? 0 : 1)) continue;
			const right = this.#followBottom ? theme.fg("dim", status) : theme.fg("accent", status);
			return `${hints === "" ? "" : theme.fg("dim", hints)}${" ".repeat(gap)}${right}`;
		}
		return undefined;
	}

	/**
	 * The status keeps its right anchor at every width: a narrow terminal steps
	 * the hints down through {@link FOOTER_HINTS} and only then shortens the
	 * status itself. Anchoring matters most exactly when the new-rows counter
	 * widens the status, which is while the reader is scrolled back watching it.
	 */
	#footerLine(width: number): string {
		const long = this.#composeFooter(width, this.#footerStatus(true));
		if (long !== undefined) return long;
		const short = this.#footerStatus(false);
		const composed = this.#composeFooter(width, short);
		if (composed !== undefined) return composed;
		return truncateToWidth(this.#followBottom ? theme.fg("dim", short) : theme.fg("accent", short), width);
	}

	render(width: number): readonly string[] {
		const safeWidth = Math.max(1, width);
		const height = Math.max(1, this.#deps.ui.terminal.rows || 24);
		// The scrollbar column is reserved unconditionally, so the transcript is
		// laid out at one stable content width: no stray `…` on every full row,
		// and no one-column reflow of the whole screen the moment the
		// conversation grows past a single screenful.
		const contentWidth = Math.max(1, safeWidth - 1);

		const editorLines = this.#deps.editor.render(safeWidth);
		const above = this.#chromeAboveLines;
		above.length = 0;
		renderInto(this.#deps.chromeAbove, safeWidth, above);
		const below = this.#chromeBelowLines;
		below.length = 0;
		renderInto(this.#deps.chromeBelow, safeWidth, below);
		const content = this.#deps.transcript.render(contentWidth);
		this.#totalRows = content.length;
		// Own a copy: the container recycles its anchor buffer, and the key/mouse
		// handlers read these rows between renders.
		const prompts = this.#prompts;
		prompts.length = 0;
		for (const anchor of this.#deps.transcript.getPromptAnchors()) prompts.push(anchor);

		// Header and footer are permanent rows. Reserving the header while
		// following too makes the geometry identical in both states, so pausing
		// or resuming auto-follow no longer slides the transcript by one row.
		const footerRows = height >= 2 ? 1 : 0;
		const headerRows = height >= 3 ? 1 : 0;
		const bodyRows = height - headerRows - footerRows;
		// Row budget, in priority order: the editor (never clipped away, never
		// the whole screen either), then the chrome, then the transcript. The
		// surface returns exactly `height` rows, so the compositor never has to
		// drop a tail — which is what used to swallow the footer whenever the
		// autocomplete popup grew past the bottom of the screen.
		const editorRows = Math.min(editorLines.length, bodyRows >= 2 ? bodyRows - 1 : bodyRows);
		const chromeRoom = Math.max(0, bodyRows - editorRows - 1);
		// Chrome overflow drops from the top of `chromeAbove`: its tail holds the
		// working loader and the status line, the rows worth keeping.
		const aboveRows = Math.min(above.length, chromeRoom);
		const belowRows = Math.min(below.length, chromeRoom - aboveRows);
		const viewportRows = bodyRows - editorRows - aboveRows - belowRows;
		this.#viewportHeight = Math.max(1, viewportRows);
		this.#footerRow = footerRows === 0 ? -1 : height - 1;

		// A transcript shorter than its viewport rests on the editor instead of
		// hanging from the top row with a gap underneath it.
		const scrollRows = Math.min(this.#totalRows, viewportRows);
		this.#scrollView.setLines(content);
		this.#scrollView.setHeight(scrollRows);
		if (this.#followBottom) {
			this.#scrollView.scrollToBottom();
			this.#rowsAtPause = this.#totalRows;
		} else {
			const anchoredTop = this.#resolveAnchor();
			if (anchoredTop !== undefined) this.#scrollView.setScrollOffset(anchoredTop);
		}

		// Chosen *after* the offset is clamped, from the row the reader will see.
		// A prompt sitting exactly on the top row belongs to the section on
		// screen, the same boundary the scroll anchor uses: under the old strict
		// rule, clicking the header snapped that prompt to the top and the header
		// immediately renamed itself to the previous section.
		const top = this.#scrollView.getScrollOffset();
		const stickyIndex = headerRows === 0 ? -1 : promptAbove(prompts, top + 1);
		this.#stickyRow = stickyIndex < 0 ? -1 : prompts[stickyIndex]!.row;

		const frame = this.#frame;
		frame.length = 0;
		if (headerRows === 1) frame.push(truncateToWidth(replaceTabs(this.#headerLine(stickyIndex)), safeWidth));
		for (let pad = viewportRows - scrollRows; pad > 0; pad--) frame.push("");
		const viewport = this.#scrollView.render(safeWidth);
		for (let i = 0; i < viewport.length; i++) frame.push(viewport[i]!);
		for (let i = above.length - aboveRows; i < above.length; i++) frame.push(above[i]!);
		for (let i = 0; i < editorRows; i++) frame.push(editorLines[i]!);
		for (let i = 0; i < belowRows; i++) frame.push(below[i]!);
		// Footer last: it reports the position this frame settled on.
		if (footerRows === 1) frame.push(this.#footerLine(safeWidth));
		return frame;
	}
}
