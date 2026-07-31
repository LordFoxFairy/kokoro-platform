import type { AuthenticatedUserSession, ProductWorkloadIdentity } from "../../modules/authorization/domain/session-access-grant.js";
import type { VerifiedRequestSecurityContext } from "../../shared/security-context/index.js";
import {
  PLATFORM_PUBLIC_OPERATIONS,
  type PlatformPublicOperationId,
} from "./generated/platform-public/operations.gen.js";

type RuntimeSchemaOutput<Schema> = Schema extends { parse(value: unknown): infer Output }
  ? Output
  : null;

type OperationDefinition<Id extends PlatformPublicOperationId> =
  (typeof PLATFORM_PUBLIC_OPERATIONS)[Id];

export type PlatformPublicOperationExecution<Id extends PlatformPublicOperationId> = Readonly<{
  operationId: Id;
  workload: ProductWorkloadIdentity;
  session: AuthenticatedUserSession | null;
  context: VerifiedRequestSecurityContext;
  headers: RuntimeSchemaOutput<OperationDefinition<Id>["requestSchemas"]["headers"]>;
  body: RuntimeSchemaOutput<OperationDefinition<Id>["requestSchemas"]["body"]>;
  path: RuntimeSchemaOutput<OperationDefinition<Id>["requestSchemas"]["path"]>;
  query: RuntimeSchemaOutput<OperationDefinition<Id>["requestSchemas"]["query"]>;
  receiptRecoveryCapability: string | null;
  signal: AbortSignal;
}>;

export interface PlatformPublicOperationDescriptor<Id extends PlatformPublicOperationId = PlatformPublicOperationId> {
  readonly operationId: Id;
  readonly successStatus?: (result: unknown) => number;
  readonly targetProjectRef?: (
    input: Readonly<{
      body: RuntimeSchemaOutput<OperationDefinition<Id>["requestSchemas"]["body"]>;
      path: RuntimeSchemaOutput<OperationDefinition<Id>["requestSchemas"]["path"]>;
    }>,
  ) => string | null;
  execute(input: PlatformPublicOperationExecution<Id>): Promise<unknown>;
}

export type RegisteredPlatformPublicOperation = PlatformPublicOperationDescriptor<PlatformPublicOperationId>;

export type MatchedPlatformPublicOperation = Readonly<{
  descriptor: RegisteredPlatformPublicOperation;
  definition: (typeof PLATFORM_PUBLIC_OPERATIONS)[PlatformPublicOperationId];
  path: Readonly<Record<string, string>>;
}>;

export interface PlatformPublicOperationRegistry {
  match(method: string | undefined, path: string): MatchedPlatformPublicOperation | null;
}

export function definePlatformPublicOperation<Id extends PlatformPublicOperationId>(
  descriptor: PlatformPublicOperationDescriptor<Id>,
): PlatformPublicOperationDescriptor<Id> {
  return Object.freeze(descriptor);
}

export function createPlatformPublicOperationRegistry(
  descriptors: readonly RegisteredPlatformPublicOperation[],
  requiredOperationIds: readonly PlatformPublicOperationId[] = [],
): PlatformPublicOperationRegistry {
  const seen = new Set<PlatformPublicOperationId>();
  const routes = descriptors.map((descriptor) => {
    if (seen.has(descriptor.operationId)) throw new Error("PLATFORM_PUBLIC_OPERATION_DUPLICATE");
    seen.add(descriptor.operationId);
    const definition = PLATFORM_PUBLIC_OPERATIONS[descriptor.operationId];
    return Object.freeze({ descriptor, definition, matcher: compilePath(definition.path) });
  });
  if (requiredOperationIds.some((operationId) => !seen.has(operationId))) {
    throw new Error("PLATFORM_PUBLIC_REQUIRED_OPERATION_MISSING");
  }
  return Object.freeze({
    match(method: string | undefined, path: string) {
      for (const route of routes) {
        if (route.definition.method !== method) continue;
        const parameters = route.matcher(path);
        if (parameters !== null) {
          return Object.freeze({
            descriptor: route.descriptor,
            definition: route.definition,
            path: Object.freeze(parameters),
          });
        }
      }
      return null;
    },
  });
}

function compilePath(template: string): (path: string) => Record<string, string> | null {
  const names: string[] = [];
  let source = "^";
  for (let offset = 0; offset < template.length;) {
    if (template[offset] === "{") {
      const end = template.indexOf("}", offset + 1);
      if (end < 0) throw new Error("PLATFORM_PUBLIC_GENERATED_PATH_INVALID");
      const name = template.slice(offset + 1, end);
      if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(name) || names.includes(name)) {
        throw new Error("PLATFORM_PUBLIC_GENERATED_PATH_INVALID");
      }
      names.push(name);
      source += "([^/]+)";
      offset = end + 1;
      continue;
    }
    source += escapeRegex(template[offset]!);
    offset += 1;
  }
  const expression = new RegExp(`${source}$`, "u");
  return (path) => {
    const match = expression.exec(path);
    if (match === null) return null;
    const result: Record<string, string> = {};
    try {
      for (const [index, name] of names.entries()) {
        const value = decodeURIComponent(match[index + 1]!);
        if (value.includes("/") || value.includes("\\") || value.length > 256) return null;
        result[name] = value;
      }
    } catch {
      return null;
    }
    return result;
  };
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}
