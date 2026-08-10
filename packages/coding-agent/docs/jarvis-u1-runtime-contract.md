# Jarvis U1 Prime runtime contract

This fork treats Prime as the cognition runtime before Feishu is connected. The machine-readable contract is `test/fixtures/jarvis-u1-runtime-contract.json`.

## Session ownership

| Transition | Goal | One-shot, cron, user heartbeat, agent heartbeat |
|---|---|---|
| Resume the same persisted session | Loaded from that session branch | Rebound from the stable session file to the new daemon active id |
| `new` in the same live runtime | Starts empty | Move with the live active id to the replacement file |
| Inclusive fork in the same live runtime | Copied when the `thread_goal_state` entry is on the selected branch | Move with the live active id to the fork file |
| Independently created successor | Starts empty | Stay with the predecessor until a handoff explicitly cancels and re-registers them |

The independent-successor case is the one Jarvis bounded episodes will use. U4 must not assume that creating another Prime session transfers wakeups.

## State truth

- The persistent IPython namespace and its dill snapshot are revivable computation cache. They may be discarded.
- A result that must survive an episode boundary is durable only after it is explicitly stored as an artifact and referenced by the handoff.
- Session JSONL is Prime's conversation truth. It is not a general artifact store and the Feishu gateway must not parse it to infer live state.

## Child authority

Native RLM children inherit the configured parent tool surface and run as the same OS user. That is useful delegation, not a sandbox. Until a separate coding-specialist boundary exists, the threat model must assume an ordinary child can mutate any path its process identity can reach.

## Executable evidence

The U1 evidence run includes these existing Prime suites in addition to `jarvis-u1-runtime-ownership.test.ts`:

- `kernel-state-roundtrip.test.ts`: live kernel namespace save and revival;
- `suite/agent-session-runtime.test.ts`: native child lifecycle plus new, resume, and fork replacement;
- `suite/agent-session-goal.test.ts`: durable goal state, continuation, completion, and restart idempotency;
- `cron-jobs.test.ts`: one-shot, cron, user heartbeat, agent heartbeat, rebind, persistence, and recovery;
- `suite/acp-features.test.ts`: heartbeat/schedule events, goal events, and agent messaging;
- `daemon-supervisor-process.test.ts`: real supervisor/worker subprocess recovery and adoption.

Repository rules forbid local `npm run build`. `.github/workflows/jarvis-prime-artifact.yml` therefore builds the fixed release tarballs in GitHub Actions, records the source commit and checksums, and uploads them without publishing a release or mutating a channel.
