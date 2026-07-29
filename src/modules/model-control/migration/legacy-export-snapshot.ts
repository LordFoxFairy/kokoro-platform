import { createHash, verify, type KeyObject } from "node:crypto";

export interface LegacySourceWatermark {
  readonly digest: string;
  readonly latestUpdatedAt: string | null;
}

export interface LegacyExportFenceClaims {
  readonly schemaVersion: 1;
  readonly leaseId: string;
  readonly issuer: string;
  readonly purpose: "model_control_export";
  readonly issuedAt: string;
  readonly fencedAt: string;
  readonly expiresAt: string;
  readonly sources: readonly {
    readonly name: string;
    readonly databaseIdentity: string;
    readonly watermark: LegacySourceWatermark;
  }[];
}

const verifiedFenceBrand: unique symbol = Symbol("VerifiedLegacyExportFence");
export type VerifiedLegacyExportFence = LegacyExportFenceClaims & {
  readonly keyVersion: string;
  readonly [verifiedFenceBrand]: true;
};
const verifiedFences = new WeakSet<object>();

export interface LegacyExportFenceAttestation {
  readonly claims: LegacyExportFenceClaims;
  readonly signature: string;
  readonly keyVersion: string;
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
  return legacyMysqlDatabaseIdentity(left) === legacyMysqlDatabaseIdentity(right);
}

export function legacyMysqlDatabaseIdentity(value: string): string {
  return mysqlDatabaseIdentity(value);
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

export function legacyExportFenceSigningPayload(input: unknown): Buffer {
  return Buffer.from(stableJson(parseFenceClaims(input)), "utf8");
}

export function verifyLegacyExportFenceAttestation(
  input: unknown,
  options: {
    readonly publicKey: KeyObject;
    readonly expectedIssuer: string;
    readonly expectedSources: readonly {
      readonly name: string;
      readonly databaseIdentity: string;
    }[];
    readonly now: string;
  },
): VerifiedLegacyExportFence {
  const envelope = strictRecord(
    input,
    ["claims", "signature", "keyVersion"],
    "MODEL_LEGACY_EXPORT_FENCE_ATTESTATION_INVALID",
  );
  const claims = parseFenceClaims(envelope.claims);
  const keyVersion = boundedText(
    envelope.keyVersion,
    128,
    "MODEL_LEGACY_EXPORT_FENCE_ATTESTATION_INVALID",
  );
  const signature = boundedText(
    envelope.signature,
    4096,
    "MODEL_LEGACY_EXPORT_FENCE_ATTESTATION_INVALID",
  );
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(signature))
    throw new Error("MODEL_LEGACY_EXPORT_FENCE_ATTESTATION_INVALID");
  if (
    claims.issuer !== options.expectedIssuer ||
    !verify(null, Buffer.from(stableJson(claims), "utf8"), options.publicKey, Buffer.from(signature, "base64"))
  )
    throw new Error("MODEL_LEGACY_EXPORT_FENCE_ATTESTATION_INVALID");

  const now = instant(options.now, "MODEL_LEGACY_EXPORT_CLOCK_INVALID");
  if (Date.parse(now) < Date.parse(claims.issuedAt) || Date.parse(now) >= Date.parse(claims.expiresAt))
    throw new Error("MODEL_LEGACY_EXPORT_FENCE_EXPIRED");
  const expectedSources = [...options.expectedSources]
    .map((source) => ({
      name: participantName(source.name),
      databaseIdentity: boundedText(
        source.databaseIdentity,
        512,
        "MODEL_LEGACY_EXPORT_SOURCE_INVALID",
      ),
    }))
    .sort((left, right) => canonicalCompare(left.name, right.name));
  if (
    expectedSources.length !== claims.sources.length ||
    expectedSources.some(
      (source, index) =>
        source.name !== claims.sources[index]!.name ||
        source.databaseIdentity !== claims.sources[index]!.databaseIdentity,
    )
  )
    throw new Error("MODEL_LEGACY_EXPORT_FENCE_SOURCE_MISMATCH");

  const fence = Object.defineProperty(
    { ...claims, keyVersion },
    verifiedFenceBrand,
    { value: true },
  ) as VerifiedLegacyExportFence;
  deepFreeze(fence);
  verifiedFences.add(fence);
  return fence;
}

