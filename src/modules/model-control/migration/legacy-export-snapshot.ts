import { createHash } from "node:crypto";

export interface LegacySourceWatermark {
  readonly digest: string;
  readonly latestUpdatedAt: string | null;
}

export interface LegacyExportFence {
  readonly token: string;
  readonly fencedAt: string;
}

export interface LegacySnapshotParticipant<Payload = unknown> {
  readonly name: string;
  readCurrentWatermark(): Promise<LegacySourceWatermark>;
  beginConsistentSnapshot(): Promise<void>;
  readSnapshotWatermark(): Promise<LegacySourceWatermark>;
  readPayload(): Promise<Payload>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface CapturedLegacySnapshot<Payload = unknown> {
  readonly name: string;
  readonly payload: Payload;
  readonly watermark: LegacySourceWatermark;
}

export function sameLegacyDatabaseIdentity(left: string, right: string): boolean {
  return mysqlDatabaseIdentity(left) === mysqlDatabaseIdentity(right);
}

export function createLegacySourceWatermark(
  input: readonly {
    readonly sourceName: string;
    readonly rowKey: string;
    readonly rowVersion: string;
    readonly updatedAt: string | Date;
  }[],
): LegacySourceWatermark {
  const rows = input
    .map((row) => ({
      sourceName: participantName(row.sourceName),
      rowKey: boundedText(row.rowKey, 256, "MODEL_LEGACY_EXPORT_WATERMARK_INVALID"),
      rowVersion: digest(row.rowVersion, "MODEL_LEGACY_EXPORT_WATERMARK_INVALID"),
      updatedAt: instant(
        row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
        "MODEL_LEGACY_EXPORT_WATERMARK_INVALID",
      ),
    }))
    .sort((left, right) =>
      `${left.sourceName}:${left.rowKey}`.localeCompare(`${right.sourceName}:${right.rowKey}`),
    );
  if (
    rows.some(
      (row, index) =>
        index > 0 &&
        row.sourceName === rows[index - 1]!.sourceName &&
        row.rowKey === rows[index - 1]!.rowKey,
    )
  )
    throw new Error("MODEL_LEGACY_EXPORT_WATERMARK_INVALID");
  return Object.freeze({
    digest: sha256(stableJson(rows)),
    latestUpdatedAt:
      rows.length === 0
        ? null
        : rows.reduce(
            (latest, row) =>
              Date.parse(row.updatedAt) > Date.parse(latest) ? row.updatedAt : latest,
            rows[0]!.updatedAt,
          ),
  });
}

export async function captureFencedLegacySnapshots<Payload>(
  participants: readonly LegacySnapshotParticipant<Payload>[],
  fence: LegacyExportFence,
  clock: () => string = () => new Date().toISOString(),
): Promise<readonly CapturedLegacySnapshot<Payload>[]> {
  const canonicalFence = parseFence(fence, clock());
  if (participants.length < 1) throw new Error("MODEL_LEGACY_EXPORT_SOURCE_REQUIRED");
  const names = participants.map((participant) => participantName(participant.name));
  if (new Set(names).size !== names.length) throw new Error("MODEL_LEGACY_EXPORT_SOURCE_DUPLICATE");

  const before = await Promise.all(
    participants.map((participant) => participant.readCurrentWatermark()),
  );
  before.forEach((watermark, index) =>
    assertWatermark(names[index]!, watermark, canonicalFence.fencedAt),
  );

  const begun: LegacySnapshotParticipant<Payload>[] = [];
  let committed = false;
  try {
    for (const participant of participants) {
      await participant.beginConsistentSnapshot();
      begun.push(participant);
    }
    const snapshot = await Promise.all(
      participants.map((participant) => participant.readSnapshotWatermark()),
    );
    snapshot.forEach((watermark, index) => {
      assertWatermark(names[index]!, watermark, canonicalFence.fencedAt);
      assertSameWatermark(names[index]!, before[index]!, watermark);
    });
    const payloads = await Promise.all(
      participants.map((participant) => participant.readPayload()),
    );
    for (const participant of participants) await participant.commit();
    committed = true;

    const after = await Promise.all(
      participants.map((participant) => participant.readCurrentWatermark()),
    );
    after.forEach((watermark, index) => {
      assertWatermark(names[index]!, watermark, canonicalFence.fencedAt);
      assertSameWatermark(names[index]!, snapshot[index]!, watermark);
    });
    return Object.freeze(
      names.map((name, index) =>
        Object.freeze({ name, payload: payloads[index]!, watermark: snapshot[index]! }),
      ),
    );
  } catch (error) {
    if (!committed) await Promise.allSettled(begun.map((participant) => participant.rollback()));
    throw error;
  }
}

export function legacySnapshotReference(
  reference: string,
  fence: LegacyExportFence,
  snapshots: readonly Pick<CapturedLegacySnapshot, "name" | "watermark">[],
): string {
  const base = boundedText(reference, 256, "MODEL_LEGACY_EXPORT_REFERENCE_INVALID");
  const canonicalFence = parseFence(fence, new Date().toISOString(), false);
  const sources = [...snapshots]
    .map((snapshot) => ({
      name: participantName(snapshot.name),
      watermark: parseWatermark(snapshot.watermark),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (sources.length < 1 || new Set(sources.map(({ name }) => name)).size !== sources.length)
    throw new Error("MODEL_LEGACY_EXPORT_SOURCE_INVALID");
  const evidenceDigest = sha256(
    stableJson({
      fenceTokenDigest: sha256(canonicalFence.token),
      fencedAt: canonicalFence.fencedAt,
      sources,
    }),
  );
  return boundedText(
    `${base}#fenced-at=${encodeURIComponent(canonicalFence.fencedAt)}&snapshot=${evidenceDigest}`,
    512,
    "MODEL_LEGACY_EXPORT_REFERENCE_INVALID",
  );
}

function parseFence(fence: LegacyExportFence, now: string, enforcePast = true): LegacyExportFence {
  const token = boundedText(fence.token, 128, "MODEL_LEGACY_EXPORT_FENCE_INVALID");
  const fencedAt = instant(fence.fencedAt, "MODEL_LEGACY_EXPORT_FENCE_INVALID");
  const current = instant(now, "MODEL_LEGACY_EXPORT_CLOCK_INVALID");
  if (enforcePast && Date.parse(fencedAt) > Date.parse(current))
    throw new Error("MODEL_LEGACY_EXPORT_FENCE_INVALID");
  return Object.freeze({ token, fencedAt });
}

function assertWatermark(name: string, value: LegacySourceWatermark, fencedAt: string): void {
  const watermark = parseWatermark(value);
  if (
    watermark.latestUpdatedAt !== null &&
    Date.parse(watermark.latestUpdatedAt) > Date.parse(fencedAt)
  )
    throw new Error(`MODEL_LEGACY_EXPORT_FENCE_VIOLATED:${name}`);
}

function assertSameWatermark(
  name: string,
  left: LegacySourceWatermark,
  right: LegacySourceWatermark,
): void {
  const first = parseWatermark(left);
  const second = parseWatermark(right);
  if (first.digest !== second.digest || first.latestUpdatedAt !== second.latestUpdatedAt)
    throw new Error(`MODEL_LEGACY_EXPORT_FENCE_VIOLATED:${name}`);
}

function parseWatermark(value: LegacySourceWatermark): LegacySourceWatermark {
  if (!/^[a-f0-9]{64}$/u.test(value.digest))
    throw new Error("MODEL_LEGACY_EXPORT_WATERMARK_INVALID");
  return Object.freeze({
    digest: value.digest,
    latestUpdatedAt:
      value.latestUpdatedAt === null
        ? null
        : instant(value.latestUpdatedAt, "MODEL_LEGACY_EXPORT_WATERMARK_INVALID"),
  });
}

function participantName(value: string): string {
  if (!/^[a-z][a-z0-9+_-]{0,63}$/u.test(value))
    throw new Error("MODEL_LEGACY_EXPORT_SOURCE_INVALID");
  return value;
}

function instant(value: string, code: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(code);
  return parsed.toISOString();
}

function boundedText(value: string, maximum: number, code: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum)
    throw new Error(code);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: string, code: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(code);
  return value;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function mysqlDatabaseIdentity(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MODEL_LEGACY_EXPORT_DATABASE_URL_INVALID");
  }
  if (url.protocol !== "mysql:" || !url.hostname || url.pathname.length < 2)
    throw new Error("MODEL_LEGACY_EXPORT_DATABASE_URL_INVALID");
  return `${url.hostname.toLowerCase()}:${url.port || "3306"}/${decodeURIComponent(url.pathname.slice(1))}`;
}
