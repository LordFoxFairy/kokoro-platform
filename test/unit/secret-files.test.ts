import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createBoundedFileReaderWithinTrustRoot,
  readBoundedPrivateFile,
  readBoundedRegularFile,
  type BoundedFileSystem,
} from "../../src/process/secret-files.js";

describe("bounded secret files", () => {
  it.each([0o450, 0o540, 0o700, 0o441])(
    "rejects executable or world-accessible trusted private mode %s",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "kokoro-projected-secret-"));
      const path = join(directory, "private.key");
      try {
        await writeFile(path, "private", { mode: 0o400 });
        await chmod(path, mode);
        const reader = await createBoundedFileReaderWithinTrustRoot(
          directory,
          "TEST_TRUST_ROOT_INVALID",
        );
        await expect(reader.readPrivate(path, 64, "TEST_PRIVATE_INVALID"))
          .rejects.toThrowError("TEST_PRIVATE_INVALID");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects a symlink trust root and a same-path descriptor identity swap", async () => {
    const parent = await mkdtemp(join(tmpdir(), "kokoro-trust-parent-"));
    const directory = join(parent, "actual");
    const rootLink = join(parent, "linked");
    const path = join(directory, "private.key");
    try {
      await mkdir(directory);
      await writeFile(path, "private", { mode: 0o400 });
      await symlink(directory, rootLink);

      await expect(createBoundedFileReaderWithinTrustRoot(
        rootLink,
        "TEST_TRUST_ROOT_INVALID",
      )).rejects.toThrowError("TEST_TRUST_ROOT_INVALID");

      const swappedFileSystem: BoundedFileSystem = {
        async open() {
          return {
            async stat() {
              return {
                dev: 99n,
                ino: 100n,
                mode: 0o100400n,
                size: 7n,
                ctimeNs: 1n,
                mtimeNs: 1n,
                isFile: () => true,
              };
            },
            async read() { return { bytesRead: 0 }; },
            async close() {},
          };
        },
      };
      const reader = await createBoundedFileReaderWithinTrustRoot(
        directory,
        "TEST_TRUST_ROOT_INVALID",
        swappedFileSystem,
      );
      await expect(reader.readPrivate(path, 64, "TEST_PRIVATE_INVALID"))
        .rejects.toThrowError("TEST_PRIVATE_INVALID");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
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
    const root = await mkdtemp(join(tmpdir(), "kokoro-atomic-secret-"));
    try {
      const revision = join(root, "..2026_07_30_04_00_00.000000001");
      await mkdir(revision);
      await writeFile(join(revision, "delivery-hmac.key"), "private-value", { mode: 0o440 });
      await symlink("..2026_07_30_04_00_00.000000001", join(root, "..data"));
      await symlink("..data/delivery-hmac.key", join(root, "delivery-hmac.key"));

      const reader = await createBoundedFileReaderWithinTrustRoot(
        root,
        "TEST_TRUST_ROOT_INVALID",
      );
      await expect(reader.readPrivate(
        join(root, "delivery-hmac.key"), 64, "TEST_PRIVATE_INVALID",
      )).resolves.toBe("private-value");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects AtomicWriter links that resolve outside the configured trust root", async () => {
    const root = await mkdtemp(join(tmpdir(), "kokoro-atomic-escape-"));
    const outside = await mkdtemp(join(tmpdir(), "kokoro-atomic-outside-"));
    try {
      await writeFile(join(outside, "key"), "escaped", { mode: 0o440 });
      await symlink(join(outside, "key"), join(root, "key"));
      const reader = await createBoundedFileReaderWithinTrustRoot(
        root,
        "TEST_TRUST_ROOT_INVALID",
      );
      await expect(reader.readPrivate(
        join(root, "key"), 64, "TEST_PRIVATE_INVALID",
      )).rejects.toThrow("TEST_PRIVATE_INVALID");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

});
