"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Empty, Tag } from "antd";
import {
  PageContainer,
  ProTable,
  ModalForm,
  ProFormText,
  ProFormTextArea,
  ProFormDigit,
  ProFormSelect,
  ProFormSwitch,
  type ActionType,
  type ProColumns,
} from "@ant-design/pro-components";
import { PlusOutlined } from "@ant-design/icons";
import { z } from "zod";
import { apiGet, apiPost, queryString } from "@/lib/api";
import { actionResultSchema, permits, type ModuleManifest } from "@/lib/schemas";
import { useAdmin } from "@/components/shell/app-shell";
import { RESOURCE_FORMS, type FormField } from "@/lib/resource-forms";

const SIMPLE_ACTIONS = new Set(["enable", "disable", "toggle", "refund", "revoke", "approve", "publish", "delete", "restore"]);
const ACTION_LABELS: Record<string, string> = {
  enable: "启用",
  disable: "禁用",
  toggle: "切换",
  refund: "退款",
  revoke: "吊销",
  approve: "批准",
  publish: "发布",
  delete: "删除",
  restore: "恢复",
};
const RESOURCE_LABELS: Record<string, string> = {
  sites: "站点",
  domains: "域名",
  apps: "应用",
  policies: "策略",
  "feature-flags": "功能开关",
  "credit-accounts": "积分账户",
  "ledger-entries": "流水",
  "usage-records": "用量",
  "pricing-rules": "定价规则",
  orders: "订单",
  plans: "套餐",
  refunds: "退款",
  users: "用户",
  teams: "团队",
  models: "模型",
  "model-bindings": "模型绑定",
  "provider-accounts": "供应商账号",
  bindings: "绑定",
};

type Row = Record<string, unknown>;

const NUMERIC = /micros|amount|minor|balance|price|qty|count|total|held|score|num$/i;
const DATEISH = /(at|date|time)$/i;
const MONO = /(^|_)id$|email|(^|_)key$|token|hash|slug/i;
const STATUS = /status|state$/i;
const STATUS_COLOR: Record<string, string> = {
  active: "green",
  approved: "green",
  executed: "green",
  success: "green",
  paid: "green",
  enabled: "green",
  completed: "green",
  online: "green",
  ok: "green",
  pending: "gold",
  processing: "gold",
  held: "gold",
  beta: "blue",
  sandbox: "cyan",
  draft: "default",
  disabled: "default",
  inactive: "default",
  suspended: "orange",
  rejected: "default",
  archived: "default",
  refunded: "default",
  offline: "default",
  failed: "red",
  error: "red",
  expired: "red",
};

function buildColumns(rows: Row[]): ProColumns<Row>[] {
  const keys = new Set<string>();
  rows.slice(0, 30).forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
  return [...keys].map((key) => {
    const col: ProColumns<Row> = { title: key, dataIndex: key, ellipsis: true };
    if (STATUS.test(key)) {
      col.render = (_, r) => {
        const v = r[key];
        if (v == null || v === "") return "—";
        const s = String(v);
        return <Tag color={STATUS_COLOR[s.toLowerCase()] ?? "default"}>{s}</Tag>;
      };
    } else if (NUMERIC.test(key)) {
      col.align = "right";
      col.render = (_, r) => <span style={{ fontVariantNumeric: "tabular-nums" }}>{r[key] == null ? "—" : String(r[key])}</span>;
    } else if (DATEISH.test(key)) {
      col.valueType = "dateTime";
    } else if (MONO.test(key)) {
      col.copyable = true;
      col.width = 220;
    }
    return col;
  });
}

function firstRouteParam(route: string | null | undefined): string {
  return route?.match(/:([A-Za-z0-9_]+)/)?.[1] ?? "id";
}

function shouldSendSiteId(moduleId: string, resourceId: string, siteId: string): boolean {
  return siteId.length > 0 && !(moduleId === "site" && resourceId === "sites");
}

function resourceQueryParams(moduleId: string, resourceId: string, route: string, siteId: string): Record<string, string> {
  return {
    moduleId,
    route,
    ...(shouldSendSiteId(moduleId, resourceId, siteId) ? { siteId } : {}),
  };
}

