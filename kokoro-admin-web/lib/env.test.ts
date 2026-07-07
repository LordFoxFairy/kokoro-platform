import { describe, expect, it } from "vitest";

const base = {
  AUTH_SECRET: "secret",
  DATABASE_URL_ADMIN: "mysql://user:pass@127.0.0.1:3307/kokoro_admin",
  KOKORO_GATEWAY_URL: "http://127.0.0.1:4290",
  KOKORO_ADMIN_PROXY_SECRET: "proxy-secret",
};

Object.assign(process.env, base);
const { assertSmtpConfigured, parseEnv } = await import("./env");

describe("parseEnv", () => {
  it("allows development without SMTP so magic links can print to the server console", () => {
    const env = parseEnv({ ...base, NODE_ENV: "development" });
    expect(env.EMAIL_SERVER_HOST).toBeUndefined();
    expect(env.EMAIL_FROM).toBe("no-reply@kokoro.local");
  });

  it("allows build-time parsing in production when SMTP is runtime-provided", () => {
    const env = parseEnv({ ...base, NODE_ENV: "production" });
    expect(env.EMAIL_SERVER_HOST).toBeUndefined();
  });

  it("fails at email runtime in production when SMTP host is missing", () => {
    const env = parseEnv({ ...base, NODE_ENV: "production", EMAIL_SERVER_PORT: "587" });
    expect(() => assertSmtpConfigured(env)).toThrow(
      /EMAIL_SERVER_HOST/,
    );
  });

  it("fails at email runtime in production when SMTP port is missing", () => {
    const env = parseEnv({ ...base, NODE_ENV: "production", EMAIL_SERVER_HOST: "smtp.example.com" });
    expect(() => assertSmtpConfigured(env)).toThrow(
      /EMAIL_SERVER_PORT/,
    );
  });
});
