import { createHash } from "node:crypto";

import type { McpHubService } from "./mcp-hub-service.js";
import type { McpSecretService } from "./mcp-secret-service.js";
import type { CapabilityPublicationRepository } from
  "../domain/capability-publication-repository.js";
import { contentHashOf, packageRef } from "../domain/package.js";
import type { SkillHubRepository } from "../domain/repository.js";
import { validatePackage } from "../domain/validation.js";
import type { PackageStore } from "../infrastructure/packages/package-store.js";
import { unzipTextFiles } from "../infrastructure/zip.js";

const DIGEST = /^[0-9a-f]{64}$/u;
const HANDLE_REF = /^handle:(srt_[0-9a-f]{32})$/u;
const MAX_SKILLS = 64;
const MAX_MCP = 64;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_ASSEMBLY_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_ASSEMBLY_UNPACKED_BYTES = 128 * 1024 * 1024;

export type SkillGrantSelection = Readonly<{
  optionRef: string;
  scope: string;
  name: string;
  contentHash: string;
  description: string;
}>;

export type McpGrantSelection = Readonly<{
  optionRef: string;
  scope: string;
  name: string;
  revision: number;
  configHash: string;
}>;

export type SkillArtifactManifest = SkillGrantSelection & Readonly<{
  artifactRef: string;
  artifactSize: number;
  artifactSha256: string;
}>;

export type McpAssemblyConfig = McpGrantSelection & Readonly<{
  transport: "http" | "streamable_http";
  url: string;
  allowedTools: readonly string[];
  authorizationValue?: string;
}>;

export type ExecutionAssembly = Readonly<{
  agentCatalogRef: string;
  assemblyDigest: string;
  skills: readonly SkillArtifactManifest[];
  mcpServers: readonly McpAssemblyConfig[];
}>;

export class ExecutionAssemblyError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ExecutionAssemblyError";
  }
}

export class ExecutionAssemblyService {
  constructor(private readonly dependencies: Readonly<{
    publications: Pick<CapabilityPublicationRepository, "findByAgentCatalogRef">;
    skills: Pick<SkillHubRepository, "findActive">;
    mcp: Pick<McpHubService, "getRevisionSnapshot">;
    secrets: Pick<McpSecretService, "resolve">;
    packages: Pick<PackageStore, "get">;
  }>) {}

