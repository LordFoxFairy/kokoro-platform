import { ResourceTable } from "@/components/shell/resource-table";

export default function Page(): React.ReactElement {
  return <ResourceTable moduleId="payment" title="支付" subtitle="订单、套餐与退款。" />;
}
