// manifest 外专属页：操作员治理走 admin 网关本地端点（/api/operators），非模块 manifest 资源。
import { EndpointTable } from "@/components/shell/endpoint-table";

export default function Page(): React.ReactElement {
  return <EndpointTable endpoint="/api/operators" title="操作员" subtitle="后台操作员及其角色与租户作用域。" />;
}