  async resolve(input: Readonly<{
    namespace: string;
    agentCatalogRef: string;
    skills: readonly SkillGrantSelection[];
    mcpServers: readonly McpGrantSelection[];
  }>, signal?: AbortSignal): Promise<ExecutionAssembly> {
    throwIfAborted(signal);
    this.#assertRequest(input);
    const publication = await this.dependencies.publications.findByAgentCatalogRef(
      input.agentCatalogRef,
    );
    throwIfAborted(signal);
    if (publication === null || publication.publication.agentCatalogRef !== input.agentCatalogRef ||
        publication.projectionState !== "committed") {
      throw new ExecutionAssemblyError("HUB_EXECUTION_ASSEMBLY_CATALOG_NOT_FOUND");
    }
    const snapshot = publication.publication.snapshot;
    const skillOptions = new Map(snapshot.skillOptions.map((option) => [option.optionRef, option]));
    const mcpOptions = new Map(snapshot.mcpOptions.map((option) => [option.optionRef, option]));

    let artifactBytes = 0;
    let unpackedBytes = 0;
    const skills: SkillArtifactManifest[] = [];
    for (const grant of input.skills) {
      throwIfAborted(signal);
      const option = skillOptions.get(grant.optionRef);
      if (option === undefined || option.scope !== grant.scope || option.name !== grant.name ||
          option.contentHash !== grant.contentHash || option.description !== grant.description ||
          !allowedScope(input.namespace, grant.scope)) {
        throw new ExecutionAssemblyError("HUB_EXECUTION_ASSEMBLY_SELECTION_INVALID");
      }
      if (await this.dependencies.skills.findActive(grant.scope, grant.name) === null) {
        throw new ExecutionAssemblyError("HUB_EXECUTION_ASSEMBLY_CAPABILITY_REVOKED");
      }
      throwIfAborted(signal);
      const artifactRef = packageRef(grant.scope, grant.name, grant.contentHash);
      const artifact = await this.#artifact(artifactRef, grant, signal);
      artifactBytes += artifact.data.byteLength;
      unpackedBytes += artifact.unpackedBytes;
      if (artifactBytes > MAX_ASSEMBLY_ARTIFACT_BYTES ||
          unpackedBytes > MAX_ASSEMBLY_UNPACKED_BYTES) {
        throw new ExecutionAssemblyError("HUB_EXECUTION_ASSEMBLY_ARTIFACT_BUDGET_EXCEEDED");
      }
      skills.push(Object.freeze({
        ...grant,
        artifactRef,
        artifactSize: artifact.data.byteLength,
        artifactSha256: artifact.sha256,
      }));
    }

    const pendingMcp: Array<Readonly<{
      grant: McpGrantSelection;
      transport: "http" | "streamable_http";
      url: string;
      allowedTools: readonly string[];
      handle?: string;
    }>> = [];
    const handles: string[] = [];
    for (const grant of input.mcpServers) {
      throwIfAborted(signal);
      const option = mcpOptions.get(grant.optionRef);
      if (option === undefined || option.scope !== grant.scope || option.name !== grant.name ||
          option.revision !== grant.revision || option.configHash !== grant.configHash ||
          !allowedScope(input.namespace, grant.scope)) {
        throw new ExecutionAssemblyError("HUB_EXECUTION_ASSEMBLY_SELECTION_INVALID");
      }
      const resolution = await this.dependencies.mcp.getRevisionSnapshot(
        grant.scope,
        grant.name,
        grant.revision,
      );
      throwIfAborted(signal);
      const snapshotConfig = resolution?.snapshot;
      if (resolution === null || snapshotConfig === undefined || !resolution.live.enabled ||
          resolution.live.deleted || snapshotConfig.config_hash !== grant.configHash ||
          snapshotConfig.scope !== grant.scope || snapshotConfig.name !== grant.name ||
          snapshotConfig.revision !== grant.revision) {
        throw new ExecutionAssemblyError("HUB_EXECUTION_ASSEMBLY_CAPABILITY_REVOKED");
      }
      const url = secureMcpUrl(snapshotConfig.url);
      const allowedTools = exactTools(snapshotConfig.allowed_tools);
      const secret = snapshotConfig.secret_ref;
      let handle: string | undefined;
      if (secret !== null) {
        const matched = HANDLE_REF.exec(secret);
        if (matched === null) {
          throw new ExecutionAssemblyError("HUB_EXECUTION_ASSEMBLY_SECRET_REFERENCE_INVALID");
        }
        handle = matched[1];
        if (handle === undefined) {
          throw new ExecutionAssemblyError("HUB_EXECUTION_ASSEMBLY_SECRET_REFERENCE_INVALID");
        }
        handles.push(handle);
      }
      pendingMcp.push(Object.freeze({
        grant,
        transport: snapshotConfig.transport,
        url,
        allowedTools,
        ...(handle === undefined ? {} : { handle }),
      }));
    }
    // 多个 MCP server 可以有意共享同一 namespace-owned secret；broker 只需解析一次。
    const uniqueHandles = [...new Set(handles)];
    const resolvedSecrets = uniqueHandles.length === 0
      ? {}
      : await this.dependencies.secrets.resolve(input.namespace, uniqueHandles);
    throwIfAborted(signal);
    const mcpServers = pendingMcp.map((entry): McpAssemblyConfig => {
      const authorizationValue = entry.handle === undefined
        ? undefined
        : resolvedSecrets[entry.handle];
      if (entry.handle !== undefined &&
          (authorizationValue === undefined || authorizationValue.length < 1 ||
           Buffer.byteLength(authorizationValue, "utf8") > 8_192)) {
        throw new ExecutionAssemblyError("HUB_EXECUTION_ASSEMBLY_SECRET_NOT_RESOLVABLE");
      }
      return Object.freeze({
        ...entry.grant,
        transport: entry.transport,
        url: entry.url,
        allowedTools: entry.allowedTools,
        ...(authorizationValue === undefined ? {} : { authorizationValue }),
      });
    });

    const digest = executionAssemblyDigest({
      namespace: input.namespace,
      agentCatalogRef: input.agentCatalogRef,
      skills,
      mcpServers,
    });
    return Object.freeze({
      agentCatalogRef: input.agentCatalogRef,
      assemblyDigest: digest,
      skills: Object.freeze(skills),
      mcpServers: Object.freeze(mcpServers),
    });
  }

