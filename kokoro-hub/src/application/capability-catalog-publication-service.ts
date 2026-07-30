import type {
  CapabilityCatalogSnapshot,
  FrozenCapabilityCatalogPublication,
} from "../domain/capability-catalog.js";
import { canonicalizeCapabilityCatalogSnapshot } from "../domain/capability-catalog.js";
import type {
  CapabilityCatalogAuthority,
  CapabilityCatalogPublicationRecord,
  CapabilityPublicationRepository,
} from "../domain/capability-publication-repository.js";

export class CapabilityCatalogPublicationService {
  readonly #clock: () => Date;

  constructor(private readonly input: Readonly<{
    repository: CapabilityPublicationRepository;
    authority: CapabilityCatalogAuthority;
    signer: Readonly<{
      sign(input: Readonly<{
        siteId: string;
        siteReleaseRef: string;
        snapshot: CapabilityCatalogSnapshot;
        frozenAt: string;
      }>): FrozenCapabilityCatalogPublication;
    }>;
    clock?: () => Date;
  }>) {
    this.#clock = input.clock ?? (() => new Date());
  }

  async freeze(command: Readonly<{
    commandId: string;
    idempotencyKey: string;
    requestDigest: string;
    siteId: string;
    siteReleaseRef: string;
    snapshot: unknown;
  }>): Promise<CapabilityCatalogPublicationRecord> {
    validateCommand(command);
    const replay = await this.input.repository.get({
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      requestDigest: command.requestDigest,
      siteId: command.siteId,
      siteReleaseRef: command.siteReleaseRef,
    });
    if (replay !== null) return replay;
    const snapshot = canonicalizeCapabilityCatalogSnapshot(command.snapshot);
    await this.input.authority.assertCurrent(snapshot);
    const publication = this.input.signer.sign({
      siteId: command.siteId,
      siteReleaseRef: command.siteReleaseRef,
      snapshot,
      frozenAt: this.#instant(),
    });
    return this.input.repository.freeze({
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      requestDigest: command.requestDigest,
      publication,
    });
  }

  get(input: Readonly<{
    commandId: string;
    idempotencyKey: string;
    requestDigest: string;
    siteId: string;
    siteReleaseRef: string;
  }>): Promise<CapabilityCatalogPublicationRecord | null> {
    validateCommand(input);
    return this.input.repository.get(input);
  }

  #instant(): string {
    const value = this.#clock().getTime();
    if (!Number.isFinite(value)) throw new Error("HUB_CAPABILITY_CATALOG_CLOCK_INVALID");
    return new Date(value).toISOString();
  }
}

function validateCommand(input: Readonly<{
  commandId: string;
  idempotencyKey: string;
  requestDigest: string;
  siteId: string;
  siteReleaseRef: string;
}>): void {
  if (!reference(input.commandId, 128) || !reference(input.idempotencyKey, 191) ||
      !/^[a-f0-9]{64}$/u.test(input.requestDigest) || !reference(input.siteId, 128) ||
      !reference(input.siteReleaseRef, 256)) {
    throw new Error("HUB_CAPABILITY_CATALOG_COMMAND_INVALID");
  }
}

function reference(value: string, maximum: number): boolean {
  return value.length >= 1 && value.length <= maximum && value.trim() === value;
}
