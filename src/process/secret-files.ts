import { constants as fileSystemConstants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const MAXIMUM_SUPPORTED_BYTES = 16 * 1024 * 1024;
const MAXIMUM_SYMLINK_HOPS = 8;
const MAXIMUM_RESOLVED_SEGMENTS = 64;

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

export interface TrustedRootBoundedFileReader {
  readRegular(path: string, maximumBytes: number, invalidCode: string): Promise<string>;
  readPrivate(path: string, maximumBytes: number, invalidCode: string): Promise<string>;
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

/**
 * Creates one closure over a stable, non-symlink trust-root inode. Each read
 * resolves bounded Kubernetes AtomicWriter links one segment at a time, then
 * proves the final path and opened O_NOFOLLOW descriptor are the same inode.
 */
export async function createBoundedFileReaderWithinTrustRoot(
  trustRoot: string,
  invalidCode: string,
  fileSystem: BoundedFileSystem = NODE_FILE_SYSTEM,
): Promise<TrustedRootBoundedFileReader> {
  if (!isAbsolute(trustRoot) || trustRoot.includes("\0") || !safeCode(invalidCode)) {
    throw new Error(invalidCode);
  }
  try {
    const rootPath = resolve(trustRoot);
    const rootMetadata = await lstat(rootPath, { bigint: true });
    if (
      !rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()
    ) throw new Error(invalidCode);
    const canonicalRoot = await realpath(rootPath);
    const [rootAfterRealpath, canonicalRootMetadata] = await Promise.all([
      lstat(rootPath, { bigint: true }),
      lstat(canonicalRoot, { bigint: true }),
    ]);
    if (
      !rootAfterRealpath.isDirectory() || rootAfterRealpath.isSymbolicLink() ||
      !canonicalRootMetadata.isDirectory() || canonicalRootMetadata.isSymbolicLink() ||
      !sameIdentity(rootMetadata, rootAfterRealpath) ||
      !sameIdentity(rootMetadata, canonicalRootMetadata)
    ) throw new Error(invalidCode);
    const state = Object.freeze({ rootPath, canonicalRoot, rootMetadata, fileSystem });
    return Object.freeze({
      readRegular: (path: string, maximumBytes: number, fileInvalidCode: string) =>
        readTrustedFile(state, path, maximumBytes, fileInvalidCode, false),
      readPrivate: (path: string, maximumBytes: number, fileInvalidCode: string) =>
        readTrustedFile(state, path, maximumBytes, fileInvalidCode, true),
    });
  } catch {
    throw new Error(invalidCode);
  }
}

async function readTrustedFile(
  trustRoot: Readonly<{
    rootPath: string;
    canonicalRoot: string;
    rootMetadata: Readonly<{ dev: bigint; ino: bigint }>;
    fileSystem: BoundedFileSystem;
  }>,
  path: string,
  maximumBytes: number,
  invalidCode: string,
  privateMaterial: boolean,
): Promise<string> {
  try {
    if (!isAbsolute(path) || path.includes("\0")) throw new Error(invalidCode);
    await assertTrustRootStable(trustRoot, invalidCode);
    const requestedPath = resolve(path);
    if (!contained(trustRoot.rootPath, requestedPath) || requestedPath === trustRoot.rootPath) {
      throw new Error(invalidCode);
    }
    const resolvedPath = await resolveInsideTrustRoot({
      canonicalRoot: trustRoot.canonicalRoot,
      segments: splitRelative(relative(trustRoot.rootPath, requestedPath), invalidCode),
      invalidCode,
    });
    const finalPath = resolvedPath.finalPath;
    const before = await lstat(finalPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(invalidCode);
    const validatingFileSystem: BoundedFileSystem = Object.freeze({
      open: async (openedPath: string, flags: number) => {
        if (openedPath !== finalPath) throw new Error(invalidCode);
        const handle = await trustRoot.fileSystem.open(openedPath, flags);
        return Object.freeze({
          stat: async () => {
            const [opened, atPath] = await Promise.all([
              handle.stat(),
              lstat(finalPath, { bigint: true }),
            ]);
            if (
              !atPath.isFile() || atPath.isSymbolicLink() ||
              !sameSnapshot(before, opened) || !sameSnapshot(opened, atPath)
            ) throw new Error(invalidCode);
            return opened;
          },
          read: (buffer: Buffer, offset: number, length: number, position: number) =>
            handle.read(buffer, offset, length, position),
          close: () => handle.close(),
        });
      },
    });
    const value = await readFile(
      finalPath,
      maximumBytes,
      invalidCode,
      privateMaterial ? "trusted-private" : false,
      validatingFileSystem,
    );
    const finalRealPath = await realpath(requestedPath);
    if (finalRealPath !== finalPath || !contained(trustRoot.canonicalRoot, finalRealPath)) {
      throw new Error(invalidCode);
    }
    await assertTraversalStable(resolvedPath.snapshots, invalidCode);
    await assertTrustRootStable(trustRoot, invalidCode);
    return value;
  } catch {
    throw new Error(invalidCode);
  }
}

async function assertTrustRootStable(
  trustRoot: Readonly<{
    rootPath: string;
    canonicalRoot: string;
    rootMetadata: Readonly<{ dev: bigint; ino: bigint }>;
  }>,
  invalidCode: string,
): Promise<void> {
  const [rootPathMetadata, canonicalRootMetadata] = await Promise.all([
    lstat(trustRoot.rootPath, { bigint: true }),
    lstat(trustRoot.canonicalRoot, { bigint: true }),
  ]);
  if (
    !rootPathMetadata.isDirectory() || rootPathMetadata.isSymbolicLink() ||
    !canonicalRootMetadata.isDirectory() || canonicalRootMetadata.isSymbolicLink() ||
    !sameIdentity(trustRoot.rootMetadata, rootPathMetadata) ||
    !sameIdentity(trustRoot.rootMetadata, canonicalRootMetadata)
  ) throw new Error(invalidCode);
}

async function resolveInsideTrustRoot(input: Readonly<{
  canonicalRoot: string;
  segments: string[];
  invalidCode: string;
}>): Promise<Readonly<{
  finalPath: string;
  snapshots: readonly Readonly<{ path: string; metadata: BoundedFileMetadata }>[];
}>> {
  let current = input.canonicalRoot;
  let pending = [...input.segments];
  let symlinkHops = 0;
  let resolvedSegments = 0;
  const snapshots: Array<Readonly<{ path: string; metadata: BoundedFileMetadata }>> = [];
  while (pending.length > 0) {
    if (++resolvedSegments > MAXIMUM_RESOLVED_SEGMENTS) throw new Error(input.invalidCode);
    const [segment, ...remaining] = pending;
    if (segment === undefined || segment === "" || segment === "." || segment === "..") {
      throw new Error(input.invalidCode);
    }
    const candidate = resolve(current, segment);
    if (!contained(input.canonicalRoot, candidate)) throw new Error(input.invalidCode);
    const metadata = await lstat(candidate, { bigint: true });
    if (!metadata.isSymbolicLink()) {
      snapshots.push(Object.freeze({ path: candidate, metadata }));
      current = candidate;
      pending = remaining;
      continue;
    }
    if (++symlinkHops > MAXIMUM_SYMLINK_HOPS) throw new Error(input.invalidCode);
    const target = await readlink(candidate);
    const linkAfterRead = await lstat(candidate, { bigint: true });
    if (!linkAfterRead.isSymbolicLink() || !sameSnapshot(metadata, linkAfterRead)) {
      throw new Error(input.invalidCode);
    }
    snapshots.push(Object.freeze({ path: candidate, metadata: linkAfterRead }));
    const expanded = resolve(dirname(candidate), target);
    if (!contained(input.canonicalRoot, expanded)) throw new Error(input.invalidCode);
    pending = [
      ...splitRelative(relative(input.canonicalRoot, expanded), input.invalidCode),
      ...remaining,
    ];
    current = input.canonicalRoot;
  }
  return Object.freeze({ finalPath: current, snapshots: Object.freeze(snapshots) });
}

async function assertTraversalStable(
  snapshots: readonly Readonly<{ path: string; metadata: BoundedFileMetadata }>[],
  invalidCode: string,
): Promise<void> {
  for (const snapshot of snapshots) {
    const current = await lstat(snapshot.path, { bigint: true });
    if (!sameSnapshot(snapshot.metadata, current)) throw new Error(invalidCode);
  }
}

function splitRelative(value: string, invalidCode: string): string[] {
  if (value === "" || isAbsolute(value)) throw new Error(invalidCode);
  return value.split(sep);
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function sameIdentity(
  left: Readonly<{ dev: bigint; ino: bigint }>,
  right: Readonly<{ dev: bigint; ino: bigint }>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(
  left: Readonly<{
    dev: bigint; ino: bigint; size: bigint; mode: bigint; mtimeNs: bigint; ctimeNs: bigint;
  }>,
  right: Readonly<{
    dev: bigint; ino: bigint; size: bigint; mode: bigint; mtimeNs: bigint; ctimeNs: bigint;
  }>,
): boolean {
  return sameIdentity(left, right) && left.size === right.size && left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function readFile(
  path: string,
  maximumBytes: number,
  invalidCode: string,
  privateMaterial: boolean | "trusted-private",
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
  privateMaterial: boolean | "trusted-private",
  invalidCode: string,
): void {
  if (
    !metadata.isFile() || metadata.dev < 0n || metadata.ino < 1n ||
    metadata.size < 1n || metadata.size > BigInt(maximumBytes) ||
    metadata.ctimeNs < 0n || metadata.mtimeNs < 0n ||
    !safeMode(metadata.mode, privateMaterial)
  ) throw new Error(invalidCode);
}

function safeMode(
  mode: bigint,
  privateMaterial: boolean | "trusted-private",
): boolean {
  const permissions = mode & 0o777n;
  if (privateMaterial === "trusted-private") {
    return permissions === 0o400n || permissions === 0o600n ||
      permissions === 0o440n || permissions === 0o640n;
  }
  if (privateMaterial) {
    return permissions === 0o400n || permissions === 0o600n;
  }
  return (permissions & 0o400n) !== 0n && (permissions & 0o022n) === 0n;
}

function safeCode(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{2,127}$/u.test(value);
}
