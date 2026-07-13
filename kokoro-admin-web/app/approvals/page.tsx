"use client";

// manifest 外专属页：审批工作流（网关本地 /api/approvals 状态机 + 复核动作），非模块 manifest 资源。
import { useRef, useState } from "react";
import { App, Tag } from "antd";
import {
  PageContainer,
  ProTable,
  ModalForm,
  ProFormTextArea,
  type ActionType,
  type ProColumns,
} from "@ant-design/pro-components";
import { z } from "zod";
import { apiGet, apiPost } from "@/lib/api";

const approvalSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    moduleId: z.string(),
    actionId: z.string(),
    siteId: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    requestedByEmail: z.string().nullable().optional(),
  })
  .passthrough();
const approvalsSchema = z.array(approvalSchema);
type Approval = z.infer<typeof approvalSchema>;

const STATUS_COLOR: Record<string, string> = {
  pending: "gold",
  approved: "green",
  executed: "green",
  rejected: "default",
  failed: "red",
};

export default function ApprovalsPage(): React.ReactElement {
  const { message } = App.useApp();
  const actionRef = useRef<ActionType>();
  const [rejectId, setRejectId] = useState<string | null>(null);

  async function approve(id: string) {
    try {
      await apiPost(`/api/approvals/${id}/approve`, {}, z.unknown());
      message.success("已批准 · 已执行");
      actionRef.current?.reload();
    } catch (e) {
      message.error(e instanceof Error ? e.message : "批准失败");
    }
  }

  const columns: ProColumns<Approval>[] = [
    {
      title: "动作",
      render: (_, r) => (
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {r.moduleId}/{r.actionId}
        </span>
      ),
    },
    { title: "站点", dataIndex: "siteId", render: (_, r) => r.siteId ?? "—" },
    { title: "申请人", dataIndex: "requestedByEmail", render: (_, r) => r.requestedByEmail ?? "—" },
    { title: "理由", dataIndex: "reason", ellipsis: true, render: (_, r) => r.reason ?? "—" },
    {
      title: "状态",
      dataIndex: "status",
      width: 110,
      render: (_, r) => <Tag color={STATUS_COLOR[r.status] ?? "default"}>{r.status}</Tag>,
    },
    {
      title: "操作",
      valueType: "option",
      width: 160,
      render: (_, r) =>
        r.status === "pending"
          ? [
              <a key="approve" onClick={() => approve(r.id)}>
                批准
              </a>,
              <a key="reject" style={{ color: "#c2410c" }} onClick={() => setRejectId(r.id)}>
                拒绝
              </a>,
            ]
          : [<span key="none" style={{ color: "rgba(0,0,0,0.35)" }}>—</span>],
    },
  ];

  return (
    <PageContainer header={{ title: "审批" }} content="maker-checker 审批队列；危险/大额动作在此二次确认。">
      <ProTable<Approval>
        actionRef={actionRef}
        rowKey="id"
        columns={columns}
        search={false}
        options={{ reload: true, density: true, setting: true }}
        pagination={{ pageSize: 20 }}
        headerTitle="待审批与历史"
        request={async () => {
          try {
            const rows = await apiGet("/api/approvals", approvalsSchema);
            return { data: rows, success: true, total: rows.length };
          } catch (e) {
            message.error(e instanceof Error ? e.message : "加载失败");
            return { data: [], success: false, total: 0 };
          }
        }}
      />

      <ModalForm
        open={rejectId !== null}
        title="拒绝审批"
        width={420}
        onOpenChange={(o) => !o && setRejectId(null)}
        modalProps={{ destroyOnHidden: true, okText: "确认拒绝", cancelText: "取消", okButtonProps: { danger: true } }}
        onFinish={async (values) => {
          if (!rejectId) return false;
          try {
            await apiPost(`/api/approvals/${rejectId}/reject`, { note: String(values.note ?? "") }, z.unknown());
            message.success("已拒绝");
            setRejectId(null);
            actionRef.current?.reload();
            return true;
          } catch (e) {
            message.error(e instanceof Error ? e.message : "拒绝失败");
            return false;
          }
        }}
      >
        <ProFormTextArea
          name="note"
          label="拒绝理由"
          rules={[{ required: true, message: "请填写拒绝理由" }]}
          fieldProps={{ rows: 3 }}
        />
      </ModalForm>
    </PageContainer>
  );
}
