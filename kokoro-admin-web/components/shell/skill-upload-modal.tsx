"use client";

// 技能上传 bespoke 两步流（通用 ResourceTable 表单覆盖不了：文件 + 预览 + 逐项确认）。
// 走 /api/action(actionId=upload-preview/upload-confirm) → 网关透传上游 UploadPreview/ConfirmResult，
// 享网关 RBAC + 审计。上传归属恒 scope==namespace（自有包，官方位只走 seed/管理面）。
import { useState } from "react";
import { App, Alert, Button, Input, Modal, Space, Steps, Table, Tag, Typography, Upload } from "antd";
import { InboxOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { apiPost } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import {
  skillUploadConfirmSchema,
  skillUploadPreviewSchema,
  type SkillUploadCandidate,
  type SkillUploadConfirm,
  type SkillUploadPreview,
} from "@/lib/schemas";

// FileReader → raw base64（剥离 data:...;base64, 前缀，hub 只收裸 base64）。
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result);
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

type ConfirmRow = SkillUploadConfirm["results"][number];

export function SkillUploadModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const t = useT();
  const { message } = App.useApp();
  const [step, setStep] = useState(0);
  const [namespace, setNamespace] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [zipB64, setZipB64] = useState("");
  const [preview, setPreview] = useState<SkillUploadPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<SkillUploadConfirm | null>(null);
  const [busy, setBusy] = useState(false);

  function reset(): void {
    setStep(0);
    setNamespace("");
    setFile(null);
    setZipB64("");
    setPreview(null);
    setSelected([]);
    setResult(null);
    setBusy(false);
  }
  function close(): void {
    reset();
    onClose();
  }

  async function doPreview(): Promise<void> {
    if (!namespace.trim()) {
      message.warning(t("ui.required", { label: t("ui.skillUpload.namespace") }));
      return;
    }
    if (!file) {
      message.warning(t("ui.skillUpload.noFile"));
      return;
    }
    setBusy(true);
    try {
      const b64 = await fileToBase64(file);
      setZipB64(b64);
      const data = await apiPost(
        "/api/action",
        {
          moduleId: "hub",
          resourceId: "skill-uploads",
          actionId: "upload-preview",
          body: { namespace: namespace.trim(), zip_base64: b64 },
        },
        skillUploadPreviewSchema,
      );
      setPreview(data);
      setSelected(data.candidates.filter((c) => c.valid).map((c) => c.name));
      setStep(1);
    } catch (e) {
      message.error(e instanceof Error ? e.message : t("ui.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function doConfirm(): Promise<void> {
    setBusy(true);
    try {
      const data = await apiPost(
        "/api/action",
        {
          moduleId: "hub",
          resourceId: "skill-uploads",
          actionId: "upload-confirm",
          body: { namespace: namespace.trim(), zip_base64: zipB64, names: selected },
        },
        skillUploadConfirmSchema,
      );
      setResult(data);
      setStep(2);
      onDone();
    } catch (e) {
      message.error(e instanceof Error ? e.message : t("ui.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  const candidateCols: ColumnsType<SkillUploadCandidate> = [
    { title: t("col.name"), dataIndex: "name", render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
    {
      title: t("col.status"),
      dataIndex: "valid",
      render: (valid: boolean) =>
        valid ? <Tag color="green">{t("ui.skillUpload.valid")}</Tag> : <Tag color="red">{t("ui.skillUpload.invalid")}</Tag>,
    },
    { title: t("ui.skillUpload.files"), dataIndex: "file_count", render: (n: number) => t("ui.skillUpload.files", { count: n }) },
    {
      title: t("ui.skillUpload.conflictNamespace"),
      key: "conflicts",
      render: (_v, r) => (
        <Space size={4} wrap>
          {r.conflicts.official ? <Tag color="orange">{t("ui.skillUpload.conflictOfficial")}</Tag> : null}
          {r.conflicts.namespace ? <Tag color="blue">{t("ui.skillUpload.conflictNamespace")}</Tag> : null}
        </Space>
      ),
    },
    {
      title: t("col.name"),
      dataIndex: "errors",
      key: "errors",
      render: (errors: string[]) =>
        errors.length > 0 ? <Typography.Text type="danger">{errors.join("；")}</Typography.Text> : <Typography.Text type="secondary">—</Typography.Text>,
    },
  ];

  const resultCols: ColumnsType<ConfirmRow> = [
    { title: t("col.name"), dataIndex: "name", render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
    {
      title: t("col.status"),
      key: "status",
      render: (_v, r) =>
        r.status === "published" ? (
          <Tag color="green">{t("ui.skillUpload.published", { revision: r.revision ?? 0 })}</Tag>
        ) : r.status === "unchanged" ? (
          <Tag color="default">{t("ui.skillUpload.unchanged")}</Tag>
        ) : (
          <Tag color="red">{t("ui.skillUpload.failed")}</Tag>
        ),
    },
    {
      title: t("col.name"),
      dataIndex: "error",
      key: "error",
      render: (err: string | null) => (err ? <Typography.Text type="danger">{err}</Typography.Text> : <Typography.Text type="secondary">—</Typography.Text>),
    },
  ];

  const anyValid = (preview?.candidates ?? []).some((c) => c.valid);

  const footer =
    step === 0
      ? [
          <Button key="cancel" onClick={close}>
            {t("ui.cancel")}
          </Button>,
          <Button key="preview" type="primary" loading={busy} onClick={doPreview}>
            {t("ui.skillUpload.preview")}
          </Button>,
        ]
      : step === 1
        ? [
            <Button key="back" onClick={() => setStep(0)}>
              {t("ui.skillUpload.back")}
            </Button>,
            <Button key="confirm" type="primary" loading={busy} disabled={selected.length === 0} onClick={doConfirm}>
              {t("ui.skillUpload.confirm")}
            </Button>,
          ]
        : [
            <Button key="done" type="primary" onClick={close}>
              {t("ui.skillUpload.done")}
            </Button>,
          ];

  return (
    <Modal open={open} onCancel={close} title={t("ui.skillUpload.title")} footer={footer} width={760} destroyOnHidden>
      <Steps
        size="small"
        current={step}
        items={[{ title: t("ui.skillUpload.stepPick") }, { title: t("ui.skillUpload.stepConfirm") }]}
        style={{ marginBottom: 20 }}
      />

      {step === 0 ? (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <div>
            <Typography.Text strong>{t("ui.skillUpload.namespace")}</Typography.Text>
            <Input
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              placeholder={t("ui.skillUpload.namespacePlaceholder")}
              style={{ marginTop: 6 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t("ui.skillUpload.namespaceTip")}
            </Typography.Text>
          </div>
          <Upload.Dragger
            accept=".zip"
            maxCount={1}
            multiple={false}
            beforeUpload={(f) => {
              setFile(f);
              setZipB64("");
              return false;
            }}
            onRemove={() => {
              setFile(null);
              setZipB64("");
            }}
            fileList={file ? [{ uid: "1", name: file.name, status: "done" }] : []}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">{t("ui.skillUpload.pickFile")}</p>
            <p className="ant-upload-hint">{t("ui.skillUpload.pickHint")}</p>
          </Upload.Dragger>
        </Space>
      ) : null}

      {step === 1 && preview ? (
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Text strong>{t("ui.skillUpload.candidates", { count: preview.candidates.length })}</Typography.Text>
          {!anyValid ? <Alert type="warning" showIcon message={t("ui.skillUpload.noValid")} /> : null}
          <Table<SkillUploadCandidate>
            rowKey="name"
            size="small"
            pagination={false}
            columns={candidateCols}
            dataSource={preview.candidates}
            rowSelection={{
              selectedRowKeys: selected,
              onChange: (keys) => setSelected(keys.map(String)),
              getCheckboxProps: (r) => ({ disabled: !r.valid }),
            }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("ui.skillUpload.selectToPublish")}
          </Typography.Text>
        </Space>
      ) : null}

      {step === 2 && result ? (
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Text strong>{t("ui.skillUpload.resultTitle")}</Typography.Text>
          <Table<ConfirmRow> rowKey="name" size="small" pagination={false} columns={resultCols} dataSource={result.results} />
        </Space>
      ) : null}
    </Modal>
  );
}
