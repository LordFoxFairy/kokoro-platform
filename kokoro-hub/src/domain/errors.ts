// required 官方技能拒绝用户关闭（对齐 agent hub.py set_enabled）；路由映射为 409 resource.conflict。
export class SkillRequiredError extends Error {
  constructor(public readonly name: string) {
    super(`skill ${name} is required and cannot be disabled`);
    this.name = "SkillRequiredError";
  }
}
