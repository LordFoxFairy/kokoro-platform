"use client";

// manifest 外专属页：用户 360 聚合视图（跨模块身份+积分+订单 + 专属运营动作），
// 非通用列表/动作可表达，故不走 ResourceTable 通用渲染。
import { useState } from "react";
import { App, Button, Descriptions, Empty, Input, Segmented, Space, Tag } from "antd";
import {
  PageContainer,
  ProCard,
  ProTable,
  ModalForm,
  ProFormText,
  ProFormDigit,
  ProFormSelect,
  type ProColumns,
} from "@ant-design/pro-components";
import { SearchOutlined } from "@ant-design/icons";
import { z } from "zod";
import { apiGet, apiPost, queryString } from "@/lib/api";
import { ACTION_SPECS, type ActionContext, type ActionKey } from "@/lib/actions";
import { actionResultSchema, user360Schema, type Order, type OwnerKind, type User360 } from "@/lib/schemas";
import { useAdmin } from "@/components/shell/app-shell";

const ORDER_STATUS_COLOR: Record<string, string> = {
  paid: "green",
  pending: "gold",
  refunded: "default",
  failed: "red",
};

export default function UsersPage(): React.ReactElement {
  const { siteId, can, manifests } = useAdmin();
  const { message } = App.useApp();
  const [ownerKind, setOwnerKind] = useState<OwnerKind>("team");
  const [ownerId, setOwnerId] = useState("");
  const [result, setResult] = useState<User360 | null>(null);
  const [resultOwner, setResultOwner] = useState<{ ownerKind: OwnerKind; ownerId: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [openKey, setOpenKey] = useState<ActionKey | null>(null);
  const [orderId, setOrderId] = useState<string | undefined>(undefined);

  async function lookup() {
    if (!siteId) return message.error("请先在右上角选择站点");
    const trimmed = ownerId.trim();
    if (!trimmed) return message.error("请输入 owner ID");
    setLoading(true);
    try {
      const data = await apiGet(
        `/api/user360?${queryString({ siteId, ownerKind, ownerId: trimmed })}`,
        user360Schema,
      );
      setResult(data);
      setResultOwner({ ownerKind, ownerId: trimmed });
    } catch (e) {
      message.error(e instanceof Error ? e.message : "查询失败");
    } finally {
      setLoading(false);
    }
  }

  const identity = result?.identity ?? null;
  const account = result?.creditAccount ?? null;
  const spec = openKey ? ACTION_SPECS[openKey] : null;

  const userToggleKey: ActionKey | null =
    resultOwner?.ownerKind === "user" && identity && can("user.disable")
      ? identity.status === "active"
        ? "disableUser"
        : "enableUser"
      : null;

  function start(key: ActionKey, oid?: string) {
    setOrderId(oid);
    setOpenKey(key);
  }

  const orderColumns: ProColumns<Order>[] = [
    { title: "订单", dataIndex: "id", copyable: true, ellipsis: true },
    { title: "套餐", dataIndex: "planId", render: (_, r) => r.planId ?? "—" },
    {
      title: "金额",
      align: "right",
      render: (_, r) => (
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {r.amountMinor ?? "—"} {r.currency ?? ""}
        </span>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (_, r) => (r.status ? <Tag color={ORDER_STATUS_COLOR[r.status] ?? "default"}>{r.status}</Tag> : "—"),
    },
    {
      title: "操作",
      valueType: "option",
      width: 90,
      render: (_, r) =>
        r.status === "paid" && can("payment.order.refund")
          ? [
              <a key="refund" style={{ color: "#c2410c" }} onClick={() => start("refund", r.id)}>
                退款
              </a>,
            ]
          : [<span key="none" style={{ color: "rgba(0,0,0,0.35)" }}>—</span>],
    },
  ];

  return (
    <PageContainer header={{ title: "用户 360" }} content="按 owner 查询身份、积分与订单，并执行运营操作。">
      <ProCard style={{ marginBottom: 16 }}>
        <Space size="middle" wrap align="end">
          <Segmented
            value={ownerKind}
            onChange={(v) => setOwnerKind(v as OwnerKind)}
            options={[
              { label: "团队", value: "team" },
              { label: "用户", value: "user" },
            ]}
          />
          <Input
            style={{ width: 320, fontFamily: "var(--font-mono)" }}
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            onPressEnter={lookup}
            placeholder={`输入 ${ownerKind} id`}
            allowClear
          />
          <Button type="primary" icon={<SearchOutlined />} loading={loading} onClick={lookup}>
            查询
          </Button>
        </Space>
      </ProCard>

      {!result || !resultOwner ? (
        <ProCard>
          <Empty description="输入 owner ID，开始查询" style={{ padding: "48px 0" }} />
        </ProCard>
      ) : (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <ProCard
            title="身份 & 积分"
            bordered
            headerBordered
            extra={
              <Space>
                {can("credit.grant") ? (
                  <Button type="primary" onClick={() => start("grant")}>
                    发积分
                  </Button>
                ) : null}
                {resultOwner.ownerKind === "team" && can("payment.plan.grant") ? (
                  <Button onClick={() => start("grantPlan")}>授予套餐</Button>
                ) : null}
                {userToggleKey === "disableUser" ? (
                  <Button danger onClick={() => start("disableUser")}>
                    禁用用户
                  </Button>
                ) : null}
                {userToggleKey === "enableUser" ? <Button onClick={() => start("enableUser")}>启用用户</Button> : null}
              </Space>
            }
          >
            <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
              <Descriptions.Item label="归属">
                {resultOwner.ownerKind} · <span style={{ fontFamily: "var(--font-mono)" }}>{resultOwner.ownerId}</span>
              </Descriptions.Item>
              <Descriptions.Item label="站点">{siteId}</Descriptions.Item>
              <Descriptions.Item label="身份状态">
                {identity?.status ? <Tag color={identity.status === "active" ? "green" : "default"}>{identity.status}</Tag> : "—"}
              </Descriptions.Item>
              <Descriptions.Item label="名称">{identity?.displayName ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="积分余额">
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{account?.balanceMicros ?? "—"}</span>
              </Descriptions.Item>
              <Descriptions.Item label="冻结">
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{account?.heldMicros ?? "—"}</span>
              </Descriptions.Item>
            </Descriptions>
          </ProCard>

          <ProCard title={`订单（${result.orders.length}）`} bordered headerBordered bodyStyle={{ padding: 0 }}>
            <ProTable<Order>
              rowKey="id"
              columns={orderColumns}
              dataSource={result.orders}
              search={false}
              options={false}
              pagination={false}
              locale={{ emptyText: <Empty description="无订单" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            />
          </ProCard>
        </Space>
      )}

      <ModalForm
        open={openKey !== null}
        title={spec?.title}
        width={440}
        onOpenChange={(o) => !o && setOpenKey(null)}
        modalProps={{ destroyOnHidden: true, okText: "确认", cancelText: "取消", okButtonProps: { danger: spec?.danger } }}
        onFinish={async (values) => {
          if (!spec || !resultOwner || !result) return false;
          const ctx: ActionContext = {
            siteId,
            ownerKind: resultOwner.ownerKind,
            ownerId: resultOwner.ownerId,
            data: result,
            ...(orderId === undefined ? {} : { orderId }),
          };
          try {
            const res = await apiPost(
              "/api/action",
              spec.build(values as Record<string, string>, ctx),
              actionResultSchema,
            );
            message.success(res.pendingApproval ? "已提交审批，待复核" : "成功 · 已留审计");
            setOpenKey(null);
            void lookup();
            return true;
          } catch (e) {
            message.error(e instanceof Error ? e.message : "操作失败");
            return false;
          }
        }}
      >
        {(spec?.fields ?? []).map((f) =>
          f.name === "planId" ? (
            <ProFormSelect
              key={f.name}
              name={f.name}
              label={f.label}
              rules={f.required ? [{ required: true }] : undefined}
              placeholder="选择本站套餐"
              request={async () => {
                if (!siteId) return [];
                const route = manifests
                  .find((m) => m.id === "payment")
                  ?.manifest?.resources?.find((r) => r.id === "plans")?.route;
                if (!route) return [];
                const rows = await apiGet(
                  `/api/resource?${queryString({ moduleId: "payment", route, siteId })}`,
                  z.array(z.record(z.unknown())),
                );
                return rows
                  .filter((r) => r.siteId === siteId)
                  .map((r) => ({ label: `${String(r.name ?? r.key)} · ${String(r.key)}`, value: String(r.id) }));
              }}
            />
          ) : f.type === "select" ? (
            <ProFormSelect
              key={f.name}
              name={f.name}
              label={f.label}
              rules={f.required ? [{ required: true }] : undefined}
              options={(f.options ?? []).map((o) => ({ label: o, value: o }))}
            />
          ) : f.type === "number" ? (
            <ProFormDigit key={f.name} name={f.name} label={f.label} rules={f.required ? [{ required: true }] : undefined} />
          ) : (
            <ProFormText key={f.name} name={f.name} label={f.label} rules={f.required ? [{ required: true }] : undefined} />
          ),
        )}
        {(spec?.fields ?? []).length === 0 ? (
          <div style={{ padding: "8px 0", color: "rgba(0,0,0,0.65)" }}>确认执行该操作？</div>
        ) : null}
      </ModalForm>
    </PageContainer>
  );
}
