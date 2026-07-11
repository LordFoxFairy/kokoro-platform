// required 官方技能拒绝用户关闭（对齐 agent hub.py set_enabled）；路由映射为 409 resource.conflict。
export class SkillRequiredError extends Error {
  constructor(public readonly name: string) {
    super(`skill ${name} is required and cannot be disabled`);
    this.name = "SkillRequiredError";
  }
}

// 入库校验清单违规（skills-design §5）：坏包 fail-loud 不入库；preview 收敛为候选项 errors。
export class SkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillValidationError";
  }
}

// revision CAS 落败（对齐 agent hub.py upsert）：竞争者先写，本次不覆盖，调用方可重试。
export class ConcurrentWriteError extends Error {
  constructor(scope: string, name: string) {
    super(`concurrent write conflict on skill ${scope}/${name}`);
    this.name = "ConcurrentWriteError";
  }
}

// 包体存储不可用/对象缺失（local/s3 双档同一错误面）。
export class PackageStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageStoreError";
  }
}

// namespace 上传配额（包数/字节合计，env 上限）超限：confirm 单项失败，不阻断其余项。
export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}
