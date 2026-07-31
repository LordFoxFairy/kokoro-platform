export type MemoryDatabaseRoleKind = "memory_public" | "memory_runtime" | "memory_worker";
export type MemoryDeploymentType =
  | "platform-api"
  | "platform-memory-runtime"
  | "platform-memory-worker";

export const MEMORY_DATABASE_ROLE_CONTRACTS = Object.freeze([
  Object.freeze({ roleKind: "memory_public", loginRole: "platform_memory_public" }),
  Object.freeze({ roleKind: "memory_runtime", loginRole: "platform_memory_runtime" }),
  Object.freeze({ roleKind: "memory_worker", loginRole: "platform_memory_worker" }),
] as const satisfies readonly Readonly<{
  roleKind: MemoryDatabaseRoleKind;
  loginRole: string;
}>[]);

/** Database logins exist; process credentials, listeners, readiness and composition remain inactive. */
export const MEMORY_DEPLOYMENT_TYPES = Object.freeze([
  "platform-api",
  "platform-memory-runtime",
  "platform-memory-worker",
] as const satisfies readonly MemoryDeploymentType[]);
