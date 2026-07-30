type ActiveProcessRoute = Readonly<{
  module: "src/process/worker.ts";
  symbol: string;
}>;

export const OUTBOX_ROUTE_CATALOG = Object.freeze({
  identity: Object.freeze({
    consumer: "identity-worker",
    closure: "reserved",
    eventTypes: Object.freeze([
      "identity.verification.delivery.requested",
      "identity.namespace.allocation.requested",
    ] as const),
    process: null,
  }),
  commerce: activeRoute("commerce-worker", [
    "commerce.redemption.fulfilled.v1",
  ] as const, "createCommerceOutboxReconciliationCycle"),
  credit: activeRoute("commerce-worker", [
    "credit.reserve_root.v1",
    "credit.finalize_segment.v1",
    "credit.release_segment.v1",
    "credit.reconcile_segment.v1",
  ] as const, "createCommerceOutboxReconciliationCycle"),
  site: activeRoute("site-worker", [
    "site.activation.begin.v1",
    "site.traffic-stop.request.v1",
  ] as const, "createSiteRuntimeWorkerProductionComposition"),
  asset: activeRoute("asset-worker", [
    "asset.upload.completion.requested",
    "asset.scan.requested",
    "asset.blob.promotion.requested",
    "asset.object.cleanup.requested",
  ] as const, "createAssetWorkerProductionComposition"),
  "admin-execution": activeRoute("admin-worker", [
    "admin.approval.execution.requested",
  ] as const, "createAdminWorkerExecutionRuntime"),
} as const);

export type OutboxOwner = keyof typeof OUTBOX_ROUTE_CATALOG;
export type OutboxConsumer = (typeof OUTBOX_ROUTE_CATALOG)[OutboxOwner]["consumer"];
export type OutboxEventType =
  (typeof OUTBOX_ROUTE_CATALOG)[OutboxOwner]["eventTypes"][number];

export const OUTBOX_OWNER_CONSUMER_REGISTRY = Object.freeze(Object.fromEntries(
  Object.entries(OUTBOX_ROUTE_CATALOG).map(([owner, route]) => [owner, route.consumer]),
)) as Readonly<{
  [Owner in OutboxOwner]: (typeof OUTBOX_ROUTE_CATALOG)[Owner]["consumer"];
}>;

const owners = new Set<string>(Object.keys(OUTBOX_ROUTE_CATALOG));
const consumers = new Set<string>(Object.values(OUTBOX_ROUTE_CATALOG)
  .map((route) => route.consumer));

export function assertOutboxOwner(value: string): asserts value is OutboxOwner {
  if (!owners.has(value)) throw new Error("OUTBOX_OWNER_UNREGISTERED");
}

export function assertOutboxEventRoute(owner: string, eventType: string): void {
  assertOutboxOwner(owner);
  if (!(OUTBOX_ROUTE_CATALOG[owner].eventTypes as readonly string[]).includes(eventType)) {
    throw new Error("OUTBOX_EVENT_ROUTE_UNREGISTERED");
  }
}

export function outboxOwnersForConsumer(value: OutboxConsumer): readonly OutboxOwner[] {
  assertConsumer(value);
  return Object.freeze((Object.entries(OUTBOX_ROUTE_CATALOG) as
    readonly (readonly [OutboxOwner, (typeof OUTBOX_ROUTE_CATALOG)[OutboxOwner]])[])
    .filter(([, route]) => route.consumer === value)
    .map(([owner]) => owner));
}

export function outboxEventTypesForConsumer(value: OutboxConsumer): readonly OutboxEventType[] {
  assertConsumer(value);
  return Object.freeze((Object.values(OUTBOX_ROUTE_CATALOG) as readonly
    (typeof OUTBOX_ROUTE_CATALOG)[OutboxOwner][])
    .filter((route) => route.consumer === value)
    .flatMap((route) => [...route.eventTypes]));
}

export function assertOutboxConsumerEventTypes(
  consumer: OutboxConsumer,
  eventTypes: readonly string[] | undefined,
): void {
  const expected = outboxEventTypesForConsumer(consumer);
  if (eventTypes === undefined || eventTypes.length !== expected.length ||
      eventTypes.some((eventType, index) => eventType !== expected[index])) {
    throw new Error("OUTBOX_EVENT_TYPE_ALLOWLIST_INVALID");
  }
}

function activeRoute<Consumer extends OutboxConsumerLiteral, EventTypes extends readonly string[]>(
  consumer: Consumer,
  eventTypes: EventTypes,
  symbol: string,
): Readonly<{
  consumer: Consumer;
  closure: "active";
  eventTypes: Readonly<EventTypes>;
  process: ActiveProcessRoute;
}> {
  return Object.freeze({
    consumer,
    closure: "active" as const,
    eventTypes: Object.freeze(eventTypes),
    process: Object.freeze({ module: "src/process/worker.ts" as const, symbol }),
  });
}

type OutboxConsumerLiteral =
  | "identity-worker"
  | "commerce-worker"
  | "site-worker"
  | "asset-worker"
  | "admin-worker";

function assertConsumer(value: string): asserts value is OutboxConsumer {
  if (!consumers.has(value)) throw new Error("OUTBOX_CONSUMER_UNREGISTERED");
}
