export interface ProviderOperationalAvailability {
  readonly providerKey: string;
  readonly status: "active" | "disabled";
  readonly health: "unknown" | "healthy" | "degraded" | "down";
  readonly epoch: string;
  readonly observationRef: string | null;
  readonly observedAt: string | null;
}

export function canonicalizeProviderOperationalAvailability(
  input: readonly ProviderOperationalAvailability[],
  providerKeys: ReadonlySet<string>,
): readonly ProviderOperationalAvailability[] {
  const facts = [...input]
    .map((fact) => {
      const value = strictRecord(
        fact,
        ["providerKey", "status", "health", "epoch", "observationRef", "observedAt"],
        "MODEL_AVAILABILITY_SCHEMA_UNKNOWN_FIELD",
      );
      const providerKey = requiredString(value.providerKey, "MODEL_AVAILABILITY_PROVIDER_INVALID");
      const status = value.status;
      const health = value.health;
      const epoch = requiredString(value.epoch, "MODEL_AVAILABILITY_EPOCH_INVALID");
      if (!providerKeys.has(providerKey)) throw new Error("MODEL_AVAILABILITY_PROVIDER_UNKNOWN");
      if (status !== "active" && status !== "disabled")
        throw new Error("MODEL_AVAILABILITY_STATUS_INVALID");
      if (
        health !== "unknown" &&
        health !== "healthy" &&
        health !== "degraded" &&
        health !== "down"
      )
        throw new Error("MODEL_AVAILABILITY_HEALTH_INVALID");
      if (!/^(?:0|[1-9][0-9]*)$/u.test(epoch)) throw new Error("MODEL_AVAILABILITY_EPOCH_INVALID");
      const observationRef = nullableString(value.observationRef, "MODEL_AVAILABILITY_REF_INVALID");
      const observedAt = nullableString(value.observedAt, "MODEL_AVAILABILITY_TIME_INVALID");
      return Object.freeze({
        providerKey: identifier(providerKey),
        status,
        health,
        epoch,
        observationRef: observationRef === null ? null : boundedText(observationRef, 512),
        observedAt: observedAt === null ? null : canonicalInstant(observedAt),
      });
    })
    .sort((left, right) => canonicalCompare(left.providerKey, right.providerKey));
  if (
    facts.length !== providerKeys.size ||
    facts.some((fact, index) => index > 0 && facts[index - 1]!.providerKey === fact.providerKey)
  )
    throw new Error("MODEL_AVAILABILITY_PROVIDER_COVERAGE_INVALID");
  return Object.freeze(facts);
}

function strictRecord(value: unknown, allowed: readonly string[], code: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error(code);
  return record;
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  return value;
}

function nullableString(value: unknown, code: string): string | null {
  if (value === null) return null;
  return requiredString(value, code);
}

function identifier(value: string): string {
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value)) throw new Error("MODEL_IDENTIFIER_INVALID");
  return value;
}

function boundedText(value: string, maximum: number): string {
  if (value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value))
    throw new Error("MODEL_TEXT_INVALID");
  return value;
}

function canonicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalInstant(value: string): string {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error("MODEL_AVAILABILITY_TIME_INVALID");
  return instant.toISOString();
}
