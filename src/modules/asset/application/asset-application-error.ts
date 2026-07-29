export type AssetApplicationErrorCode =
  | "ASSET_NOT_ACCEPTED"
  | "ASSET_UPLOAD_CONFLICT"
  | "ASSET_QUOTA_EXCEEDED"
  | "ASSET_TEMPORARILY_UNAVAILABLE";

export class AssetApplicationError extends Error {
  constructor(readonly code: AssetApplicationErrorCode) {
    super(code);
    this.name = "AssetApplicationError";
  }
}

export async function assetPublicResult<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AssetApplicationError) throw error;
    if (!(error instanceof Error)) throw error;
    if (error.message === "ASSET_NOT_ACCEPTED" || error.message === "ASSET_USER_AUTHORITY_INVALID") {
      throw new AssetApplicationError("ASSET_NOT_ACCEPTED");
    }
    if (error.message === "ASSET_UPLOAD_QUOTA_EXCEEDED" || error.message === "ASSET_STORAGE_QUOTA_EXCEEDED") {
      throw new AssetApplicationError("ASSET_QUOTA_EXCEEDED");
    }
    if (
      error.message.includes("ASSET_UPLOAD_COMPLETION_CONFLICT") ||
      error.message.includes("ASSET_UPLOAD_CAPABILITY_CONFLICT") ||
      error.message.includes("ASSET_IDEMPOTENCY_DIGEST_CONFLICT")
    ) throw new AssetApplicationError("ASSET_UPLOAD_CONFLICT");
    if (error.message === "ASSET_TEMPORARILY_UNAVAILABLE") {
      throw new AssetApplicationError("ASSET_TEMPORARILY_UNAVAILABLE");
    }
    throw error;
  }
}
