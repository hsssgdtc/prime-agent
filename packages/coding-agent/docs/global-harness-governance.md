# Global continual-harness governance

Prime Agent keeps local continual-harness state writable inside one session. Cross-session global state uses a separate proposal and publication lifecycle.

## Write lifecycle

Both model-accessible global mutation paths are proposal-only:

- host `/refine --global` and `await refine.run(global_=True)` stage a candidate under `~/.prime/agent/harness/proposals/<proposal-id>/`;
- Python `rlm.harness.*(..., global_=True)` stages the same three-file proposal shape.

Each proposal contains:

- `candidate_harness_state.json`: the complete candidate state;
- `proposal.json`: source, candidate hash, and refinement result when available;
- `receipt.json`: a `pending_approval` receipt.

These calls never overwrite `harness_state.json` and never make the candidate visible to another session.

## Approval and publication

The approval authority owns an Ed25519 private key outside Prime Agent. Prime receives only the base64-encoded DER public key through `PRIME_GLOBAL_HARNESS_APPROVAL_PUBLIC_KEY`.

The authority signs the UTF-8 JSON returned by `buildGlobalHarnessApprovalPayload()`:

```json
{
  "schema": 1,
  "proposalId": "refine_...",
  "candidateSha256": "...",
  "decision": "approved",
  "approvedBy": "sky",
  "approvedAt": "2026-08-10T00:00:00.000Z",
  "signatureAlgorithm": "ed25519"
}
```

`publishGlobalHarnessProposal()` verifies the candidate hash and signature before replacing the published state and approval receipt. The private key must not be placed in the Prime process environment, agent directory, kernel, shell environment, or repository.

## Load lifecycle

The TypeScript system-prompt loader verifies all of the following on every global load:

1. the approval receipt has the expected schema and decision;
2. the state bytes match `candidateSha256`;
3. the Ed25519 signature matches the externally configured public key.

The Python RLM helper independently applies the same hash and Ed25519 checks before returning global entries. A missing key, missing receipt, malformed receipt, invalid signature, corrupt JSON, or direct `harness_state.json` rewrite fails closed.

Rejected TypeScript loads return an empty global projection, emit `PRIME_GLOBAL_HARNESS_REJECTED`, and leave one content-addressed receipt under `harness/governance/rejections/`. Repeated loads of the same rejected bytes and reason do not append duplicate receipts.

## Boundary

This patch prevents Prime's official refinement paths and arbitrary kernel state-file writes from silently becoming cross-session prompt context. It does not turn the entire Prime process into an OS security boundary. The approval private key must remain external; if it is exposed to the runtime user or model tools, the governance guarantee collapses and the signer must be rotated before accepting further publications.

## Fork patch ledger

| Patch | Classification | Reason | Removal condition |
|---|---|---|---|
| Proposal-only global host refinement | upstreamable | Generic cross-session state safety | Upstream offers equivalent proposal lifecycle |
| Proposal-only Python `global_=True` | upstreamable | Closes the second official write path | Upstream offers equivalent proposal lifecycle |
| Signed published-state loader | Jarvis-required, upstreamable | Enforces external approval ownership | Upstream offers configurable external approval verification |
| Rejection receipts | upstreamable | Makes fail-closed behavior observable and deduplicated | Upstream exposes equivalent audit events |

No temporary compatibility patch is present in this slice.
