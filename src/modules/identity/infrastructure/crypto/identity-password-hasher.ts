import { createHmac } from "node:crypto";
import { Algorithm, hash, verify } from "@node-rs/argon2";

export type IdentityPasswordHash = Readonly<{
  passwordHash: string;
  pepperVersion: number;
}>;

type Pepper = Readonly<{
  version: number;
  secret: Uint8Array;
}>;

export type IdentityPasswordHasherConfig = Readonly<{
  currentPepperVersion: number;
  peppers: readonly Pepper[];
  memoryCostKiB: number;
  timeCost: number;
  parallelism: number;
}>;

export type IdentityPasswordHasher = Readonly<{
  hash(password: string): Promise<IdentityPasswordHash>;
  verify(password: string, stored: IdentityPasswordHash): Promise<boolean>;
}>;

function prehashPassword(password: string, pepper: Uint8Array): string {
  // The Argon2 binding verifies textual inputs. Base64url preserves every bit
  // of the keyed prehash without introducing a second interpretation of bytes.
  return createHmac("sha256", pepper).update(password, "utf8").digest("base64url");
}

export function createIdentityPasswordHasher(
  config: IdentityPasswordHasherConfig,
): IdentityPasswordHasher {
  if (
    !Number.isSafeInteger(config.currentPepperVersion) ||
    config.currentPepperVersion < 1 ||
    !Number.isSafeInteger(config.memoryCostKiB) ||
    config.memoryCostKiB < 19_456 ||
    !Number.isSafeInteger(config.timeCost) ||
    config.timeCost < 2 ||
    !Number.isSafeInteger(config.parallelism) ||
    config.parallelism < 1
  ) {
    throw new Error("IDENTITY_PASSWORD_HASHER_CONFIG_INVALID");
  }

  const peppers = new Map<number, Uint8Array>();
  for (const pepper of config.peppers) {
    if (
      !Number.isSafeInteger(pepper.version) ||
      pepper.version < 1 ||
      pepper.secret.byteLength < 32 ||
      peppers.has(pepper.version)
    ) {
      throw new Error("IDENTITY_PASSWORD_HASHER_CONFIG_INVALID");
    }
    peppers.set(pepper.version, Uint8Array.from(pepper.secret));
  }
  const currentPepper = peppers.get(config.currentPepperVersion);
  if (currentPepper === undefined) {
    throw new Error("IDENTITY_PASSWORD_HASHER_CONFIG_INVALID");
  }

  const argonOptions = {
    algorithm: Algorithm.Argon2id,
    memoryCost: config.memoryCostKiB,
    timeCost: config.timeCost,
    parallelism: config.parallelism,
    outputLen: 32,
  } as const;

  return {
    async hash(password) {
      const passwordHash = await hash(prehashPassword(password, currentPepper), argonOptions);
      return { passwordHash, pepperVersion: config.currentPepperVersion };
    },
    async verify(password, stored) {
      const pepper = peppers.get(stored.pepperVersion);
      if (pepper === undefined || !stored.passwordHash.startsWith("$argon2id$")) {
        return false;
      }
      try {
        return await verify(stored.passwordHash, prehashPassword(password, pepper));
      } catch {
        return false;
      }
    },
  };
}
