import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type {
  CandidateAuthorityBinding,
  ImmutableRevisionBinding,
} from "../../domain/site-publication-authority.js";

export interface SiteActiveReleasePointer {
  readonly siteRef: string;
  readonly environment: string;
  readonly generation: bigint;
  readonly activeRelease: ImmutableRevisionBinding | null;
  readonly authorizationEpoch: bigint;
}
export interface SiteActivationAuthoritySnapshot {
  readonly attemptRef: string;
  readonly phase: "begin" | "pre-cas";
  readonly siteRef: string;
  readonly environment: string;
  readonly candidate: CandidateAuthorityBinding;
  readonly release: ImmutableRevisionBinding;
  readonly certificationRevocationEpoch: bigint;
  readonly producerRegistryHeadDigest: string;
  readonly trustPolicyHeadDigest: string;
  readonly signingKeyHeadDigest: string;
  readonly activePointerGeneration: bigint;
  readonly attemptDigest: string;
  readonly snapshotDigest: string;
  readonly observedAt: string;
}

export interface SiteActivationAuthorityReaderPort {
  read(transaction: PlatformTransaction, input: Readonly<{
    attemptRef: string;
    phase: "begin" | "pre-cas";
    siteRef: string;
    environment: string;
    candidate: CandidateAuthorityBinding;
    release: ImmutableRevisionBinding;
    activePointerGeneration: bigint;
    attemptDigest: string;
  }>): Promise<SiteActivationAuthoritySnapshot>;
}

export interface SiteActivationPointerRepository {
  loadPointerForUpdate(transaction: PlatformTransaction, input: Readonly<{
    siteRef: string; environment: string;
  }>): Promise<SiteActiveReleasePointer>;
  loadSnapshot(transaction: PlatformTransaction, attemptRef: string, phase: "begin" | "pre-cas"):
    Promise<SiteActivationAuthoritySnapshot | null>;
  insertSnapshot(transaction: PlatformTransaction, snapshot: SiteActivationAuthoritySnapshot): Promise<void>;
  commitPointer(transaction: PlatformTransaction, input: Readonly<{
    pointer: SiteActiveReleasePointer;
    release: ImmutableRevisionBinding;
    authorizationEpoch: bigint;
    commandId: string;
    beginSnapshotDigest: string;
    preCasSnapshotDigest: string;
    eligibilityDigest: string;
    evaluatedAt: string;
  }>): Promise<SiteActiveReleasePointer>;
}
