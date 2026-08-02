import { MemoryApplicationError } from "./memory-application-error.js";
import type { MemoryContentProtectionPort, MemoryPublicCursor, MemoryPublicCursorCodec,
  MemoryPublicEntryRecord, MemoryPublicRepository, MemoryPublicResolvedOwner,
  MemoryPublicRevisionRecord, MemoryPublicUnitOfWork } from "./memory-authority-ports.js";
import { MEMORY_PUBLIC_MAX_RESPONSE_UTF8_BYTES, MEMORY_PUBLIC_SNAPSHOT_TTL_MS,
  memoryPublicDerivedRef, memoryPublicPersonalContext, type MemoryPublicPersonalContext } from
  "../domain/memory-public.js";
import { memoryEntryRef, memoryRevisionRef, memorySpaceRef } from "../domain/memory-references.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type MemoryPublicEntryView = Readonly<Record<string, unknown> & { entryRef: string;
  state: "active" | "revoked_purge_pending" | "purged" }>;
type MemoryPublicRevisionView = Readonly<Record<string, unknown> & { revision: number;
  revisionRef: string; state: "available" | "purged" }>;

export class MemoryPublicReadOwner {
  constructor(private readonly dependencies: Readonly<{
    repository: MemoryPublicRepository;
    protector: MemoryContentProtectionPort;
    cursors: MemoryPublicCursorCodec;
    unitOfWork: MemoryPublicUnitOfWork;
    clock?: () => Date;
    reference?: () => string;
  }>) {}

