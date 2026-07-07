"use client";

import { useState } from "react";
import { App, Tag } from "antd";
import { PageContainer, ProTable, type ProColumns } from "@ant-design/pro-components";
import { z } from "zod";
import { apiGet, queryString } from "@/lib/api";
import { useAdmin } from "@/components/shell/app-shell";

const rowsSchema = z.array(z.record(z.unknown()));
type Row = Record<string, unknown>;

const NUMERIC = /micros|amount|minor|balance|price|qty|count|total|held|score|num$/i;
const DATEISH = /(at|date|time)$/i;
const MONO = /(^|_)id$|email|(^|_)key$|token|hash|slug/i;
const STATUS = /status|state$/i;

const STATUS_COLOR: Record<string, string> = {
  active: "green",
  approved: "green",
  enabled: "green",
  ok: "green",
  pending: "gold",
  disabled: "default",
  inactive: "default",
  rejected: "default",
  failed: "red",
  error: "red",
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

function withSiteId(endpoint: string, siteId: string): string {
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}${queryString({ siteId })}`;
}

export function EndpointTable({
  endpoint,
  title,
  subtitle,
  siteScoped = false,
}: {
  endpoint: string;
  title: string;
  subtitle: string;
  siteScoped?: boolean;
}): React.ReactElement {
  const { message } = App.useApp();
  const { siteId } = useAdmin();
  const [cols, setCols] = useState<ProColumns<Row>[]>([]);
  const url = siteScoped && siteId ? withSiteId(endpoint, siteId) : endpoint;

  return (
    <PageContainer header={{ title }} content={subtitle}>
      <ProTable<Row>
        key={url}
        rowKey={(r) => String(r.id ?? Math.random())}
        columns={cols}
        search={false}
        options={{ density: true, reload: true, setting: true }}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        dateFormatter="string"
        headerTitle={title}
        request={async () => {
          if (siteScoped && !siteId) return { data: [], success: true, total: 0 };
          try {
            const raw = await apiGet(url, rowsSchema);
            setCols(buildColumns(raw));
            return { data: raw, success: true, total: raw.length };
          } catch (e) {
            message.error(e instanceof Error ? e.message : "加载失败");
            return { data: [], success: false, total: 0 };
          }
        }}
      />
    </PageContainer>
  );
}
