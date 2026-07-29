import { verify } from "otplib";
import type { IdentityTotpVerifierPort } from "../../application/contracts/identity-security-ports.js";

export function createIdentityTotpVerifier(): IdentityTotpVerifierPort {
  return Object.freeze({
    async verify(input: Parameters<IdentityTotpVerifierPort["verify"]>[0]) {
      if (!/^\d{6}$/u.test(input.code) || !Number.isSafeInteger(input.epochSeconds) || input.epochSeconds < 0) {
        return Object.freeze({ valid: false as const });
      }
      try {
        const result = await verify({
          strategy: "totp",
          secret: input.secret,
          token: input.code,
          epoch: input.epochSeconds,
          epochTolerance: 30,
          ...(input.afterTimeStep === null ? {} : { afterTimeStep: input.afterTimeStep }),
        });
        return result.valid && "timeStep" in result
          ? Object.freeze({ valid: true as const, timeStep: result.timeStep })
          : Object.freeze({ valid: false as const });
      } catch {
        return Object.freeze({ valid: false as const });
      }
    },
  });
}
