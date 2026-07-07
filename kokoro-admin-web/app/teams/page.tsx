import { ResourceTable } from "@/components/shell/resource-table";

export default function Page(): React.ReactElement {
  return <ResourceTable moduleId="user" title="用户与团队" subtitle="用户、团队、成员与角色（站内隔离）。" />;
}
