import type { JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import { defineAdminCommand } from "../../domain/admin-command.js";
import type { AdminLocalCommandHandler } from "../../application/admin-command-service.js";

export function createAdminAuthorityCommandHandler(): AdminLocalCommandHandler {
  const execute: AdminLocalCommandHandler["execute"] = async (transaction, input) => {
    if (input.approval === undefined) throw new Error("ADMIN_AUTHORITY_APPROVAL_REQUIRED");
    const rows = await resolvePlatformTransaction(transaction).query<{
      result: JsonValue;
    }>(
      `SELECT platform.apply_admin_authority_change($1::uuid,$2::jsonb) AS result`,
      [input.approval.approvalRef, JSON.stringify(input.payload)],
    );
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
