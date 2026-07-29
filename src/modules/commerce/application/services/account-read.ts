import type {
  AccountProductsResponse,
  CreditGrantResponse,
  CreditSummaryResponse,
  UsageDetailResponse,
} from "../../../../interfaces/http/generated/platform-public/types.gen.js";
import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/unit-of-work.js";
import { authorizeCommerceRead } from "../../../../workflows/commerce/authorize-command.js";
import { CommerceApplicationError } from "../commerce-application-error.js";
import type { AccountReadRepository } from "../contracts/account-read-repository.js";

export class AccountReadService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: Pick<PlatformUnitOfWork, "execute">;
    repository: AccountReadRepository;
    authorizeRead?: typeof authorizeCommerceRead;
    clock?: () => string;
  }>) {}

  getCreditGrant(input: Readonly<{ context: VerifiedRequestSecurityContext; grantId: string }>): Promise<CreditGrantResponse> {
    return this.#read(input.context, "getCreditGrant", (transaction, identity) =>
      this.dependencies.repository.getCreditGrant(transaction, { ...identity, grantId: input.grantId }), true);
  }

  getCreditSummary(input: Readonly<{ context: VerifiedRequestSecurityContext }>): Promise<CreditSummaryResponse> {
    return this.#read(input.context, "getCreditSummary", (transaction, identity) =>
      this.dependencies.repository.getCreditSummary(transaction, identity), false);
  }

  getUsageDetail(input: Readonly<{ context: VerifiedRequestSecurityContext; usageId: string }>): Promise<UsageDetailResponse> {
    return this.#read(input.context, "getUsageDetail", (transaction, identity) =>
      this.dependencies.repository.getUsageDetail(transaction, { ...identity, usageId: input.usageId }), true);
  }

  listAccountProducts(input: Readonly<{ context: VerifiedRequestSecurityContext }>): Promise<AccountProductsResponse> {
    return this.#read(input.context, "listAccountProducts", (transaction, identity) =>
      this.dependencies.repository.listAccountProducts(transaction, identity), false);
  }

  async #read<Result>(
    context: VerifiedRequestSecurityContext,
    operation: "getCreditGrant" | "getCreditSummary" | "getUsageDetail" | "listAccountProducts",
    query: (transaction: Parameters<AccountReadRepository["getCreditSummary"]>[0], identity: ReturnType<typeof userIdentity>) => Promise<Result | null>,
    notFound: boolean,
  ): Promise<Result> {
    const identity = userIdentity(context);
    const result = await this.dependencies.unitOfWork.execute(
      { context, operation },
      async (transaction) => {
        await (this.dependencies.authorizeRead ?? authorizeCommerceRead)(
          transaction, context, operation, (this.dependencies.clock ?? (() => new Date().toISOString()))(),
        );
        return query(transaction, identity);
      },
    );
    if (notFound && result === null) throw new CommerceApplicationError("ACCOUNT_RESOURCE_NOT_FOUND");
    if (result === null) throw new Error("ACCOUNT_READ_RESULT_INVALID");
    return result;
  }
}

function userIdentity(context: VerifiedRequestSecurityContext) {
  if (context.actor.kind !== "user" || context.target.siteId === null) throw new Error("COMMERCE_EFFECT_NOT_AUTHORIZED");
  return Object.freeze({
    siteId: context.target.siteId,
    subjectId: context.actor.subjectId,
    subjectGeneration: context.actor.subjectGeneration,
  });
}
