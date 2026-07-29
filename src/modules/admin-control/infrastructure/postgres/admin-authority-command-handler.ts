import type { JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import { defineAdminCommand } from "../../domain/admin-command.js";
import type { AdminLocalCommandHandler } from "../../application/admin-command-service.js";

export function createAdminAuthorityCommandHandler(): AdminLocalCommandHandler {
  const execute: AdminLocalCommandHandler["execute"] = async (transaction, input) => {
    if (input.approval === undefined) throw new Error("ADMIN_AUTHORITY_APPROVAL_REQUIRED");
    let rows: readonly { result: JsonValue }[];
    try {
      rows = await resolvePlatformTransaction(transaction).query<{ result: JsonValue }>(
        `SELECT platform.apply_admin_authority_change($1::uuid,$2::jsonb) AS result`,
        [input.approval.approvalRef, JSON.stringify(input.payload)],
      );
    } catch (error) {
      const code = permanentAuthorityRejection(error);
      if (code !== null) {
        return Object.freeze({ disposition: "rejected" as const, code, result: { code } });
      }
      throw error;
    }
    if (rows.length !== 1 || rows[0] === undefined) {
      throw new Error("ADMIN_AUTHORITY_CHANGE_FAILED");
    }
    return Object.freeze({ disposition: "succeeded" as const, result: rows[0].result });
  };
  return Object.freeze({
    definition: defineAdminCommand({
      commandId: "admin.authority.change",
      permission: "admin.authority.manage",
      effectClass: "dangerous",
      scopeKind: "global",
      approvalPolicy: "pre_effect",
      reasonRequired: true,
    }),
    execute,
  });
}

function permanentAuthorityRejection(error: unknown): string | null {
  const code = error instanceof Error ? error.message : "";
  return [
    "ADMIN_AUTHORITY_CHANGE_INVALID",
    "ADMIN_AUTHORITY_EPOCH_CONFLICT",
    "ADMIN_AUTHORITY_QUORUM_REQUIRED",
  ].includes(code) ? code : null;
}
