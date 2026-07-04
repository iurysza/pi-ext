/**
 * openspec-flow — one command (/spec) to drive the OpenSpec + taskflow workflow.
 *
 * Picks an OpenSpec change (with task progress), then offers the right next
 * action for its state: implement via the gated taskflow (whole-change or
 * per-task loop, recommended by task count), implement interactively via
 * /opsx-apply, open the plannotator review UI, validate, or archive.
 *
 * See WORKFLOWS.md for the full pipeline this fronts.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

interface OpenSpecChange {
	name: string;
	completedTasks: number;
	totalTasks: number;
	status: "no-tasks" | "complete" | "in-progress";
}

/** Changes with at most this many tasks get the whole-change flow recommended. */
const LOOP_FLOW_TASK_THRESHOLD = 4;

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

			// ── Pick an action for the selected change ────────────────────
			const smallChange = change.totalTasks <= LOOP_FLOW_TASK_THRESHOLD;
			const ACTIONS = {
				implementFlow: `implement — gated flow${smallChange ? "  (recommended)" : ""}`,
				implementLoop: `implement — per-task loop${smallChange ? "" : "  (recommended)"}`,
				implementInteractive: "implement — interactive in this session",
				plannotator: "review diff — plannotator",
				validate: "validate spec (--strict)",
				archive: "archive change",
			};

			const actions: string[] = [];
			if (change.status !== "complete") {
				actions.push(ACTIONS.implementFlow, ACTIONS.implementLoop, ACTIONS.implementInteractive);
			}
			actions.push(ACTIONS.plannotator, ACTIONS.validate);
			if (change.status === "complete") {
				actions.push(ACTIONS.implementInteractive, ACTIONS.archive);
			}

			const statusLine = change.status === "complete" ? "all tasks done" : `${remaining} task${remaining === 1 ? "" : "s"} remaining`;
			const action = await ctx.ui.select(`${id} (${statusLine}):`, actions);
			if (action === undefined) return;

			switch (action) {
				case ACTIONS.implementFlow:
					stageCommand(
						ctx,
						`/tf:openspec-implement change=${id}`,
						'Enter to run — append verify="..." if this repo needs a different test command',
					);
					break;
				case ACTIONS.implementLoop:
					stageCommand(
						ctx,
						`/tf:openspec-implement-loop change=${id}`,
						'Enter to run — append verify="..." if this repo needs a different test command',
					);
					break;
				case ACTIONS.implementInteractive:
					stageCommand(ctx, `/opsx-apply ${id}`, "Enter to implement interactively in this session");
					break;
				case ACTIONS.plannotator:
					stageCommand(ctx, "/plannotator-review", "Enter to open the plannotator review UI");
					break;
				case ACTIONS.validate: {
					const result = await pi.exec("openspec", ["validate", id, "--strict"]);
					const line = (result.stdout || result.stderr).trim().split("\n")[0] || "(no output)";
					ctx.ui.notify(line, result.code === 0 ? "info" : "error");
					break;
				}
				case ACTIONS.archive: {
					if (change.status !== "complete") break;
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
