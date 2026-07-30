import type {
  AssetDataPlaneOperation,
  PlatformTransactionalDatabaseClient,
} from "../../../../infrastructure/postgres/client.js";
import type { AssetMultipartUnitOfWorkPort } from
  "../../application/contracts/asset-multipart-ports.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

export class AssetMultipartUnitOfWork implements AssetMultipartUnitOfWorkPort {
  constructor(
    private readonly database: PlatformTransactionalDatabaseClient,
    private readonly deployment: Readonly<{ environment: string; region: string }>,
  ) {}

  execute<Result>(
    claims: Parameters<AssetMultipartUnitOfWorkPort["execute"]>[0],
    operation: string,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.database.assetDataPlaneTransaction({
      operation: operation as AssetDataPlaneOperation,
      siteRef: claims.siteRef,
      environment: this.deployment.environment,
      region: this.deployment.region,
      subjectRef: claims.subjectRef,
      subjectGeneration: claims.subjectGeneration,
      projectRef: claims.projectRef,
      purpose: claims.purpose,
      capabilityEpoch: claims.capabilityEpoch,
      expiresAt: claims.expiresAt,
    }, work);
  }
}
