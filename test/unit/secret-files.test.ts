import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readBoundedPrivateFile,
  readBoundedRegularFile,
  createBoundedFileReaderWithinTrustRoot,
  type BoundedFileSystem,
} from "../../src/process/secret-files.js";
import * as secretFileModule from "../../src/process/secret-files.js";

type TrustRootReader = (
  path: string,
  trustRoot: string,
  maximumBytes: number,
  invalidCode: string,
  fileSystem?: BoundedFileSystem & Readonly<{ realpath(path: string): Promise<string> }>,
) => Promise<string>;

describe("bounded secret files", () => {
  it("reads Kubernetes AtomicWriter links with fsGroup 0440 through a trusted root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kokoro-projected-secret-"));
    const revision = join(directory, "..2026_07_30_00_00_00.000000000");
    await mkdir(revision, { mode: 0o755 });
    await writeFile(join(revision, "session-access.json"), "private-key-ring", { mode: 0o440 });
    await symlink("..2026_07_30_00_00_00.000000000", join(directory, "..data"));
    await symlink("..data/session-access.json", join(directory, "session-access.json"));

    const reader = await createBoundedFileReaderWithinTrustRoot(
      directory,
      "TEST_TRUST_ROOT_INVALID",
    );
    await expect(reader.readPrivate(
      join(directory, "session-access.json"),
      64,
      "TEST_PRIVATE_INVALID",
    )).resolves.toBe("private-key-ring");
  });

  it("rejects projected links outside the root and group-writable private material", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kokoro-projected-secret-"));
    const outside = await mkdtemp(join(tmpdir(), "kokoro-outside-secret-"));
    const outsideFile = join(outside, "escaped.key");
    const writableFile = join(directory, "writable.key");
    await writeFile(outsideFile, "escaped", { mode: 0o440 });
    await writeFile(writableFile, "writable", { mode: 0o660 });
    await chmod(writableFile, 0o660);
    await symlink(outsideFile, join(directory, "escaped.key"));

    const reader = await createBoundedFileReaderWithinTrustRoot(
      directory,
      "TEST_TRUST_ROOT_INVALID",
    );
    await expect(reader.readPrivate(
      join(directory, "escaped.key"),
      64,
      "TEST_PRIVATE_INVALID",
    )).rejects.toThrowError("TEST_PRIVATE_INVALID");
    await expect(reader.readPrivate(
      writableFile,
      64,
      "TEST_PRIVATE_INVALID",
    )).rejects.toThrowError("TEST_PRIVATE_INVALID");
  });

  it("reads only an absolute, regular, non-symlink file within the byte cap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kokoro-secret-"));
    const target = join(directory, "ca.pem");
    const link = join(directory, "ca-link.pem");
    await writeFile(target, "trusted-ca", { mode: 0o644 });
    await symlink(target, link);

    await expect(readBoundedRegularFile(target, 10, "TEST_SECRET_INVALID"))
      .resolves.toBe("trusted-ca");
    await expect(readBoundedRegularFile(link, 10, "TEST_SECRET_INVALID"))
      .rejects.toThrowError("TEST_SECRET_INVALID");
    await expect(readBoundedRegularFile("relative.pem", 10, "TEST_SECRET_INVALID"))
      .rejects.toThrowError("TEST_SECRET_INVALID");
    await expect(readBoundedRegularFile(target, 9, "TEST_SECRET_INVALID"))
      .rejects.toThrowError("TEST_SECRET_INVALID");
    await chmod(target, 0o666);
    await expect(readBoundedRegularFile(target, 10, "TEST_SECRET_INVALID"))
      .rejects.toThrowError("TEST_SECRET_INVALID");
  });

  it("requires private material to have no group or world permission bits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kokoro-private-"));
    const path = join(directory, "client.key");
    await writeFile(path, "private-key", { mode: 0o600 });

    await expect(readBoundedPrivateFile(path, 32, "TEST_PRIVATE_INVALID"))
      .resolves.toBe("private-key");
    await chmod(path, 0o640);
    await expect(readBoundedPrivateFile(path, 32, "TEST_PRIVATE_INVALID"))
      .rejects.toThrowError("TEST_PRIVATE_INVALID");
    await chmod(path, 0o700);
    await expect(readBoundedPrivateFile(path, 32, "TEST_PRIVATE_INVALID"))
      .rejects.toThrowError("TEST_PRIVATE_INVALID");
    await chmod(path, 0o200);
    await expect(readBoundedPrivateFile(path, 32, "TEST_PRIVATE_INVALID"))
      .rejects.toThrowError("TEST_PRIVATE_INVALID");
  });

  it("rejects a file replaced or resized between descriptor reads", async () => {
    let statCall = 0;
    const bytes = Buffer.from("trust-root", "utf8");
    const fileSystem: BoundedFileSystem = {
      async open() {
        return {
          async stat() {
            statCall += 1;
            return {
              dev: 10n,
              ino: 20n,
              mode: 0o100600n,
              size: BigInt(bytes.byteLength),
              ctimeNs: 100n,
              mtimeNs: statCall === 1 ? 100n : 101n,
              isFile: () => true,
            };
          },
          async read(buffer, offset, length, position) {
            if (position >= bytes.byteLength) return { bytesRead: 0 };
            const count = Math.min(length, bytes.byteLength - position);
            bytes.copy(buffer, offset, position, position + count);
            return { bytesRead: count };
          },
          async close() {},
        };
      },
    };

    await expect(readBoundedRegularFile(
      "/run/secrets/ca.pem",
      64,
      "TEST_SECRET_INVALID",
      fileSystem,
    )).rejects.toThrowError("TEST_SECRET_INVALID");
  });

  it("never reads more than the cap plus one byte when a file grows after stat", async () => {
    let bytesReadTotal = 0;
    const fileSystem: BoundedFileSystem = {
      async open() {
        return {
          async stat() {
            return {
              dev: 1n,
              ino: 2n,
              mode: 0o100600n,
              size: 4n,
              ctimeNs: 1n,
              mtimeNs: 1n,
              isFile: () => true,
            };
          },
          async read(buffer, offset, length) {
            buffer.fill(0x61, offset, offset + length);
            bytesReadTotal += length;
            return { bytesRead: length };
          },
          async close() {},
        };
      },
    };

    await expect(readBoundedRegularFile(
      "/run/secrets/growing.pem",
      8,
      "TEST_SECRET_INVALID",
      fileSystem,
    )).rejects.toThrowError("TEST_SECRET_INVALID");
    expect(bytesReadTotal).toBe(9);
  });

  it("safely reads a group-readable Kubernetes AtomicWriter secret inside its trust root", async () => {
    const readFromTrustRoot = (secretFileModule as unknown as {
      readBoundedPrivateFileWithinTrustRoot?: TrustRootReader;
    }).readBoundedPrivateFileWithinTrustRoot;
    expect(readFromTrustRoot).toBeTypeOf("function");
    if (readFromTrustRoot === undefined) return;
    const root = await mkdtemp(join(tmpdir(), "kokoro-atomic-secret-"));
    try {
      const revision = join(root, "..2026_07_30_04_00_00.000000001");
      await mkdir(revision);
      await writeFile(join(revision, "delivery-hmac.key"), "private-value", { mode: 0o440 });
      await symlink("..2026_07_30_04_00_00.000000001", join(root, "..data"));
      await symlink("..data/delivery-hmac.key", join(root, "delivery-hmac.key"));

      await expect(readFromTrustRoot(
        join(root, "delivery-hmac.key"), root, 64, "TEST_PRIVATE_INVALID",
      )).resolves.toBe("private-value");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects AtomicWriter links that resolve outside the configured trust root", async () => {
    const readFromTrustRoot = (secretFileModule as unknown as {
      readBoundedPrivateFileWithinTrustRoot?: TrustRootReader;
    }).readBoundedPrivateFileWithinTrustRoot;
    expect(readFromTrustRoot).toBeTypeOf("function");
    if (readFromTrustRoot === undefined) return;
    const root = await mkdtemp(join(tmpdir(), "kokoro-atomic-escape-"));
    const outside = await mkdtemp(join(tmpdir(), "kokoro-atomic-outside-"));
    try {
      await writeFile(join(outside, "key"), "escaped", { mode: 0o440 });
      await symlink(join(outside, "key"), join(root, "key"));
      await expect(readFromTrustRoot(
        join(root, "key"), root, 64, "TEST_PRIVATE_INVALID",
      )).rejects.toThrow("TEST_PRIVATE_INVALID");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("rejects an AtomicWriter target swapped between resolution and descriptor verification", async () => {
    const readFromTrustRoot = (secretFileModule as unknown as {
      readBoundedPrivateFileWithinTrustRoot?: TrustRootReader;
    }).readBoundedPrivateFileWithinTrustRoot;
    expect(readFromTrustRoot).toBeTypeOf("function");
    if (readFromTrustRoot === undefined) return;
    const bytes = Buffer.from("private-value");
    let logicalResolutions = 0;
    const fileSystem = {
      async realpath(path: string) {
        if (path === "/run/secrets/identity") return path;
        logicalResolutions += 1;
        return logicalResolutions === 1
          ? "/run/secrets/identity/..revision/key"
          : "/tmp/escaped-key";
      },
      async open() {
        return {
          async stat() {
            return {
              dev: 1n, ino: 2n, mode: 0o100440n, size: BigInt(bytes.byteLength),
              ctimeNs: 1n, mtimeNs: 1n, isFile: () => true,
            };
          },
          async read(buffer: Buffer, offset: number, length: number, position: number) {
            if (position >= bytes.byteLength) return { bytesRead: 0 };
            const count = Math.min(length, bytes.byteLength - position);
            bytes.copy(buffer, offset, position, position + count);
            return { bytesRead: count };
          },
          async close() {},
        };
      },
    };
    await expect(readFromTrustRoot(
      "/run/secrets/identity/key", "/run/secrets/identity", 64,
      "TEST_PRIVATE_INVALID", fileSystem,
    )).rejects.toThrow("TEST_PRIVATE_INVALID");
  });
});
