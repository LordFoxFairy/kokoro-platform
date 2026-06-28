import { describe, expect, it } from "vitest";
import { ModelService } from "../../src/application/model-service.js";
import type { ModelBinding, ProviderAccount } from "../../src/domain/model.js";
import type {
  EnsureModelBindingInput,
  EnsureProviderAccountInput,
  ListModelBindingsFilter,
  ModelRepository,
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
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

interface Captured {
  account?: EnsureProviderAccountInput;
  binding?: EnsureModelBindingInput;
  filter?: ListModelBindingsFilter;
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

  it("forwards listModelBindings filter and result", async () => {
    const captured: Captured = {};
    const service = new ModelService(trackingRepo(captured));
    const filter: ListModelBindingsFilter = { featureKey: "chat", labelKey: "chat.default" };
    await expect(service.listModelBindings(filter)).resolves.toEqual([binding]);
    expect(captured.filter).toBe(filter);
  });
});
