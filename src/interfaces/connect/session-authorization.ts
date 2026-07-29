import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { create, fromBinary } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import type { PlatformTransactionalDatabaseClient } from "../../infrastructure/postgres/client.js";
import type { SessionAuthorizationVerificationKeySet } from "../../modules/authorization/application/contracts/session-authorization-ports.js";
import { PostgresAuthorizationFeedRepository } from "../../modules/authorization/infrastructure/postgres/authorization-feed-repository.js";
import {
  AuthorizationEventBatchSchema,
  AuthorizationSignatureAlgorithm,
  AuthorizationSnapshotPageSchema,
  AuthorizationSnapshotReason,
  AuthorizationSnapshotRecordSchema,
  AuthorizationSnapshotRequiredSchema,
  AuthorizationVerificationKeySchema,
  AuthorizationVerificationKeyPurpose,
  AuthorizationVerificationKeysNotModifiedSchema,
  AuthorizationVerificationKeysSchema,
  AuthorizationVerificationKeyState,
  GetAuthorizationSnapshotPageResponseSchema,
  GetAuthorizationVerificationKeysResponseSchema,
  PullAuthorizationEventsResponseSchema,
  SessionAuthorizationService,
  SignedAuthorizationEventSchema,
  AuthorizationEventSigningPayloadSchema,
  type AuthorizationEventSigningPayload,
  type AuthorizationSnapshotRecord,
} from "./generated-authorization/kokoro/platform/authorization/v1/session_authorization_pb.js";

export type SessionAuthorizationFeedService = ServiceImpl<typeof SessionAuthorizationService>;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