  async list(input: Readonly<{ context: MemoryPublicPersonalContext;
    category?: "profile" | "preference" | "fact"; source?: "explicit" | "import";
    cursor?: string; limit?: number }>) {
    const context = personal(input.context);
    const now = this.#now();
    const limit = boundedLimit(input.limit);
    const category = input.category ?? null;
    const source = input.source ?? null;
    const filter = activeFilter(category, source);
    const cursor = input.cursor === undefined ? null : this.#cursor(input.cursor, {
      kind: "entries", context, filter, order: "priority_updated_entry_desc",
    }, now);
    return this.dependencies.unitOfWork.execute({ operation: "memory.list" }, async (transaction) => {
      const owner = await this.#owner(transaction, context, "list_entries", now);
      assertCurrentSnapshot(owner, cursor);
      const rows = await this.dependencies.repository.listEntries(transaction, { owner,
        category: filter.category, source: filter.source,
        after: cursor === null ? null : { prioritized: requiredBoolean(cursor.prioritized),
          updatedAt: requiredString(cursor.updatedAt), entryRef: cursor.entryRef }, limit: limit + 1 });
      assertEntryRows(rows, filter.category, filter.source);
      const snapshotRef = cursor?.snapshotRef ?? this.#reference();
      const expiresAt = cursor?.expiresAt ?? new Date(new Date(now).getTime() +
        MEMORY_PUBLIC_SNAPSHOT_TTL_MS).toISOString();
      return this.#boundedEntries(owner, rows, limit, filter, snapshotRef, expiresAt);
    });
  }

  async get(input: Readonly<{ context: MemoryPublicPersonalContext; entryRef: string }>) {
    const context = personal(input.context);
    const now = this.#now();
    return this.dependencies.unitOfWork.execute({ operation: "memory.get" }, async (transaction) => {
      const owner = await this.#owner(transaction, context, "get_entry", now);
      const row = await this.dependencies.repository.getEntry(transaction, {
        owner, entryRef: reference(input.entryRef),
      });
      if (row === null) throw new MemoryApplicationError("MEMORY_PUBLIC_NOT_AVAILABLE");
      return Object.freeze({ entry: await this.#entryView(owner, row),
        observedSpaceVersion: owner.spaceVersion });
    });
  }

  async history(input: Readonly<{ context: MemoryPublicPersonalContext; entryRef: string;
    cursor?: string; limit?: number }>) {
    const context = personal(input.context);
    const entryRef = reference(input.entryRef);
    const now = this.#now();
    const limit = boundedLimit(input.limit);
    const filter = activeFilter(null, null);
    const cursor = input.cursor === undefined ? null : this.#cursor(input.cursor, {
      kind: "history", context, filter, order: "revision_desc", entryRef,
    }, now);
    return this.dependencies.unitOfWork.execute({ operation: "memory.history" }, async (transaction) => {
      const owner = await this.#owner(transaction, context, "list_history", now);
      assertCurrentSnapshot(owner, cursor);
      const page = await this.dependencies.repository.listHistory(transaction, { owner, entryRef,
        revisionBefore: cursor?.revision ?? null, limit: limit + 1 });
      if (page === null) throw new MemoryApplicationError("MEMORY_PUBLIC_NOT_AVAILABLE");
      assertRevisionRows(page.revisions, cursor?.revision ?? null);
      const snapshotRef = cursor?.snapshotRef ?? this.#reference();
      const expiresAt = cursor?.expiresAt ?? new Date(new Date(now).getTime() +
        MEMORY_PUBLIC_SNAPSHOT_TTL_MS).toISOString();
      return this.#boundedRevisions(owner, page.entry, page.revisions, limit, filter, snapshotRef,
        expiresAt);
    });
  }

  async #boundedEntries(owner: MemoryPublicResolvedOwner, rows: readonly MemoryPublicEntryRecord[],
    limit: number, filter: MemoryPublicCursor["filter"], snapshotRef: string, expiresAt: string) {
    const candidates: Array<Readonly<{
      record: MemoryPublicEntryRecord; view: MemoryPublicEntryView;
    }>> = [];
    for (const row of rows.slice(0, limit)) {
      candidates.push(Object.freeze({ record: row, view: await this.#entryView(owner, row) }));
    }
    for (let count = candidates.length; count >= (rows.length === 0 ? 0 : 1); count -= 1) {
      const visible = candidates.slice(0, count);
      const hasMore = rows.length > count;
      const last = visible.at(-1)?.record;
      const nextCursor = hasMore && last !== undefined
        ? this.dependencies.cursors.encode({ kind: "entries", context: owner.context, filter,
          order: "priority_updated_entry_desc", spaceVersion: owner.spaceVersion, snapshotRef,
          prioritized: last.prioritized, updatedAt: last.updatedAt, entryRef: last.entryRef,
          expiresAt }) : null;
      const response = Object.freeze({ items: visible.map(({ view }) => view),
        ownerSnapshot: Object.freeze({ snapshotRef, spaceVersion: owner.spaceVersion }),
        pageInfo: Object.freeze({ hasMore, nextCursor }) });
      if (encodedBytes(response) <= MEMORY_PUBLIC_MAX_RESPONSE_UTF8_BYTES) return response;
    }
    throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
  }

  async #boundedRevisions(owner: MemoryPublicResolvedOwner, entry: MemoryPublicEntryRecord,
    rows: readonly MemoryPublicRevisionRecord[], limit: number, filter: MemoryPublicCursor["filter"],
    snapshotRef: string, expiresAt: string) {
    const candidates: Array<Readonly<{
      record: MemoryPublicRevisionRecord; view: MemoryPublicRevisionView;
    }>> = [];
    for (const row of rows.slice(0, limit)) {
      const view = await this.#revisionView(owner, entry.entryRef, row);
      candidates.push(Object.freeze({ record: row, view }));
    }
    for (let count = candidates.length; count >= (rows.length === 0 ? 0 : 1); count -= 1) {
      const visible = candidates.slice(0, count);
      const hasMore = rows.length > count;
      const last = visible.at(-1)?.record;
      const nextCursor = hasMore && last !== undefined
        ? this.dependencies.cursors.encode({ kind: "history", context: owner.context, filter,
          order: "revision_desc", spaceVersion: owner.spaceVersion, snapshotRef,
          entryRef: entry.entryRef, revision: last.revision, expiresAt }) : null;
      const response = Object.freeze({ entryRef: entry.entryRef,
        items: visible.map(({ view }) => view),
        ownerSnapshot: Object.freeze({ snapshotRef, spaceVersion: owner.spaceVersion }),
        pageInfo: Object.freeze({ hasMore, nextCursor }) });
      if (encodedBytes(response) <= MEMORY_PUBLIC_MAX_RESPONSE_UTF8_BYTES) return response;
    }
    throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
  }

  async #entryView(owner: MemoryPublicResolvedOwner, row: MemoryPublicEntryRecord):
    Promise<MemoryPublicEntryView> {
    if (row.state === "revoked_purge_pending") {
      if (row.purgeReceiptRef === undefined || row.revokedAt === undefined ||
        row.purgedAt !== undefined || !isExactInstant(row.revokedAt)) {
        throw new MemoryApplicationError("MEMORY_PUBLIC_NOT_AVAILABLE");
      }
      return Object.freeze({ entryRef: row.entryRef, state: "revoked_purge_pending" as const,
        purgeReceiptRef: publicReference(row.purgeReceiptRef), revokedAt: row.revokedAt });
    }
    if (row.state === "purged") {
      if (row.purgeReceiptRef === undefined || row.purgedAt === undefined ||
        row.revokedAt !== undefined || !isExactInstant(row.purgedAt)) {
        throw new MemoryApplicationError("MEMORY_PUBLIC_NOT_AVAILABLE");
      }
      return Object.freeze({ entryRef: row.entryRef, state: "purged" as const,
        purgeReceiptRef: publicReference(row.purgeReceiptRef), purgedAt: row.purgedAt });
    }
    if (row.protectedContent === null) throw new MemoryApplicationError("MEMORY_PUBLIC_NOT_AVAILABLE");
    const plaintext = await this.dependencies.protector.reveal({ binding: {
      siteRef: owner.context.siteRef, spaceRef: memorySpaceRef(owner.spaceRef),
      entryRef: memoryEntryRef(row.entryRef), revisionRef: memoryRevisionRef(row.currentRevisionRef),
    }, protectedContent: row.protectedContent });
    const content = decodeContent(plaintext);
    return Object.freeze({ entryRef: row.entryRef, entryVersion: row.entryVersion,
      state: "active" as const, scopeKind: "user" as const, category: row.category, content,
      prioritized: row.prioritized, revision: Number(row.revision),
      currentRevisionRef: row.currentRevisionRef, validFrom: row.validFrom, validTo: row.validTo,
      source: Object.freeze({ sourceKind: row.sourceKind, state: row.sourceState,
        safeLabel: row.safeSourceLabel }), createdAt: row.createdAt, updatedAt: row.updatedAt });
  }

  async #revisionView(owner: MemoryPublicResolvedOwner, entryRef: string,
    row: MemoryPublicRevisionRecord): Promise<MemoryPublicRevisionView> {
    const base = { revision: Number(row.revision), revisionRef: row.revisionRef,
      reason: row.reason, recordedAt: row.recordedAt };
    if (row.protectedContent === null) return Object.freeze({ ...base, state: "purged" as const,
      restorable: false as const });
    const plaintext = await this.dependencies.protector.reveal({ binding: {
      siteRef: owner.context.siteRef, spaceRef: memorySpaceRef(owner.spaceRef),
      entryRef: memoryEntryRef(entryRef), revisionRef: memoryRevisionRef(row.revisionRef),
    }, protectedContent: row.protectedContent });
    return Object.freeze({ ...base, state: "available" as const, restorable: true,
      content: decodeContent(plaintext), supersedesRevisionRef: row.supersedesRevisionRef,
      validFrom: row.validFrom, validTo: row.validTo });
  }

  async #owner(transaction: Parameters<MemoryPublicRepository["resolveOwner"]>[0],
    context: MemoryPublicPersonalContext,
    operation: Parameters<MemoryPublicRepository["resolveOwner"]>[1]["operation"], now: string) {
    const owner = await this.dependencies.repository.resolveOwner(transaction, { context, operation, now,
      candidateSpaceRef: memoryPublicDerivedRef("space", context, "owner") });
    if (owner === null) throw new MemoryApplicationError("MEMORY_PUBLIC_NOT_AVAILABLE");
    return owner;
  }

  #cursor(value: string, expected: Omit<MemoryPublicCursor, "spaceVersion" | "snapshotRef" |
    "prioritized" | "updatedAt" | "revision" | "expiresAt" | "entryRef"> &
    Readonly<{ entryRef?: string }>, now: string): MemoryPublicCursor {
    let cursor: MemoryPublicCursor;
    try { cursor = this.dependencies.cursors.decode(value); } catch {
      throw new MemoryApplicationError("MEMORY_PAGE_CURSOR_INVALID");
    }
    if (cursor.kind !== expected.kind || !sameContext(cursor.context, expected.context) ||
      !sameFilter(cursor.filter, expected.filter) ||
      cursor.order !== expected.order || (expected.entryRef !== undefined &&
        cursor.entryRef !== expected.entryRef) || new Date(cursor.expiresAt).getTime() <= new Date(now).getTime()) {
      throw new MemoryApplicationError("MEMORY_PAGE_CURSOR_INVALID");
    }
    return cursor;
  }

  #now(): string {
    const value = (this.dependencies.clock ?? (() => new Date()))();
    if (!Number.isFinite(value.getTime())) throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
    return value.toISOString();
  }
  #reference(): string { return reference((this.dependencies.reference ?? (() => crypto.randomUUID()))()); }
}

