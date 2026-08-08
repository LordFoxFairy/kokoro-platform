export const DEPLOYMENT_ENVIRONMENTS = Object.freeze([
  "development",
  "preview",
  "staging",
  "production",
] as const);

export type DeploymentEnvironment = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

export function isDeploymentEnvironment(value: unknown): value is DeploymentEnvironment {
  return value === "development" || value === "preview" ||
    value === "staging" || value === "production";
}
