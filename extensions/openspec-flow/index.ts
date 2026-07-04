/**
 * openspec-flow — one command (/spec) to drive the OpenSpec + taskflow workflow.
 *
 * Picks an OpenSpec change (with task progress), then shows a leader-key-style
 * overlay with the right next actions for its state: implement via the gated
 * taskflow (full change or per-group loop, recommended by task count),
 * implement interactively via /opsx-apply, open the plannotator review UI,
 * validate, or archive.
 *
 * See WORKFLOWS.md for the full pipeline this fronts.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, parseKey, Key } from "@mariozechner/pi-tui";
import { OverlayFrame } from "../shared/overlay.js";

interface OpenSpecChange {
	name: string;
	completedTasks: number;
	totalTasks: number;
	status: "no-tasks" | "complete" | "in-progress";
}

interface SpecAction {
	key: string;
	label: string;
	description: string;
}

/** Changes with at most this many tasks get the full-change flow recommended. */
const GROUP_LOOP_TASK_THRESHOLD = 4;

async function listChanges(pi: ExtensionAPI): Promise<OpenSpecChange[] | null> {
	const result = await pi.exec("openspec", ["list", "--json"]);
	if (result.code !== 0) return null;
	try {
		const parsed = JSON.parse(result.stdout);
		return Array.isArray(parsed.changes) ? parsed.changes : null;
	} catch {
		return null;
	}
}

