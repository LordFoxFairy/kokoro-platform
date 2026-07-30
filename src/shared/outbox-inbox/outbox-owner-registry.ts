export const OUTBOX_OWNER_CONSUMER_REGISTRY = Object.freeze({
  identity: "identity-worker",
  commerce: "commerce-worker",
  credit: "commerce-worker",
  site: "site-worker",
  asset: "asset-worker",
  "admin-execution": "admin-worker",
} as const);

export type OutboxOwner = keyof typeof OUTBOX_OWNER_CONSUMER_REGISTRY;
export type OutboxConsumer = (typeof OUTBOX_OWNER_CONSUMER_REGISTRY)[OutboxOwner];

const owners = new Set<string>(Object.keys(OUTBOX_OWNER_CONSUMER_REGISTRY));
const consumers = new Set<string>(Object.values(OUTBOX_OWNER_CONSUMER_REGISTRY));

export function assertOutboxOwner(value: string): asserts value is OutboxOwner {
  if (!owners.has(value)) throw new Error("OUTBOX_OWNER_UNREGISTERED");
}

export function outboxOwnersForConsumer(value: OutboxConsumer): readonly OutboxOwner[] {
  if (!consumers.has(value)) throw new Error("OUTBOX_CONSUMER_UNREGISTERED");
  return Object.freeze((Object.entries(OUTBOX_OWNER_CONSUMER_REGISTRY) as
    readonly (readonly [OutboxOwner, OutboxConsumer])[])
    .filter(([, consumer]) => consumer === value)
    .map(([owner]) => owner));
}
