// S3 档包体存储（minio/AWS/R2 仅 endpoint 之差）：HeadObject 命中即幂等跳过，miss 再 PutObject。
// 与 session 读侧同用 @aws-sdk/client-s3；凭据 env 注入（ADR-010），永不落配置文件。

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { StoreLocation } from "../../config/storage.js";
import { PackageStoreError } from "../../domain/errors.js";
import type { PackageStore } from "./package-store.js";

export interface S3StoreCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

type S3Location = Extract<StoreLocation, { type: "s3" }>;

export class S3PackageStore implements PackageStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(location: S3Location, credentials: S3StoreCredentials) {
    this.bucket = location.bucket;
    this.client = new S3Client({
      endpoint: location.endpoint,
      region: location.region,
      forcePathStyle: location.force_path_style,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });
  }

  async put(ref: string, data: Buffer): Promise<void> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: ref }));
      return; // 内容寻址：已存在=同内容，幂等跳过。
    } catch {
      // NotFound → 继续上传；其余错误也交给 PutObject 定夺（与 agent S3PackageStore 同口径）。
    }
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: ref, Body: data }));
  }

  async get(ref: string, signal?: AbortSignal): Promise<Buffer> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: ref }),
        signal === undefined ? {} : { abortSignal: signal },
      );
      if (response.Body === undefined) {
        throw new PackageStoreError(`package '${ref}' has empty body in s3 store`);
      }
      return Buffer.from(await response.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof PackageStoreError) {
        throw error;
      }
      throw new PackageStoreError(`package '${ref}' not found in s3 store: ${String(error)}`);
    }
  }
}