/** Pre-fill the editor with a command and let the user confirm/extend it. */
function stageCommand(ctx: ExtensionCommandContext, command: string, hint?: string) {
	ctx.ui.setEditorText(command);
	if (hint) ctx.ui.notify(hint, "info");
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay (leader-key style: key badges, label + dim description per action)
// ─────────────────────────────────────────────────────────────────────────────

class SpecActionsOverlay {
	private highlighted = 0;

	constructor(
		private title: string,
		private subtitle: string,
		private actions: SpecAction[],
		private theme: Theme,
		private done: (key: string | null) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, Key.ctrl("c"))) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "up")) {
			this.highlighted = Math.max(0, this.highlighted - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.highlighted = Math.min(this.actions.length - 1, this.highlighted + 1);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.done(this.actions[this.highlighted].key);
			return;
		}

		// Direct key press (Kitty protocol aware, raw printable fallback)
		const parsed = parseKey(data);
		const key = parsed && parsed.length === 1 ? parsed.toLowerCase() : data.length === 1 && data >= " " && data <= "~" ? data.toLowerCase() : null;
		if (key && this.actions.some((a) => a.key === key)) {
			this.done(key);
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const f = new OverlayFrame(width, th);
		const lines: string[] = [];

		lines.push(f.top());
		lines.push(f.row(th.fg("accent", th.bold(this.title))));
		lines.push(f.row(th.fg("dim", this.subtitle)));
		lines.push(f.separator());

		for (let i = 0; i < this.actions.length; i++) {
			const a = this.actions[i];
			const isHl = i === this.highlighted;
			const keyBadge = th.fg("warning", th.bold(`[${a.key}]`));
			const label = isHl ? th.fg("accent", th.bold(a.label)) : th.fg("text", a.label);
			lines.push(f.rowTruncated(`${isHl ? "> " : "  "}${keyBadge} ${label}`));
			lines.push(f.rowTruncated(`      ${th.fg("dim", a.description)}`));
		}

		lines.push(f.separator());
		lines.push(f.row(th.fg("dim", "↑↓ move · enter/key run · esc close")));
		lines.push(f.bottom());
		return lines;
	}

	invalidate(): void {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension
// ─────────────────────────────────────────────────────────────────────────────

export default function openspecFlow(pi: ExtensionAPI) {
	pi.registerCommand("spec", {
		description: "OpenSpec workflow: pick a change, then implement / review / validate / archive",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/spec needs an interactive session", "error");
				return;
			}

			const changes = await listChanges(pi);
			if (changes === null) {
				ctx.ui.notify("openspec list failed — is OpenSpec initialized here? (openspec init --tools pi)", "error");
				return;
			}

			// ── Pick a change (or start a new one) ────────────────────────
			const NEW_CHANGE = "+ propose a new change";
			const changeLabels = changes.map((c) => {
				const progress = c.status === "no-tasks" ? "no tasks yet" : `${c.completedTasks}/${c.totalTasks} tasks`;
				const done = c.status === "complete" ? " ✓" : "";
				return `${c.name}  —  ${progress}${done}`;
			});

			const picked = await ctx.ui.select("OpenSpec change:", [...changeLabels, NEW_CHANGE]);
			if (picked === undefined) return;

			if (picked === NEW_CHANGE) {
				stageCommand(ctx, "/opsx-propose ", "Describe the change after /opsx-propose, then press Enter");
				return;
			}

			const change = changes[changeLabels.indexOf(picked)];
			const id = change.name;
			const remaining = change.totalTasks - change.completedTasks;
			const smallChange = change.totalTasks <= GROUP_LOOP_TASK_THRESHOLD;

			// ── Action overlay for the selected change ────────────────────
			const actions: SpecAction[] = [];
			if (change.status !== "complete") {
				actions.push(
					{
						key: "f",
						label: `Implement — full change${smallChange ? "  (recommended)" : ""}`,
						description: "background agent implements everything, then tests + 6-reviewer panel + verdict",
					},
					{
						key: "g",
						label: `Implement — group loop${smallChange ? "" : "  (recommended)"}`,
						description: "fresh agent per task group (## sections in tasks.md), same tests + panel + verdict",
					},
					{
						key: "i",
						label: "Implement — interactive",
						description: "step by step in THIS session, you watch and steer, no gates",
					},
				);
			}
			actions.push(
				{
					key: "r",
					label: "Review diff — plannotator",
					description: "browser UI over current git changes, annotate lines, send feedback",
				},
				{
					key: "v",
					label: "Validate spec",
					description: "openspec validate --strict — checks spec file structure only, runs nothing",
				},
			);
			if (change.status === "complete") {
				actions.push(
					{
						key: "i",
						label: "Implement — interactive",
						description: "step by step in THIS session (e.g. to address leftover feedback)",
					},
					{
						key: "a",
						label: "Archive",
						description: "merge spec deltas into openspec/specs/ and move the change to archive/",
					},
				);
			}

			const statusLine = change.status === "complete" ? "all tasks done ✓" : `${remaining} task${remaining === 1 ? "" : "s"} remaining of ${change.totalTasks}`;

			const selectedKey = await ctx.ui.custom<string | null>(
				(tui, theme, _kb, done) => {
					const overlay = new SpecActionsOverlay(id, statusLine, actions, theme, done);
					return {
						render: (w: number) => overlay.render(w),
						invalidate: () => overlay.invalidate(),
						handleInput: (data: string) => {
							overlay.handleInput(data);
							tui.requestRender();
						},
					};
				},
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: 80, minWidth: 50, maxHeight: "80%" },
				},
			);
			if (!selectedKey) return;

			switch (selectedKey) {
				case "f":
					stageCommand(
						ctx,
						`/tf:openspec-implement change=${id}`,
						'Enter to run — append verify="..." if this repo needs a different test command',
					);
					break;
				case "g":
					stageCommand(
						ctx,
						`/tf:openspec-implement-loop change=${id}`,
						'Enter to run — append verify="..." if this repo needs a different test command',
					);
					break;
				case "i":
					stageCommand(ctx, `/opsx-apply ${id}`, "Enter to implement interactively in this session");
					break;
				case "r":
					stageCommand(ctx, "/plannotator-review", "Enter to open the plannotator review UI");
					break;
				case "v": {
					const result = await pi.exec("openspec", ["validate", id, "--strict"]);
					const line = (result.stdout || result.stderr).trim().split("\n")[0] || "(no output)";
					ctx.ui.notify(line, result.code === 0 ? "info" : "error");
					break;
				}
				case "a": {
					const confirm = await ctx.ui.select(`Archive ${id}? Delta specs merge into openspec/specs/.`, [
						"Yes, archive",
						"Cancel",
					]);
					if (confirm !== "Yes, archive") return;
					const result = await pi.exec("openspec", ["archive", id, "--yes"]);
					const line = (result.stdout || result.stderr).trim().split("\n").pop() || "(no output)";
					ctx.ui.notify(line, result.code === 0 ? "info" : "error");
					break;
				}
			}
		},
	});
}
