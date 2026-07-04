/**
 * openspec-flow — one command (/spec) to drive the OpenSpec + taskflow workflow.
 *
 * A leader-key-style overlay with two views: pick an OpenSpec change (with
 * task progress), then pick the right next action for its state — implement
 * via the gated taskflow (full change or per-group loop, recommended by task
 * count), implement interactively via /opsx-apply, open the plannotator
 * review UI, validate, or archive. Backspace returns to the change list.
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

type SpecResult = { kind: "propose" } | { kind: "action"; change: OpenSpecChange; key: string } | null;

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

function changeProgress(c: OpenSpecChange): string {
	if (c.status === "no-tasks") return "no tasks yet";
	return `${c.completedTasks}/${c.totalTasks} tasks${c.status === "complete" ? " ✓" : ""}`;
}

function buildActions(change: OpenSpecChange): SpecAction[] {
	const smallChange = change.totalTasks <= GROUP_LOOP_TASK_THRESHOLD;
	const actions: SpecAction[] = [];

	if (change.status !== "complete") {
		actions.push(
			{
				key: "f",
				label: `Implement — full change${smallChange ? "  (recommended)" : ""}`,
				description: "background agent implements everything, then tests + 6-reviewer panel + verdict + informed fix round",
			},
			{
				key: "g",
				label: `Implement — group loop${smallChange ? "" : "  (recommended)"}`,
				description: "fresh agent per task group (## sections in tasks.md), same tests + panel + verdict + fix round",
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
			key: "p",
			label: "Review — gate panel",
			description: "tests + 6-reviewer panel + arbiter verdict + fix round on the current working tree",
		},
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
	return actions;
}

/** Pre-fill the editor with a command and let the user confirm/extend it. */
function stageCommand(ctx: ExtensionCommandContext, command: string, hint?: string) {
	ctx.ui.setEditorText(command);
	if (hint) ctx.ui.notify(hint, "info");
}

/**
 * Stage a saved-taskflow invocation. `/tf:<name>` shortcuts are registered only
 * at session start, so a flow file added mid-session has no command yet — pi
 * would send the unknown slash command to the model as plain text. In that case
 * stage the explicit taskflow-tool instruction instead (the tool reads saved
 * flows from disk live, no registration needed).
 */
