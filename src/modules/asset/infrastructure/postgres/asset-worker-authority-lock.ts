import type { PlatformSqlTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type { AssetPromotionIntent } from "../../domain/promotion-intent.js";

export interface AssetWorkerAuthorityLock {
  lockUploadCompletion(
    sql: PlatformSqlTransaction,
    input: Readonly<{ siteRef: string; intentRef: string }>,
  ): Promise<boolean>;
  lockPromotion(sql: PlatformSqlTransaction, intent: AssetPromotionIntent): Promise<boolean>;
}

export class PostgresAssetWorkerAuthorityLock implements AssetWorkerAuthorityLock {
  async lockUploadCompletion(
    sql: PlatformSqlTransaction,
    input: Readonly<{ siteRef: string; intentRef: string }>,
  ): Promise<boolean> {
    const rows = await sql.query<{ allowed: boolean }>(
      `SELECT platform.lock_asset_worker_upload_completion_authority(
         $1,$2
       ) AS allowed`,
      [input.siteRef, input.intentRef],
    );
    return rows[0]?.allowed === true;
  }

  async lockPromotion(
    sql: PlatformSqlTransaction,
    intent: AssetPromotionIntent,
  ): Promise<boolean> {
    const rows = await sql.query<{ allowed: boolean }>(
      `SELECT platform.lock_asset_worker_promotion_authority(
         $1,$2,$3,$4::bigint,$5
       ) AS allowed`,
      [intent.siteRef, intent.intentRef, intent.subjectRef, intent.subjectGeneration,
        intent.projectRef],
    );
    return rows[0]?.allowed === true;
  }
}