  async fetchArtifact(input: Readonly<{
    namespace: string;
    agentCatalogRef: string;
    grant: SkillGrantSelection;
    artifactRef: string;
    expectedSize: number;
    expectedSha256: string;
  }>, signal?: AbortSignal): Promise<Buffer> {
    throwIfAborted(signal);
    this.#assertRequest({
      namespace: input.namespace,
      agentCatalogRef: input.agentCatalogRef,
      skills: [input.grant],
      mcpServers: [],
    });
    if (!Number.isSafeInteger(input.expectedSize) || input.expectedSize < 1 ||
        input.expectedSize > MAX_ARTIFACT_BYTES || !DIGEST.test(input.expectedSha256)) {
      throw new ExecutionAssemblyError("HUB_SKILL_ARTIFACT_REQUEST_INVALID");
    }
    const publication = await this.dependencies.publications.findByAgentCatalogRef(
      input.agentCatalogRef,
    );
    throwIfAborted(signal);
    const option = publication?.publication.snapshot.skillOptions.find(
      (candidate) => candidate.optionRef === input.grant.optionRef,
    );
    if (publication === null || publication === undefined || publication.projectionState !== "committed" ||
        option === undefined || option.scope !== input.grant.scope || option.name !== input.grant.name ||
        option.contentHash !== input.grant.contentHash || option.description !== input.grant.description ||
        !allowedScope(input.namespace, input.grant.scope) ||
        await this.dependencies.skills.findActive(input.grant.scope, input.grant.name) === null) {
      throw new ExecutionAssemblyError("HUB_SKILL_ARTIFACT_NOT_AUTHORIZED");
    }
    throwIfAborted(signal);
    const expectedRef = packageRef(input.grant.scope, input.grant.name, input.grant.contentHash);
    if (input.artifactRef !== expectedRef) {
      throw new ExecutionAssemblyError("HUB_SKILL_ARTIFACT_REQUEST_INVALID");
    }
    const artifact = await this.#artifact(expectedRef, input.grant, signal);
    if (artifact.data.byteLength !== input.expectedSize || artifact.sha256 !== input.expectedSha256) {
      throw new ExecutionAssemblyError("HUB_SKILL_ARTIFACT_CHANGED");
    }
    return artifact.data;
  }

  async #artifact(
    artifactRef: string,
    grant: SkillGrantSelection,
    signal?: AbortSignal,
  ): Promise<Readonly<{ data: Buffer; sha256: string; unpackedBytes: number }>> {
    throwIfAborted(signal);
    const data = await this.dependencies.packages.get(artifactRef, signal);
    throwIfAborted(signal);
    if (data.byteLength < 1 || data.byteLength > MAX_ARTIFACT_BYTES) {
      throw new ExecutionAssemblyError("HUB_SKILL_ARTIFACT_INVALID");
    }
    let files: Record<string, string>;
    try {
      files = unzipTextFiles(data);
      const validated = validatePackage(grant.name, files);
      throwIfAborted(signal);
      if (validated.description !== grant.description || contentHashOf(files) !== grant.contentHash) {
        throw new Error("mismatch");
      }
      return Object.freeze({
        data: Buffer.from(data),
        sha256: createHash("sha256").update(data).digest("hex"),
        unpackedBytes: validated.packageSize,
      });
    } catch {
      throwIfAborted(signal);
      throw new ExecutionAssemblyError("HUB_SKILL_ARTIFACT_INVALID");
    }
  }

  #assertRequest(input: Readonly<{
    namespace: string;
    agentCatalogRef: string;
    skills: readonly SkillGrantSelection[];
    mcpServers: readonly McpGrantSelection[];
  }>): void {
    if (!reference(input.namespace, 256) ||
        !/^agent-catalog:sha256:[0-9a-f]{64}$/u.test(input.agentCatalogRef) ||
        input.skills.length > MAX_SKILLS || input.mcpServers.length > MAX_MCP ||
        duplicateSelections(input.skills) || duplicateSelections(input.mcpServers) ||
        input.skills.some((grant) => !skillGrant(grant)) ||
        input.mcpServers.some((grant) => !mcpGrant(grant))) {
      throw new ExecutionAssemblyError("HUB_EXECUTION_ASSEMBLY_REQUEST_INVALID");
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason;
}

export function executionAssemblyDigest(input: Readonly<{
  namespace: string;
  agentCatalogRef: string;
  skills: readonly SkillArtifactManifest[];
  mcpServers: readonly McpAssemblyConfig[];
}>): string {
  const canonical = {
    schemaVersion: 1,
    namespace: input.namespace,
    agentCatalogRef: input.agentCatalogRef,
    skills: input.skills.map((item) => ({
      optionRef: item.optionRef,
      scope: item.scope,
      name: item.name,
      contentHash: item.contentHash,
      description: item.description,
      artifactRef: item.artifactRef,
      artifactSize: item.artifactSize,
      artifactSha256: item.artifactSha256,
    })),
    mcpServers: input.mcpServers.map((item) => ({
      optionRef: item.optionRef,
      scope: item.scope,
      name: item.name,
      revision: item.revision,
      configHash: item.configHash,
      transport: item.transport,
      url: item.url,
      allowedTools: [...item.allowedTools],
      hasAuthorization: item.authorizationValue !== undefined,
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function duplicateSelections(
  values: readonly Readonly<{ optionRef: string; scope: string; name: string }>[],
): boolean {
  return new Set(values.map(({ optionRef }) => optionRef)).size !== values.length ||
    new Set(values.map(({ scope, name }) => `${scope}\0${name}`)).size !== values.length;
}

function skillGrant(value: SkillGrantSelection): boolean {
  return reference(value.optionRef, 256) && reference(value.scope, 256) &&
    reference(value.name, 256) && DIGEST.test(value.contentHash) &&
    value.description.length >= 1 && Buffer.byteLength(value.description, "utf8") <= 2_048;
}

function mcpGrant(value: McpGrantSelection): boolean {
  return reference(value.optionRef, 256) && reference(value.scope, 256) &&
    reference(value.name, 256) && Number.isSafeInteger(value.revision) && value.revision >= 1 &&
    DIGEST.test(value.configHash);
}

function allowedScope(namespace: string, scope: string): boolean {
  return scope === "official" || scope === namespace;
}

function secureMcpUrl(value: string): string {
  if (Buffer.byteLength(value, "utf8") > 4_096) {
    throw new ExecutionAssemblyError("HUB_EXECUTION_ASSEMBLY_MCP_CONFIG_INVALID");
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
        url.hash !== "" || url.hostname === "") throw new Error("invalid");
    return url.toString();
  } catch {
    throw new ExecutionAssemblyError("HUB_EXECUTION_ASSEMBLY_MCP_CONFIG_INVALID");
  }
}

function exactTools(values: readonly string[]): readonly string[] {
  if (values.length > 256 || new Set(values).size !== values.length ||
      values.some((value) => !reference(value, 256))) {
    throw new ExecutionAssemblyError("HUB_EXECUTION_ASSEMBLY_MCP_CONFIG_INVALID");
  }
  return Object.freeze([...values]);
}

function reference(value: string, maximum: number): boolean {
  return value.length >= 1 && value.length <= maximum && value.trim() === value;
}