export function createSessionAuthorizationFeedService(input: Readonly<{
  database: Pick<PlatformTransactionalDatabaseClient, "internalTransaction">;
  repository: PostgresAuthorizationFeedRepository;
  verificationKeySet: SessionAuthorizationVerificationKeySet;
  cursorSecret: Uint8Array;
  clock?: () => Date;
  snapshotTtlMs?: number;
}>): SessionAuthorizationFeedService {
  const clock = input.clock ?? (() => new Date());
  const snapshotTtlMs = input.snapshotTtlMs ?? 5 * 60_000;
  const cursors = createSnapshotCursorCodec(input.cursorSecret, clock);
  if (snapshotTtlMs < 30_000 || snapshotTtlMs > 15 * 60_000) {
    throw new Error("AUTHORIZATION_SNAPSHOT_TTL_INVALID");
  }

  return {
    async pullAuthorizationEvents(request, context) {
      const limit = boundedLimit(request.limit);
      if (request.afterStreamSequence > POSTGRES_BIGINT_MAX) {
        throw new ConnectError("after_stream_sequence invalid", Code.InvalidArgument);
      }
      const waitMs = request.waitMs ?? 0;
      if (waitMs < 0 || waitMs > 30_000) throw new ConnectError("wait_ms invalid", Code.InvalidArgument);
      const deadline = clock().getTime() + waitMs;
      while (true) {
        const window = await input.database.internalTransaction(
          "authorization.feed.read",
          (transaction) => input.repository.readWindow(transaction, {
            afterStreamSequence: request.afterStreamSequence,
            limit,
          }),
        );
        if (window.snapshotRequired) {
          return create(PullAuthorizationEventsResponseSchema, {
            outcome: {
              case: "snapshotRequired",
              value: create(AuthorizationSnapshotRequiredSchema, {
                reason: AuthorizationSnapshotReason.CURSOR_EXPIRED,
                oldestAvailableStreamSequence: window.oldestAvailable,
                highWatermarkStreamSequence: window.highWatermark,
              }),
            },
          });
        }
        if (request.afterStreamSequence > window.highWatermark) {
          return create(PullAuthorizationEventsResponseSchema, {
            outcome: {
              case: "snapshotRequired",
              value: create(AuthorizationSnapshotRequiredSchema, {
                reason: AuthorizationSnapshotReason.SEQUENCE_GAP,
                oldestAvailableStreamSequence: window.oldestAvailable,
                highWatermarkStreamSequence: window.highWatermark,
              }),
            },
          });
        }
        if (window.events[0] !== undefined && window.events[0].streamSequence !== request.afterStreamSequence + 1n) {
          return create(PullAuthorizationEventsResponseSchema, {
            outcome: {
              case: "snapshotRequired",
              value: create(AuthorizationSnapshotRequiredSchema, {
                reason: AuthorizationSnapshotReason.SEQUENCE_GAP,
                oldestAvailableStreamSequence: window.oldestAvailable,
                highWatermarkStreamSequence: window.highWatermark,
              }),
            },
          });
        }
        if (window.events.length > 0 || clock().getTime() >= deadline || waitMs === 0) {
          return create(PullAuthorizationEventsResponseSchema, {
            outcome: {
              case: "batch",
              value: create(AuthorizationEventBatchSchema, {
                events: window.events.map((event) => {
                  const payload = fromBinary(AuthorizationEventSigningPayloadSchema, event.signingPayload, {
                    readUnknownFields: false,
                  });
                  assertEventMatchesRow(payload, event);
                  const digest = createHash("sha256").update(event.signingPayload).digest("hex");
                  if (digest !== event.payloadDigest) throw new ConnectError("feed corrupt", Code.DataLoss);
                  return create(SignedAuthorizationEventSchema, {
                    payload,
                    payloadDigest: event.payloadDigest,
                    signingKeyRevision: event.signingKeyRevision,
                    signatureAlgorithm: AuthorizationSignatureAlgorithm.RS256,
                    signature: event.signature,
                  });
                }),
                highWatermarkStreamSequence: window.highWatermark,
                observedAt: timestampFromDate(clock()),
              }),
            },
          });
        }
        await abortableDelay(Math.min(250, Math.max(1, deadline - clock().getTime())), context.signal);
      }
    },

    async getAuthorizationSnapshotPage(request) {
      const limit = boundedLimit(request.limit);
      const now = clock();
      let snapshotRef: string;
      let afterOrdinal: bigint;
      if (request.snapshotRef === undefined && request.pageCursor === undefined) {
        snapshotRef = randomUUID();
        afterOrdinal = -1n;
        const frozenAt = now.toISOString();
        const expiresAt = new Date(now.getTime() + snapshotTtlMs).toISOString();
        await input.database.internalTransaction("authorization.snapshot.create", (transaction) =>
          input.repository.createSnapshot(transaction, {
            snapshotRef,
            frozenAt,
            expiresAt,
            keySetRevision: input.verificationKeySet.keySetRevision,
            keyRecords: verificationKeyRecords(input.verificationKeySet),
          }));
      } else if (request.snapshotRef !== undefined && request.pageCursor !== undefined) {
        snapshotRef = request.snapshotRef;
        afterOrdinal = cursors.decode(request.pageCursor, snapshotRef);
      } else {
        throw new ConnectError("snapshot_ref and page_cursor must be paired", Code.InvalidArgument);
      }
      const page = await input.database.internalTransaction("authorization.feed.read", (transaction) =>
        input.repository.readSnapshotPage(transaction, {
          snapshotRef,
          afterOrdinal,
          limit: limit + 1,
          now: now.toISOString(),
        }));
      if (page === null) throw new ConnectError("snapshot unavailable", Code.FailedPrecondition);
      const hasMore = page.records.length > limit;
      const visible = page.records.slice(0, limit);
      const last = visible.at(-1)?.ordinal;
      return create(GetAuthorizationSnapshotPageResponseSchema, {
        page: create(AuthorizationSnapshotPageSchema, {
          snapshotRef,
          highWatermarkStreamSequence: page.highWatermark,
          keySetRevision: page.keySetRevision,
          frozenAt: timestampFromDate(new Date(page.frozenAt)),
          records: visible.map((entry) => entry.record),
          ...(hasMore && last !== undefined
            ? { nextPageCursor: cursors.encode(snapshotRef, last, page.expiresAt) }
            : {}),
        }),
      });
    },

    async getAuthorizationVerificationKeys(request) {
      const observedAt = timestampFromDate(clock());
      if (request.ifNoneMatchRevision !== undefined && !/^[0-9a-f]{64}$/u.test(request.ifNoneMatchRevision)) {
        throw new ConnectError("if_none_match_revision invalid", Code.InvalidArgument);
      }
      if (request.ifNoneMatchRevision === input.verificationKeySet.keySetRevision) {
        return create(GetAuthorizationVerificationKeysResponseSchema, {
          outcome: {
            case: "notModified",
            value: create(AuthorizationVerificationKeysNotModifiedSchema, {
              revision: input.verificationKeySet.keySetRevision,
            }),
          },
          observedAt,
        });
      }
      return create(GetAuthorizationVerificationKeysResponseSchema, {
        outcome: {
          case: "keySet",
          value: create(AuthorizationVerificationKeysSchema, {
            revision: input.verificationKeySet.keySetRevision,
            keys: verificationKeys(input.verificationKeySet),
          }),
        },
        observedAt,
      });
    },
  };
}

