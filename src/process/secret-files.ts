import { constants as fileSystemConstants } from "node:fs";
import { open } from "node:fs/promises";

const MAXIMUM_SUPPORTED_BYTES = 16 * 1024 * 1024;

export interface BoundedFileMetadata {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly ctimeNs: bigint;
  readonly mtimeNs: bigint;
  isFile(): boolean;
}

export interface BoundedFileHandle {
  stat(): Promise<BoundedFileMetadata>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<Readonly<{ bytesRead: number }>>;
  close(): Promise<void>;
}

export interface BoundedFileSystem {
  open(path: string, flags: number): Promise<BoundedFileHandle>;
}

const NODE_FILE_SYSTEM: BoundedFileSystem = Object.freeze({
  open: async (path: string, flags: number) => {
    const handle = await open(path, flags);
    return Object.freeze({
      stat: () => handle.stat({ bigint: true }),
      read: (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => handle.read(buffer, offset, length, position),
      close: () => handle.close(),
    });
  },
});

/**
 * Reads through one no-follow descriptor, caps actual I/O, and verifies stable
 * identity, size, mode, ctime and mtime before and after the read.
 */
export function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  invalidCode: string,
  fileSystem: BoundedFileSystem = NODE_FILE_SYSTEM,
): Promise<string> {
  return readFile(path, maximumBytes, invalidCode, false, fileSystem);
}

/** Adds Unix owner-only permission enforcement for private key material. */
export function readBoundedPrivateFile(
  path: string,
  maximumBytes: number,
  invalidCode: string,
  fileSystem: BoundedFileSystem = NODE_FILE_SYSTEM,
): Promise<string> {
  return readFile(path, maximumBytes, invalidCode, true, fileSystem);
}

async function readFile(
  path: string,
  maximumBytes: number,
  invalidCode: string,
  privateMaterial: boolean,
  fileSystem: BoundedFileSystem,
): Promise<string> {
  let handle: BoundedFileHandle | undefined;
  let value: string | undefined;
  let invalid = false;
  try {
    if (
      !path.startsWith("/") || path.includes("\0") ||
      !Number.isInteger(maximumBytes) || maximumBytes < 1 ||
      maximumBytes > MAXIMUM_SUPPORTED_BYTES || !safeCode(invalidCode)
    ) throw new Error(invalidCode);
    handle = await fileSystem.open(
      path,
      fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW,
    );
    const before = await handle.stat();
    assertMetadata(before, maximumBytes, privateMaterial, invalidCode);

    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const requested = buffer.byteLength - total;
      const result = await handle.read(buffer, total, requested, total);
      if (
        !Number.isInteger(result.bytesRead) ||
        result.bytesRead < 0 || result.bytesRead > requested
      ) throw new Error(invalidCode);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    if (total < 1 || total > maximumBytes) throw new Error(invalidCode);

    const after = await handle.stat();
    assertMetadata(after, maximumBytes, privateMaterial, invalidCode);
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mode !== after.mode || before.ctimeNs !== after.ctimeNs ||
      before.mtimeNs !== after.mtimeNs || BigInt(total) !== before.size
    ) throw new Error(invalidCode);
    value = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
  } catch {
    invalid = true;
  }
  try {
    await handle?.close();
  } catch {
    invalid = true;
  }
  if (invalid || value === undefined) throw new Error(invalidCode);
  return value;
}

function assertMetadata(
  metadata: BoundedFileMetadata,
  maximumBytes: number,
  privateMaterial: boolean,
  invalidCode: string,
): void {
  if (
    !metadata.isFile() || metadata.dev < 0n || metadata.ino < 1n ||
    metadata.size < 1n || metadata.size > BigInt(maximumBytes) ||
    metadata.ctimeNs < 0n || metadata.mtimeNs < 0n ||
    !safeMode(metadata.mode, privateMaterial)
  ) throw new Error(invalidCode);
}

function safeMode(mode: bigint, privateMaterial: boolean): boolean {
  const permissions = mode & 0o777n;
  if (privateMaterial) return permissions === 0o400n || permissions === 0o600n;
  return (permissions & 0o400n) !== 0n && (permissions & 0o022n) === 0n;
}

function safeCode(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{2,127}$/u.test(value);
}
