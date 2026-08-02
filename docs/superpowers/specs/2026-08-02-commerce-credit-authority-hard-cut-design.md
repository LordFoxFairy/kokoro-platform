# Commerce/Credit Authority Hard-Cut Design

**Status:** Approved by the coordinating architecture owner on 2026-08-02.

## Objective

Close the seven Commerce/Credit authority defects introduced around recurring Credit without enabling recurring public redemption or payment money rails. This is an incompatible hard cut: the new schema and module boundaries do not preserve old data or the stale Admin Commerce provider.

## Scope and Boundaries

- Commerce owns products, immutable Credit Program revisions, window policy, enrollment, acquisition, correction orchestration, receipts, reconciliation, and Commerce outbox facts.
- Credit owns Account, Grant, Hold, and Ledger authority. It exposes only narrow issuance and correction ports to Commerce.
- Public redemption supports permanent Credit only. Daily and period redemption stay feature-off.
- The recurring window worker remains dormant and is not granted to the API role or composed into public runtime. Its internal authority is completed and tested for a later explicit enablement decision.
- Root, Web, Session, and Agent are read-only. Platform generated mirrors are regenerated from current Root sources. Root/Web drift is reported as an exact handoff.
- The current Root Admin Commerce boundary is `contract-only`. Platform removes the stale legacy provider from runtime composition rather than implementing placeholders for payment, pricing, secret delivery, approval, or reconciliation RPCs.

## Domain Model

Commerce represents Program windows as a discriminated union:

- `permanent`: no calendar zone, anchor, relative expiry, enrollment, acquisition, or source window.
- `daily`: an IANA calendar zone plus a canonical local reset time; a Grant is bounded by one acquired absolute daily window.
- `period`: the authoritative Subscription Term start plus a positive duration; a Grant is bounded by one acquired absolute term window.

Program, Enrollment, Acquisition, and Grant references are branded at application boundaries. All wire and persistence mappings use exhaustive switches. No numeric enum casts are permitted.

## Persistence Hard Cut

The Program catalog table is renamed into the Commerce namespace. All Commerce repositories, readers, grants, privilege inventories, schema tests, and operational probes use the new name.

Database checks enforce:

- `program_window` source if and only if the Grant bucket is `daily` or `period`.
- permanent Grants have an empty source-window key and no expiry.
- daily/period Grants have a non-empty source-window key and an absolute expiry after their effective time.
- Enrollment binds an exact Site, billing account, Program revision/ref/digest, output identity, and effective interval.
- Acquisition binds one exact Enrollment/window to one exact Grant and acquired instant.

Deferred constraint triggers run at transaction commit so issuance may insert Grant and Acquisition in either order while still requiring an exact composite match. The old relative-expiry journal invariant is replaced with a branch:

- permanent: relative/non-expiring semantics only;
- daily/period: effective time, expiry, acquisition time, Program revision, account, enrollment source, and window key must match the absolute Acquisition fact.

## Window Resolution

Daily resolution never compares a wall-clock timestamp with `acquiredAt`. It creates local anchor candidates for neighboring civil dates, converts every candidate to `timestamptz`, then chooses the greatest absolute boundary not after `acquiredAt` and the next greater absolute boundary. The selected interval is clipped to Enrollment bounds. Tests cover normal dates, spring-forward gaps, both sides of fall-back overlap, and exact anchors.

Period resolution starts at the Subscription Term effective instant and ends at the earlier of the term end or configured positive duration. An expired period is not reacquired.

## Revocation, Credit Correction, and Reconciliation

Commerce executes an idempotent local command in one Platform unit of work:

1. lock the Enrollment and its prior revocation/correction receipt;
2. return the prior receipt on replay;
3. insert the immutable Enrollment revocation, preventing future acquisition;
4. call Credit's correction port for every exact `program_window` Grant;
5. if no live Hold or captured exposure blocks correction, append a balanced `grant_revoke` journal transaction for the remaining available amount;
6. otherwise create an immutable `reconciliation_required` fact linked to the Enrollment and affected Grant/Hold evidence;
7. persist a Commerce command receipt, audit entry, and transactional outbox event in the same transaction.

Credit never mutates or deletes a Grant. The correction port returns a discriminated result: `corrected`, `reconciliation_required`, or `replayed`. Commerce folds those results into a closed execution receipt. Reconciliation and redemption-source receipt queries include Enrollment revocation and Credit correction references.

## Runtime and Privileges

The public API role receives no Enrollment or Acquisition write privilege. The dormant recurring worker is not composed until an explicit design approves its runtime identity, exact RLS, scheduling, retry, and batch-failure behavior. Public preview and confirmation reject daily/period Credit before any mutation.

The stale legacy Admin Commerce Connect provider is removed from admin composition after regeneration. This is an explicit absence, not a fake success path. Existing internal application services remain available for future provider work.

## Generated Contracts

Regenerate:

- the internal fulfillment mirror, including `CREDIT_PROGRAM_ENROLLMENT = 4`;
- the Platform Admin Commerce mirror and metadata from the current Root `platform-admin-commerce` boundary.

Production adapters use generated enum members directly. Because the current boundary is contract-only, generated service expansion does not authorize runtime provider stubs. Root/Web generated mirrors and consumer implementation remain a handoff outside this repository.

## Testing and Verification

Every behavioral change follows RED, observed failure, minimal GREEN, and refactor:

- permanent-only public capability tests;
- Commerce ownership/import-boundary tests;
- Program-window discriminated-union validation tests;
- SQL schema tests for iff checks and deferred exact binding;
- DST gap/overlap repository tests;
- Enrollment revocation replay, correction, active-Hold reconciliation, receipt, and outbox tests;
- generated enum and stale numeric-cast tests;
- runtime-composition tests proving the contract-only provider is absent.

Final verification runs focused Vitest suites, Platform lint/typecheck, generated-artifact checks available without Docker, `git diff --check`, and a clean status check. Docker and database integration tests are explicitly excluded and reported.

## Non-Goals and Handoff

- No payment processor, price publication, payment intent, money capture/refund, or payment fulfillment path is enabled.
- No recurring public redemption or worker deployment is enabled.
- No Root/Web/Session/Agent file is edited.
- Provider implementation for the new Admin Commerce contract, Root boundary lifecycle activation, Web regeneration, and the exact worker/RLS deployment are separate follow-ups.