function assertCurrentSnapshot(owner: MemoryPublicResolvedOwner, cursor: MemoryPublicCursor | null) {
  if (cursor !== null && cursor.spaceVersion !== owner.spaceVersion) {
    throw new MemoryApplicationError("MEMORY_OWNER_SNAPSHOT_STALE");
  }
}
function assertEntryRows(rows: readonly MemoryPublicEntryRecord[], category: string | null,
  source: string | null) {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.state !== "active" || (category !== null && row.category !== category) ||
      (source !== null && row.sourceKind !== source)) throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
    const previous = rows[index - 1];
    if (previous !== undefined && compareEntry(previous, row) >= 0) {
      throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
    }
  }
}
function compareEntry(left: MemoryPublicEntryRecord, right: MemoryPublicEntryRecord): number {
  if (left.prioritized !== right.prioritized) return left.prioritized ? -1 : 1;
  if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? -1 : 1;
  return left.entryRef > right.entryRef ? -1 : left.entryRef === right.entryRef ? 0 : 1;
}
function assertRevisionRows(rows: readonly MemoryPublicRevisionRecord[], before: bigint | null) {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if ((before !== null && row.revision >= before) ||
      (index > 0 && rows[index - 1]!.revision <= row.revision)) {
      throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
    }
  }
}
function boundedLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new MemoryApplicationError("MEMORY_PAGE_CURSOR_INVALID");
  }
  return limit;
}
function personal(value: unknown): MemoryPublicPersonalContext {
  try { return memoryPublicPersonalContext(value); } catch {
    throw new MemoryApplicationError("MEMORY_PUBLIC_SCOPE_UNAVAILABLE");
  }
}
function sameContext(left: MemoryPublicPersonalContext, right: MemoryPublicPersonalContext): boolean {
  return left.siteRef === right.siteRef && left.subjectRef === right.subjectRef &&
    left.subjectGeneration === right.subjectGeneration &&
    left.featurePolicyRevisionRef === right.featurePolicyRevisionRef;
}
function activeFilter(category: MemoryPublicCursor["filter"]["category"],
  source: MemoryPublicCursor["filter"]["source"]): MemoryPublicCursor["filter"] {
  return Object.freeze({ state: "active", category, source });
}
function sameFilter(value: unknown, expected: MemoryPublicCursor["filter"]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return Object.keys(record).length === 3 && record.state === "active" &&
    record.category === expected.category && record.source === expected.source;
}
function reference(value: unknown): string {
  if (typeof value !== "string" || value.length < 3 || value.length > 256 || /[\0\r\n]/u.test(value)) {
    throw new MemoryApplicationError("MEMORY_PAGE_CURSOR_INVALID");
  }
  return value;
}
function publicReference(value: unknown): string {
  try { return reference(value); } catch {
    throw new MemoryApplicationError("MEMORY_PUBLIC_NOT_AVAILABLE");
  }
}
function isExactInstant(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new MemoryApplicationError("MEMORY_PAGE_CURSOR_INVALID");
  return value;
}
function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new MemoryApplicationError("MEMORY_PAGE_CURSOR_INVALID");
  return value;
}
function decodeContent(value: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); } catch {
    throw new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
  }
}
function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item), "utf8");
}