export async function captureFencedLegacySnapshots<Payload>(
  participants: readonly LegacySnapshotParticipant<Payload>[],
  fence: VerifiedLegacyExportFence,
  clock: () => string = () => new Date().toISOString(),
): Promise<readonly CapturedLegacySnapshot<Payload>[]> {
  assertVerifiedFence(fence, clock());
  if (participants.length < 1) throw new Error("MODEL_LEGACY_EXPORT_SOURCE_REQUIRED");
  const names = participants.map((participant) => participantName(participant.name));
  if (new Set(names).size !== names.length) throw new Error("MODEL_LEGACY_EXPORT_SOURCE_DUPLICATE");

  const before = await Promise.all(
    participants.map((participant) => participant.readCurrentWatermark()),
  );
  before.forEach((watermark, index) =>
    assertAuthorizedWatermark(names[index]!, watermark, fence),
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
      assertAuthorizedWatermark(names[index]!, watermark, fence);
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
      assertAuthorizedWatermark(names[index]!, watermark, fence);
      assertSameWatermark(names[index]!, snapshot[index]!, watermark);
    });
    assertVerifiedFence(fence, clock());
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
  fence: VerifiedLegacyExportFence,
  snapshots: readonly Pick<CapturedLegacySnapshot, "name" | "watermark">[],
): string {
  const base = boundedText(reference, 256, "MODEL_LEGACY_EXPORT_REFERENCE_INVALID");
  assertVerifiedFence(fence, new Date().toISOString());
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
      leaseId: fence.leaseId,
      issuer: fence.issuer,
      keyVersion: fence.keyVersion,
      fencedAt: fence.fencedAt,
      expiresAt: fence.expiresAt,
      sources,
    }),
  );
  return boundedText(
    `${base}#fenced-at=${encodeURIComponent(fence.fencedAt)}&snapshot=${evidenceDigest}`,
    512,
    "MODEL_LEGACY_EXPORT_REFERENCE_INVALID",
  );
}

