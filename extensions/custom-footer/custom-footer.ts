/**
 * Custom Footer Extension — Two-line compact powerline style
 *
 * Line 1:  MODE  ~/path (branch) │ 42%/200k │ ⚡ model • thinking
 * Line 2: Extension statuses registered through ctx.ui.setStatus().
 *
 * Rendered as a belowEditor widget while the default footer is suppressed.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { PermissionMode } from "../permissions/permissions.js";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { execSync } from "node:child_process";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import {
	buildPathString,
	fmtTokens,
	modePillWidth,
	renderContextUsage,
	renderModelInfo,
	renderModePill,
	renderPath,
} from "./renderers.js";



// ── Helpers ────────────────────────────────────────────────────────────

function getGitBranch(cwd: string): string | null {
	try {
		return execSync("git branch --show-current", { cwd, encoding: "utf-8", timeout: 500 }).trim() || null;
	} catch {
		return null;
	}
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let currentMode: PermissionMode = "safe";
	let tuiRef: { requestRender(): void } | null = null;
	let footerDataRef: { getExtensionStatuses(): ReadonlyMap<string, string> } | null = null;
	let gitBranch: string | null = null;
	let gitWatcher: FSWatcher | undefined;

	pi.events.on("mode:change", (data: unknown) => {
		currentMode = data as PermissionMode;
		tuiRef?.requestRender();
	});

	pi.on("session_start", async (_event, ctx) => {
		// Get initial git branch
		gitBranch = getGitBranch(ctx.cwd);

		// Watch .git/HEAD for branch changes
		const headPath = join(ctx.cwd, ".git", "HEAD");
		if (existsSync(headPath)) {
			gitWatcher = watch(headPath, () => {
				gitBranch = getGitBranch(ctx.cwd);
				tuiRef?.requestRender();
			});
		}

		// Suppress the default footer, but retain its data provider so extension
		// statuses remain visible in our below-editor footer.
		ctx.ui.setFooter((_footerTui, _footerTheme, footerData) => {
			footerDataRef = footerData;
			return {
				render() { return []; },
				invalidate() { tuiRef?.requestRender(); },
			};
		});

		const setWidgetFn = ctx.ui.setWidget.bind(ctx.ui) as (
			name: string,
			content: unknown,
			options?: { placement?: string },
		) => void;

		setWidgetFn(
			"custom-footer",
			(_widgetTui: { requestRender(): void }, widgetTheme: any) => {
				tuiRef = _widgetTui;
				return {
					render(width: number): string[] {
						const lines = [renderLine1(width, widgetTheme, ctx)];
						const statusLine = renderExtensionStatuses(width);
						if (statusLine) lines.push(statusLine);
						return lines;
					},
					invalidate() {},
				};
			},
			{ placement: "belowEditor" },
		);
	});

	pi.on("session_shutdown", async () => {
		gitWatcher?.close();
		footerDataRef = null;
		tuiRef = null;
	});

	function renderExtensionStatuses(width: number): string | null {
		const statuses = footerDataRef?.getExtensionStatuses();
		if (!statuses || statuses.size === 0) return null;

		const text = Array.from(statuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, value]) => value.replace(/[\r\n\t]+/g, " ").trim())
			.filter(Boolean)
			.join(" ");

		return text ? truncateToWidth(` ${text}`, width) : null;
	}

	// ── Line 1: Mode │ Path │ Context │ Model ──────────────────────────

	function renderLine1(
		width: number,
		theme: { fg: (role: any, text: string) => string; bold: (text: string) => string; inverse: (text: string) => string; bg: (role: any, text: string) => string },
		ctx: { getContextUsage(): { percent: number | null; contextWindow: number } | null | undefined; model: { provider?: string; id?: string; contextWindow?: number } | null | undefined },
	): string {
		const sep = theme.fg("dim", " │ ");
		const sepW = 3;

		// Mode pill
		const pill = renderModePill(currentMode, theme);
		const pillW = modePillWidth(currentMode);

		// Path + branch
		const pathRaw = buildPathString(process.cwd(), gitBranch);

		// Context usage
		const usage = ctx.getContextUsage();
		const pct = usage?.percent ?? 0;
		const win = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const ctxRaw = `${pct.toFixed(0)}%/${fmtTokens(win)}`;
		const ctxColored = renderContextUsage(pct, win, theme);

		// Model + thinking
		const provider = ctx.model?.provider || "unknown";
		const modelName = ctx.model?.id || "no-model";
		const thinking = pi.getThinkingLevel();
		const model = renderModelInfo(modelName, provider, thinking, theme);

		// Layout: compute path budget from remaining space
		const rightBlockWidth = visibleWidth(ctxRaw) + sepW + model.rawWidth;
		const pathBudget = width - pillW - sepW - rightBlockWidth - sepW;
		const pathDisplay = renderPath(pathRaw, pathBudget, theme);

		// Assemble
		const segments: string[] = [pill];
		if (pathDisplay) segments.push(pathDisplay);
		segments.push(ctxColored);
		segments.push(model.text);

		return truncateToWidth(segments.join(sep), width);
	}


}
