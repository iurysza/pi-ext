import type { AssistantMessage, Message, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createConnection } from "node:net";
import { basename } from "node:path";

const socketPath = process.env.MUXY_SOCKET_PATH;
const paneID = process.env.MUXY_PANE_ID;
const enabled = Boolean(socketPath && paneID);

function clean(text: string, max = 200): string {
	const normalized = text.trim().replace(/[\n\r|]+/g, " ").replace(/\s+/g, " ");
	if (normalized.length <= max) return normalized;
	return normalized.slice(0, max - 3) + "...";
}

function sendToMuxy(type: string, title: string, body: string): void {
	if (!enabled || !socketPath || !paneID) return;

	const payload = `${type}|${paneID}|${clean(title, 80)}|${clean(body, 200)}`;
	const conn = createConnection({ path: socketPath });

	let done = false;
	const timeout = setTimeout(() => {
		if (!done) {
			done = true;
			conn.destroy();
		}
	}, 3000);

	conn.on("error", () => {
		clearTimeout(timeout);
		conn.destroy();
	});

	conn.on("connect", () => {
		conn.write(payload, (err) => {
			clearTimeout(timeout);
			if (!done) {
				done = true;
				if (err) conn.destroy();
				else conn.end();
			}
		});
	});

	conn.on("close", () => {
		clearTimeout(timeout);
		done = true;
	});
}

function lastAssistantText(messages: Message[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;

		const text = (msg as AssistantMessage).content
			.filter((content): content is TextContent => content.type === "text")
			.map((content) => content.text)
			.join(" ")
			.trim();

		if (text) return clean(text, 160);
	}

	return null;
}

export default function (pi: ExtensionAPI) {
	if (!enabled) return;

	let currentPrompt: string | null = null;
	let lastNotifyTime = 0;
	const notifyDebounceMs = 500;

	pi.on("before_agent_start", async (event) => {
		currentPrompt = null;
		if (typeof event.prompt === "string" && event.prompt.trim()) {
			currentPrompt = event.prompt.trim();
		}
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "ask_user_question") return;
		sendToMuxy("pi", `Pi · ${basename(process.cwd())}`, "Needs input");
	});

	pi.on("agent_end", async (event) => {
		const now = Date.now();
		if (now - lastNotifyTime < notifyDebounceMs) {
			currentPrompt = null;
			return;
		}
		lastNotifyTime = now;

		const title = `Pi · ${basename(process.cwd()) || "session"}`;
		const body = currentPrompt
			? `Done: ${clean(currentPrompt, 150)}`
			: (lastAssistantText(event.messages as Message[]) ?? "Task completed");

		sendToMuxy("pi", title, body);
		currentPrompt = null;
	});
}
