import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We need to test the module behavior, so we'll dynamically import it fresh each test
let mockSocketPath: string;
let mockServer: Server;
let receivedMessages: string[];

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function setupMockMuxyServer(): Promise<void> {
	return new Promise((resolve) => {
		receivedMessages = [];
		mockServer = createServer((socket) => {
			let data = "";
			socket.on("data", (chunk) => {
				data += chunk.toString();
			});
			socket.on("end", () => {
				receivedMessages.push(data);
			});
		});
		mockServer.listen(mockSocketPath, () => resolve());
	});
}

async function loadExtension(): Promise<any> {
	// Dynamic import to get fresh module each time
	const mod = await import("./index.ts");
	return mod.default;
}

function createMockPi(): {
	listeners: Record<string, Array<(event: any) => void>>;
	emit: (event: string, data: any) => Promise<void>;
	on: (event: string, handler: (event: any) => void) => void;
} {
	const listeners: Record<string, Array<(event: any) => void>> = {};
	return {
		listeners,
		on: (event: string, handler: (event: any) => void) => {
			if (!listeners[event]) listeners[event] = [];
			listeners[event].push(handler);
		},
		emit: async (event: string, data: any) => {
			const handlers = listeners[event] || [];
			for (const h of handlers) {
				await h(data);
			}
		},
	};
}

describe("muxy-notify", () => {
	beforeEach(() => {
		const tmpDir = join(tmpdir(), `muxy-test-${Date.now()}`);
		mkdirSync(tmpDir, { recursive: true });
		mockSocketPath = join(tmpDir, "muxy.sock");
		receivedMessages = [];
	});

	afterEach(() => {
		if (mockServer) {
			mockServer.close();
		}
		try {
			rmSync(join(tmpdir(), mockSocketPath.split("/").slice(-2, -1)[0]), { recursive: true });
		} catch {}
	});

	test("should send notification on agent_end", async () => {
		process.env.MUXY_SOCKET_PATH = mockSocketPath;
		process.env.MUXY_PANE_ID = "test-pane-123";

		await setupMockMuxyServer();
		const ext = await loadExtension();
		const pi = createMockPi();
		ext(pi as any);

		await pi.emit("before_agent_start", { prompt: "refactor auth" });
		await pi.emit("agent_end", { messages: [] });
		await wait(200);

		expect(receivedMessages.length).toBe(1);
		expect(receivedMessages[0]).toContain("pi|test-pane-123|");
		expect(receivedMessages[0]).toContain("Done: refactor auth");
	});

	test("should debounce rapid agent_end calls", async () => {
		process.env.MUXY_SOCKET_PATH = mockSocketPath;
		process.env.MUXY_PANE_ID = "test-pane-456";

		await setupMockMuxyServer();
		const ext = await loadExtension();
		const pi = createMockPi();
		ext(pi as any);

		await pi.emit("before_agent_start", { prompt: "task 1" });
		await pi.emit("agent_end", { messages: [] });
		await pi.emit("before_agent_start", { prompt: "task 2" });
		await pi.emit("agent_end", { messages: [] });
		await wait(200);

		// Only first agent_end should send, second debounced
		expect(receivedMessages.length).toBe(1);
		expect(receivedMessages[0]).toContain("task 1");
	});

	test("should reset currentPrompt on new before_agent_start", async () => {
		process.env.MUXY_SOCKET_PATH = mockSocketPath;
		process.env.MUXY_PANE_ID = "test-pane-789";

		await setupMockMuxyServer();
		const ext = await loadExtension();
		const pi = createMockPi();
		ext(pi as any);

		await pi.emit("before_agent_start", { prompt: "first task" });
		await pi.emit("before_agent_start", { prompt: "second task" });
		await wait(600); // wait for debounce window
		await pi.emit("agent_end", { messages: [] });
		await wait(200);

		expect(receivedMessages.length).toBe(1);
		expect(receivedMessages[0]).toContain("second task");
		expect(receivedMessages[0]).not.toContain("first task");
	});

	test("should fallback to assistant text when no prompt", async () => {
		process.env.MUXY_SOCKET_PATH = mockSocketPath;
		process.env.MUXY_PANE_ID = "test-pane-abc";

		await setupMockMuxyServer();
		const ext = await loadExtension();
		const pi = createMockPi();
		ext(pi as any);

		await pi.emit("agent_end", {
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "All done here" }] },
			],
		});
		await wait(200);

		expect(receivedMessages.length).toBe(1);
		expect(receivedMessages[0]).toContain("All done here");
	});

	test("should send ask_user_question notification", async () => {
		process.env.MUXY_SOCKET_PATH = mockSocketPath;
		process.env.MUXY_PANE_ID = "test-pane-def";

		await setupMockMuxyServer();
		const ext = await loadExtension();
		const pi = createMockPi();
		ext(pi as any);

		await pi.emit("tool_call", { toolName: "ask_user_question" });
		await wait(200);

		expect(receivedMessages.length).toBe(1);
		expect(receivedMessages[0]).toContain("Needs input");
	});

	test("should not send when env vars missing", async () => {
		delete process.env.MUXY_SOCKET_PATH;
		delete process.env.MUXY_PANE_ID;

		await setupMockMuxyServer();
		const ext = await loadExtension();
		const pi = createMockPi();
		ext(pi as any);

		await pi.emit("agent_end", { messages: [] });
		await wait(200);

		expect(receivedMessages.length).toBe(0);
	});
});
