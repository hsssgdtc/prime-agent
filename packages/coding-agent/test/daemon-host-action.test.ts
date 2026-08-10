import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { createExtensionUIContext } from "../src/modes/daemon/daemon-extension-binding.js";
import {
	setDaemonClientSessionCapabilities,
	shouldSendDaemonOutboundToClient,
} from "../src/modes/daemon/daemon-mode.js";
import {
	DAEMON_SCHEMA_REVISION,
	DAEMON_SUPPORTED_CLIENT_CAPABILITIES,
	type DaemonOutbound,
} from "../src/modes/daemon/daemon-protocol.js";

function makeClient(capabilities: string[] = []): DaemonSocketClient {
	return {
		id: "gateway",
		socket: {} as DaemonSocketClient["socket"],
		attachedActiveSessionIds: new Set(["active"]),
		detachInput: () => {},
		supportsExtensionUi: capabilities.includes("extension_ui"),
		capabilities: new Set(capabilities as DaemonSocketClient["capabilities"] extends Set<infer T> ? T[] : never),
	};
}

function makeHarness() {
	const client = makeClient(["extension_host_action"]);
	const state = {
		activeSessionId: "active",
		clients: new Set([client]),
		extensionUiRequests: new Map(),
	} as unknown as ActiveSessionState;
	const outbound: DaemonOutbound[] = [];
	const ui = createExtensionUIContext(state, (_state, message) => outbound.push(message));
	return { client, state, outbound, ui };
}

describe("daemon extension host actions", () => {
	it("implements the preregistered U2 wire contract", () => {
		const fixture = JSON.parse(readFileSync(resolve(__dirname, "fixtures/jarvis-u2-action-broker.json"), "utf8")) as {
			baselineCommit: string;
			wire: { protocol: number; minimumSchemaRevision: number; clientCapability: string; requestMethod: string };
		};
		expect(fixture.baselineCommit).toBe("1120b606179f80a02f8912cf80bdfb3fa427edbb");
		expect(fixture.wire).toMatchObject({
			protocol: 7,
			minimumSchemaRevision: 15,
			clientCapability: "extension_host_action",
			requestMethod: "hostAction",
		});
	});

	it("advertises the schema and dedicated capability", () => {
		expect(DAEMON_SCHEMA_REVISION).toBeGreaterThanOrEqual(15);
		expect(DAEMON_SUPPORTED_CLIENT_CAPABILITIES).toContain("extension_host_action");
	});

	it("routes host actions only to a capable client attached to the same session", () => {
		const request: DaemonOutbound = {
			type: "extension_ui_request",
			activeSessionId: "active",
			id: "request",
			method: "hostAction",
			payload: { action: "lark.doc.create", payload: {} },
		};
		const ordinary = makeClient();
		const uiOnly = makeClient(["extension_ui"]);
		const capable = makeClient(["extension_host_action"]);
		const otherSession = makeClient(["extension_host_action"]);
		setDaemonClientSessionCapabilities(otherSession, "other", new Set(["extension_host_action"]));

		expect(shouldSendDaemonOutboundToClient(ordinary, request)).toBe(false);
		expect(shouldSendDaemonOutboundToClient(uiOnly, request)).toBe(false);
		expect(shouldSendDaemonOutboundToClient(capable, request)).toBe(true);
		expect(shouldSendDaemonOutboundToClient(otherSession, request)).toBe(false);
	});

	it("resolves structured success and preserves structured failure", async () => {
		const { state, outbound, ui } = makeHarness();
		const success = ui.requestHostAction("lark.doc.create", { title: "U2" });
		const request = outbound[0] as Extract<DaemonOutbound, { type: "extension_ui_request" }>;
		expect(request.method).toBe("hostAction");
		expect(request.payload).toEqual({ action: "lark.doc.create", payload: { title: "U2" }, timeout: 30_000 });
		state.extensionUiRequests.get(request.id)?.resolve({ result: { receiptId: "receipt-1" } });
		await expect(success).resolves.toEqual({ receiptId: "receipt-1" });

		const failure = ui.requestHostAction("lark.calendar.create", {});
		const failureRequest = outbound[1] as Extract<DaemonOutbound, { type: "extension_ui_request" }>;
		state.extensionUiRequests.get(failureRequest.id)?.resolve({
			error: {
				code: "permission_denied",
				message: "scope missing",
				retryable: false,
				details: { account: "personal" },
			},
		});
		await expect(failure).rejects.toMatchObject({
			code: "permission_denied",
			message: "scope missing",
			retryable: false,
			details: { account: "personal" },
		});
	});

	it("fails closed when unavailable, aborted, or timed out", async () => {
		const unavailable = makeHarness();
		unavailable.state.clients.clear();
		await expect(unavailable.ui.requestHostAction("lark.doc.create", {})).rejects.toMatchObject({
			code: "host_unavailable",
		});

		const aborted = makeHarness();
		const controller = new AbortController();
		const pending = aborted.ui.requestHostAction("lark.doc.create", {}, { signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "aborted" });
		expect(aborted.state.extensionUiRequests).toHaveLength(0);

		vi.useFakeTimers();
		try {
			const timed = makeHarness();
			const request = timed.ui.requestHostAction("lark.doc.create", {}, { timeout: 10 });
			const assertion = expect(request).rejects.toMatchObject({ code: "timeout", retryable: true });
			await vi.advanceTimersByTimeAsync(10);
			await assertion;
			expect(timed.state.extensionUiRequests).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
