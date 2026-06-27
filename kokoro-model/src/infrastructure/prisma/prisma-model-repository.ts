import type { Prisma, PrismaClient } from "../../../generated/prisma/index.js";
import type { ModelBinding, ProviderAccount } from "../../domain/model.js";
import type {
  EnsureModelBindingInput,
  EnsureProviderAccountInput,
  ListModelBindingsFilter,
  ModelRepository,
} from "../../domain/repository.js";

export class PrismaModelRepository implements ModelRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async ensureProviderAccount(input: EnsureProviderAccountInput): Promise<ProviderAccount> {
    const account = await this.prisma.providerAccount.upsert({
      where: {
        provider_key: {
          provider: input.provider,
          key: input.key,
        },
      },
      create: {
        provider: input.provider,
        key: input.key,
        label: input.label,
        secretRef: input.secretRef,
        priority: input.priority ?? 100,
        transportKind: input.transportKind,
        status: "active",
      },
      update: {
        label: input.label,
        secretRef: input.secretRef,
        priority: input.priority ?? 100,
        transportKind: input.transportKind,
        status: "active",
      },
    });

    return mapProviderAccount(account);
  }

  async ensureModelBinding(input: EnsureModelBindingInput): Promise<ModelBinding> {
    const account = await this.prisma.providerAccount.findUniqueOrThrow({
      where: {
        id: input.providerAccountId,
      },
    });

    const binding = await this.prisma.modelBinding.upsert({
      where: {
        providerAccountId_modelName_transportKind: {
          providerAccountId: input.providerAccountId,
          modelName: input.modelName,
          transportKind: input.transportKind,
        },
      },
      create: {
        providerAccountId: input.providerAccountId,
        provider: account.provider,
        modelName: input.modelName,
        displayName: input.displayName,
        featureKey: input.featureKey,
        labelKeys: input.labelKeys,
        inputModalities: input.inputModalities,
        outputModalities: input.outputModalities,
        transportKind: input.transportKind,
        ...defined("gatewayModelName", input.gatewayModelName),
        ...defined("contextWindow", input.contextWindow),
        priority: input.priority ?? 100,
        status: "active",
      },
      update: {
        provider: account.provider,
        displayName: input.displayName,
        featureKey: input.featureKey,
        labelKeys: input.labelKeys,
        inputModalities: input.inputModalities,
        outputModalities: input.outputModalities,
        transportKind: input.transportKind,
        gatewayModelName: input.gatewayModelName ?? null,
        contextWindow: input.contextWindow ?? null,
        priority: input.priority ?? 100,
        status: "active",
      },
    });

    return mapModelBinding(binding);
  }

  async listModelBindings(filter: ListModelBindingsFilter): Promise<ModelBinding[]> {
    const bindings = await this.prisma.modelBinding.findMany({
      where: {
        status: "active",
        ...defined("featureKey", filter.featureKey),
      },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });

    return bindings
      .map(mapModelBinding)
      .filter((binding) => !filter.labelKey || binding.labelKeys.includes(filter.labelKey));
  }
}

function defined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Record<Key, Value> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
}

function mapProviderAccount(account: {
  id: string;
  provider: string;
  key: string;
  label: string;
  secretRef: string;
  status: "active" | "disabled";
  priority: number;
  transportKind: "litellm" | "direct" | "internal";
  healthStatus: "unknown" | "healthy" | "degraded" | "down";
  createdAt: Date;
  updatedAt: Date;
}): ProviderAccount {
  return {
    id: account.id,
    provider: account.provider,
    key: account.key,
    label: account.label,
    secretRef: account.secretRef,
    status: account.status,
    priority: account.priority,
    transportKind: account.transportKind,
    healthStatus: account.healthStatus,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function mapModelBinding(binding: {
  id: string;
  providerAccountId: string;
  provider: string;
  modelName: string;
  displayName: string;
  featureKey: string;
  labelKeys: Prisma.JsonValue;
  inputModalities: Prisma.JsonValue;
  outputModalities: Prisma.JsonValue;
  transportKind: "litellm" | "direct" | "internal";
  gatewayModelName: string | null;
  contextWindow: number | null;
  priority: number;
  status: "active" | "disabled";
  createdAt: Date;
  updatedAt: Date;
}): ModelBinding {
  return {
    id: binding.id,
    providerAccountId: binding.providerAccountId,
    provider: binding.provider,
    modelName: binding.modelName,
    displayName: binding.displayName,
    featureKey: binding.featureKey,
    labelKeys: stringArray(binding.labelKeys),
    inputModalities: stringArray(binding.inputModalities),
    outputModalities: stringArray(binding.outputModalities),
    transportKind: binding.transportKind,
    gatewayModelName: binding.gatewayModelName,
    contextWindow: binding.contextWindow,
    priority: binding.priority,
    status: binding.status,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

function stringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
