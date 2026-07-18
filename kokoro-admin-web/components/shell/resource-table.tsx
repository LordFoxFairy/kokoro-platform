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
import { PlusOutlined, UploadOutlined } from "@ant-design/icons";
import { z } from "zod";
import { apiGet, apiPost, queryString } from "@/lib/api";
import { actionResultSchema, permits, type ModuleManifest } from "@/lib/schemas";
import { useAdmin } from "@/components/shell/app-shell";
import { useT } from "@/lib/i18n/context";
import type { MessageKey } from "@/lib/i18n/messages";
import { RESOURCE_FORMS, ROW_ACTION_FORMS, type FormField, type RowActionForm } from "@/lib/resource-forms";
import { SkillUploadModal } from "@/components/shell/skill-upload-modal";

// 资源/动作文案一律取自 manifest 声明的 labelKey（经 i18n 解析），前端不再维护标签映射表。
// 本集合只做「行内单目标动作 vs 走表单的写动作」的行为分类，与显示文案无关。
const SIMPLE_ACTIONS = new Set(["enable", "disable", "toggle", "refund", "revoke", "approve", "publish", "delete", "restore"]);

type Row = Record<string, unknown>;
type Translate = (key: MessageKey, vars?: Readonly<Record<string, string | number>>) => string;

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

// 列头：优先 i18n 通用列名 col.<key>，词典无此 key 时引擎回传 key 本身 → 回退原始字段名。
// 列的「类型」仍按字段名启发式推断（manifest 未声明每列类型；补充需模块侧 manifest 扩列元数据）。
function columnTitle(t: Translate, key: string): string {
  const resolved = t(`col.${key}` as MessageKey);
  return resolved === `col.${key}` ? key : resolved;
}

