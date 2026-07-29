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
      if (!providerKeys.has(fact.providerKey))
        throw new Error("MODEL_AVAILABILITY_PROVIDER_UNKNOWN");
      if (fact.status !== "active" && fact.status !== "disabled")
        throw new Error("MODEL_AVAILABILITY_STATUS_INVALID");
      if (!("unknown healthy degraded down".split(" ") as string[]).includes(fact.health))
        throw new Error("MODEL_AVAILABILITY_HEALTH_INVALID");
      if (!/^(?:0|[1-9][0-9]*)$/u.test(fact.epoch))
        throw new Error("MODEL_AVAILABILITY_EPOCH_INVALID");
      return Object.freeze({
        providerKey: identifier(fact.providerKey),
        status: fact.status,
        health: fact.health,
        epoch: fact.epoch,
        observationRef:
          fact.observationRef === null ? null : boundedText(fact.observationRef, 512),
        observedAt: fact.observedAt === null ? null : canonicalInstant(fact.observedAt),
      });
    })
    .sort((left, right) => left.providerKey.localeCompare(right.providerKey));
  if (
    facts.length !== providerKeys.size ||
    facts.some((fact, index) => index > 0 && facts[index - 1]!.providerKey === fact.providerKey)
  )
    throw new Error("MODEL_AVAILABILITY_PROVIDER_COVERAGE_INVALID");
  return Object.freeze(facts);
}

function identifier(value: string): string {
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value))
    throw new Error("MODEL_IDENTIFIER_INVALID");
  return value;
}

function boundedText(value: string, maximum: number): string {
  if (value.length < 1 || value.length > maximum) throw new Error("MODEL_TEXT_INVALID");
  return value;
}

function canonicalInstant(value: string): string {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error("MODEL_AVAILABILITY_TIME_INVALID");
  return instant.toISOString();
}
