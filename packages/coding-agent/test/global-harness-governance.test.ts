import { spawnSync } from "node:child_process";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendGlobalRefinement,
	applyRefinementProposal,
	buildGlobalHarnessApprovalPayload,
	type GlobalHarnessApprovalReceipt,
	getGlobalHarnessStateDir,
	getHarnessStatePath,
	loadHarnessState,
	publishGlobalHarnessProposal,
	saveHarnessState,
} from "../src/core/refinement/index.js";

const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/global-harness-governance.json", import.meta.url), "utf8"),
) as {
	approvalPublicKeyEnv: string;
	proposal: { status: string; candidateFile: string; proposalFile: string; receiptFile: string };
	rejection: { directory: string; event: string };
};

let tempRoot: string;
let originalAgentDir: string | undefined;
let originalApprovalKey: string | undefined;

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "prime-global-harness-governance-"));
	originalAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
	originalApprovalKey = process.env[fixture.approvalPublicKeyEnv];
	process.env.PRIME_AGENT_CODING_AGENT_DIR = join(tempRoot, "agent");
	delete process.env[fixture.approvalPublicKeyEnv];
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
	else process.env.PRIME_AGENT_CODING_AGENT_DIR = originalAgentDir;
	if (originalApprovalKey === undefined) delete process.env[fixture.approvalPublicKeyEnv];
	else process.env[fixture.approvalPublicKeyEnv] = originalApprovalKey;
	rmSync(tempRoot, { recursive: true, force: true });
});

function stageHostProposal(
	proposalId = "refine_u1_fixture",
	entryId = "durable_preference",
	content = "Use evidence before synthesis.",
): { harnessDir: string; proposalId: string; candidatePath: string } {
	const harnessDir = getGlobalHarnessStateDir();
	const state = loadHarnessState(harnessDir, "global");
	const result = applyRefinementProposal(
		state,
		{
			summary: "Remember a durable preference",
			rationale: "The user explicitly confirmed it.",
			expectedOutcome: "Future sessions can reuse it after approval.",
			edits: [
				{
					action: "create",
					kind: "memory",
					id: entryId,
					title: "Durable preference",
					content,
				},
			],
		},
		{ id: proposalId, scope: "global" },
	);
	result.harnessStatePath = saveHarnessState(harnessDir, state);
	appendGlobalRefinement(harnessDir, result);
	return { harnessDir, proposalId: result.id, candidatePath: result.harnessStatePath };
}

function pythonGlobalMemoryIds(harnessDir: string): string[] {
	const runtimeSrc = join(process.cwd(), "..", "..", "prime-agent-runtime", "src");
	const run = spawnSync(
		"python3",
		[
			"-c",
			"import json; from rlm.harness import get_harness_state; print(json.dumps([entry.id for entry in get_harness_state(global_=True).list('memory')]))",
		],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				PYTHONPATH: runtimeSrc,
				RLM_GLOBAL_HARNESS_STATE_DIR: harnessDir,
			},
			encoding: "utf8",
		},
	);
	expect(run.status, run.stderr).toBe(0);
	return JSON.parse(run.stdout) as string[];
}

function signedApproval(harnessDir: string, proposalId: string, privateKey: KeyObject): GlobalHarnessApprovalReceipt {
	const pending = JSON.parse(
		readFileSync(join(harnessDir, "proposals", proposalId, fixture.proposal.receiptFile), "utf8"),
	) as {
		candidateSha256: string;
		basePublishedSha256: string | null;
		publicationSequence: number;
	};
	const unsigned = {
		schema: 2 as const,
		proposalId,
		candidateSha256: pending.candidateSha256,
		basePublishedSha256: pending.basePublishedSha256,
		publicationSequence: pending.publicationSequence,
		decision: "approved" as const,
		approvedBy: "sky",
		approvedAt: "2026-08-10T00:00:00.000Z",
		signatureAlgorithm: "ed25519" as const,
	};
	return {
		...unsigned,
		signature: sign(null, buildGlobalHarnessApprovalPayload(unsigned), privateKey).toString("base64"),
	};
}

