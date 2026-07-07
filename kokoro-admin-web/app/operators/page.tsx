import { EndpointTable } from "@/components/shell/endpoint-table";

export default function Page(): React.ReactElement {
  return <EndpointTable endpoint="/api/operators" title="操作员" subtitle="后台操作员及其角色与租户作用域。" />;
}
