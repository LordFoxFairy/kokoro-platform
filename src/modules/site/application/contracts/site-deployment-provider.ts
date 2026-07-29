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
}

export interface SitePromotionObservation {
  readonly status: "ready" | "pending" | "unknown" | "rejected";
  readonly deploymentRef: string | null;
  readonly observedAt: string;
  readonly payloadDigest: string;
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
  readonly payloadDigest: string;
}

/** Provider effects are idempotent by operationKey; observations must be provider-authored facts. */
export interface SiteDeploymentProvider {
  readonly namespace: string;
  promote(command: SitePromotionCommand, signal: AbortSignal): Promise<SitePromotionObservation>;
  observePromotion(command: SitePromotionCommand, signal: AbortSignal): Promise<SitePromotionObservation>;
  stopTraffic(command: SiteTrafficStopCommand, signal: AbortSignal): Promise<SiteTrafficStopProviderObservation>;
  observeTrafficStop(command: SiteTrafficStopCommand, signal: AbortSignal): Promise<SiteTrafficStopProviderObservation>;
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
