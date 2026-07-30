import type { AssetOwnerAuthority } from "../../application/asset-user-authority.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

/** Applies the verified owner axes required by Asset's forced-RLS policies. */
export async function applyAssetOwnerScope(
  transaction: PlatformTransaction,
  input: AssetOwnerAuthority & Readonly<{ purpose: string }>,
): Promise<void> {
  await resolvePlatformTransaction(transaction).query(
    `SELECT set_config('app.site_id',$1,true),
            set_config('app.subject_id',$2,true),
            set_config('app.subject_generation',$3,true),
            set_config('app.project_id',$4,true),
            set_config('app.purpose',$5,true)`,
    [input.siteRef, input.subjectRef, input.subjectGeneration.toString(), input.projectRef, input.purpose],
  );
}
