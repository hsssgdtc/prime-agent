import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	CONTEXT_TELEMETRY_ENTRY_TYPE,
	createContextTelemetryExtension,
} from "../src/core/extensions/builtin/context-telemetry.js";
import type { ExtensionAPI } from "../src/core/extensions/types.js";

interface RecordedEntry {
	type: string;
	data: Record<string, unknown>;
}

function usage(input: number, output: number, cacheRead: number, cacheWrite: number): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
	};
}

function createHarness(nowValues: number[]) {
	const handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
	const entries: RecordedEntry[] = [];
	const childUsage = usage(5, 2, 3, 0);
	const branch = [{ type: "child_usage_attributed", id: "child-1", childUsage }];
	const pi = {
		on(event: string, handler: (event: never, ctx: never) => unknown) {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		appendEntry(type: string, data: Record<string, unknown>) {
			entries.push({ type, data });
		},
		getActiveTools: () => ["ipython"],
		getAllTools: () => [
			{
				name: "ipython",
				description: "SECRET TOOL DESCRIPTION",
				parameters: { type: "object", properties: { code: { type: "string", secret: "SECRET PARAMETER" } } },
				sourceInfo: { type: "builtin" },
			},
		],
	} as unknown as ExtensionAPI;
	createContextTelemetryExtension({ now: () => nowValues.shift() ?? 0 })(pi);
	const ctx = {
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => branch,
		},
		getSystemPrompt: () => "SYSTEM SECRET",
	};
	const emit = (event: string, payload: unknown) => {
		for (const handler of handlers.get(event) ?? []) handler(payload as never, ctx as never);
	};
	return { entries, emit };
}

describe("context telemetry", () => {
	it("records context composition and exact provider usage without copying content", () => {
		const { entries, emit } = createHarness([1_100, 1_140, 1_150, 1_300]);
		emit("turn_start", { type: "turn_start", turnIndex: 4, timestamp: 1_000 });
		emit("before_agent_start", {
			type: "before_agent_start",
			prompt: "CURRENT SECRET",
			systemPrompt: "SYSTEM SECRET",
			systemPromptOptions: {},
		});
		emit("context", {
			type: "context",
			messages: [
				{ role: "user", content: "old!", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "old answer" }],
					api: "openai-responses",
					provider: "openai",
					model: "model",
					usage: usage(1, 1, 0, 0),
					stopReason: "stop",
					timestamp: 2,
				},
				{ role: "user", content: "CURRENT SECRET", timestamp: 3 },
			],
		});
		emit("before_provider_request", { type: "before_provider_request", payload: {} });
		emit("message_update", {
			type: "message_update",
			message: {},
			assistantMessageEvent: { type: "thinking_delta", delta: "x" },
		});
		emit("message_update", {
			type: "message_update",
			message: {},
			assistantMessageEvent: { type: "text_delta", delta: "x" },
		});
		emit("message_end", {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "MODEL SECRET" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-test",
				usage: usage(20, 7, 11, 3),
				stopReason: "stop",
				timestamp: 4,
			},
		});

		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({
			type: CONTEXT_TELEMETRY_ENTRY_TYPE,
			data: {
				phase: "request",
				correlationId: "session-1:4:1",
				turnIndex: 4,
				requestIndex: 1,
				historyTokens: 4,
				currentTokens: 4,
				childUsageTokensCumulative: 10,
				childUsageTokensSincePreviousRequest: 10,
				activeToolNames: ["ipython"],
			},
		});
		expect(entries[1]).toMatchObject({
			type: CONTEXT_TELEMETRY_ENTRY_TYPE,
			data: {
				phase: "response",
				correlationId: "session-1:4:1",
				uncachedInputTokens: 20,
				cacheReadTokens: 11,
				cacheWriteTokens: 3,
				outputTokens: 7,
				firstModelEventMs: 40,
				visibleTtftMs: 50,
				modelLatencyMs: 200,
				cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
			},
		});
		const serialized = JSON.stringify(entries);
		expect(serialized).not.toContain("SYSTEM SECRET");
		expect(serialized).not.toContain("CURRENT SECRET");
		expect(serialized).not.toContain("MODEL SECRET");
		expect(serialized).not.toContain("SECRET TOOL DESCRIPTION");
		expect(serialized).not.toContain("SECRET PARAMETER");
	});

	it("reports child usage only once in the since-previous-request field", () => {
		const { entries, emit } = createHarness([]);
		emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 0 });
		emit("context", { type: "context", messages: [] });
		emit("context", { type: "context", messages: [] });
		const requests = entries.map((entry) => entry.data);
		expect(requests[0]).toMatchObject({
			childUsageTokensCumulative: 10,
			childUsageTokensSincePreviousRequest: 10,
		});
		expect(requests[1]).toMatchObject({
			childUsageTokensCumulative: 10,
			childUsageTokensSincePreviousRequest: 0,
		});
	});
});