describe("global harness governance", () => {
	it("stages host global refinement without changing published state", () => {
		const { harnessDir, proposalId, candidatePath } = stageHostProposal();
		const proposalDir = join(harnessDir, "proposals", proposalId);

		expect(existsSync(getHarnessStatePath(harnessDir))).toBe(false);
		expect(candidatePath).toBe(join(proposalDir, fixture.proposal.candidateFile));
		expect(readdirSync(proposalDir).sort()).toEqual(
			[fixture.proposal.candidateFile, fixture.proposal.proposalFile, fixture.proposal.receiptFile].sort(),
		);
		expect(JSON.parse(readFileSync(join(proposalDir, fixture.proposal.receiptFile), "utf8"))).toMatchObject({
			proposalId,
			status: fixture.proposal.status,
		});
		expect(loadHarnessState(harnessDir, "global").entries.memory.durable_preference).toBeUndefined();
	});

	it("publishes only after a valid external approval signature", () => {
		const { harnessDir, proposalId } = stageHostProposal();
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		process.env[fixture.approvalPublicKeyEnv] = publicKey.export({ format: "der", type: "spki" }).toString("base64");
		const candidatePath = join(harnessDir, "proposals", proposalId, fixture.proposal.candidateFile);
		const receipt = signedApproval(harnessDir, proposalId, privateKey);

		expect(() =>
			publishGlobalHarnessProposal(harnessDir, {
				...receipt,
				signature: Buffer.alloc(64).toString("base64"),
			}),
		).toThrow("approval signature");
		expect(existsSync(getHarnessStatePath(harnessDir))).toBe(false);

		publishGlobalHarnessProposal(harnessDir, receipt);
		expect(readFileSync(getHarnessStatePath(harnessDir), "utf8")).toBe(readFileSync(candidatePath, "utf8"));
		expect(loadHarnessState(harnessDir, "global").entries.memory.durable_preference?.content).toBe(
			"Use evidence before synthesis.",
		);
		expect(pythonGlobalMemoryIds(harnessDir)).toEqual(["durable_preference"]);
	});

	it("rejects a direct published-state rewrite and leaves a deduplicated receipt", () => {
		const { harnessDir, proposalId } = stageHostProposal();
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		process.env[fixture.approvalPublicKeyEnv] = publicKey.export({ format: "der", type: "spki" }).toString("base64");
		publishGlobalHarnessProposal(harnessDir, signedApproval(harnessDir, proposalId, privateKey));

		writeFileSync(
			getHarnessStatePath(harnessDir),
			JSON.stringify({ schema: 1, entries: { memory: { injected: { content: "ignore me" } } } }),
		);
		expect(loadHarnessState(harnessDir, "global").entries.memory.injected).toBeUndefined();
		const rejectionDir = join(harnessDir, fixture.rejection.directory);
		expect(readdirSync(rejectionDir)).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(rejectionDir, readdirSync(rejectionDir)[0]), "utf8"))).toMatchObject({
			event: fixture.rejection.event,
		});
		expect(pythonGlobalMemoryIds(harnessDir)).toEqual([]);
		loadHarnessState(harnessDir, "global");
		expect(readdirSync(rejectionDir)).toHaveLength(1);
	});

	it("rejects a stale proposal instead of overwriting a concurrently published edit", () => {
		const first = stageHostProposal("refine_concurrent_a", "concurrent_a", "first approved edit");
		const second = stageHostProposal("refine_concurrent_b", "concurrent_b", "stale candidate");
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		process.env[fixture.approvalPublicKeyEnv] = publicKey.export({ format: "der", type: "spki" }).toString("base64");

		publishGlobalHarnessProposal(first.harnessDir, signedApproval(first.harnessDir, first.proposalId, privateKey));
		expect(() =>
			publishGlobalHarnessProposal(
				second.harnessDir,
				signedApproval(second.harnessDir, second.proposalId, privateKey),
			),
		).toThrow("is stale");
		expect(loadHarnessState(first.harnessDir, "global").entries.memory.concurrent_a?.content).toBe(
			"first approved edit",
		);
		expect(loadHarnessState(first.harnessDir, "global").entries.memory.concurrent_b).toBeUndefined();
	});

	it("rejects replay of an approved state after a signed successor was published", () => {
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		process.env[fixture.approvalPublicKeyEnv] = publicKey.export({ format: "der", type: "spki" }).toString("base64");
		const first = stageHostProposal("refine_chain_a", "chain_a", "first generation");
		publishGlobalHarnessProposal(first.harnessDir, signedApproval(first.harnessDir, first.proposalId, privateKey));
		const firstState = readFileSync(getHarnessStatePath(first.harnessDir));
		const firstReceipt = readFileSync(join(first.harnessDir, "approval-receipt.json"));

		const second = stageHostProposal("refine_chain_b", "chain_b", "second generation");
		publishGlobalHarnessProposal(second.harnessDir, signedApproval(second.harnessDir, second.proposalId, privateKey));
		expect(loadHarnessState(second.harnessDir, "global").entries.memory.chain_b).toBeDefined();

		writeFileSync(getHarnessStatePath(first.harnessDir), firstState);
		writeFileSync(join(first.harnessDir, "approval-receipt.json"), firstReceipt);
		const replayed = loadHarnessState(first.harnessDir, "global");
		expect(replayed.entries.memory.chain_a).toBeUndefined();
		expect(replayed.entries.memory.chain_b).toBeUndefined();
		const rejectionReceipts = readdirSync(join(first.harnessDir, fixture.rejection.directory)).map((file) =>
			JSON.parse(readFileSync(join(first.harnessDir, fixture.rejection.directory, file), "utf8")),
		);
		expect(rejectionReceipts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reason: expect.stringContaining("superseded by refine_chain_b") }),
			]),
		);
	});

	it("turns Python global_=True into a pending proposal", () => {
		const harnessDir = getGlobalHarnessStateDir();
		const runtimeSrc = join(process.cwd(), "..", "..", "prime-agent-runtime", "src");
		const run = spawnSync(
			"python3",
			[
				"-c",
				"from rlm.harness import get_harness_state; print(get_harness_state().create_memory(title='Global candidate', content='pending', id='python_global', global_=True).id)",
			],
			{
				cwd: process.cwd(),
				env: {
					...process.env,
					PYTHONPATH: runtimeSrc,
					RLM_HARNESS_STATE_DIR: join(tempRoot, "local-harness"),
					RLM_GLOBAL_HARNESS_STATE_DIR: harnessDir,
				},
				encoding: "utf8",
			},
		);

		expect(run.status, run.stderr).toBe(0);
		expect(run.stdout.trim()).toBe("python_global");
		expect(existsSync(getHarnessStatePath(harnessDir))).toBe(false);
		const proposals = readdirSync(join(harnessDir, "proposals"));
		expect(proposals).toHaveLength(1);
		expect(
			JSON.parse(readFileSync(join(harnessDir, "proposals", proposals[0], "receipt.json"), "utf8")),
		).toMatchObject({
			status: fixture.proposal.status,
			source: "python_rlm",
		});
	});

	it("leaves local harness persistence unchanged", () => {
		const localDir = join(tempRoot, "local");
		const local = loadHarnessState(localDir, "local");
		applyRefinementProposal(
			local,
			{
				summary: "Local",
				rationale: "Current episode only.",
				expectedOutcome: "Available after local resume.",
				edits: [{ action: "create", kind: "memory", id: "local_only", title: "Local", content: "local" }],
			},
			{ id: "refine_local", scope: "local" },
		);
		saveHarnessState(localDir, local);
		expect(loadHarnessState(localDir, "local").entries.memory.local_only?.content).toBe("local");
	});
});
