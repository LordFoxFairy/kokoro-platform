export type MemoryDatabaseRoleKind = "memory_public" | "memory_runtime" | "memory_worker";
export type MemoryDeploymentType =
  | "platform-api"
  | "platform-memory-runtime"
  | "platform-memory-worker";

export const MEMORY_DATABASE_ROLE_CONTRACTS = Object.freeze([
  Object.freeze({ roleKind: "memory_public", futureLoginRole: "platform_memory_public" }),
  Object.freeze({ roleKind: "memory_runtime", futureLoginRole: "platform_memory_runtime" }),
  Object.freeze({ roleKind: "memory_worker", futureLoginRole: "platform_memory_worker" }),
] as const satisfies readonly Readonly<{
  roleKind: MemoryDatabaseRoleKind;
  futureLoginRole: string;
}>[]);

/** Dormant deployment identities only; no process, listener, readiness, or credential is composed in M0. */
export const MEMORY_DEPLOYMENT_TYPES = Object.freeze([
  "platform-api",
  "platform-memory-runtime",
  "platform-memory-worker",
] as const satisfies readonly MemoryDeploymentType[]);
