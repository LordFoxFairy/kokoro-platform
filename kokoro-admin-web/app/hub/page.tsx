import { ResourceTable } from "@/components/shell/resource-table";

// 能力枢纽（技能池 / 上传 / 审核 / MCP 服务）全部经 manifest 通用渲染，无 per-module 前端代码。
export default function Page(): React.ReactElement {
  return <ResourceTable moduleId="hub" title="能力枢纽" subtitle="技能池、上传、审核与 MCP 服务（manifest 驱动）。" />;
}
