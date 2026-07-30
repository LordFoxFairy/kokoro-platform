import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readBoundedPrivateFile,
  readBoundedRegularFile,
  createBoundedFileReaderWithinTrustRoot,
  type BoundedFileSystem,
} from "../../src/process/secret-files.js";

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
});