function parseFenceClaims(input: unknown): LegacyExportFenceClaims {
  const claims = strictRecord(
    input,
    ["schemaVersion", "leaseId", "issuer", "purpose", "issuedAt", "fencedAt", "expiresAt", "sources"],
    "MODEL_LEGACY_EXPORT_FENCE_ATTESTATION_INVALID",
  );
  if (claims.schemaVersion !== 1 || claims.purpose !== "model_control_export")
    throw new Error("MODEL_LEGACY_EXPORT_FENCE_ATTESTATION_INVALID");
  const leaseId = boundedText(claims.leaseId, 128, "MODEL_LEGACY_EXPORT_FENCE_ATTESTATION_INVALID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(leaseId))
    throw new Error("MODEL_LEGACY_EXPORT_FENCE_ATTESTATION_INVALID");
  const issuer = boundedText(claims.issuer, 256, "MODEL_LEGACY_EXPORT_FENCE_ATTESTATION_INVALID");
  const issuedAt = instant(claims.issuedAt, "MODEL_LEGACY_EXPORT_FENCE_ATTESTATION_INVALID");
  const fencedAt = instant(claims.fencedAt, "MODEL_LEGACY_EXPORT_FENCE_ATTESTATION_INVALID");
  const expiresAt = instant(claims.expiresAt, "MODEL_LEGACY_EXPORT_FENCE_ATTESTATION_INVALID");
  if (
    Date.parse(issuedAt) > Date.parse(fencedAt) ||
    Date.parse(fencedAt) >= Date.parse(expiresAt) ||
    Date.parse(expiresAt) - Date.parse(fencedAt) > 15 * 60_000
  )
    throw new Error("MODEL_LEGACY_EXPORT_FENCE_ATTESTATION_INVALID");
  const sources = array(claims.sources, "MODEL_LEGACY_EXPORT_FENCE_ATTESTATION_INVALID")
    .map((inputSource) => {
      const source = strictRecord(
        inputSource,
        ["name", "databaseIdentity", "watermark"],
        "MODEL_LEGACY_EXPORT_FENCE_ATTESTATION_INVALID",
      );
      const watermark = parseWatermark(source.watermark as LegacySourceWatermark);
      if (
        watermark.latestUpdatedAt !== null &&
        Date.parse(watermark.latestUpdatedAt) > Date.parse(fencedAt)
      )
        throw new Error("MODEL_LEGACY_EXPORT_FENCE_ATTESTATION_INVALID");
      return Object.freeze({
        name: participantName(source.name as string),
        databaseIdentity: boundedText(
          source.databaseIdentity,
          512,
          "MODEL_LEGACY_EXPORT_FENCE_ATTESTATION_INVALID",
        ),
        watermark,
      });
    })
    .sort((left, right) => canonicalCompare(left.name, right.name));
  if (
    sources.length < 1 ||
    sources.some((source, index) => index > 0 && sources[index - 1]!.name === source.name)
  )
    throw new Error("MODEL_LEGACY_EXPORT_FENCE_ATTESTATION_INVALID");
  return deepFreeze({
    schemaVersion: 1,
    leaseId,
    issuer,
    purpose: "model_control_export",
    issuedAt,
    fencedAt,
    expiresAt,
    sources,
  });
}

function assertAuthorizedWatermark(
  name: string,
  value: LegacySourceWatermark,
  fence: VerifiedLegacyExportFence,
): void {
  const watermark = parseWatermark(value);
  const authorized = fence.sources.find((source) => source.name === name)?.watermark;
  if (
    !authorized ||
    authorized.digest !== watermark.digest ||
    authorized.latestUpdatedAt !== watermark.latestUpdatedAt ||
    watermark.latestUpdatedAt !== null &&
    Date.parse(watermark.latestUpdatedAt) > Date.parse(fence.fencedAt)
  )
    throw new Error(`MODEL_LEGACY_EXPORT_FENCE_VIOLATED:${name}`);
}

function assertVerifiedFence(fence: VerifiedLegacyExportFence, now: string): void {
  if (!verifiedFences.has(fence)) throw new Error("MODEL_LEGACY_EXPORT_FENCE_NOT_VERIFIED");
  const current = Date.parse(instant(now, "MODEL_LEGACY_EXPORT_CLOCK_INVALID"));
  if (current < Date.parse(fence.issuedAt) || current >= Date.parse(fence.expiresAt))
    throw new Error("MODEL_LEGACY_EXPORT_FENCE_EXPIRED");
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

function parseWatermark(value: unknown): LegacySourceWatermark {
  const watermark = strictRecord(
    value,
    ["digest", "latestUpdatedAt"],
    "MODEL_LEGACY_EXPORT_WATERMARK_INVALID",
  );
  if (typeof watermark.digest !== "string" || !/^[a-f0-9]{64}$/u.test(watermark.digest))
    throw new Error("MODEL_LEGACY_EXPORT_WATERMARK_INVALID");
  return Object.freeze({
    digest: watermark.digest,
    latestUpdatedAt:
      watermark.latestUpdatedAt === null
        ? null
        : instant(watermark.latestUpdatedAt, "MODEL_LEGACY_EXPORT_WATERMARK_INVALID"),
  });
}

function participantName(value: string): string {
  if (!/^[a-z][a-z0-9+_-]{0,63}$/u.test(value))
    throw new Error("MODEL_LEGACY_EXPORT_SOURCE_INVALID");
  return value;
}

function instant(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(code);
  return parsed.toISOString();
}

function boundedText(value: unknown, maximum: number, code: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum)
    throw new Error(code);
  return value;
}

function strictRecord(value: unknown, allowed: readonly string[], code: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error(code);
  return record;
}

function array(value: unknown, code: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
}

function canonicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
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
