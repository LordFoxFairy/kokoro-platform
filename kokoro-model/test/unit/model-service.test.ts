import { describe, expect, it } from "vitest";
import { ModelService } from "../../src/application/model-service.js";
import type { ModelBinding, ModelLabel, ProviderAccount, SiteModelPolicy } from "../../src/domain/model.js";
import type {
  EnsureModelBindingInput,
  EnsureModelLabelInput,
  EnsureProviderAccountInput,
  ListModelBindingsFilter,
  ModelRepository,
  ResolveModelInput,
  UpsertSiteModelPolicyInput,
} from "../../src/domain/repository.js";

const account: ProviderAccount = {
  id: "pa1",
  provider: "openai",
  key: "main",
  label: "OpenAI Main",
  secretRef: "secret://openai/main",
  status: "active",
  priority: 100,
  transportKind: "litellm",
  healthStatus: "unknown",
  deletedAt: null,
  deletedBy: null,
  deleteReason: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const binding: ModelBinding = {
  id: "mb1",
  providerAccountId: "pa1",
  provider: "openai",
  modelName: "gpt-4o",
  displayName: "GPT-4o",
  featureKey: "chat",
  labelKeys: ["chat.default"],
  inputModalities: ["text"],
  outputModalities: ["text"],
  transportKind: "litellm",
  gatewayModelName: null,
  contextWindow: null,
  priority: 100,
  status: "active",
  deletedAt: null,
  deletedBy: null,
  deleteReason: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const label: ModelLabel = {
  id: "ml1",
  key: "chat.default",
  displayName: "Kokoro 默认",
  description: null,
  featureKey: "chat",
  tier: null,
  defaultBindingId: null,
  status: "active",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const policy: SiteModelPolicy = {
  id: "sp1",
  siteId: "site-a",
  labelKey: "chat.premium",
  status: "hidden",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

interface Captured {
  account?: EnsureProviderAccountInput;
  binding?: EnsureModelBindingInput;
  filter?: ListModelBindingsFilter;
  resolve?: ResolveModelInput;
  label?: EnsureModelLabelInput;
  policy?: UpsertSiteModelPolicyInput;
  listPolicySiteId?: string | undefined;
  deleteProviderAccount?: { id: string; deletedBy: string; reason?: string | undefined };
  restoreProviderAccount?: { id: string };
  deleteModelBinding?: { id: string; deletedBy: string; reason?: string | undefined };
  restoreModelBinding?: { id: string };
}

function trackingRepo(captured: Captured): ModelRepository {
  return {
    ensureProviderAccount: async (input) => {
      captured.account = input;
      return account;
    },
    ensureModelBinding: async (input) => {
      captured.binding = input;
      return binding;
    },
    listModelBindings: async (filter) => {
      captured.filter = filter;
      return [binding];
    },
    resolveModelBindings: async (input) => {
      captured.resolve = input;
      return [binding];
    },
    listProviderAccounts: async () => [account],
    listAllModelBindings: async () => [binding],
    listModelLabels: async () => [label],
    ensureModelLabel: async (input) => {
      captured.label = input;
      return label;
    },
    setProviderAccountStatus: async () => account,
    setModelBindingStatus: async () => binding,
    deleteProviderAccount: async (input) => {
      captured.deleteProviderAccount = input;
      return { ...account, deletedAt: new Date(1), deletedBy: input.deletedBy, deleteReason: input.reason ?? null };
    },
    restoreProviderAccount: async (input) => {
      captured.restoreProviderAccount = input;
      return account;
    },
    deleteModelBinding: async (input) => {
      captured.deleteModelBinding = input;
      return { ...binding, deletedAt: new Date(1), deletedBy: input.deletedBy, deleteReason: input.reason ?? null };
    },
    restoreModelBinding: async (input) => {
      captured.restoreModelBinding = input;
      return binding;
    },
    upsertSiteModelPolicy: async (input) => {
      captured.policy = input;
      return policy;
    },
    listSiteModelPolicies: async (siteId) => {
      captured.listPolicySiteId = siteId;
      return [policy];
    },
  };
}

describe("ModelService delegates to repository", () => {
  const providerInput: EnsureProviderAccountInput = {
    provider: "openai",
    key: "main",
    label: "OpenAI Main",
    secretRef: "secret://openai/main",
    transportKind: "litellm",
  };
  const bindingInput: EnsureModelBindingInput = {
    providerAccountId: "pa1",
    modelName: "gpt-4o",
    displayName: "GPT-4o",
    featureKey: "chat",
    labelKeys: [],
    inputModalities: [],
    outputModalities: [],
    transportKind: "litellm",
  };

  it("forwards ensureProviderAccount input and result", async () => {
    const captured: Captured = {};
    const service = new ModelService(trackingRepo(captured));
    await expect(service.ensureProviderAccount(providerInput)).resolves.toBe(account);
    expect(captured.account).toBe(providerInput);
  });

  it("forwards ensureModelBinding input and result", async () => {
    const captured: Captured = {};
    const service = new ModelService(trackingRepo(captured));
    await expect(service.ensureModelBinding(bindingInput)).resolves.toBe(binding);
    expect(captured.binding).toBe(bindingInput);
  });

  it("forwards ensureModelLabel input and result", async () => {
    const captured: Captured = {};
    const service = new ModelService(trackingRepo(captured));
    const labelInput: EnsureModelLabelInput = {
      key: "chat.default",
      displayName: "Kokoro 默认",
      featureKey: "chat",
    };
    await expect(service.ensureModelLabel(labelInput)).resolves.toBe(label);
    expect(captured.label).toBe(labelInput);
  });

  it("forwards listModelLabels result", async () => {
    const service = new ModelService(trackingRepo({}));
    await expect(service.listModelLabels()).resolves.toEqual([label]);
  });

  it("listActiveModelLabels filters out disabled and by featureKey", async () => {
    const labels: ModelLabel[] = [
      { ...label, key: "chat.active", featureKey: "chat", status: "active" },
      { ...label, key: "chat.off", featureKey: "chat", status: "disabled" },
      { ...label, key: "embed.active", featureKey: "embedding", status: "active" },
    ];
    const repo = { ...trackingRepo({}), listModelLabels: async () => labels };
    const service = new ModelService(repo);
    // featureKey 过滤 + 只出 active。
    expect((await service.listActiveModelLabels("chat")).map((l) => l.key)).toEqual(["chat.active"]);
    // 无 featureKey = 只按 active 过滤,跨 feature。
    expect((await service.listActiveModelLabels()).map((l) => l.key)).toEqual(["chat.active", "embed.active"]);
  });

  it("forwards listModelBindings filter and result", async () => {
    const captured: Captured = {};
    const service = new ModelService(trackingRepo(captured));
    const filter: ListModelBindingsFilter = { featureKey: "chat", labelKey: "chat.default" };
    await expect(service.listModelBindings(filter)).resolves.toEqual([binding]);
    expect(captured.filter).toBe(filter);
  });

  it("forwards resolveModelBindings input and result", async () => {
    const captured: Captured = {};
    const service = new ModelService(trackingRepo(captured));
    const input: ResolveModelInput = { featureKey: "chat", labelKey: "chat.default", transportKind: "litellm" };
    await expect(service.resolveModelBindings(input)).resolves.toEqual([binding]);
    expect(captured.resolve).toBe(input);
  });

  it("forwards resolveModelBindings siteId to repository", async () => {
    const captured: Captured = {};
    const service = new ModelService(trackingRepo(captured));
    await service.resolveModelBindings({ featureKey: "chat", siteId: "site-a" });
    expect(captured.resolve?.siteId).toBe("site-a");
  });

  it("forwards upsertSiteModelPolicy input and result", async () => {
    const captured: Captured = {};
    const service = new ModelService(trackingRepo(captured));
    const input: UpsertSiteModelPolicyInput = {
      siteId: "site-a",
      labelKey: "chat.premium",
      status: "hidden",
    };
    await expect(service.upsertSiteModelPolicy(input)).resolves.toBe(policy);
    expect(captured.policy).toBe(input);
  });

  it("forwards listSiteModelPolicies siteId and result", async () => {
    const captured: Captured = {};
    const service = new ModelService(trackingRepo(captured));
    await expect(service.listSiteModelPolicies("site-a")).resolves.toEqual([policy]);
    expect(captured.listPolicySiteId).toBe("site-a");
  });

  it("forwards listSiteModelPolicies with omitted siteId", async () => {
    const captured: Captured = {};
    const service = new ModelService(trackingRepo(captured));
    await service.listSiteModelPolicies();
    expect(captured.listPolicySiteId).toBeUndefined();
  });

  it("forwards provider account lifecycle inputs and results", async () => {
    const captured: Captured = {};
    const service = new ModelService(trackingRepo(captured));
    const deleteInput = { id: "pa1", deletedBy: "operator-1", reason: "rotated" };

    await expect(service.deleteProviderAccount(deleteInput)).resolves.toMatchObject({
      id: "pa1",
      deletedBy: "operator-1",
      deleteReason: "rotated",
    });
    expect(captured.deleteProviderAccount).toBe(deleteInput);

    const restoreInput = { id: "pa1" };
    await expect(service.restoreProviderAccount(restoreInput)).resolves.toBe(account);
    expect(captured.restoreProviderAccount).toBe(restoreInput);
  });

  it("forwards model binding lifecycle inputs and results", async () => {
    const captured: Captured = {};
    const service = new ModelService(trackingRepo(captured));
    const deleteInput = { id: "mb1", deletedBy: "operator-1", reason: "retired" };

    await expect(service.deleteModelBinding(deleteInput)).resolves.toMatchObject({
      id: "mb1",
      deletedBy: "operator-1",
      deleteReason: "retired",
    });
    expect(captured.deleteModelBinding).toBe(deleteInput);

    const restoreInput = { id: "mb1" };
    await expect(service.restoreModelBinding(restoreInput)).resolves.toBe(binding);
    expect(captured.restoreModelBinding).toBe(restoreInput);
  });
});