function FormFields({
  fields,
  editMode,
  manifests,
  siteId,
}: {
  fields: FormField[];
  editMode: boolean;
  manifests: ModuleManifest[];
  siteId: string;
}): React.ReactElement {
  return (
    <>
      {fields.map((f) => {
        const disabled = editMode && f.editable === false;
        const rules = f.required ? [{ required: true, message: `请填写${f.label}` }] : undefined;
        if (f.optionsFrom) {
          const of = f.optionsFrom;
          return (
            <ProFormSelect
              key={f.name}
              name={f.name}
              label={f.label}
              tooltip={f.tip}
              rules={rules}
              disabled={disabled}
              placeholder="选择…"
              showSearch
              request={async () => {
                if (of.siteScoped && !siteId) return [];
                const route = manifests
                  .find((m) => m.id === of.moduleId)
                  ?.manifest?.resources?.find((r) => r.id === of.resourceId)?.route;
                if (!route) return [];
                const rows = await apiGet(
                  `/api/resource?${queryString(resourceQueryParams(of.moduleId, of.resourceId, route, of.siteScoped ? siteId : ""))}`,
                  z.array(z.record(z.unknown())),
                );
                return rows
                  .filter((r) => !of.siteScoped || r.siteId === siteId)
                  .map((r) => ({
                    label: of.labelKeys.map((k) => r[k]).filter(Boolean).map(String).join(" · ") || String(r.id),
                    value: String(r.id),
                  }));
              }}
            />
          );
        }
        if (f.type === "select") {
          return <ProFormSelect key={f.name} name={f.name} label={f.label} tooltip={f.tip} rules={rules} disabled={disabled} options={f.options} />;
        }
        if (f.type === "switch") {
          return <ProFormSwitch key={f.name} name={f.name} label={f.label} tooltip={f.tip} disabled={disabled} />;
        }
        if (f.type === "json") {
          return <ProFormTextArea key={f.name} name={f.name} label={f.label} tooltip={f.tip} rules={rules} disabled={disabled} fieldProps={{ rows: 4, placeholder: f.placeholder }} />;
        }
        if (f.type === "number") {
          return <ProFormDigit key={f.name} name={f.name} label={f.label} tooltip={f.tip} rules={rules} disabled={disabled} fieldProps={{ style: { width: "100%" } }} />;
        }
        return <ProFormText key={f.name} name={f.name} label={f.label} tooltip={f.tip} rules={rules} disabled={disabled} fieldProps={{ placeholder: f.placeholder }} />;
      })}
    </>
  );
}

