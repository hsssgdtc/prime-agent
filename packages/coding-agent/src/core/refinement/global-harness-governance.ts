import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "../../config.js";

const GLOBAL_HARNESS_DIR_NAME = "harness";
const GLOBAL_HARNESS_STATE_FILE_NAME = "harness_state.json";
const GLOBAL_HARNESS_APPROVAL_RECEIPT_FILE_NAME = "approval-receipt.json";
const GLOBAL_HARNESS_REFINEMENT_HISTORY_FILE_NAME = "refinements.jsonl";
const GLOBAL_HARNESS_PROPOSALS_DIR_NAME = "proposals";
const GLOBAL_HARNESS_GOVERNANCE_DIR_NAME = "governance";
const GLOBAL_HARNESS_APPROVAL_PUBLIC_KEY_ENV = "PRIME_GLOBAL_HARNESS_APPROVAL_PUBLIC_KEY";

export interface GlobalHarnessApprovalReceiptUnsigned {
	schema: 2;
	proposalId: string;
	candidateSha256: string;
	basePublishedSha256: string | null;
	publicationSequence: number;
	decision: "approved";
	approvedBy: string;
	approvedAt: string;
	signatureAlgorithm: "ed25519";
}

export interface GlobalHarnessApprovalReceipt extends GlobalHarnessApprovalReceiptUnsigned {
	signature: string;
}

interface GlobalHarnessPendingReceipt {
	schema: 2;
	proposalId: string;
	candidateSha256: string;
	basePublishedSha256: string | null;
	publicationSequence: number;
	status: "pending_approval";
	source: "host_refine" | "python_rlm";
	createdAt: string;
}

interface GlobalHarnessProposalEnvelope extends GlobalHarnessPendingReceipt {
	candidateFile: "candidate_harness_state.json";
	refinementResult?: unknown;
}

interface GlobalHarnessRejectionReceipt {
	schema: 1;
	event: "global_harness_load_rejected";
	stateSha256: string;
	reason: string;
	observedAt: string;
}

