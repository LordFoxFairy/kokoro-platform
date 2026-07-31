# Media worker launch blockers

`platform-media-worker` is present in the deployment inventory with `activationAuthorized: false`.
Its PostgreSQL lease, saga receipt, dead-letter and staged-cleanup authorities are implemented, but the
process intentionally fails before opening PostgreSQL until all seven production authorities exist:

1. Model Gateway image-effect ConnectRPC generated client for Create, RecoverImageEffectByCommand,
   GetImageEffectByCommand, GetImageEffectEvidence and RequestCancelImageEffect. `accepted` means only Gateway
   journal/outbox commit. The adapter must use the Root `createImageEffectRequestDigest` and
   `imageEffectCommandReceiptDigest` helpers; Platform does not maintain a second JSON hash.
2. Purpose-bound capability envelope opener for the caller-access and model-option bearer handles.
   Bearers remain encrypted at rest and are zeroized after the RPC attempt.
3. Generated `IssueImageEffectOutputAccess`, `RecoverImageEffectOutputAccessByCommand` and bounded
   `ReadImageEffectOutput` client composition over the same Model Gateway ImageEffect boundary. Ordinary owner
   views contain no outputs. Media first durably pages
   immutable evidence by `uint64 evidence_sequence`, then binds output access to the exact logical invocation and
   output evidence ref/digest. The short-lived source capability remains inside the generated adapter; Media never
   persists it, raw provider responses, or image bytes.
4. Session terminal projection client with idempotent receipt recovery.
5. Root-generated canonical Artifact-finalization and Media-terminal receipt helpers/golden corpus.
6. The Root-owned EffectBudgetCommit issuer contract and its Platform-owned durable materializer. Every attempt must
   arrive with the exact Credit `attemptAuthorizationRef`, live `attemptAuthorizationFenceEpoch`, canonical
   `attemptAuthorizationDigest`, issuer key revision, signed receipt envelope and signed receipt digest. The persisted
   commit must bind Site, caller, model option/deployment, invocation command, attempt ordinal, operation-input revision
   and logical output slots. Neither the Media worker nor Model Gateway may late-prepare an attempt, reuse a root
   Segment for an Agent child, self-sign a commit, or infer missing authority.
7. Credit's direct-root terminal authority and the native production Media composition. The Credit owner must lock the
   exact root allocation/root/Hold in the canonical order, prove no child/Segment/attempt work remains, terminal the
   allocation and root, capture the rated amount, release the exact remainder to the original Hold sources, write a
   balanced journal and an idempotent closure receipt, and move ambiguous states to reconciliation. Until that owner is
   composed, public Studio direct-root operations remain unavailable; an injected mock or a partial Hold update is not
   a launch substitute.

`AttachNextAttemptAuthorization` requires a separate durable next-attempt materializer owned by Media/Credit/Model:
a new attempt command,
strictly increasing ordinal, new EffectBudgetCommit, model-option authorization capability, and the exact
definitely-not-submitted owner evidence. V1 therefore records DNS and enters reconciliation; it never reuses
the old command, budget commit, or bearer.

The landed Credit-owned finalizer resolves one exact immutable Model Gateway usage fact under the live Media task lease,
finalizes its pre-issued attempt, settles the exact authorization Segment, and returns an Agent Media child allocation
using fresh parent/child revision and epoch fences. A canceled-before-effect operation may close an empty evidence set;
every other terminal outcome requires a certified attempt fact. Usage-unavailable or ambiguous authority enters
reconciliation and never invents zero usage. Direct-root closure is deliberately only a required owner port until blocker
7 is implemented.

The current application composition accepts only production adapters, rejects every `developmentOnly`
adapter, and can resume Gateway, Artifact staged/Trust/ready, usage, child Credit return, and Session projection from
durable receipts after the missing production contracts are composed. Artifact staging uses the private `s3-object-api` selected by the trusted
`PLATFORM_ARTIFACT_STORAGE_ROUTE_FILE`; it is not a second Artifact-source RPC service. Turning on the deployable
before the blockers above are supplied is prohibited.
