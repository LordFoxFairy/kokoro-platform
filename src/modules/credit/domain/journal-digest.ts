import { createHash } from "node:crypto";

export type CreditJournalDigestEntry = Readonly<{
  ordinal: number;
  siteId: string;
  creditAccountId: string;
  unit: string;
  side: "debit" | "credit";
  accountType: string;
  amount: bigint | string;
  creditGrantId: string;
  creditHoldRef: string | null;
}>;

export function creditJournalEntriesDigest(entries: readonly CreditJournalDigestEntry[]): string {
  const canonical = [...entries]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((entry) => [
      entry.ordinal,
      entry.siteId,
      entry.creditAccountId.toLowerCase(),
      entry.unit,
      entry.side,
      entry.accountType,
      entry.amount.toString(),
      entry.creditGrantId.toLowerCase(),
      entry.creditHoldRef?.toLowerCase() ?? "",
    ].map((field) => lengthDelimited(String(field))).join(""))
    .join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function lengthDelimited(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}
