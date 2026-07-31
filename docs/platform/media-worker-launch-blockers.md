# Media worker launch blockers

`platform-media-worker` is present in the deployment inventory with `activationAuthorized: false`.
Its PostgreSQL lease, saga receipt, dead-letter and staged-cleanup authorities are implemented, but the
process intentionally fails before opening PostgreSQL until all five Root-owned generated boundaries exist:

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

`AttachNextAttemptAuthorization` requires a separate durable next-attempt materializer owned by Media/Credit/Model:
a new attempt command,
strictly increasing ordinal, new EffectBudgetCommit, model-option authorization capability, and the exact
definitely-not-submitted owner evidence. V1 therefore records DNS and enters reconciliation; it never reuses
the old command, budget commit, or bearer.

The current application composition accepts only production adapters, rejects every `developmentOnly`
adapter, and resumes Gateway, Artifact staged/Trust/ready, usage, Credit return, and Session projection from
durable receipts. Artifact staging uses the private `s3-object-api` selected by the trusted
`PLATFORM_ARTIFACT_STORAGE_ROUTE_FILE`; it is not a second Artifact-source RPC service. Turning on the deployable
before the blockers above are supplied is prohibited.
