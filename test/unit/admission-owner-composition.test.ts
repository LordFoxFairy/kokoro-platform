import { describe, expect, it, vi } from "vitest";
import {
  createAdmissionProductionOwnerPorts,
  loadAdmissionOutboundOwnerConfiguration,
} from "../../src/process/admission-owner-composition.js";

const certificate = "-----BEGIN CERTIFICATE-----\ncertificate\n-----END CERTIFICATE-----";
const privateKey = "-----BEGIN PRIVATE KEY-----\nprivate-key\n-----END PRIVATE KEY-----";
const environment = Object.freeze({
  PLATFORM_ADMISSION_OUTBOUND_TLS_CERT_FILE: "/run/secrets/admission/client.crt",
  PLATFORM_ADMISSION_OUTBOUND_TLS_KEY_FILE: "/run/secrets/admission/client.key",
  PLATFORM_ADMISSION_SESSION_CA_FILE: "/run/secrets/admission/session-ca.crt",
  PLATFORM_ADMISSION_AGENT_CA_FILE: "/run/secrets/admission/agent-ca.crt",
  PLATFORM_ADMISSION_SESSION_BASE_URL: "https://session.internal:7443",
  PLATFORM_ADMISSION_SESSION_SERVER_NAME: "session.internal",
  PLATFORM_ADMISSION_AGENT_BASE_URL: "https://agent.internal:7444",
  PLATFORM_ADMISSION_AGENT_SERVER_NAME: "agent.internal",
});

describe("Admission outbound owner composition", () => {
  it("loads one workload identity with independently pinned Session and Agent roots", async () => {
    const readSecret = vi.fn(async (path: string) =>
      path.endsWith("client.key") ? privateKey : certificate);
    const configuration = await loadAdmissionOutboundOwnerConfiguration({
      environment,
      readSecret,
      readPrivateSecret: readSecret,
    });

    expect(configuration.session).toEqual({
      baseUrl: "https://session.internal:7443",
      serverName: "session.internal",
      certificatePem: certificate,
      privateKeyPem: privateKey,
      certificateAuthorityPem: certificate,
    });
    expect(configuration.agent).toMatchObject({
      baseUrl: "https://agent.internal:7444",
      serverName: "agent.internal",
      certificatePem: certificate,
      privateKeyPem: privateKey,
      certificateAuthorityPem: certificate,
    });
    expect(readSecret).toHaveBeenCalledTimes(4);
  });

  it("creates all three remote owner adapters over their strict mTLS clients", async () => {
    const readSecret = async (path: string) => path.endsWith("client.key") ? privateKey : certificate;
    const ports = await createAdmissionProductionOwnerPorts({
      environment,
      readSecret,
      readPrivateSecret: readSecret,
    });

    expect(typeof ports.session.resolve).toBe("function");
    expect(typeof ports.session.verifyFinalizeReceipts).toBe("function");
    expect(typeof ports.dispatchEvidence.get).toBe("function");
    expect(typeof ports.executionEvidence.resolve).toBe("function");
  });

  it("fails closed when any endpoint or trust reference is absent", async () => {
    const incomplete = { ...environment } as Record<string, string | undefined>;
    delete incomplete.PLATFORM_ADMISSION_AGENT_CA_FILE;

    await expect(loadAdmissionOutboundOwnerConfiguration({
      environment: incomplete,
      readSecret: async () => certificate,
      readPrivateSecret: async () => privateKey,
    })).rejects.toThrowError("PLATFORM_ADMISSION_AGENT_CA_FILE_REQUIRED");
  });
});
