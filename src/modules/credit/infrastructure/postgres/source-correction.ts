import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type { CreditSourceCorrectionPort } from "../../application/contracts/source-correction.js";

export class PostgresCreditSourceCorrection implements CreditSourceCorrectionPort {
  async listCorrectionRefs(
    transaction: Parameters<CreditSourceCorrectionPort["listCorrectionRefs"]>[0],
    input: Parameters<CreditSourceCorrectionPort["listCorrectionRefs"]>[1],
  ): ReturnType<CreditSourceCorrectionPort["listCorrectionRefs"]> {
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown> & { correctionRef: string }>(
      `SELECT DISTINCT journal.journal_transaction_ref::text AS "correctionRef"
       FROM platform.credit_grant grant_fact
       JOIN platform.credit_journal_entry entry ON entry.credit_grant_id=grant_fact.credit_grant_id
       JOIN platform.credit_journal_transaction journal
         ON journal.journal_transaction_ref=entry.journal_transaction_ref AND journal.site_ref=grant_fact.site_ref
       WHERE grant_fact.site_ref=$1 AND grant_fact.source_type=$2
         AND strpos(grant_fact.source_ref,$3 || ':')=1
         AND journal.operation_kind IN ('grant_revoke','reversal')
       ORDER BY "correctionRef"`,
      [input.siteId, input.sourceType, input.sourceRefPrefix],
    );
    return Object.freeze(rows.map((row) => row.correctionRef));
  }
}
