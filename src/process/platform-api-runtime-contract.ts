export const PLATFORM_API_RUNTIME_CONTRACT = Object.freeze({
  trustRootEnvironment: "PLATFORM_API_FILE_TRUST_ROOT",
  trustRootPath: "/run/secrets/platform-api",
  ports: Object.freeze({
    public: Object.freeze({ environment: "PLATFORM_API_PORT", default: 4100 }),
    health: Object.freeze({ environment: "PLATFORM_API_HEALTH_PORT", default: 4101 }),
  }),
  files: Object.freeze([
    file("PLATFORM_PRODUCT_WORKLOAD_REGISTRY_FILE", "product-workloads.json", false,
      "product-workload-registry"),
    file("PLATFORM_SESSION_ACCESS_KEY_RING_FILE", "session-access-keys.json", true,
      "session-access-signing-keyring"),
    file("PLATFORM_AUTHORIZATION_EVENT_KEY_RING_FILE", "authorization-event-keys.json", true,
      "authorization-event-signing-keyring"),
    file("PLATFORM_PUBLIC_TLS_KEY_FILE", "public-tls.key", true, "mtls-server"),
    file("PLATFORM_PUBLIC_TLS_CERT_FILE", "public-tls.crt", false, "mtls-server"),
    file("PLATFORM_PUBLIC_TLS_CLIENT_CA_FILE", "public-client-ca.crt", false,
      "mtls-client-ca"),
    file("PLATFORM_COMMERCE_REDEMPTION_KEY_RING_FILE", "commerce-redemption-keys.json", true,
      "commerce-redemption-keyring"),
    file("PLATFORM_ASSET_UPLOAD_POLICY_REGISTRY_FILE", "asset-upload-policies.json", false,
      "asset-upload-policy-registry"),
    file("PLATFORM_ASSET_UPLOAD_CAPABILITY_KEY_RING_FILE", "asset-upload-capability-keys.json", true,
      "asset-upload-capability-keyring"),
    file("PLATFORM_IDENTITY_PASSWORD_PEPPER_RING_FILE", "identity-password-peppers.json", true,
      "identity-password-pepper-keyring"),
    file("PLATFORM_IDENTITY_VERIFICATION_DIGEST_KEY_FILE", "identity-verification-digest.key", true,
      "identity-verification-digest-key"),
    file("PLATFORM_IDENTITY_SESSION_DIGEST_KEY_FILE", "identity-session-digest.key", true,
      "identity-session-digest-key"),
    file("PLATFORM_IDENTITY_REFRESH_DIGEST_KEY_FILE", "identity-refresh-digest.key", true,
      "identity-refresh-digest-key"),
    file("PLATFORM_IDENTITY_REAUTH_DIGEST_KEY_FILE", "identity-reauth-digest.key", true,
      "identity-reauthentication-digest-key"),
    file("PLATFORM_IDENTITY_AUDIT_DIGEST_KEY_FILE", "identity-audit-digest.key", true,
      "identity-audit-digest-key"),
    file("PLATFORM_IDENTITY_DELIVERY_KEY_FILE", "identity-delivery.key", true,
      "identity-delivery-encryption-key"),
    file("PLATFORM_IDENTITY_TOTP_KEY_RING_FILE", "identity-totp-keys.json", true,
      "identity-totp-encryption-keyring"),
  ]),
});

export interface PlatformApiBoundedFileReader {
  readPrivate(path: string, maximumBytes: number, invalidCode: string): Promise<string>;
  readRegular(path: string, maximumBytes: number, invalidCode: string): Promise<string>;
}

export interface PlatformApiRuntimeFileReader {
  read(
    environment: PlatformApiFileEnvironment,
    path: string,
    maximumBytes: number,
    invalidCode: string,
  ): Promise<string>;
}

const FILE_CONTRACT_BY_ENVIRONMENT = new Map(
  PLATFORM_API_RUNTIME_CONTRACT.files.map((entry) => [entry.environment, entry] as const),
);

export function createPlatformApiRuntimeFileReader(
  reader: PlatformApiBoundedFileReader,
): PlatformApiRuntimeFileReader {
  return Object.freeze({
    read(
      environment: PlatformApiFileEnvironment,
      path: string,
      maximumBytes: number,
      invalidCode: string,
    ) {
      const contract = FILE_CONTRACT_BY_ENVIRONMENT.get(environment);
      if (contract === undefined) throw new Error("PLATFORM_API_FILE_CONTRACT_INVALID");
      return contract.privateMaterial
        ? reader.readPrivate(path, maximumBytes, invalidCode)
        : reader.readRegular(path, maximumBytes, invalidCode);
    },
  });
}

export function loadPlatformApiRuntimePorts(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<{ public: number; health: number }> {
  return Object.freeze({
    public: runtimePort(PLATFORM_API_RUNTIME_CONTRACT.ports.public, environment),
    health: runtimePort(PLATFORM_API_RUNTIME_CONTRACT.ports.health, environment),
  });
}

function file<
  const Environment extends string,
  const Filename extends string,
  const PrivateMaterial extends boolean,
  const SecretClass extends string,
>(
  environment: Environment,
  filename: Filename,
  privateMaterial: PrivateMaterial,
  secretClass: SecretClass,
) {
  return Object.freeze({ environment, filename, privateMaterial, secretClass });
}

export type PlatformApiFileEnvironment =
  typeof PLATFORM_API_RUNTIME_CONTRACT.files[number]["environment"];

function runtimePort(
  contract: Readonly<{ environment: string; default: number }>,
  environment: Readonly<Record<string, string | undefined>>,
): number {
  const raw = environment[contract.environment] ?? String(contract.default);
  if (!/^[1-9][0-9]{0,4}$/u.test(raw)) throw new Error(`${contract.environment}_INVALID`);
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error(`${contract.environment}_INVALID`);
  }
  return port;
}
