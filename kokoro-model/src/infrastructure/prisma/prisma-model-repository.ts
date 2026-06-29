import type { Prisma, PrismaClient } from "../../../generated/prisma/index.js";
import type { ModelBinding, ModelLabel, ProviderAccount } from "../../domain/model.js";
import type {
  EnsureModelBindingInput,
  EnsureProviderAccountInput,
  ListModelBindingsFilter,
  ModelRepository,
  ResolveModelInput,
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

  async resolveModelBindings(input: ResolveModelInput): Promise<ModelBinding[]> {
    const bindings = await this.prisma.modelBinding.findMany({
      where: {
        status: "active",
        featureKey: input.featureKey,
        ...defined("transportKind", input.transportKind),
        providerAccount: { status: "active", healthStatus: { not: "down" } },
      },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });

    return bindings
      .map(mapModelBinding)
      .filter((binding) => !input.labelKey || binding.labelKeys.includes(input.labelKey));
  }

  async listProviderAccounts(): Promise<ProviderAccount[]> {
    const accounts = await this.prisma.providerAccount.findMany({
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
      take: 100,
    });

    return accounts.map(mapProviderAccount);
  }

  async listAllModelBindings(): Promise<ModelBinding[]> {
    const bindings = await this.prisma.modelBinding.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    return bindings.map(mapModelBinding);
  }

  async listModelLabels(): Promise<ModelLabel[]> {
    const labels = await this.prisma.modelLabel.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    return labels.map(
      (label): ModelLabel => ({
        id: label.id,
        key: label.key,
        displayName: label.displayName,
        description: label.description,
        featureKey: label.featureKey,
        tier: label.tier,
        defaultBindingId: label.defaultBindingId,
        status: label.status,
        createdAt: label.createdAt,
        updatedAt: label.updatedAt,
      }),
    );
  }
}

function defined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Partial<Record<Key, Value>> {
  if (value === undefined) {
    return {};
  }
  const out: Partial<Record<Key, Value>> = {};
  out[key] = value;
  return out;
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
