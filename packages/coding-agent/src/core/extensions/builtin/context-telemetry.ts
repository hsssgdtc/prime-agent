import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { estimateTokens } from "../../compaction/compaction.js";
import type { ExtensionAPI, ExtensionFactory } from "../types.js";

export const CONTEXT_TELEMETRY_ENTRY_TYPE = "prime_context_telemetry";

interface ContextTelemetryOptions {
	now?: () => number;
}

interface ChildUsageAttributionLike {
	id: string;
	type: "child_usage_attributed";
	childUsage: Usage;
}

interface ActiveRequest {
	correlationId: string;
	providerStartedAt?: number;
	firstModelEventMs?: number;
	visibleTtftMs?: number;
}

function textTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function usageTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => [key, canonicalize(item)]),
	);
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function currentTurnStart(messages: readonly AgentMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "user") return index;
	}
	return messages.length;
}

function isChildUsageAttribution(value: unknown): value is ChildUsageAttributionLike {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return record.type === "child_usage_attributed" && typeof record.id === "string" && !!record.childUsage;
}

export function createContextTelemetryExtension(options: ContextTelemetryOptions = {}): ExtensionFactory {
	return (pi) => contextTelemetryExtension(pi, options);
}

export function contextTelemetryExtension(pi: ExtensionAPI, options: ContextTelemetryOptions = {}): void {
	const now = options.now ?? Date.now;
	let turnIndex = 0;
	let sessionRequestIndex = 0;
	let latestSystemPrompt = "";
	let activeRequest: ActiveRequest | undefined;
	const seenChildUsageEntryIds = new Set<string>();

	pi.on("turn_start", (event) => {
		turnIndex = event.turnIndex;
	});

	pi.on("before_agent_start", (event) => {
		latestSystemPrompt = event.systemPrompt;
	});

	pi.on("context", (event, ctx) => {
		sessionRequestIndex += 1;
		const correlationId = `${ctx.sessionManager.getSessionId()}:${sessionRequestIndex}`;
		const currentStart = currentTurnStart(event.messages);
		const history = event.messages.slice(0, currentStart);
		const current = event.messages.slice(currentStart);
		const activeToolNames = [...pi.getActiveTools()].sort();
		const activeToolSet = new Set(activeToolNames);
		const toolSchemas = pi
			.getAllTools()
			.filter((tool) => activeToolSet.has(tool.name))
			.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
			.sort((left, right) => left.name.localeCompare(right.name));
		const toolSchemaJson = canonicalJson(toolSchemas);
		const systemPrompt = latestSystemPrompt || ctx.getSystemPrompt();
		let childUsageTokensCumulative = 0;
		let childUsageTokensSincePreviousRequest = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (!isChildUsageAttribution(entry)) continue;
			const tokens = usageTokens(entry.childUsage);
			childUsageTokensCumulative += tokens;
			if (!seenChildUsageEntryIds.has(entry.id)) {
				seenChildUsageEntryIds.add(entry.id);
				childUsageTokensSincePreviousRequest += tokens;
			}
		}

		activeRequest = { correlationId };
		pi.appendEntry(CONTEXT_TELEMETRY_ENTRY_TYPE, {
			schema: 1,
			phase: "request",
			correlationId,
			turnIndex,
			requestIndex: sessionRequestIndex,
			systemTokens: textTokens(systemPrompt),
			historyTokens: history.reduce((total, message) => total + estimateTokens(message), 0),
			toolSchemaTokens: textTokens(toolSchemaJson),
			currentTokens: current.reduce((total, message) => total + estimateTokens(message), 0),
			childUsageTokensCumulative,
			childUsageTokensSincePreviousRequest,
			historyMessageCount: history.length,
			currentMessageCount: current.length,
			activeToolNames,
			systemPromptSha256: sha256(systemPrompt),
			toolSchemaSha256: sha256(toolSchemaJson),
		});
	});

	pi.on("before_provider_request", (_event) => {
		if (!activeRequest) return;
		activeRequest.providerStartedAt = now();
		activeRequest.firstModelEventMs = undefined;
		activeRequest.visibleTtftMs = undefined;
	});

	pi.on("message_update", (event) => {
		if (!activeRequest?.providerStartedAt) return;
		const elapsed = Math.max(0, now() - activeRequest.providerStartedAt);
		activeRequest.firstModelEventMs ??= elapsed;
		if (
			activeRequest.visibleTtftMs === undefined &&
			event.assistantMessageEvent.type === "text_delta" &&
			event.assistantMessageEvent.delta.length > 0
		) {
			activeRequest.visibleTtftMs = elapsed;
		}
	});

	pi.on("message_end", (event) => {
		if (!activeRequest || event.message.role !== "assistant") return;
		const usage = event.message.usage;
		pi.appendEntry(CONTEXT_TELEMETRY_ENTRY_TYPE, {
			schema: 1,
			phase: "response",
			correlationId: activeRequest.correlationId,
			provider: event.message.provider,
			model: event.message.model,
			stopReason: event.message.stopReason,
			uncachedInputTokens: usage.input,
			cacheReadTokens: usage.cacheRead,
			cacheWriteTokens: usage.cacheWrite,
			outputTokens: usage.output,
			firstModelEventMs: activeRequest.firstModelEventMs ?? null,
			visibleTtftMs: activeRequest.visibleTtftMs ?? null,
			modelLatencyMs:
				activeRequest.providerStartedAt === undefined ? null : Math.max(0, now() - activeRequest.providerStartedAt),
			cost: { ...usage.cost },
		});
		activeRequest = undefined;
	});
}
