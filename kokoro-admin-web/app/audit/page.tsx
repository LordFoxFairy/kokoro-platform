import { EndpointTable } from "@/components/shell/endpoint-table";

export default function Page(): React.ReactElement {
  return <EndpointTable endpoint="/api/audit" title="审计" subtitle="守门人记录的运营动作留痕（append-only）。" siteScoped />;
}
