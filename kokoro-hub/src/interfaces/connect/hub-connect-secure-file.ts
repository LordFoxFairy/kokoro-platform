import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const MAXIMUM_SYMLINK_HOPS = 8;
const MAXIMUM_RESOLVED_SEGMENTS = 64;

export async function readBoundedHubConnectFile(
  path: string,
  trustRoot: string,
  maximumBytes: number,
  privateFile: boolean,
): Promise<string> {
  try {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) invalid();
    const rootPath = resolve(trustRoot);
    const requestedPath = resolve(path);
    const rootMetadata = await lstat(rootPath, { bigint: true });
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) invalid();
    if (!contained(rootPath, requestedPath) || requestedPath === rootPath) invalid();

    const canonicalRoot = await realpath(rootPath);
    const [rootAfterRealpath, canonicalRootMetadata] = await Promise.all([
      lstat(rootPath, { bigint: true }),
      lstat(canonicalRoot, { bigint: true }),
    ]);
    if (
      !rootAfterRealpath.isDirectory() ||
      rootAfterRealpath.isSymbolicLink() ||
      !canonicalRootMetadata.isDirectory() ||
      canonicalRootMetadata.isSymbolicLink() ||
      !sameIdentity(rootMetadata, rootAfterRealpath) ||
      !sameIdentity(rootMetadata, canonicalRootMetadata)
    ) invalid();
    const finalPath = await resolveInsideTrustRoot({
      canonicalRoot,
      segments: splitRelative(relative(rootPath, requestedPath)),
    });
    const before = await lstat(finalPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) invalid();

    const handle = await open(finalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (
        !opened.isFile() ||
        !sameIdentity(before, opened) ||
        opened.size < 1n ||
        opened.size > BigInt(maximumBytes) ||
        (privateFile && (opened.mode & 0o037n) !== 0n)
      ) invalid();

      const value = await handle.readFile();
      const [afterHandle, afterPath] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(finalPath, { bigint: true }),
      ]);
      if (
        value.byteLength !== Number(opened.size) ||
        value.byteLength > maximumBytes ||
        !afterPath.isFile() ||
        afterPath.isSymbolicLink() ||
        !sameSnapshot(opened, afterHandle) ||
        !sameSnapshot(opened, afterPath)
      ) invalid();
      return value.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error && error.message === "HUB_CONNECT_TRUST_FILE_INVALID") throw error;
    throw new Error("HUB_CONNECT_TRUST_FILE_INVALID", { cause: error });
  }
}

async function resolveInsideTrustRoot(input: Readonly<{
  canonicalRoot: string;
  segments: string[];
}>): Promise<string> {
  let current = input.canonicalRoot;
  let pending = [...input.segments];
  let symlinkHops = 0;
  let resolvedSegments = 0;
  while (pending.length > 0) {
    if (++resolvedSegments > MAXIMUM_RESOLVED_SEGMENTS) invalid();
    const [segment, ...remaining] = pending;
    if (segment === undefined || segment === "" || segment === "." || segment === "..") invalid();
    const candidate = resolve(current, segment);
    if (!contained(input.canonicalRoot, candidate)) invalid();
    const metadata = await lstat(candidate);
    if (!metadata.isSymbolicLink()) {
      current = candidate;
      pending = remaining;
      continue;
    }

    if (++symlinkHops > MAXIMUM_SYMLINK_HOPS) invalid();
    const target = await readlink(candidate);
    const expanded = resolve(dirname(candidate), target);
    if (!contained(input.canonicalRoot, expanded)) invalid();
    pending = [...splitRelative(relative(input.canonicalRoot, expanded)), ...remaining];
    current = input.canonicalRoot;
  }
  return current;
}

function splitRelative(value: string): string[] {
  if (value === "" || isAbsolute(value)) invalid();
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

function invalid(): never {
  throw new Error("HUB_CONNECT_TRUST_FILE_INVALID");
}