function sha256(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

function atomicWrite(path: string, data: string | Buffer): void {
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	mkdirSync(resolve(path, ".."), { recursive: true });
	try {
		writeFileSync(tempPath, data, { mode: 0o600 });
		renameSync(tempPath, path);
	} finally {
		if (existsSync(tempPath)) unlinkSync(tempPath);
	}
}

function jsonText(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function proposalDir(harnessStateDir: string, proposalId: string): string {
	return join(harnessStateDir, GLOBAL_HARNESS_PROPOSALS_DIR_NAME, proposalId);
}

function proposalCandidatePath(harnessStateDir: string, proposalId: string): string {
	return join(proposalDir(harnessStateDir, proposalId), "candidate_harness_state.json");
}

function proposalEnvelopePath(harnessStateDir: string, proposalId: string): string {
	return join(proposalDir(harnessStateDir, proposalId), "proposal.json");
}

function proposalReceiptPath(harnessStateDir: string, proposalId: string): string {
	return join(proposalDir(harnessStateDir, proposalId), "receipt.json");
}

function approvalPublicKey(): ReturnType<typeof createPublicKey> {
	const encoded = process.env[GLOBAL_HARNESS_APPROVAL_PUBLIC_KEY_ENV]?.trim();
	if (!encoded) {
		throw new Error(`${GLOBAL_HARNESS_APPROVAL_PUBLIC_KEY_ENV} is not configured`);
	}
	try {
		return createPublicKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "spki" });
	} catch (error) {
		throw new Error(
			`${GLOBAL_HARNESS_APPROVAL_PUBLIC_KEY_ENV} is not a valid base64 DER public key: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function parseApprovalReceipt(value: Record<string, unknown>): GlobalHarnessApprovalReceipt | undefined {
	if (
		value.schema !== 2 ||
		typeof value.proposalId !== "string" ||
		typeof value.candidateSha256 !== "string" ||
		!(typeof value.basePublishedSha256 === "string" || value.basePublishedSha256 === null) ||
		!Number.isSafeInteger(value.publicationSequence) ||
		(value.publicationSequence as number) < 1 ||
		value.decision !== "approved" ||
		typeof value.approvedBy !== "string" ||
		typeof value.approvedAt !== "string" ||
		value.signatureAlgorithm !== "ed25519" ||
		typeof value.signature !== "string"
	) {
		return undefined;
	}
	return value as unknown as GlobalHarnessApprovalReceipt;
}

function verifyApprovalReceiptSignature(receipt: GlobalHarnessApprovalReceipt): void {
	let signature: Buffer;
	try {
		signature = Buffer.from(receipt.signature, "base64");
	} catch {
		throw new Error("approval signature is not valid base64");
	}
	if (!verify(null, buildGlobalHarnessApprovalPayload(receipt), approvalPublicKey(), signature)) {
		throw new Error("approval signature is invalid");
	}
}

function verifyApprovalReceipt(receipt: GlobalHarnessApprovalReceipt, candidate: Buffer): void {
	if (sha256(candidate) !== receipt.candidateSha256) {
		throw new Error("approval receipt candidate hash does not match global harness state");
	}
	verifyApprovalReceiptSignature(receipt);
}

function currentApprovedPublication(
	harnessStateDir: string,
): { state: Buffer; receipt: GlobalHarnessApprovalReceipt } | undefined {
	const statePath = join(harnessStateDir, GLOBAL_HARNESS_STATE_FILE_NAME);
	const receiptPath = join(harnessStateDir, GLOBAL_HARNESS_APPROVAL_RECEIPT_FILE_NAME);
	if (!existsSync(statePath) || !existsSync(receiptPath)) return undefined;
	const state = readFileSync(statePath);
	const receipt = parseApprovalReceipt(readJsonObject(receiptPath) ?? {});
	if (!receipt) return undefined;
	try {
		verifyApprovalReceipt(receipt, state);
		return { state, receipt };
	} catch {
		return undefined;
	}
}

function recordRejection(harnessStateDir: string, state: Buffer, reason: string): void {
	const stateSha256 = sha256(state);
	const receipt: GlobalHarnessRejectionReceipt = {
		schema: 1,
		event: "global_harness_load_rejected",
		stateSha256,
		reason,
		observedAt: new Date().toISOString(),
	};
	const receiptPath = join(
		harnessStateDir,
		GLOBAL_HARNESS_GOVERNANCE_DIR_NAME,
		"rejections",
		`${sha256(`${stateSha256}\0${reason}`)}.json`,
	);
	if (existsSync(receiptPath)) return;
	atomicWrite(receiptPath, jsonText(receipt));
	process.emitWarning(`Rejected unapproved global harness state: ${reason}`, {
		code: "PRIME_GLOBAL_HARNESS_REJECTED",
	});
}

export function isGovernedGlobalHarnessStateDir(harnessStateDir: string): boolean {
	return resolve(harnessStateDir) === resolve(getAgentDir(), GLOBAL_HARNESS_DIR_NAME);
}

export function buildGlobalHarnessApprovalPayload(receipt: GlobalHarnessApprovalReceiptUnsigned): Buffer {
	return Buffer.from(
		JSON.stringify({
			schema: receipt.schema,
			proposalId: receipt.proposalId,
			candidateSha256: receipt.candidateSha256,
			basePublishedSha256: receipt.basePublishedSha256,
			publicationSequence: receipt.publicationSequence,
			decision: receipt.decision,
			approvedBy: receipt.approvedBy,
			approvedAt: receipt.approvedAt,
			signatureAlgorithm: receipt.signatureAlgorithm,
		}),
		"utf8",
	);
}

export function stageGlobalHarnessStateProposal(
	harnessStateDir: string,
	state: unknown,
	source: "host_refine" | "python_rlm" = "host_refine",
): string {
	const stateRecord = state as { refinements?: Array<{ id?: unknown }> };
	const lastRefinement = stateRecord.refinements?.at(-1);
	const proposalId =
		typeof lastRefinement?.id === "string"
			? lastRefinement.id
			: `proposal_${new Date()
					.toISOString()
					.replace(/[^0-9]/g, "")
					.slice(0, 17)}_${randomUUID()}`;
	const createdAt = new Date().toISOString();
	const candidate = Buffer.from(jsonText(state), "utf8");
	const candidateSha256 = sha256(candidate);
	const published = currentApprovedPublication(harnessStateDir);
	const pending: GlobalHarnessPendingReceipt = {
		schema: 2,
		proposalId,
		candidateSha256,
		basePublishedSha256: published?.receipt.candidateSha256 ?? null,
		publicationSequence: (published?.receipt.publicationSequence ?? 0) + 1,
		status: "pending_approval",
		source,
		createdAt,
	};
	const envelope: GlobalHarnessProposalEnvelope = {
		...pending,
		candidateFile: "candidate_harness_state.json",
	};
	atomicWrite(proposalCandidatePath(harnessStateDir, proposalId), candidate);
	atomicWrite(proposalEnvelopePath(harnessStateDir, proposalId), jsonText(envelope));
	atomicWrite(proposalReceiptPath(harnessStateDir, proposalId), jsonText(pending));
	return proposalCandidatePath(harnessStateDir, proposalId);
}

export function attachGlobalHarnessRefinementResult(
	harnessStateDir: string,
	proposalId: string,
	result: unknown,
): string {
	const path = proposalEnvelopePath(harnessStateDir, proposalId);
	const envelope = readJsonObject(path);
	if (!envelope) {
		throw new Error(`Global harness proposal ${proposalId} is missing or invalid`);
	}
	atomicWrite(path, jsonText({ ...envelope, refinementResult: result }));
	return path;
}

export function publishGlobalHarnessProposal(harnessStateDir: string, receipt: GlobalHarnessApprovalReceipt): string {
	const candidatePath = proposalCandidatePath(harnessStateDir, receipt.proposalId);
	if (!existsSync(candidatePath)) {
		throw new Error(`Global harness proposal ${receipt.proposalId} has no candidate state`);
	}
	const candidate = readFileSync(candidatePath);
	verifyApprovalReceipt(receipt, candidate);
	const pending = readJsonObject(proposalReceiptPath(harnessStateDir, receipt.proposalId));
	if (
		pending?.candidateSha256 !== receipt.candidateSha256 ||
		pending.basePublishedSha256 !== receipt.basePublishedSha256 ||
		pending.publicationSequence !== receipt.publicationSequence
	) {
		throw new Error(`Global harness proposal ${receipt.proposalId} approval does not match its pending receipt`);
	}
	const publishedStatePath = join(harnessStateDir, GLOBAL_HARNESS_STATE_FILE_NAME);
	const publishedReceiptPath = join(harnessStateDir, GLOBAL_HARNESS_APPROVAL_RECEIPT_FILE_NAME);
	const published = currentApprovedPublication(harnessStateDir);
	if ((existsSync(publishedStatePath) || existsSync(publishedReceiptPath)) && !published) {
		throw new Error("Current global harness publication is invalid; refusing to overwrite it");
	}
	const expectedBase = published?.receipt.candidateSha256 ?? null;
	const expectedSequence = (published?.receipt.publicationSequence ?? 0) + 1;
	if (receipt.basePublishedSha256 !== expectedBase || receipt.publicationSequence !== expectedSequence) {
		throw new Error(
			`Global harness proposal ${receipt.proposalId} is stale: expected base ${expectedBase ?? "none"} at sequence ${expectedSequence}`,
		);
	}
	const statePath = join(harnessStateDir, GLOBAL_HARNESS_STATE_FILE_NAME);
	atomicWrite(statePath, candidate);
	atomicWrite(join(harnessStateDir, GLOBAL_HARNESS_APPROVAL_RECEIPT_FILE_NAME), jsonText(receipt));
	atomicWrite(
		join(harnessStateDir, GLOBAL_HARNESS_GOVERNANCE_DIR_NAME, "published", `${receipt.proposalId}.json`),
		jsonText(receipt),
	);

	const proposal = readJsonObject(proposalEnvelopePath(harnessStateDir, receipt.proposalId));
	const refinementResult = proposal?.refinementResult;
	if (refinementResult && typeof refinementResult === "object") {
		const historyPath = join(harnessStateDir, GLOBAL_HARNESS_REFINEMENT_HISTORY_FILE_NAME);
		const resultId = (refinementResult as { id?: unknown }).id;
		const alreadyRecorded =
			typeof resultId === "string" &&
			existsSync(historyPath) &&
			readFileSync(historyPath, "utf8")
				.split("\n")
				.some((line) => {
					try {
						return (JSON.parse(line) as { id?: unknown }).id === resultId;
					} catch {
						return false;
					}
				});
		if (!alreadyRecorded) {
			mkdirSync(harnessStateDir, { recursive: true });
			appendFileSync(historyPath, `${JSON.stringify(refinementResult)}\n`, "utf8");
		}
	}
	return statePath;
}

export function loadApprovedGlobalHarnessState(harnessStateDir: string): unknown | undefined {
	const statePath = join(harnessStateDir, GLOBAL_HARNESS_STATE_FILE_NAME);
	if (!existsSync(statePath)) return undefined;
	const state = readFileSync(statePath);
	const rawReceipt = readJsonObject(join(harnessStateDir, GLOBAL_HARNESS_APPROVAL_RECEIPT_FILE_NAME));
	const receipt = rawReceipt ? parseApprovalReceipt(rawReceipt) : undefined;
	if (!receipt) {
		recordRejection(harnessStateDir, state, "a valid approval receipt is missing");
		return undefined;
	}
	try {
		verifyApprovalReceipt(receipt, state);
	} catch (error) {
		recordRejection(harnessStateDir, state, error instanceof Error ? error.message : String(error));
		return undefined;
	}
	const publishedDir = join(harnessStateDir, GLOBAL_HARNESS_GOVERNANCE_DIR_NAME, "published");
	if (existsSync(publishedDir)) {
		for (const entry of readdirSync(publishedDir)) {
			const newer = parseApprovalReceipt(readJsonObject(join(publishedDir, entry)) ?? {});
			if (!newer || newer.publicationSequence <= receipt.publicationSequence) continue;
			try {
				verifyApprovalReceiptSignature(newer);
			} catch {
				continue;
			}
			if (newer.basePublishedSha256 === receipt.candidateSha256) {
				recordRejection(harnessStateDir, state, `published state was superseded by ${newer.proposalId}`);
				return undefined;
			}
		}
	}
	try {
		return JSON.parse(state.toString("utf8"));
	} catch {
		recordRejection(harnessStateDir, state, "published state is not valid JSON");
		return undefined;
	}
}
