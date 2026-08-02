import { TextEncoder } from "node:util";
import { MemoryApplicationError } from "./memory-application-error.js";
import type { MemoryContentProtectionPort, MemoryPublicCommand, MemoryPublicCommandResult,
  MemoryPublicOperation, MemoryPublicRepository, MemoryPublicUnitOfWork } from
  "./memory-authority-ports.js";
import { memoryEntryRef, memoryRevisionRef, memorySpaceRef } from "../domain/memory-references.js";
import { memoryPublicDerivedRef, memoryPublicPersonalContext,
  type MemoryCommandFingerprintPort, type MemoryContentAdmissionPort,
  type MemoryPublicPersonalContext } from
  "../domain/memory-public.js";

export class MemoryPublicOwner {
  constructor(private readonly dependencies: Readonly<{
    admission: MemoryContentAdmissionPort;
    fingerprints: MemoryCommandFingerprintPort;
    protector: MemoryContentProtectionPort;
    repository: MemoryPublicRepository;
    unitOfWork: MemoryPublicUnitOfWork;
    clock?: () => Date;
  }>) {}

  async remember(input: Readonly<{ context: MemoryPublicPersonalContext; commandRef: string;
    category: "profile" | "preference" | "fact"; content: string;
    validFrom: string | null; validTo: string | null }>): Promise<MemoryPublicCommandResult> {
    const context = personal(input.context);
    const validity = temporalValidity(input.validFrom, input.validTo);
    const entryRef = memoryPublicDerivedRef("entry", context, input.commandRef);
    const revisionRef = memoryPublicDerivedRef("revision", context, input.commandRef);
    const spaceRef = memoryPublicDerivedRef("space", context, "owner");
    const fields = { category: input.category, content: input.content,
      validFrom: validity.validFrom, validTo: validity.validTo } as const;
    const recovered = await this.#recover("remember", context, input.commandRef, spaceRef,
      entryRef, revisionRef, fields);
    if (recovered.result !== null) return recovered.result;
    const fingerprint = recovered.fingerprint;
    const content = await this.#admit(input.category, input.content);
    const protectedContent = await this.dependencies.protector.protect({ binding: {
      siteRef: context.siteRef, spaceRef: memorySpaceRef(spaceRef),
      entryRef: memoryEntryRef(entryRef), revisionRef: memoryRevisionRef(revisionRef),
    }, plaintext: content });
    return this.#execute({ operation: "remember", context, commandRef: input.commandRef,
      requestDigest: fingerprint.digest, requestDigestKeyRevision: fingerprint.keyRevision,
      ...recovered.payloadProof,
      spaceRef, entryRef, revisionRef,
      provenanceRef: memoryPublicDerivedRef("provenance", context, input.commandRef),
      category: input.category, protectedContent, validFrom: validity.validFrom,
      validTo: validity.validTo,
      recordedAt: this.#now() });
  }

  async correct(input: Readonly<{ context: MemoryPublicPersonalContext; commandRef: string;
    entryRef: string; expectedRevision: number; content: string;
    validFrom: string | null; validTo: string | null }>): Promise<MemoryPublicCommandResult> {
    const context = personal(input.context);
    const expectedRevision = boundedRevision(input.expectedRevision);
    const validity = temporalValidity(input.validFrom, input.validTo);
    const revisionRef = memoryPublicDerivedRef("revision", context, input.commandRef);
    const spaceRef = memoryPublicDerivedRef("space", context, "owner");
    const fields = { entryRef: input.entryRef, expectedRevision, content: input.content,
      validFrom: validity.validFrom, validTo: validity.validTo } as const;
    const recovered = await this.#recover("correct", context, input.commandRef, spaceRef,
      input.entryRef, revisionRef, fields);
    if (recovered.result !== null) return recovered.result;
    const fingerprint = recovered.fingerprint;
    const current = await this.#currentEntry(context, input.entryRef);
    if (current.entry.revision !== BigInt(expectedRevision)) {
      throw new MemoryApplicationError("MEMORY_PUBLIC_VERSION_CONFLICT");
    }
    const content = await this.#admit(current.entry.category, input.content);
    const protectedContent = await this.dependencies.protector.protect({ binding: {
      siteRef: context.siteRef, spaceRef: memorySpaceRef(spaceRef),
      entryRef: memoryEntryRef(input.entryRef), revisionRef: memoryRevisionRef(revisionRef),
    }, plaintext: content });
    return this.#execute({ operation: "correct", context, commandRef: input.commandRef,
      requestDigest: fingerprint.digest, requestDigestKeyRevision: fingerprint.keyRevision,
      ...recovered.payloadProof,
      spaceRef, entryRef: input.entryRef,
      revisionRef, provenanceRef: memoryPublicDerivedRef("provenance", context, input.commandRef),
      protectedContent, expectedRevision, validFrom: validity.validFrom,
      validTo: validity.validTo, recordedAt: this.#now() });
  }

  async restore(input: Readonly<{ context: MemoryPublicPersonalContext; commandRef: string;
    entryRef: string; revisionRef: string; expectedRevision: number }> ):
    Promise<MemoryPublicCommandResult> {
    const context = personal(input.context);
    const expectedRevision = boundedRevision(input.expectedRevision);
    const nextRevisionRef = memoryPublicDerivedRef("revision", context, input.commandRef);
    const candidateSpaceRef = memoryPublicDerivedRef("space", context, "owner");
    const fields = { entryRef: input.entryRef, revisionRef: input.revisionRef,
      expectedRevision } as const;
    const recovered = await this.#recover("restore", context, input.commandRef, candidateSpaceRef,
      input.entryRef, input.revisionRef, fields);
    if (recovered.result !== null) return recovered.result;
    const fingerprint = recovered.fingerprint;
    const { owner, entry, historical } = await this.#restoreSource(context, input.entryRef,
      input.revisionRef, expectedRevision);
    if (historical.protectedContent === null) {
      throw new MemoryApplicationError("MEMORY_PUBLIC_NOT_RESTORABLE");
    }
    let protectedContent;
    {
      const plaintext = await this.dependencies.protector.reveal({ binding: {
        siteRef: context.siteRef, spaceRef: memorySpaceRef(owner.spaceRef),
        entryRef: memoryEntryRef(input.entryRef), revisionRef: memoryRevisionRef(input.revisionRef),
      }, protectedContent: historical.protectedContent });
      const text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      await this.#admit(entry.category, text);
      protectedContent = await this.dependencies.protector.protect({ binding: {
        siteRef: context.siteRef, spaceRef: memorySpaceRef(owner.spaceRef),
        entryRef: memoryEntryRef(input.entryRef), revisionRef: memoryRevisionRef(nextRevisionRef),
      }, plaintext: new TextEncoder().encode(text) });
    }
    const validity = temporalValidity(historical.validFrom, historical.validTo);
    return this.#execute({ operation: "restore", context, commandRef: input.commandRef,
      requestDigest: fingerprint.digest, requestDigestKeyRevision: fingerprint.keyRevision,
      ...recovered.payloadProof,
      spaceRef: owner.spaceRef, entryRef: input.entryRef, revisionRef: nextRevisionRef,
      provenanceRef: memoryPublicDerivedRef("provenance", context, input.commandRef),
      restoredFromRevisionRef: input.revisionRef, expectedRevision,
      validFrom: validity.validFrom, validTo: validity.validTo,
      ...(protectedContent === undefined ? {} : { protectedContent }), recordedAt: this.#now() });
  }

  async setPriority(input: Readonly<{ context: MemoryPublicPersonalContext; commandRef: string;
    entryRef: string; expectedEntryVersion: bigint; prioritized: boolean }>):
    Promise<MemoryPublicCommandResult> {
    const context = personal(input.context);
    const spaceRef = memoryPublicDerivedRef("space", context, "owner");
    const fields = {
      entryRef: input.entryRef, expectedEntryVersion: input.expectedEntryVersion,
      prioritized: input.prioritized } as const;
    const operation = input.prioritized ? "prioritize" : "deprioritize";
    const recovered = await this.#recover(operation, context, input.commandRef, spaceRef,
      input.entryRef, null, fields, "priority");
    if (recovered.result !== null) return recovered.result;
    const fingerprint = recovered.fingerprint;
    return this.#execute({ operation, context,
      commandRef: input.commandRef, requestDigest: fingerprint.digest,
      requestDigestKeyRevision: fingerprint.keyRevision,
      ...recovered.payloadProof,
      spaceRef, entryRef: input.entryRef, revisionRef: null,
      expectedEntryVersion: input.expectedEntryVersion, prioritized: input.prioritized,
      recordedAt: this.#now() });
  }

  async forget(input: Readonly<{ context: MemoryPublicPersonalContext; commandRef: string;
    entryRef: string; expectedEntryVersion: bigint }>): Promise<MemoryPublicCommandResult> {
    const context = personal(input.context);
    const spaceRef = memoryPublicDerivedRef("space", context, "owner");
    const fields = { entryRef: input.entryRef,
      expectedEntryVersion: input.expectedEntryVersion } as const;
    const recovered = await this.#recover("forget", context, input.commandRef, spaceRef,
      input.entryRef, null, fields);
    if (recovered.result !== null) return recovered.result;
    const fingerprint = recovered.fingerprint;
    return this.#execute({ operation: "forget", context, commandRef: input.commandRef,
      requestDigest: fingerprint.digest, requestDigestKeyRevision: fingerprint.keyRevision,
      ...recovered.payloadProof,
      spaceRef, entryRef: input.entryRef,
      revisionRef: null, expectedEntryVersion: input.expectedEntryVersion, recordedAt: this.#now() });
  }

  async reset(input: Readonly<{ context: MemoryPublicPersonalContext; commandRef: string }> ):
    Promise<MemoryPublicCommandResult> {
    const context = personal(input.context);
    const spaceRef = memoryPublicDerivedRef("space", context, "owner");
    const recovered = await this.#recover("reset", context, input.commandRef, spaceRef,
      null, null, {});
    if (recovered.result !== null) return recovered.result;
    const fingerprint = recovered.fingerprint;
    return this.#execute({ operation: "reset", context, commandRef: input.commandRef,
      requestDigest: fingerprint.digest, requestDigestKeyRevision: fingerprint.keyRevision,
      ...recovered.payloadProof,
      spaceRef, entryRef: null, revisionRef: null,
      recordedAt: this.#now() });
  }

  async #execute(command: MemoryPublicCommand): Promise<MemoryPublicCommandResult> {
    return this.dependencies.unitOfWork.execute({ operation: `memory.${command.operation}` },
      (transaction) => this.dependencies.repository.executeCommand(transaction, command));
  }

  async #recover(operation: MemoryPublicOperation, context: MemoryPublicPersonalContext,
    commandRef: string, spaceRef: string, entryRef: string | null, revisionRef: string | null,
    fields: Readonly<Record<string, string | number | bigint | boolean | null>>,
    fingerprintOperation: string = operation): Promise<Readonly<{
      fingerprint: Readonly<{ keyRevision: string; digest: string }>;
      payloadProof: Readonly<{ requestPayloadKeyRevision: string; requestPayloadDigest: string }>;
      result: MemoryPublicCommandResult | null;
    }>> {
    const identity = { operation, context, commandRef, spaceRef, entryRef, revisionRef,
      fingerprintInput: Object.freeze({ operation: fingerprintOperation, fields }) } as const;
    const recovery = await this.dependencies.unitOfWork.execute(
      { operation: `memory.${operation}.recover` },
      (transaction) => this.dependencies.repository.recoverCommand(transaction, identity));
    if (recovery.kind === "payload_conflict") {
      throw new MemoryApplicationError("MEMORY_COMMAND_DIGEST_CONFLICT");
    }
    if (recovery.kind === "replay") {
      return Object.freeze({ fingerprint: Object.freeze({ keyRevision: "replayed", digest: "0".repeat(64) }),
        payloadProof: Object.freeze({ requestPayloadKeyRevision: "replayed",
          requestPayloadDigest: "0".repeat(64) }),
        result: Object.freeze({ ...recovery.result, replayed: true }) });
    }
    const payloadProof = Object.freeze({
      requestPayloadKeyRevision: recovery.requestPayloadKeyRevision,
      requestPayloadDigest: recovery.requestPayloadDigest,
    });
    let fingerprint = await this.#fingerprint(fingerprintOperation, fields);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const claimed = await this.dependencies.unitOfWork.execute(
        { operation: `memory.${operation}.claim` },
        (transaction) => this.dependencies.repository.claimCommand(transaction, {
          ...identity, requestDigest: fingerprint.digest,
          requestDigestKeyRevision: fingerprint.keyRevision, ...payloadProof,
        }));
      if (claimed.kind === "continue") {
        return Object.freeze({ fingerprint, payloadProof, result: null });
      }
      if (claimed.kind === "replay") {
        return Object.freeze({ fingerprint, payloadProof,
          result: Object.freeze({ ...claimed.result, replayed: true }) });
      }
      if (claimed.kind === "payload_conflict") {
        throw new MemoryApplicationError("MEMORY_COMMAND_DIGEST_CONFLICT");
      }
      if (attempt !== 0 || claimed.requestDigestKeyRevision === fingerprint.keyRevision) {
        throw new MemoryApplicationError("MEMORY_COMMAND_DIGEST_CONFLICT");
      }
      fingerprint = await this.#fingerprint(fingerprintOperation, fields,
        claimed.requestDigestKeyRevision);
    }
    throw new MemoryApplicationError("MEMORY_COMMAND_DIGEST_CONFLICT");
  }

  async #currentEntry(context: MemoryPublicPersonalContext, entryRef: string) {
    return this.dependencies.unitOfWork.execute({ operation: "memory.correct.read" },
      async (transaction) => {
        const owner = await this.dependencies.repository.resolveOwner(transaction, {
          context, operation: "get_entry", now: this.#now(),
          candidateSpaceRef: memoryPublicDerivedRef("space", context, "owner"),
        });
        if (owner === null) throw new MemoryApplicationError("MEMORY_PUBLIC_NOT_AVAILABLE");
        const entry = await this.dependencies.repository.getEntry(transaction, { owner, entryRef });
        if (entry === null || entry.state !== "active") {
          throw new MemoryApplicationError("MEMORY_PUBLIC_NOT_AVAILABLE");
        }
        return Object.freeze({ owner, entry });
      });
  }

  async #restoreSource(context: MemoryPublicPersonalContext, entryRef: string,
    revisionRef: string, expectedRevision: number) {
    return this.dependencies.unitOfWork.execute({ operation: "memory.restore.read" },
      async (transaction) => {
        const owner = await this.dependencies.repository.resolveOwner(transaction, {
          context, operation: "restore", now: this.#now(),
          candidateSpaceRef: memoryPublicDerivedRef("space", context, "owner"),
        });
        if (owner === null) throw new MemoryApplicationError("MEMORY_PUBLIC_NOT_AVAILABLE");
        const [entry, historical] = await Promise.all([
          this.dependencies.repository.getEntry(transaction, { owner, entryRef }),
          this.dependencies.repository.getRevisionForRestore === undefined ? Promise.resolve(null) :
            this.dependencies.repository.getRevisionForRestore(transaction, {
              owner, entryRef, revisionRef, expectedRevision,
            }),
        ]);
        if (entry === null || entry.state !== "active" || entry.revision !== BigInt(expectedRevision) ||
          historical === null || historical.revision >= entry.revision ||
          historical.protectedContent === null) {
          throw new MemoryApplicationError("MEMORY_PUBLIC_NOT_RESTORABLE");
        }
        return Object.freeze({ owner, entry, historical });
      });
  }

  async #admit(category: "profile" | "preference" | "fact", content: string): Promise<Uint8Array> {
    const result = await this.dependencies.admission.admit({ category, content });
    if (result.kind !== "accepted") throw new MemoryApplicationError("MEMORY_CONTENT_POLICY_REJECTED");
    return new TextEncoder().encode(content);
  }

  async #fingerprint(operation: string,
    fields: Readonly<Record<string, string | number | bigint | boolean | null>>,
    keyRevision?: string) {
    const value = await this.dependencies.fingerprints.fingerprint({ operation, fields }, keyRevision);
    if (keyRevision !== undefined && value.keyRevision !== keyRevision) {
      throw new MemoryApplicationError("MEMORY_COMMAND_DIGEST_CONFLICT");
    }
    if (typeof value.keyRevision !== "string" || value.keyRevision.length < 3 ||
      value.keyRevision.length > 128 || !/^[a-f0-9]{64}$/u.test(value.digest)) {
      throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
    }
    return value;
  }

  #now(): string {
    const value = (this.dependencies.clock ?? (() => new Date()))();
    if (!Number.isFinite(value.getTime())) throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
    return value.toISOString();
  }
}

function personal(value: unknown): MemoryPublicPersonalContext {
  try { return memoryPublicPersonalContext(value); } catch {
    throw new MemoryApplicationError("MEMORY_PUBLIC_SCOPE_UNAVAILABLE");
  }
}
function boundedRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new MemoryApplicationError("MEMORY_PUBLIC_VERSION_CONFLICT");
  }
  return value;
}
function temporalValidity(validFrom: unknown, validTo: unknown): Readonly<{
  validFrom: string | null; validTo: string | null;
}> {
  const from = exactNullableInstant(validFrom);
  const to = exactNullableInstant(validTo);
  if (from !== null && to !== null && new Date(to).getTime() <= new Date(from).getTime()) {
    throw new MemoryApplicationError("MEMORY_PUBLIC_INPUT_INVALID");
  }
  return Object.freeze({ validFrom: from, validTo: to });
}
function exactNullableInstant(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new MemoryApplicationError("MEMORY_PUBLIC_INPUT_INVALID");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new MemoryApplicationError("MEMORY_PUBLIC_INPUT_INVALID");
  }
  return value;
}
