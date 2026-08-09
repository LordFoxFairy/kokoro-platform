export const COMMERCE_PUBLIC_LOCK_ROUTINES = Object.freeze([
  "platform.lock_commerce_command_authority(text,text,text,text)",
  "platform.lock_commerce_redemption_program_authority(text,text,text,text,text)",
  "platform.lock_commerce_redemption_plan_authority(text,text,text,text,text)",
  "platform.lock_commerce_redemption_batch_authority(uuid,text,text,text,text)",
  "platform.lock_commerce_redemption_billing_authority(text,text,text,text,text)",
] as const);

export const COMMERCE_PUBLIC_LOCK_ROUTINES_SQL = COMMERCE_PUBLIC_LOCK_ROUTINES.join(", ");

export const COMMERCE_PUBLIC_LOCK_REGPROCEDURES_SQL = COMMERCE_PUBLIC_LOCK_ROUTINES
  .map((routine) => `to_regprocedure('${routine}')`)
  .join(",\n                 ");

export function commercePublicLockPrivilegeChecks(
  roleExpression: "current_user" | "runtime_role.rolname",
): string {
  return COMMERCE_PUBLIC_LOCK_ROUTINES
    .map((routine) => `has_function_privilege(${roleExpression}, '${routine}','EXECUTE')`)
    .join("\n           AND ");
}
