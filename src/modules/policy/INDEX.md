---
architectureIndex: 1
owners: ["Platform Security"]
---

# Policy module

The domain registry is fail-closed: an absent operation policy denies. `authorizeAndExecuteEffect` locks fresh owner-provided
authorization facts inside the same Unit of Work as the mutation and persists the decision before calling the effect callback.
Risk assessment is a pre-transaction remote port. A trusted cryptographic verifier issues an opaque, runtime-tracked
`VerifiedRiskDecisionSnapshot`; a non-empty signature string is never treated as proof. Policy still binds the verified evidence
to operation, deployment axes, subject generation, resource/request digests, Risk epoch, and current time.

Site, Identity, Workspace, and Admin owners must implement `EffectPolicyRepository` without exporting their tables or repository.
Task 4/5 intentionally does not create those aggregates; their migrations and repository adapters arrive with their owner tasks.
