// manifest 外专属页：审计留痕走 admin 网关本地端点（/api/audit，append-only），非模块 manifest 资源。
import { EndpointTable } from "@/components/shell/endpoint-table";

export default function Page(): React.ReactElement {
  return <EndpointTable endpoint="/api/audit" title="审计" subtitle="守门人记录的运营动作留痕（append-only）。" siteScoped />;
}
