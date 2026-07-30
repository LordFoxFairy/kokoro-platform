import { createHash } from "node:crypto";

export interface SitePromotionCommand {
  readonly operationKey: string;
  readonly siteRef: string;
  readonly providerProjectRef: string;
  readonly releaseRef: string;
  readonly webArtifactDigest: string;
  readonly releaseManifestDigest: string;
  readonly certificationDigest: string;
  readonly environment: "development" | "preview" | "production";
  readonly region: string;
  readonly audience: string;
  readonly sessionContractRevision: string;
}

export interface SitePromotionObservation {
  readonly status: "ready" | "pending" | "unknown" | "rejected";
  readonly deploymentRef: string | null;
  readonly observedAt: string;
  readonly operationKey: string;
  readonly siteRef: string;
  readonly providerProjectRef: string;
  readonly releaseRef: string;
  readonly webArtifactDigest: string;
  readonly releaseManifestDigest: string;
  readonly certificationDigest: string;
  readonly environment: SitePromotionCommand["environment"];
  readonly region: string;
  readonly audience: string;
  readonly sessionContractRevision: string;
  readonly commandDigest: string;
  readonly payloadDigest: string;
}

export function sitePromotionCommandDigest(command: SitePromotionCommand): string {
  return commandDigest("kokoro-site-provider-promotion-command-v1", [
    command.operationKey, command.siteRef, command.providerProjectRef, command.releaseRef,
    command.webArtifactDigest, command.releaseManifestDigest, command.certificationDigest,
    command.environment, command.region, command.audience, command.sessionContractRevision,
  ]);
}

export interface SiteTrafficStopCommand {
  readonly operationKey: string;
  readonly siteRef: string;
  readonly providerProjectRef: string;
  readonly deploymentRef: string;
  readonly environment: "development" | "preview" | "production";
  readonly region: string;
}

export interface SiteTrafficStopProviderObservation {
  readonly status: "stopped" | "serving" | "unknown" | "rejected";
  readonly observedAt: string;
  readonly operationKey: string;
  readonly siteRef: string;
  readonly providerProjectRef: string;
  readonly deploymentRef: string;
  readonly environment: SiteTrafficStopCommand["environment"];
  readonly region: string;
  readonly commandDigest: string;
  readonly payloadDigest: string;
}

export function siteTrafficStopCommandDigest(command: SiteTrafficStopCommand): string {
  return commandDigest("kokoro-site-provider-traffic-stop-command-v1", [
    command.operationKey, command.siteRef, command.providerProjectRef, command.deploymentRef,
    command.environment, command.region,
  ]);
}

/** Provider effects are idempotent by operationKey; observations must be provider-authored facts. */
export interface SiteDeploymentProvider {
  readonly namespace: string;
  promote(command: SitePromotionCommand, signal: AbortSignal): Promise<SitePromotionObservation>;
  observePromotion(command: SitePromotionCommand, signal: AbortSignal): Promise<SitePromotionObservation>;
  stopTraffic(command: SiteTrafficStopCommand, signal: AbortSignal): Promise<SiteTrafficStopProviderObservation>;
  observeTrafficStop(command: SiteTrafficStopCommand, signal: AbortSignal): Promise<SiteTrafficStopProviderObservation>;
}

export class SiteProviderEffectError extends Error {
  constructor(
    readonly outcome: "failed" | "unknown",
    readonly code: string,
  ) {
    super(code);
    if (!/^[A-Z][A-Z0-9_]{2,127}$/u.test(code)) throw new Error("SITE_PROVIDER_ERROR_CODE_INVALID");
  }
}

export class SiteDeploymentProviderRegistry {
  readonly #providers: ReadonlyMap<string, SiteDeploymentProvider>;

  constructor(providers: readonly SiteDeploymentProvider[]) {
    if (providers.length === 0) throw new Error("SITE_PROVIDER_REGISTRY_EMPTY");
    const entries = providers.map((provider) => {
      if (!/^[a-z][a-z0-9.-]{1,63}$/u.test(provider.namespace)) {
        throw new Error("SITE_PROVIDER_NAMESPACE_INVALID");
      }
      return [provider.namespace, provider] as const;
    });
    if (new Set(entries.map(([namespace]) => namespace)).size !== entries.length) {
      throw new Error("SITE_PROVIDER_NAMESPACE_DUPLICATE");
    }
    this.#providers = new Map(entries);
  }

  require(namespace: string): SiteDeploymentProvider {
    const provider = this.#providers.get(namespace);
    if (provider === undefined) throw new Error(`SITE_PROVIDER_NOT_CONFIGURED:${namespace}`);
    return provider;
  }
}

function commandDigest(domain: string, fields: readonly string[]): string {
  if (fields.some((field) => typeof field !== "string" || field.length === 0)) {
    throw new Error("SITE_PROVIDER_COMMAND_INVALID");
  }
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify(fields), "utf8")
    .digest("hex");
}
