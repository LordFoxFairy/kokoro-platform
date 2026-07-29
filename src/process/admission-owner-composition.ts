import { createAgentExecutionEvidenceClient } from "../interfaces/connect/agent-execution-evidence-client.js";
import { createSessionDispatchOwnerEvidenceClient } from "../interfaces/connect/dispatch-owner-evidence-client.js";
import { createSessionAdmissionOwnerClient } from "../interfaces/connect/session-admission-owner-client.js";
import type { AdmissionProductionOwnerPorts } from "./admission-composition.js";
import { readBoundedPrivateSecret, readBoundedSecret } from "./platform-public-composition.js";

const CERTIFICATE_MAXIMUM_BYTES = 64 * 1024;
const CERTIFICATE_AUTHORITY_MAXIMUM_BYTES = 256 * 1024;

export interface AdmissionOutboundOwnerConfiguration {
  readonly session: Readonly<{
    baseUrl: string;
    serverName: string;
    certificatePem: string;
    privateKeyPem: string;
    certificateAuthorityPem: string;
  }>;
  readonly agent: Readonly<{
    baseUrl: string;
    serverName: string;
    certificatePem: string;
    privateKeyPem: string;
    certificateAuthorityPem: string;
  }>;
}

type SecretReader = (path: string, maximumBytes: number) => Promise<string>;

/**
 * Loads one Admission workload identity and independently pinned trust roots for
 * the Session and Agent owner services. There is deliberately no plaintext,
 * HTTP/1.1, system-CA, or environment-secret fallback.
 */
export async function loadAdmissionOutboundOwnerConfiguration(input: Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  readSecret?: SecretReader;
  readPrivateSecret?: SecretReader;
}> = {}): Promise<AdmissionOutboundOwnerConfiguration> {
  const environment = input.environment ?? process.env;
  const readSecret = input.readSecret ?? readBoundedSecret;
  const readPrivateSecret = input.readPrivateSecret ?? readBoundedPrivateSecret;
  const [certificatePem, privateKeyPem, sessionCaPem, agentCaPem] = await Promise.all([
    readSecret(
      required(environment, "PLATFORM_ADMISSION_OUTBOUND_TLS_CERT_FILE"),
      CERTIFICATE_MAXIMUM_BYTES,
    ),
    readPrivateSecret(
      required(environment, "PLATFORM_ADMISSION_OUTBOUND_TLS_KEY_FILE"),
      CERTIFICATE_MAXIMUM_BYTES,
    ),
    readSecret(
      required(environment, "PLATFORM_ADMISSION_SESSION_CA_FILE"),
      CERTIFICATE_AUTHORITY_MAXIMUM_BYTES,
    ),
    readSecret(
      required(environment, "PLATFORM_ADMISSION_AGENT_CA_FILE"),
      CERTIFICATE_AUTHORITY_MAXIMUM_BYTES,
    ),
  ]);
  return Object.freeze({
    session: Object.freeze({
      baseUrl: required(environment, "PLATFORM_ADMISSION_SESSION_BASE_URL"),
      serverName: required(environment, "PLATFORM_ADMISSION_SESSION_SERVER_NAME"),
      certificatePem,
      privateKeyPem,
      certificateAuthorityPem: sessionCaPem,
    }),
    agent: Object.freeze({
      baseUrl: required(environment, "PLATFORM_ADMISSION_AGENT_BASE_URL"),
      serverName: required(environment, "PLATFORM_ADMISSION_AGENT_SERVER_NAME"),
      certificatePem,
      privateKeyPem,
      certificateAuthorityPem: agentCaPem,
    }),
  });
}

export async function createAdmissionProductionOwnerPorts(input: Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  readSecret?: SecretReader;
  readPrivateSecret?: SecretReader;
}> = {}): Promise<AdmissionProductionOwnerPorts> {
  const configuration = await loadAdmissionOutboundOwnerConfiguration(input);
  return Object.freeze({
    session: createSessionAdmissionOwnerClient(configuration.session),
    dispatchEvidence: createSessionDispatchOwnerEvidenceClient(configuration.session),
    executionEvidence: createAgentExecutionEvidenceClient(configuration.agent),
  });
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
