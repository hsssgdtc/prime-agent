import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCronJobStore } from "../src/core/cron-jobs.js";
import { GOAL_STATE_CUSTOM_TYPE, type GoalState } from "../src/core/goals.js";
import { SessionManager } from "../src/core/session-manager.js";

const now = new Date("2026-08-10T00:00:00.000Z");
const activeGoal: GoalState = {
	active: true,
	status: "active",
	goalId: "goal-u1",
	objective: "Verify Prime runtime ownership",
	tokensUsed: 0,
	timeUsedSeconds: 0,
	continuationsUsed: 0,
};

function persistedGoal(manager: SessionManager): GoalState | undefined {
	const branch = manager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type === "custom" && entry.customType === GOAL_STATE_CUSTOM_TYPE) {
			return entry.data as GoalState;
		}
	}
	return undefined;
}

function createAllScheduleKinds(store: AgentCronJobStore, sessionFile: string, activeSessionId = "active-old") {
	const common = {
		activeSessionId,
		sessionId: "session-old",
		sessionFile,
		cwd: "/tmp/project",
		now,
	};
	return [
		store.create({ ...common, scheduleText: "in 1h", prompt: "one shot" }),
		store.create({ ...common, scheduleText: "0 * * * *", prompt: "cron" }),
		store.createHeartbeat({ ...common, scheduleText: "every 5m", prompt: "user heartbeat" }),
		store.createRlmHeartbeat({
			...common,
			label: "agent heartbeat",
			scheduleText: "every 10m",
			prompt: "agent heartbeat",
		}),
	];
}

describe("Jarvis U1 Prime runtime ownership", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const path = tempDirs.pop();
			if (path) rmSync(path, { recursive: true, force: true });
		}
	});

	it("loads goal state on resume, copies it on an inclusive fork, and clears it on new", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-u1-goal-ownership-"));
		tempDirs.push(root);
		const source = SessionManager.create(root, join(root, "sessions"));
		const goalEntryId = source.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, activeGoal);
		source.flushNow();
		const sourceFile = source.getSessionFile();
		expect(sourceFile).toBeDefined();

		const resumed = SessionManager.open(sourceFile!);
		expect(persistedGoal(resumed)).toMatchObject({ goalId: "goal-u1", status: "active" });

		const forked = SessionManager.open(sourceFile!);
		forked.createBranchedSession(goalEntryId);
		expect(forked.getSessionId()).not.toBe(source.getSessionId());
		expect(persistedGoal(forked)).toMatchObject({ goalId: "goal-u1", status: "active" });

		const fresh = SessionManager.open(sourceFile!);
		fresh.newSession();
		expect(fresh.getBranch()).toEqual([]);
		expect(persistedGoal(fresh)).toBeUndefined();
	});

	it("moves one-shot, cron, and both heartbeat kinds with a live session replacement", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-u1-live-replacement-"));
		tempDirs.push(root);
		const store = new AgentCronJobStore(join(root, "jobs.json"));
		const jobs = createAllScheduleKinds(store, join(root, "old.jsonl"));

		const rebound = store.rebindSessionJobs({
			activeSessionId: "active-old",
			sessionId: "session-new",
			sessionFile: join(root, "new.jsonl"),
			cwd: "/tmp/project",
		});

		expect(rebound.map((job) => job.id).sort()).toEqual(jobs.map((job) => job.id).sort());
		expect(store.list()).toEqual(
			expect.arrayContaining(
				jobs.map((job) =>
					expect.objectContaining({
						id: job.id,
						activeSessionId: "active-old",
						sessionId: "session-new",
						sessionFile: join(root, "new.jsonl"),
					}),
				),
			),
		);
	});

	it("rebinds a resumed file to a new daemon id but leaves an independent successor empty", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-u1-resume-successor-"));
		tempDirs.push(root);
		const sessionFile = join(root, "session.jsonl");
		const resumeStore = new AgentCronJobStore(join(root, "resume-jobs.json"));
		const resumeJobs = createAllScheduleKinds(resumeStore, sessionFile);
		const resumed = resumeStore.rebindSessionJobs({
			activeSessionId: "active-resumed",
			sessionId: "session-resumed",
			sessionFile,
			cwd: "/tmp/project",
		});
		expect(resumed.map((job) => job.id).sort()).toEqual(resumeJobs.map((job) => job.id).sort());

		const successorStore = new AgentCronJobStore(join(root, "successor-jobs.json"));
		const predecessorJobs = createAllScheduleKinds(successorStore, join(root, "predecessor.jsonl"));
		const successorRebind = successorStore.rebindSessionJobs({
			activeSessionId: "active-successor",
			sessionId: "session-successor",
			sessionFile: join(root, "successor.jsonl"),
			cwd: "/tmp/project",
		});
		expect(successorRebind).toEqual([]);
		expect(successorStore.list()).toEqual(
			expect.arrayContaining(
				predecessorJobs.map((job) =>
					expect.objectContaining({ id: job.id, activeSessionId: "active-old", sessionId: "session-old" }),
				),
			),
		);
	});
});