function verificationKeys(keySet: SessionAuthorizationVerificationKeySet) {
  return keySet.verificationKeys().map((key) => create(AuthorizationVerificationKeySchema, {
    purpose: key.purpose === "event_signing"
      ? AuthorizationVerificationKeyPurpose.EVENT_SIGNING
      : AuthorizationVerificationKeyPurpose.SESSION_ACCESS_GRANT,
    keyRevision: key.keyRevision,
    state: key.current
      ? AuthorizationVerificationKeyState.CURRENT
      : AuthorizationVerificationKeyState.PREVIOUS,
    algorithm: AuthorizationSignatureAlgorithm.RS256,
    canonicalPublicJwkJson: key.canonicalPublicJwkJson,
    notBefore: timestampFromDate(new Date(key.notBefore)),
    notAfter: timestampFromDate(new Date(key.notAfter)),
  }));
}

function verificationKeyRecords(keySet: SessionAuthorizationVerificationKeySet): readonly AuthorizationSnapshotRecord[] {
  return Object.freeze(verificationKeys(keySet).map((key) => create(AuthorizationSnapshotRecordSchema, {
    record: { case: "verificationKey", value: key },
  })));
}

function boundedLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new ConnectError("limit invalid", Code.InvalidArgument);
  }
  return value;
}

function assertEventMatchesRow(
  payload: AuthorizationEventSigningPayload,
  row: Readonly<{ eventId: string; streamSequence: bigint; siteRef: string; aggregateSequence: bigint }>,
): void {
  if (
    payload.eventId !== row.eventId || payload.streamSequence !== row.streamSequence ||
    payload.siteRef !== row.siteRef || payload.aggregateSequence !== row.aggregateSequence ||
    payload.event.case === undefined ||
    (payload.event.case === "grantDelivered" && payload.event.value.siteRef !== payload.siteRef)
  ) throw new ConnectError("feed corrupt", Code.DataLoss);
}

function createSnapshotCursorCodec(secret: Uint8Array, clock: () => Date) {
  if (!(secret instanceof Uint8Array) || secret.byteLength < 32 || secret.byteLength > 128) {
    throw new Error("AUTHORIZATION_CURSOR_SECRET_INVALID");
  }
  const key = Buffer.from(secret);
  return Object.freeze({
    encode(snapshotRef: string, ordinal: bigint, expiresAt: string): string {
      const body = Buffer.from(JSON.stringify({ v: 1, s: snapshotRef, o: ordinal.toString(), e: expiresAt }), "utf8")
        .toString("base64url");
      const mac = createHmac("sha256", key).update(body).digest("base64url");
      return `${body}.${mac}`;
    },
    decode(cursor: string, expectedSnapshotRef: string): bigint {
      if (cursor.length < 20 || cursor.length > 4096) throw new ConnectError("cursor invalid", Code.InvalidArgument);
      const [body, suppliedMac, extra] = cursor.split(".");
      if (!body || !suppliedMac || extra !== undefined) throw new ConnectError("cursor invalid", Code.InvalidArgument);
      const expectedMac = createHmac("sha256", key).update(body).digest();
      let actualMac: Buffer;
      try { actualMac = Buffer.from(suppliedMac, "base64url"); } catch { throw new ConnectError("cursor invalid", Code.InvalidArgument); }
      if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) {
        throw new ConnectError("cursor invalid", Code.InvalidArgument);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch {
        throw new ConnectError("cursor invalid", Code.InvalidArgument);
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ConnectError("cursor invalid", Code.InvalidArgument);
      }
      const value = parsed as Record<string, unknown>;
      if (
        Object.keys(value).sort().join(",") !== "e,o,s,v" || value.v !== 1 ||
        value.s !== expectedSnapshotRef || typeof value.o !== "string" ||
        !/^(?:0|[1-9][0-9]*)$/u.test(value.o) || typeof value.e !== "string" ||
        Date.parse(value.e) <= clock().getTime()
      ) throw new ConnectError("cursor invalid", Code.FailedPrecondition);
      const ordinal = BigInt(value.o);
      if (ordinal > POSTGRES_BIGINT_MAX) throw new ConnectError("cursor invalid", Code.InvalidArgument);
      return ordinal;
    },
  });
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new ConnectError("request aborted", Code.Canceled);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ConnectError("request aborted", Code.Canceled));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
