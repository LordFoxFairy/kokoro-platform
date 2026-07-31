export type MemoryApplicationErrorCode =
  | "MEMORY_AUTHORIZATION_DENIED"
  | "MEMORY_AUTHORIZATION_FACTS_STALE"
  | "MEMORY_COMMAND_DIGEST_CONFLICT"
  | "MEMORY_ENTRY_NOT_FOUND"
  | "MEMORY_PARENT_SCOPE_INVALID"
  | "MEMORY_PERSISTENCE_CONFLICT"
  | "MEMORY_RECEIPT_INVALID"
  | "MEMORY_SPACE_NOT_FOUND";

export class MemoryApplicationError extends Error {
  readonly name = "MemoryApplicationError";

  constructor(readonly code: MemoryApplicationErrorCode) {
    super(code);
  }
}
