import type {
  EnsureModelBindingInput,
  EnsureProviderAccountInput,
  ListModelBindingsFilter,
  ModelRepository,
  ResolveModelInput,
  UpsertSiteModelPolicyInput,
} from "../domain/repository.js";

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

  async resolveModelBindings(input: ResolveModelInput) {
    return this.repository.resolveModelBindings(input);
  }

  async upsertSiteModelPolicy(input: UpsertSiteModelPolicyInput) {
    return this.repository.upsertSiteModelPolicy(input);
  }

  async listSiteModelPolicies(siteId?: string | undefined) {
    return this.repository.listSiteModelPolicies(siteId);
  }
}