export function ResourceTable({
  moduleId,
  title,
  subtitle,
}: {
  moduleId: string;
  title: string;
  subtitle: string;
}): React.ReactElement {
  const { me, siteId, manifests, reloadSites } = useAdmin();
  const { message } = App.useApp();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [cols, setCols] = useState<ProColumns<Row>[]>([]);
  const [simple, setSimple] = useState<{ actionId: string; label: string; danger: boolean; rowId: string; paramName: string } | null>(null);
  const [form, setForm] = useState<{ mode: "create" | "edit"; row?: Row } | null>(null);
  const actionRef = useRef<ActionType>();

  const mod = manifests.find((m) => m.id === moduleId);
  const online = manifests.length === 0 ? null : (mod?.online ?? false);
  const resources = useMemo(() => (mod?.online ? (mod.manifest?.resources ?? []) : []), [mod]);
  const active = resources.find((r) => r.id === activeId) ?? resources[0] ?? null;

  useEffect(() => {
    actionRef.current?.reload();
  }, [active?.id, siteId]);

  const resourceForm = active ? RESOURCE_FORMS[`${moduleId}:${active.id}`] : undefined;
  const upsertAvailable =
    resourceForm != null &&
    (active?.actions ?? []).some(
      (a) => a.id === resourceForm.actionId && a.route && (!a.requiredPermission || permits(me?.permissions ?? [], a.requiredPermission)),
    );

  const rowActions = useMemo(() => {
    if (!active) return [];
    return (active.actions ?? [])
      .filter((a) => SIMPLE_ACTIONS.has(a.id) && a.route && (!a.requiredPermission || permits(me?.permissions ?? [], a.requiredPermission)))
      .map((a) => ({ id: a.id, label: ACTION_LABELS[a.id] ?? a.id, danger: a.kind === "dangerMutation", paramName: firstRouteParam(a.route) }));
  }, [active, me]);

  const columns: ProColumns<Row>[] = useMemo(() => {
    const hasOps = rowActions.length > 0 || upsertAvailable;
    if (!hasOps) return cols;
    return [
      ...cols,
      {
        title: "操作",
        valueType: "option",
        fixed: "right",
        width: 80 + (rowActions.length + (upsertAvailable ? 1 : 0)) * 44,
        render: (_dom, row) => [
          ...(upsertAvailable ? [<a key="edit" onClick={() => setForm({ mode: "edit", row })}>编辑</a>] : []),
          ...rowActions.map((a) => (
            <a key={a.id} style={a.danger ? { color: "#c2410c" } : undefined} onClick={() => setSimple({ actionId: a.id, label: a.label, danger: a.danger, rowId: String(row.id ?? ""), paramName: a.paramName })}>
              {a.label}
            </a>
          )),
        ],
      },
    ];
  }, [cols, rowActions, upsertAvailable]);

  async function dispatchAction(actionId: string, extra: { params?: Record<string, string>; body?: Record<string, unknown>; reason?: string }): Promise<boolean> {
    try {
      const res = await apiPost(
        "/api/action",
        { moduleId, resourceId: active?.id, actionId, siteId, ...extra },
        actionResultSchema,
      );
      message.success(res.pendingApproval ? "已提交审批，待复核" : "成功 · 已留审计");
      actionRef.current?.reload();
      if (moduleId === "site") reloadSites();
      return true;
    } catch (e) {
      message.error(e instanceof Error ? e.message : "操作失败");
      return false;
    }
  }

  if (online === false) {
    return (
      <PageContainer header={{ title }} content={subtitle}>
        <Empty description="模块当前离线" style={{ padding: "64px 0" }} />
      </PageContainer>
    );
  }

  return (
    <PageContainer
      header={{ title }}
      content={subtitle}
      tabList={resources.length > 1 ? resources.map((r) => ({ tab: RESOURCE_LABELS[r.id] ?? r.id, key: r.id })) : undefined}
      onTabChange={setActiveId}
      tabActiveKey={active?.id}
    >
      <ProTable<Row>
        actionRef={actionRef}
        rowKey={(r) => String(r.id ?? Math.random())}
        columns={columns}
        search={false}
        options={{ density: true, reload: true, setting: true }}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        dateFormatter="string"
        headerTitle={title}
        toolBarRender={() =>
          upsertAvailable && resourceForm
            ? [
                <Button key="create" type="primary" icon={<PlusOutlined />} onClick={() => setForm({ mode: "create" })}>
                  {resourceForm.createLabel}
                </Button>,
              ]
            : []
        }
        request={async () => {
          if (!active) return { data: [], success: true, total: 0 };
          if (!shouldSendSiteId(moduleId, active.id, siteId) && !(moduleId === "site" && active.id === "sites")) {
            return { data: [], success: true, total: 0 };
          }
          try {
            const raw = await apiGet(
              `/api/resource?${queryString(resourceQueryParams(moduleId, active.id, active.route, siteId))}`,
              z.array(z.record(z.unknown())),
            );
            setCols(buildColumns(raw));
            return { data: raw, success: true, total: raw.length };
          } catch (e) {
            message.error(e instanceof Error ? e.message : "加载失败");
            return { data: [], success: false, total: 0 };
          }
        }}
      />

      {/* 简单生命周期动作 */}
      <ModalForm
        open={simple !== null}
        title={simple?.label}
        width={420}
        onOpenChange={(o) => !o && setSimple(null)}
        modalProps={{ destroyOnHidden: true, okText: "确认", cancelText: "取消", okButtonProps: { danger: simple?.danger } }}
        onFinish={async (values) => {
          if (!simple) return false;
          const reason = String(values.reason ?? "");
          const ok = await dispatchAction(simple.actionId, {
            params: { [simple.paramName]: simple.rowId },
            ...(simple.danger ? { reason, body: { reason } } : {}),
          });
          if (ok) setSimple(null);
          return ok;
        }}
      >
        {simple?.danger ? (
          <ProFormText name="reason" label="原因" rules={[{ required: true, message: "危险操作需填写理由" }]} />
        ) : (
          <div style={{ padding: "8px 0", color: "rgba(0,0,0,0.65)" }}>
            确认对 <b>{simple?.rowId}</b> 执行「{simple?.label}」？
          </div>
        )}
      </ModalForm>

      {/* 新建 / 编辑 */}
      {resourceForm ? (
        <ModalForm
          open={form !== null}
          title={form?.mode === "edit" ? `编辑${resourceForm.createLabel.replace(/^新建/, "")}` : resourceForm.createLabel}
          width={480}
          initialValues={form?.mode === "edit" ? form.row : undefined}
          onOpenChange={(o) => !o && setForm(null)}
          modalProps={{ destroyOnHidden: true, okText: "保存", cancelText: "取消" }}
          onFinish={async (values) => {
            const ok = await dispatchAction(resourceForm.actionId, { body: resourceForm.buildBody(values, { siteId }) });
            if (ok) setForm(null);
            return ok;
          }}
        >
          <FormFields fields={resourceForm.fields} editMode={form?.mode === "edit"} manifests={manifests} siteId={siteId} />
        </ModalForm>
      ) : null}
    </PageContainer>
  );
}
