import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "muxy-smoke-"));
const socketPath = join(tmpDir, "muxy.sock");

const messages = [];
const server = createServer((socket) => {
	let data = "";
	socket.on("data", (chunk) => { data += chunk.toString(); });
	socket.on("end", () => { messages.push(data); });
});

await new Promise((resolve) => server.listen(socketPath, resolve));
console.log("Mock server listening on", socketPath);

// Set env and import extension
process.env.MUXY_SOCKET_PATH = socketPath;
process.env.MUXY_PANE_ID = "smoke-pane-42";

const mod = await import("./index.ts");
const ext = mod.default;

const listeners = {};
const pi = {
	on: (event, handler) => {
		if (!listeners[event]) listeners[event] = [];
		listeners[event].push(handler);
	},
};
ext(pi);

// Test 1: agent_end with prompt
await listeners["before_agent_start"]?.[0]?.({ prompt: "refactor auth" });
await listeners["agent_end"]?.[0]?.({ messages: [] });
await new Promise((r) => setTimeout(r, 300));

console.log("Messages after test 1:", messages.length);
console.log("Content:", messages[0] || "NONE");
console.assert(messages.length === 1, "Expected 1 message");
console.assert(messages[0]?.includes("Done: refactor auth"), "Expected prompt in body");

// Test 2: debounce rapid agent_end (wait for debounce window to clear first)
messages.length = 0;
await new Promise((r) => setTimeout(r, 600)); // clear debounce from test 1
await listeners["before_agent_start"]?.[0]?.({ prompt: "task 1" });
await listeners["agent_end"]?.[0]?.({ messages: [] });
await listeners["before_agent_start"]?.[0]?.({ prompt: "task 2" });
await listeners["agent_end"]?.[0]?.({ messages: [] });
await new Promise((r) => setTimeout(r, 300));
console.log("Messages after test 2 (debounce):", messages.length);
console.assert(messages.length === 1, "Expected 1 message after debounce");

// Test 3: reset prompt on new before_agent_start
messages.length = 0;
await listeners["before_agent_start"]?.[0]?.({ prompt: "first" });
await listeners["before_agent_start"]?.[0]?.({ prompt: "second" });
await new Promise((r) => setTimeout(r, 600)); // wait for debounce window
await listeners["agent_end"]?.[0]?.({ messages: [] });
await new Promise((r) => setTimeout(r, 300));
console.log("Messages after test 3 (reset):", messages.length);
console.log("Content:", messages[0] || "NONE");
console.assert(messages.length === 1, "Expected 1 message");
console.assert(messages[0]?.includes("second"), "Expected 'second' prompt");
console.assert(!messages[0]?.includes("first"), "Should NOT contain 'first' prompt");

server.close();
rmSync(tmpDir, { recursive: true });
console.log("\nAll smoke tests passed!");
