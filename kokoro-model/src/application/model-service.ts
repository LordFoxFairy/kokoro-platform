import type {
  EnsureModelBindingInput,
  EnsureModelLabelInput,
  EnsureProviderAccountInput,
  ListModelBindingsFilter,
  ModelRepository,
  ResolveModelInput,
  UpsertSiteModelPolicyInput,
} from "../domain/repository.js";
import type { DeleteInput, RestoreInput } from "../domain/model-lifecycle.js";

export class ModelService {
  constructor(private readonly repository: ModelRepository) {}

  async ensureProviderAccount(input: EnsureProviderAccountInput) {
    return this.repository.ensureProviderAccount(input);
  }

  async ensureModelBinding(input: EnsureModelBindingInput) {
    return this.repository.ensureModelBinding(input);
  }

  async listModelBindings(filter: ListModelBindingsFilter) {
    return this.repository.listModelBindings(filter);
  }

  async listModelLabels() {
    return this.repository.listModelLabels();
  }

  // 运行时目录（session 消费）：只出 active，可按 featureKey 过滤。目录空/过滤后空都合法（消费侧回落）。
  async listActiveModelLabels(featureKey?: string | undefined) {
    const labels = await this.repository.listModelLabels();
    return labels.filter(
      (label) => label.status === "active" && (featureKey === undefined || label.featureKey === featureKey),
    );
  }

  async ensureModelLabel(input: EnsureModelLabelInput) {
    return this.repository.ensureModelLabel(input);
  }

  async resolveModelBindings(input: ResolveModelInput) {
    return this.repository.resolveModelBindings(input);
  }

  async listProviderAccounts(options?: Parameters<ModelRepository["listProviderAccounts"]>[0]) {
    return this.repository.listProviderAccounts(options);
  }

  async listAllModelBindings(options?: Parameters<ModelRepository["listAllModelBindings"]>[0]) {
    return this.repository.listAllModelBindings(options);
  }

  async deleteProviderAccount(input: DeleteInput) {
    return this.repository.deleteProviderAccount(input);
  }

  async restoreProviderAccount(input: RestoreInput) {
    return this.repository.restoreProviderAccount(input);
  }

  async deleteModelBinding(input: DeleteInput) {
    return this.repository.deleteModelBinding(input);
  }

  async restoreModelBinding(input: RestoreInput) {
    return this.repository.restoreModelBinding(input);
  }

  async upsertSiteModelPolicy(input: UpsertSiteModelPolicyInput) {
    return this.repository.upsertSiteModelPolicy(input);
  }

  async listSiteModelPolicies(siteId?: string | undefined) {
    return this.repository.listSiteModelPolicies(siteId);
  }
}
