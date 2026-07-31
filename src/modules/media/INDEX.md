---
architectureIndex: 1
rootId: service.platform.media
owners: ["Platform Media"]
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
and reducer internals remain private. Until owner infrastructure lands, this module exposes no database schema, RPC/HTTP handler,
Provider adapter, worker, or runtime capability.
