---
architectureIndex: 1
rootId: service.platform.media
owners:
  - "@LordFoxFairy"
---

# Platform Media module

Media owns immutable Operation Definition revisions and the MediaOperation, MediaStep, and MediaCandidate execution projection.
It does not own Provider attempts, Credit facts, Trust decisions, Artifact bytes, or Session projections; those authorities may be
referenced only through typed receipts and opaque references.

The current implementation contains a domain kernel plus an explicit application contract boundary. It preallocates Step and
Candidate identities, enforces the ADR-015 state machines and version fences, keeps cancellation intent distinct from a confirmed
canceled outcome, and exposes one deterministic reducer as the only Operation terminal transition. The reducer requires exact
Gateway outcome, Attempt Usage, EffectBudget, Artifact and Trust receipts; it derives completed/partial/failed/canceled rather than
accepting a caller-selected terminal status. Candidate output facts are continuous across validation, and Artifact finalization is
bound to the exact Candidate with cross-Candidate Artifact identity aliasing rejected.

Every plan creation, transition, and terminal reduction rehydrates a closed runtime shape before evaluating state-machine rules,
so cast or persistence corruption in aggregate identity, version, state, Definition, child, or effect evidence fails closed.
Runtime boundaries snapshot exact own data-property descriptors before validation; accessor properties are never invoked, and dense
arrays reject accessor indexes, holes, custom prototypes, symbols, and extra properties. Validation therefore never continues on a
caller object that can change while it is being read. Dense arrays validate their own length descriptor and domain maximum before
enumerating indexes, then recheck length after copying; Proxy arrays are rejected without invoking traps. Failure and reason
vocabularies are derived from genuinely frozen runtime tuples.
Effect evidence uses one invocation-ownership map across receipt kinds; distinct invocations cannot alias the same identity while
one invocation may still own evidence shared by its preallocated output slots.
Opaque references accept well-formed non-ASCII text but reject malformed UTF-16. Candidate failure arms encode whether Provider
output evidence is mandatory or forbidden, and post-output transitions must carry the exact prior fact. Terminal failure selection
uses frozen Definition Step/slot order and is invariant to caller closure array permutations.

Caller canonical bytes and fingerprints remain owned by the Root contract. `application/contracts/MediaDefinitionCanonicalizer`
is the outbound port for the Root-generated adapter; `canonicalMediaRequest` binds the fingerprint to defensively copied internal
bytes and returns a fresh byte copy on every read. It accepts only plain, internally branded `Uint8Array` values backed by a private
`ArrayBuffer`; Proxy views, subclasses, shared memory, and native copy failures are rejected with a stable domain error. The returned
value uses frozen own properties over a null prototype. The domain defines no serialization, field ordering, hash algorithm, or
golden corpus.

Consumers use only `src/modules/media/index.ts`. That public barrel exposes validating reference/Definition/canonical factories,
the state-machine commands, necessary public types, and persistence rehydrators; descriptor helpers, brands, vocabulary predicates,
and reducer internals remain private.
The image-first application vertical adds a command-journaled Direct Studio submission service and an explicitly leased
worker closure around the existing kernel. Canonical input is stored only as a bounded envelope-encrypted
`OperationInputRevision`; caller SHA-256 fingerprints remain distinct from the Platform owner-keyed digest. The worker
never invokes a provider. It drives the typed Model Gateway image-effect owner through
Create/RecoverByCommand/GetByCommand/GetEvidence/RequestCancel. The owner View never carries output details: the worker
durably advances the immutable `uint64 evidence_sequence` cursor and persists exact outcome/usage/output ref+digest facts.
Output access is issued/recovered by a preallocated command bound to the logical invocation and output evidence, then consumed
by Artifact through the bounded `ReadImageEffectOutput` stream. The worker resumes Artifact staged/Trust/ready, usage,
Agent-child Credit return and Session projection from immutable saga receipts. Direct-root Credit terminalization remains
fail-closed until its dedicated owner is production-composed. Started and outcome-unknown effects recover by exact
command identity; definitely-not-submitted work cannot continue until a distinct planner materializes a new attempt command,
ordinal and EffectBudgetCommit. Root-generated request fingerprints/digests and every Create axis are pre-materialized in the
operation transaction; the worker verifies them and never hashes rotating bearer bytes. Caller, model-option and source-grant
bearer handles remain sealed at rest and are zeroized after use.

`platform-media-worker` also owns a separately leased staged-object cleanup activity. Its deployment inventory remains
inactive until every generated contract and Credit authority listed in `docs/platform/media-worker-launch-blockers.md` is
available; startup fails closed rather than using a
development adapter.

Agent image commands are isolated by the exact opaque access-handle digest that issued them; a different run/session handle
cannot recover or read the operation merely because it resolves to the same subject and project. The command journal freezes
the resolved Definition, model publication, Trust decision, Credit root/parent, parent revision and epoch, consumption scope,
and expiry before child allocation. Commit revalidates those owner facts and the durable Credit reservation receipt rather
than trusting caller JSON.

Media child Credit derivation is a same-process Platform owner operation inside the existing PostgreSQL unit of work. Production
composition fixes this adapter to the native Credit authority; it cannot inject an HTTP/RPC client or start an independent
transaction while the Media transaction is open. GA still sees only opaque Platform receipts and references.

Direct Studio begins with only the verified request's owner transaction scope. Inside that transaction, Admission must lock and
return a complete owner binding containing SiteRelease, Site security/policy/workload, Identity session/restriction, membership,
and authorization epochs. The command digest and encrypted input binding are computed only after that revalidation and also bind
Trust, exact Credit source/ceiling/scope/expiry, and owner-issued handle digests. Direct root reservation and Agent child derivation
are closed, distinct budget-owner capabilities; the Agent runtime composition cannot activate the Direct surface. The generated
public descriptor factory requires all nine Media operations before registration. Production Direct activation remains unavailable
until real Trust admission and every P0 launch authority is supplied in the same unit of work.

Development fakes live under `infrastructure/dev` and advertise `developmentOnly`. They are not production adapters.
