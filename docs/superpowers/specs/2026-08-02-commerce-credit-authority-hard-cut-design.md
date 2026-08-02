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

- `permanent`: no calendar zone, anchor, enrollment, acquisition, or source window. Its optional
  `expiresAfterSeconds` is the only relative-expiry policy in the model. `null` means non-expiring;
  otherwise `expiresAt = acquiredAt + expiresAfterSeconds`.
- `daily`: an IANA calendar zone plus a canonical local reset time; a Grant is bounded by one acquired absolute daily window.
- `period`: the authoritative Subscription Term start plus a positive duration; a Grant is bounded by one acquired absolute term window.

Program, Enrollment, Acquisition, and Grant references are branded at application boundaries. All wire and persistence mappings use exhaustive switches. No numeric enum casts are permitted.

## Persistence Hard Cut

The Program catalog table is renamed into the Commerce namespace. All Commerce repositories, readers, grants, privilege inventories, schema tests, and operational probes use the new name.

Database checks enforce:

- `program_window` source if and only if the Grant bucket is `daily` or `period`.
- permanent Grants have an empty source-window key. Their expiry is null if the Program duration is
  null and otherwise is exactly `acquired_at + expires_after_seconds`.
- daily/period Grants have a non-empty source-window key and an absolute expiry after their effective time.
- Period Subscription Terms are immutable version-1 facts with a digest over Site, account, plan
  version, start, and end. Enrollment stores the exact term ref/version/digest; daily Enrollment has
  all three columns null. A composite foreign key binds the period Enrollment to that frozen term.
- Enrollment has a composite unique key over enrollment ref, Site, account, Program
  ref/revision/digest, term ref/version/digest, and effective interval.
- Acquisition repeats Site, account, Program ref/revision/digest, absolute window start/end,
  acquired instant, Enrollment ref, and Grant ref. It is unique by `(site,enrollment,window_key)` and
  by `(site,grant)` so the relation is one window to one Grant.
- Grant has a composite unique key covering Grant ref, Site, account, Program ref/revision/digest,
  source type/ref/window key, effective/expiry/acquired instants. Acquisition has composite foreign
  keys to both the Enrollment and Grant keys.

Enrollment, Acquisition, Grant, Program revision, and Subscription Term are guarded by immutable
update/delete triggers. Deferred constraint triggers owned by Credit run after Grant or Acquisition
insert and at transaction commit, so issuance may insert them in either order while still requiring:

- every daily/period Grant has exactly one Acquisition;
- Acquisition's Grant is `program_window`, `source_ref = enrollment_ref`, and its source-window key,
  account, Program snapshot, effective/expiry/acquired instants exactly equal the Acquisition;
- Acquisition's Enrollment has the same account and Program snapshot and contains the acquired
  absolute interval; period Acquisition also matches the exact term snapshot.

The old relative-expiry journal invariant is replaced with a branch:

- permanent: only the optional Program-relative duration formula above is legal;
- daily/period: effective time, expiry, acquisition time, Program revision, account, enrollment source, and window key must match the absolute Acquisition fact.

## Window Resolution

Daily resolution never compares a wall-clock timestamp with `acquiredAt`. For each neighboring civil
date it derives the UTC offsets in force immediately before and after that date's transition, applies
each distinct offset to the local anchor, and round-trips each absolute candidate through the named
zone. Every round-tripping candidate is retained, so both folds of an ambiguous overlap are explicit.
If no candidate round-trips because the anchor is in a gap, the boundary shifts forward by exactly
the zone's transition gap and must round-trip to the earliest valid local instant after the requested
anchor. The resolver then sorts absolute candidates, chooses the greatest boundary not after
`acquiredAt`, and chooses the next greater boundary. The selected interval is clipped to Enrollment
bounds. Tests cover normal dates, non-hour spring-forward gaps, both folds of fall-back overlaps,
non-hour overlaps, and exact anchors.

Period resolution starts at the Subscription Term effective instant and ends at the earlier of the term end or configured positive duration. An expired period is not reacquired.

## Revocation, Credit Correction, and Reconciliation

Commerce executes an idempotent local command in one Platform unit of work. The semantic operation
key is `enrollment-revoke:<site-ref>:<enrollment-ref>` and the request digest covers the immutable
Enrollment identity, reason, evidence, and effective instant. The existing command receipt remains
unique by command id and actor/operation/idempotency key. The Enrollment row is selected `FOR UPDATE`
before the prior-revocation check, so concurrent first attempts serialize even when no receipt exists.
The revocation table is unique by Enrollment and by command; a conflicting request digest fails closed.

The steps are:

1. lock the Enrollment and its prior revocation/correction receipt;
2. return the prior receipt on replay;
3. insert the immutable Enrollment revocation, preventing future acquisition;
4. call Credit's correction port for every exact `program_window` Grant;
5. always append a balanced `grant_revoke` journal transaction for the currently available,
   unencumbered balance, using Credit's unique `(site,account,business_operation_key)` constraint;
6. when reserved/captured/consumed exposure remains, also create one immutable
   `reconciliation_required` fact unique by Enrollment, linked to the affected Grant/Hold and journal
   evidence; no unencumbered revoked amount remains spendable;
7. persist a Commerce command receipt, audit entry, and transactional outbox event in the same transaction.

Credit never mutates or deletes a Grant. The correction port returns a discriminated result:
`corrected`, `partially_corrected_reconciliation_required`, `reconciliation_required` (zero available),
or `replayed`. Commerce folds those results into a closed execution receipt. Revocation,
reconciliation, command receipt, audit, and outbox records each carry the command id; reconciliation
is unique by Enrollment; audit is unique by `(command,event_type)`; and outbox is unique by event id
and `(command,event_type)`. Reconciliation and redemption-source receipt queries include Enrollment
revocation and Credit correction references.

## Runtime and Privileges

The public API role receives no Enrollment or Acquisition table/sequence write privilege and no
execute privilege on any function that writes either table. Migration code explicitly revokes table,
sequence, and function privileges from `PUBLIC` and the API role, sets restrictive default privileges,
and rejects security-definer functions that can reach Enrollment/Acquisition. The API runtime has no
recurring issuance port in its dependency graph. Static privilege probes cover direct and indirect
writes and prove only the future dedicated worker role can receive them. The dormant recurring worker
is not composed until an explicit design approves its runtime identity, exact RLS, scheduling, retry,
and batch-failure behavior. Public preview and confirmation reject daily/period Credit before any mutation.

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
