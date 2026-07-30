import { Code, ConnectError } from "@connectrpc/connect";
import { CommandReceiptConflictError } from
  "../../shared/outbox-inbox/receipt.js";

export async function withCommandReceiptConflictMapping<Result>(
  effect: () => Promise<Result>,
): Promise<Result> {
  try {
    return await effect();
  } catch (error) {
    if (!(error instanceof CommandReceiptConflictError)) throw error;
    const kind = error.kind === "result" ? "result" : error.kind;
    throw new ConnectError(`command ${kind} conflict`, Code.AlreadyExists);
  }
}
