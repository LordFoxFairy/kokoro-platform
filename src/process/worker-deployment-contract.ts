export interface ProcessDeploymentContract {
  readonly id: "platform-worker" | "platform-identity-worker";
  readonly environment: Readonly<{
    required: readonly string[];
    optional: readonly string[];
  }>;
  readonly outboundContracts: readonly string[];
  readonly secretClasses: readonly string[];
}

export const PLATFORM_WORKER_DEPLOYMENT_CONTRACT = contract({
  id: "platform-worker",
  environment: {
    required: [
      "DATABASE_URL_PLATFORM",
      "PLATFORM_DATABASE_CREDENTIAL_CLASS",
      "PLATFORM_DATABASE_EXPECTED_DATABASE",
      "PLATFORM_DATABASE_MIGRATOR_ROLE",
      "PLATFORM_DATABASE_WORKER_ROLE",
      "PLATFORM_WORKER_ID",
      "PLATFORM_OUTBOX_DELIVERY_ENDPOINT",
      "PLATFORM_OUTBOX_DELIVERY_KEY_ID",
      "PLATFORM_OUTBOX_DELIVERY_SECRET_BASE64",
      "PLATFORM_SITE_PROVIDER_REGISTRY_FILE",
      "PLATFORM_AUTHORIZATION_EVENT_KEY_RING_FILE",
    ],
    optional: [
      "PLATFORM_AUTHORIZATION_EVENT_RETENTION_DAYS",
      "PLATFORM_OUTBOX_DELIVERY_TIMEOUT_MS",
      "PLATFORM_SITE_OUTBOX_CLAIM_LIMIT",
      "PLATFORM_SITE_OUTBOX_LEASE_SECONDS",
      "PLATFORM_ASSET_WORKER_ENABLED",
      "PLATFORM_ENVIRONMENT",
      "PLATFORM_REGION",
      "PLATFORM_ASSET_OUTBOX_CLAIM_LIMIT",
      "PLATFORM_ASSET_OUTBOX_LEASE_SECONDS",
      "PLATFORM_WORKER_HEALTH_PORT",
    ],
  },
  outboundContracts: [
    "commerce-credit-outbox-delivery-https",
    "site-deployment-provider-https",
  ],
  secretClasses: [
    "platform-worker-database",
    "authorization-event-signing-keyring",
    "commerce-credit-outbox-delivery-hmac-key",
    "site-provider-registry",
    "site-provider-bearer-tokens",
  ],
});

export const PLATFORM_IDENTITY_WORKER_DEPLOYMENT_CONTRACT = contract({
  id: "platform-identity-worker",
  environment: {
    required: [
      "DATABASE_URL_PLATFORM",
      "PLATFORM_DATABASE_CREDENTIAL_CLASS",
      "PLATFORM_DATABASE_EXPECTED_DATABASE",
      "PLATFORM_DATABASE_MIGRATOR_ROLE",
      "PLATFORM_DATABASE_IDENTITY_WORKER_ROLE",
      "PLATFORM_WORKER_ID",
      "PLATFORM_IDENTITY_AUDIT_DIGEST_KEY_FILE",
      "PLATFORM_IDENTITY_SECRET_TRUST_ROOT",
      "PLATFORM_IDENTITY_DELIVERY_ENDPOINT",
      "PLATFORM_IDENTITY_DELIVERY_HMAC_KEY_ID",
      "PLATFORM_IDENTITY_DELIVERY_HMAC_SECRET_FILE",
    ],
    optional: ["PLATFORM_IDENTITY_DELIVERY_TIMEOUT_MS", "PLATFORM_WORKER_HEALTH_PORT"],
  },
  outboundContracts: ["identity-verification-delivery-https"],
  secretClasses: [
    "platform-identity-worker-database",
    "identity-audit-digest-key",
    "identity-delivery-hmac-key",
  ],
});

export function resolveProcessDeploymentEnvironment(
  deployment: ProcessDeploymentContract,
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const resolved: Record<string, string | undefined> = {};
  for (const name of deployment.environment.required) {
    const value = environment[name];
    if (value === undefined || value.length === 0) throw new Error(`${name}_REQUIRED`);
    resolved[name] = value;
  }
  for (const name of deployment.environment.optional) {
    if (environment[name] !== undefined) resolved[name] = environment[name];
  }
  return Object.freeze(resolved);
}

function contract<const Contract extends ProcessDeploymentContract>(
  value: Contract,
): Contract {
  if (
    new Set(value.environment.required).size !== value.environment.required.length ||
    new Set(value.environment.optional).size !== value.environment.optional.length ||
    value.environment.required.some((name) => value.environment.optional.includes(name))
  ) throw new Error("PROCESS_DEPLOYMENT_CONTRACT_INVALID");
  return Object.freeze({
    ...value,
    environment: Object.freeze({
      required: Object.freeze([...value.environment.required]),
      optional: Object.freeze([...value.environment.optional]),
    }),
    outboundContracts: Object.freeze([...value.outboundContracts]),
    secretClasses: Object.freeze([...value.secretClasses]),
  }) as Contract;
}