function buildColumns(rows: Row[], t: Translate): ProColumns<Row>[] {
  const keys = new Set<string>();
  rows.slice(0, 30).forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
  return [...keys].map((key) => {
    const col: ProColumns<Row> = { title: columnTitle(t, key), dataIndex: key, ellipsis: true };
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
  const t = useT();
  return (
    <>
      {fields.map((f) => {
        const disabled = editMode && f.editable === false;
        const rules = f.required ? [{ required: true, message: t("ui.required", { label: f.label }) }] : undefined;
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
              placeholder={t("ui.selectPlaceholder")}
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
  const t = useT();
  const { message } = App.useApp();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sampleRows, setSampleRows] = useState<Row[]>([]);
  const [simple, setSimple] = useState<{ actionId: string; label: string; danger: boolean; rowId: string; paramName: string } | null>(null);
  const [form, setForm] = useState<{ mode: "create" | "edit"; row?: Row } | null>(null);
  // 行级 typed 小表单(ROW_ACTION_FORMS)当前打开态:行级动作 + typed body。
  const [rowForm, setRowForm] = useState<{ actionId: string; label: string; form: RowActionForm; row: Row; paramName: string } | null>(null);
  // bespoke 技能上传两步流开关（文件+预览+逐项确认，通用表单覆盖不了）。
  const [uploadOpen, setUploadOpen] = useState(false);
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
  // 技能上传：资源声明了 upload-preview 动作且操作员有权 → 亮 bespoke 上传按钮。
  const uploadAvailable = (active?.actions ?? []).some(
    (a) => a.id === "upload-preview" && a.route && (!a.requiredPermission || permits(me?.permissions ?? [], a.requiredPermission)),
  );

  // 动作按钮文案取 manifest 声明的 labelKey（i18n 解析）；无对应词典项时回退 key 本身。
  const rowActions = useMemo(() => {
    if (!active) return [];
    return (active.actions ?? [])
      .filter((a) => SIMPLE_ACTIONS.has(a.id) && a.route && (!a.requiredPermission || permits(me?.permissions ?? [], a.requiredPermission)))
      .map((a) => ({ id: a.id, labelKey: a.labelKey, danger: a.kind === "dangerMutation", paramName: firstRouteParam(a.route) }));
  }, [active, me]);

  // 行级 typed 小表单动作:manifest 里非 SIMPLE_ACTIONS 但在 ROW_ACTION_FORMS 声明了字段的行级动作。
  const rowFormActions = useMemo(() => {
    if (!active) return [];
    return (active.actions ?? [])
      .filter(
        (a) =>
          !SIMPLE_ACTIONS.has(a.id) &&
          a.route &&
          ROW_ACTION_FORMS[`${moduleId}:${active.id}:${a.id}`] != null &&
          (!a.requiredPermission || permits(me?.permissions ?? [], a.requiredPermission)),
      )
      .map((a) => ({
        id: a.id,
        labelKey: a.labelKey,
        form: ROW_ACTION_FORMS[`${moduleId}:${active.id}:${a.id}`]!,
        paramName: firstRouteParam(a.route),
      }));
  }, [active, me, moduleId]);

  const baseCols = useMemo(() => buildColumns(sampleRows, t), [sampleRows, t]);

  const columns: ProColumns<Row>[] = useMemo(() => {
    const hasOps = rowActions.length > 0 || rowFormActions.length > 0 || upsertAvailable;
    if (!hasOps) return baseCols;
    return [
      ...baseCols,
      {
        title: t("ui.actionsColumn"),
        valueType: "option",
        fixed: "right",
        width: 80 + (rowActions.length + rowFormActions.length + (upsertAvailable ? 1 : 0)) * 44,
        render: (_dom, row) => [
          ...(upsertAvailable && !resourceForm?.createOnly
            ? [<a key="edit" onClick={() => setForm({ mode: "edit", row })}>{t("ui.edit")}</a>]
            : []),
          ...rowActions.map((a) => {
            const label = t(a.labelKey as MessageKey);
            return (
              <a key={a.id} style={a.danger ? { color: "#c2410c" } : undefined} onClick={() => setSimple({ actionId: a.id, label, danger: a.danger, rowId: String(row[a.paramName] ?? row.id ?? ""), paramName: a.paramName })}>
                {label}
              </a>
            );
          }),
          ...rowFormActions.map((a) => {
            const label = t(a.labelKey as MessageKey);
            return (
              <a key={a.id} onClick={() => setRowForm({ actionId: a.id, label, form: a.form, row, paramName: a.paramName })}>
                {label}
              </a>
            );
          }),
        ],
      },
    ];
  }, [baseCols, rowActions, rowFormActions, upsertAvailable, t]);

  async function dispatchAction(actionId: string, extra: { params?: Record<string, string>; body?: Record<string, unknown>; reason?: string }): Promise<boolean> {
    try {
      const res = await apiPost(
        "/api/action",
        { moduleId, resourceId: active?.id, actionId, siteId, ...extra },
        actionResultSchema,
      );
      message.success(res.pendingApproval ? t("ui.pendingApproval") : t("ui.success"));
      actionRef.current?.reload();
      if (moduleId === "site") reloadSites();
      return true;
    } catch (e) {
      message.error(e instanceof Error ? e.message : t("ui.actionFailed"));
      return false;
    }
  }

  // 新建/编辑按钮与弹窗标题：取该写动作 manifest 声明的 labelKey，前端不再硬编码。
  const createAction = active?.actions?.find((a) => a.id === resourceForm?.actionId);
  const createLabel = createAction ? t(createAction.labelKey as MessageKey) : t("ui.create");

  if (online === false) {
    return (
      <PageContainer header={{ title }} content={subtitle}>
        <Empty description={t("ui.moduleOffline")} style={{ padding: "64px 0" }} />
      </PageContainer>
    );
  }

  return (
    <PageContainer
      header={{ title }}
      content={subtitle}
      tabList={resources.length > 1 ? resources.map((r) => ({ tab: t(r.labelKey as MessageKey), key: r.id })) : undefined}
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
        toolBarRender={() => [
          ...(upsertAvailable && resourceForm
            ? [
                <Button key="create" type="primary" icon={<PlusOutlined />} onClick={() => setForm({ mode: "create" })}>
                  {createLabel}
                </Button>,
              ]
            : []),
          ...(uploadAvailable
            ? [
                <Button key="skill-upload" type="primary" icon={<UploadOutlined />} onClick={() => setUploadOpen(true)}>
                  {t("ui.skillUpload.button")}
                </Button>,
              ]
            : []),
        ]}
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
            setSampleRows(raw);
            return { data: raw, success: true, total: raw.length };
          } catch (e) {
            message.error(e instanceof Error ? e.message : t("ui.loadFailed"));
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
        modalProps={{ destroyOnHidden: true, okText: t("ui.confirm"), cancelText: t("ui.cancel"), okButtonProps: { danger: simple?.danger } }}
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
          <ProFormText name="reason" label={t("ui.reason")} rules={[{ required: true, message: t("ui.reasonRequired") }]} />
        ) : (
          <div style={{ padding: "8px 0", color: "rgba(0,0,0,0.65)" }}>
            {t("ui.confirmAction", { id: simple?.rowId ?? "", label: simple?.label ?? "" })}
          </div>
        )}
      </ModalForm>

      {/* 新建 / 编辑 */}
      {resourceForm ? (
        <ModalForm
          open={form !== null}
          title={form?.mode === "edit" ? t("ui.edit") : createLabel}
          width={480}
          initialValues={form?.mode === "edit" ? form.row : undefined}
          onOpenChange={(o) => !o && setForm(null)}
          modalProps={{ destroyOnHidden: true, okText: t("ui.save"), cancelText: t("ui.cancel") }}
          onFinish={async (values) => {
            const ok = await dispatchAction(resourceForm.actionId, { body: resourceForm.buildBody(values, { siteId }) });
            if (ok) setForm(null);
            return ok;
          }}
        >
          <FormFields fields={resourceForm.fields} editMode={form?.mode === "edit"} manifests={manifests} siteId={siteId} />
        </ModalForm>
      ) : null}

      {/* 行级 typed 小表单(ROW_ACTION_FORMS):初值由行当前值预填;提交发 params(单/首 :param) + typed body。 */}
      <ModalForm
        open={rowForm !== null}
        title={rowForm?.label}
        width={440}
        initialValues={rowForm?.row}
        onOpenChange={(o) => !o && setRowForm(null)}
        modalProps={{ destroyOnHidden: true, okText: t("ui.save"), cancelText: t("ui.cancel") }}
        onFinish={async (values) => {
          if (!rowForm) return false;
          const paramValue = String(rowForm.row[rowForm.paramName] ?? rowForm.row.id ?? "");
          const ok = await dispatchAction(rowForm.actionId, {
            params: { [rowForm.paramName]: paramValue },
            body: rowForm.form.buildBody(values),
          });
          if (ok) setRowForm(null);
          return ok;
        }}
      >
        {rowForm ? <FormFields fields={rowForm.form.fields} editMode={false} manifests={manifests} siteId={siteId} /> : null}
      </ModalForm>

      {/* bespoke 技能上传两步流 */}
      {uploadAvailable ? (
        <SkillUploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} onDone={() => actionRef.current?.reload()} />
      ) : null}
    </PageContainer>
  );
}
