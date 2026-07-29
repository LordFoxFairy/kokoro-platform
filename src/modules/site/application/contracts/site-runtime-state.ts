import type {
  SitePromotionCommand,
  SitePromotionObservation,
  SiteTrafficStopCommand,
  SiteTrafficStopProviderObservation,
} from "./site-deployment-provider.js";

export type SiteRuntimeStep =
  | Readonly<{ kind: "complete" }>
  | Readonly<{ kind: "promote" | "observe_promotion"; providerNamespace: string; command: SitePromotionCommand }>
  | Readonly<{ kind: "stop_activation_drain"; providerNamespace: string; command: SiteTrafficStopCommand }>
  | Readonly<{ kind: "stop_site_traffic" | "observe_site_traffic"; providerNamespace: string;
    command: SiteTrafficStopCommand }>;

export interface SiteRuntimeStateStore {
  prepareActivation(attemptRef: string): Promise<SiteRuntimeStep>;
  acceptPromotion(attemptRef: string, observation: SitePromotionObservation): Promise<SiteRuntimeStep>;
  acceptActivationDrain(
    attemptRef: string,
    observation: SiteTrafficStopProviderObservation,
  ): Promise<SiteRuntimeStep>;
  prepareTrafficStop(attemptRef: string): Promise<SiteRuntimeStep>;
  acceptTrafficStop(
    attemptRef: string,
    observation: SiteTrafficStopProviderObservation,
  ): Promise<SiteRuntimeStep>;
}
