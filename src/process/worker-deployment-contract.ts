export interface ProcessDeploymentContract {
  readonly id:
    | "platform-commerce-worker"
    | "platform-site-worker"
    | "platform-asset-worker"
    | "platform-admin-worker"
    | "platform-identity-worker"
    | "platform-authorization-maintenance"
    | "platform-media-worker";
  readonly environment: Readonly<{
    required: readonly string[];
    optional: readonly string[];
  }>;
  readonly outboundContracts: readonly string[];
  readonly secretClasses: readonly string[];
}

const DATABASE_ENVIRONMENT = Object.freeze([
  "DATABASE_URL_PLATFORM",
  "PLATFORM_DATABASE_CREDENTIAL_CLASS",
  "PLATFORM_DATABASE_EXPECTED_DATABASE",
  "PLATFORM_DATABASE_MIGRATOR_ROLE",
] as const);

export const PLATFORM_COMMERCE_WORKER_DEPLOYMENT_CONTRACT = contract({
  id: "platform-commerce-worker",
  environment: {
    required: [
      ...DATABASE_ENVIRONMENT,
      "PLATFORM_DATABASE_COMMERCE_WORKER_ROLE",
      "PLATFORM_WORKER_ID",
      "PLATFORM_OUTBOX_DELIVERY_ENDPOINT",
      "PLATFORM_OUTBOX_DELIVERY_KEY_ID",
      "PLATFORM_COMMERCE_WORKER_SECRET_TRUST_ROOT",
      "PLATFORM_COMMERCE_OUTBOX_DELIVERY_SECRET_FILE",
    ],
    optional: ["PLATFORM_OUTBOX_DELIVERY_TIMEOUT_MS", "PLATFORM_WORKER_HEALTH_PORT"],
  },
  outboundContracts: ["commerce-credit-outbox-delivery-https"],
  secretClasses: [
    "platform-commerce-worker-database",
    "commerce-credit-outbox-delivery-hmac-key",
  ],
});

export const PLATFORM_SITE_WORKER_DEPLOYMENT_CONTRACT = contract({
  id: "platform-site-worker",
  environment: {
    required: [...DATABASE_ENVIRONMENT, "PLATFORM_DATABASE_SITE_WORKER_ROLE", "PLATFORM_WORKER_ID",
      "PLATFORM_SITE_PROVIDER_REGISTRY_FILE", "PLATFORM_AUTHORIZATION_EVENT_KEY_RING_FILE"],
    optional: ["PLATFORM_SITE_OUTBOX_CLAIM_LIMIT", "PLATFORM_SITE_OUTBOX_LEASE_SECONDS",
      "PLATFORM_WORKER_HEALTH_PORT"],
  },
  outboundContracts: ["site-deployment-provider-https"],
  secretClasses: [
    "platform-site-worker-database",
    "authorization-event-signing-keyring",
    "site-provider-registry",
    "site-provider-bearer-tokens",
  ],
});

export const PLATFORM_ASSET_WORKER_DEPLOYMENT_CONTRACT = contract({
  id: "platform-asset-worker",
  environment: {
    required: [...DATABASE_ENVIRONMENT, "PLATFORM_DATABASE_ASSET_WORKER_ROLE", "PLATFORM_WORKER_ID",
      "PLATFORM_ENVIRONMENT", "PLATFORM_REGION", "PLATFORM_ASSET_WORKER_SECRET_TRUST_ROOT",
      "PLATFORM_ASSET_STORAGE_ROUTE_FILE", "PLATFORM_ASSET_INSPECTION_POLICY_REGISTRY_FILE",
      "PLATFORM_ASSET_SCANNER_ENDPOINT", "PLATFORM_ASSET_SCANNER_AUDIENCE",
      "PLATFORM_ASSET_SCANNER_TOKEN_FILE", "PLATFORM_ASSET_SCANNER_TLS_CA_FILE",
      "PLATFORM_ASSET_SCANNER_TLS_CERT_FILE", "PLATFORM_ASSET_SCANNER_TLS_KEY_FILE"],
    optional: ["PLATFORM_ASSET_SCANNER_TIMEOUT_MS", "PLATFORM_ASSET_OUTBOX_CLAIM_LIMIT",
      "PLATFORM_ASSET_OUTBOX_LEASE_SECONDS", "PLATFORM_WORKER_HEALTH_PORT"],
  },
  outboundContracts: ["asset-security-scanner-mtls", "s3-object-api"],
  secretClasses: ["platform-asset-worker-database", "asset-storage-route-registry",
    "asset-scanner-bearer-token", "asset-scanner-mtls-client"],
});

export const PLATFORM_ADMIN_WORKER_DEPLOYMENT_CONTRACT = contract({
  id: "platform-admin-worker",
  environment: {
    required: [...DATABASE_ENVIRONMENT, "PLATFORM_DATABASE_ADMIN_WORKER_ROLE", "PLATFORM_WORKER_ID"],
    optional: ["PLATFORM_WORKER_HEALTH_PORT"],
  },
  outboundContracts: [],
  secretClasses: ["platform-admin-worker-database"],
});

export const PLATFORM_AUTHORIZATION_MAINTENANCE_DEPLOYMENT_CONTRACT = contract({
  id: "platform-authorization-maintenance",
  environment: {
    required: [...DATABASE_ENVIRONMENT, "PLATFORM_DATABASE_AUTHORIZATION_MAINTENANCE_ROLE"],
    optional: ["PLATFORM_AUTHORIZATION_EVENT_RETENTION_DAYS"],
  },
  outboundContracts: [],
  secretClasses: ["platform-authorization-maintenance-database"],
});

export const PLATFORM_IDENTITY_WORKER_DEPLOYMENT_CONTRACT = contract({
  id: "platform-identity-worker",
  environment: {
    required: [
      ...DATABASE_ENVIRONMENT,
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

/** Inventory contract only. Activation remains blocked by docs/platform/media-worker-launch-blockers.md. */
export const PLATFORM_MEDIA_WORKER_DEPLOYMENT_CONTRACT = contract({
  id: "platform-media-worker",
  environment: {
    required: [...DATABASE_ENVIRONMENT, "PLATFORM_DATABASE_MEDIA_WORKER_ROLE", "PLATFORM_WORKER_ID",
      "PLATFORM_MEDIA_WORKER_SECRET_TRUST_ROOT", "PLATFORM_MEDIA_INPUT_KEY_RING_FILE",
      "PLATFORM_MEDIA_CAPABILITY_KEY_RING_FILE", "PLATFORM_ARTIFACT_STORAGE_ROUTE_FILE",
      "PLATFORM_MODEL_GATEWAY_IMAGE_ENDPOINT",
      "PLATFORM_SESSION_PROJECTION_ENDPOINT"],
    optional: ["PLATFORM_MEDIA_WORKER_MAX_ATTEMPTS", "PLATFORM_MEDIA_WORKER_LEASE_SECONDS",
      "PLATFORM_MODEL_GATEWAY_IMAGE_TIMEOUT_MS", "PLATFORM_SESSION_PROJECTION_TIMEOUT_MS",
      "PLATFORM_WORKER_HEALTH_PORT"],
  },
  outboundContracts: ["model-gateway-image-effect-connectrpc", "s3-object-api",
    "session-media-projection-connectrpc"],
  secretClasses: ["platform-media-worker-database", "media-operation-input-keyring",
    "media-effect-capability-keyring", "artifact-storage-route-registry"],
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