function stageFlowRun(pi: ExtensionAPI, ctx: ExtensionCommandContext, flowName: string, changeId: string) {
	const registered = pi.getCommands().some((c) => c.name === `tf:${flowName}`);
	if (registered) {
		stageCommand(
			ctx,
			`/tf:${flowName} change=${changeId}`,
			'Enter to run — append verify="..." if this repo needs a different test command',
		);
	} else {
		stageCommand(
			ctx,
			`Run the saved taskflow "${flowName}" using the taskflow tool with action="run", name="${flowName}", args={"change":"${changeId}"}.`,
			`(/tf:${flowName} not registered yet — staged a direct taskflow instruction; /reload or restart pi to get the shortcut)`,
		);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay (leader-key style, two views: change list → actions for the change)
// ─────────────────────────────────────────────────────────────────────────────

type View = { type: "changes" } | { type: "actions"; change: OpenSpecChange; actions: SpecAction[] };

class SpecOverlay {
	private view: View = { type: "changes" };
	private highlighted = 0;

	constructor(
		private changes: OpenSpecChange[],
		private theme: Theme,
		private done: (result: SpecResult) => void,
	) {}

	/** Number of selectable rows in the current view (changes view has a trailing "+ propose" row). */
	private get itemCount(): number {
		return this.view.type === "changes" ? this.changes.length + 1 : this.view.actions.length;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, Key.ctrl("c"))) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.view.type === "actions") {
				this.view = { type: "changes" };
				this.highlighted = 0;
			} else {
				this.done(null);
			}
			return;
		}
		if (matchesKey(data, "up")) {
			this.highlighted = Math.max(0, this.highlighted - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.highlighted = Math.min(this.itemCount - 1, this.highlighted + 1);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.selectHighlighted();
			return;
		}

		// Direct action keys, only in the actions view
		if (this.view.type === "actions") {
			const parsed = parseKey(data);
			const key = parsed && parsed.length === 1 ? parsed.toLowerCase() : data.length === 1 && data >= " " && data <= "~" ? data.toLowerCase() : null;
			if (key && this.view.actions.some((a) => a.key === key)) {
				this.done({ kind: "action", change: this.view.change, key });
			}
		}
	}

	private selectHighlighted(): void {
		if (this.view.type === "changes") {
			if (this.highlighted === this.changes.length) {
				this.done({ kind: "propose" });
				return;
			}
			const change = this.changes[this.highlighted];
			this.view = { type: "actions", change, actions: buildActions(change) };
			this.highlighted = 0;
		} else {
			this.done({ kind: "action", change: this.view.change, key: this.view.actions[this.highlighted].key });
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const f = new OverlayFrame(width, th);
		const lines: string[] = [];
		lines.push(f.top());

		if (this.view.type === "changes") {
			lines.push(f.row(th.fg("accent", th.bold("OpenSpec changes"))));
			lines.push(f.row(th.fg("dim", this.changes.length === 0 ? "none active — propose one" : `${this.changes.length} active`)));
			lines.push(f.separator());

			for (let i = 0; i < this.changes.length; i++) {
				const c = this.changes[i];
				const isHl = i === this.highlighted;
				const name = isHl ? th.fg("accent", th.bold(c.name)) : th.fg("text", c.name);
				lines.push(f.rowTruncated(`${isHl ? "> " : "  "}${name}  ${th.fg("dim", changeProgress(c))}`));
			}
			const isHl = this.highlighted === this.changes.length;
			const proposeLabel = isHl ? th.fg("accent", th.bold("+ propose a new change")) : th.fg("muted", "+ propose a new change");
			lines.push(f.rowTruncated(`${isHl ? "> " : "  "}${proposeLabel}`));

			lines.push(f.separator());
			lines.push(f.row(th.fg("dim", "↑↓ move · enter select · esc close")));
		} else {
			const c = this.view.change;
			const remaining = c.totalTasks - c.completedTasks;
			const statusLine = c.status === "complete" ? "all tasks done ✓" : `${remaining} task${remaining === 1 ? "" : "s"} remaining of ${c.totalTasks}`;
			lines.push(f.row(th.fg("dim", "< ") + th.fg("accent", th.bold(c.name))));
			lines.push(f.row(th.fg("dim", statusLine)));
			lines.push(f.separator());

			for (let i = 0; i < this.view.actions.length; i++) {
				const a = this.view.actions[i];
				const isHl = i === this.highlighted;
				const keyBadge = th.fg("warning", th.bold(`[${a.key}]`));
				const label = isHl ? th.fg("accent", th.bold(a.label)) : th.fg("text", a.label);
				lines.push(f.rowTruncated(`${isHl ? "> " : "  "}${keyBadge} ${label}`));
				lines.push(f.rowTruncated(`      ${th.fg("dim", a.description)}`));
			}

			lines.push(f.separator());
			lines.push(f.row(th.fg("dim", "↑↓ move · enter/key run · bksp back · esc close")));
		}

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

			const result = await ctx.ui.custom<SpecResult>(
				(tui, theme, _kb, done) => {
					const overlay = new SpecOverlay(changes, theme, done);
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
			if (!result) return;

			if (result.kind === "propose") {
				stageCommand(ctx, "/opsx-propose ", "Describe the change after /opsx-propose, then press Enter");
				return;
			}

			const id = result.change.name;
			switch (result.key) {
				case "f":
					stageFlowRun(pi, ctx, "openspec-implement", id);
					break;
				case "g":
					stageFlowRun(pi, ctx, "openspec-implement-loop", id);
					break;
				case "i":
					stageCommand(ctx, `/opsx-apply ${id}`, "Enter to implement interactively — run the gate panel (p in /spec) afterwards");
					break;
				case "p":
					stageFlowRun(pi, ctx, "openspec-review", id);
					break;
				case "r":
					stageCommand(ctx, "/plannotator-review", "Enter to open the plannotator review UI");
					break;
				case "v": {
					const res = await pi.exec("openspec", ["validate", id, "--strict"]);
					const line = (res.stdout || res.stderr).trim().split("\n")[0] || "(no output)";
					ctx.ui.notify(line, res.code === 0 ? "info" : "error");
					break;
				}
				case "a": {
					const confirm = await ctx.ui.select(`Archive ${id}? Delta specs merge into openspec/specs/.`, [
						"Yes, archive",
						"Cancel",
					]);
					if (confirm !== "Yes, archive") return;
					const res = await pi.exec("openspec", ["archive", id, "--yes"]);
					const line = (res.stdout || res.stderr).trim().split("\n").pop() || "(no output)";
					ctx.ui.notify(line, res.code === 0 ? "info" : "error");
					break;
				}
			}
		},
	});
}
