"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Tag } from "antd";
import { PageContainer, ProCard, StatisticCard } from "@ant-design/pro-components";
import {
  UserOutlined,
  WalletOutlined,
  CreditCardOutlined,
  GlobalOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  FileTextOutlined,
  SafetyOutlined,
} from "@ant-design/icons";
import { z } from "zod";
import { apiGet } from "@/lib/api";
import { useAdmin } from "@/components/shell/app-shell";

const ENTRIES = [
  { label: "用户 360", href: "/users", icon: <UserOutlined />, desc: "查身份 · 积分 · 订单，并操作" },
  { label: "积分", href: "/credit", icon: <WalletOutlined />, desc: "账户 · 流水 · 定价" },
  { label: "支付", href: "/payment", icon: <CreditCardOutlined />, desc: "订单 · 套餐 · 退款" },
  { label: "站点", href: "/sites", icon: <GlobalOutlined />, desc: "站点 · 域名 · 策略" },
  { label: "模型", href: "/models", icon: <ApiOutlined />, desc: "目录 · 绑定" },
  { label: "审批", href: "/approvals", icon: <CheckCircleOutlined />, desc: "maker-checker 队列" },
  { label: "审计", href: "/audit", icon: <FileTextOutlined />, desc: "动作留痕" },
  { label: "操作员", href: "/operators", icon: <SafetyOutlined />, desc: "角色 · 作用域" },
];

const pendingSchema = z.array(z.object({ status: z.string() }).passthrough());

// 运营台计费总览（B2c）：网关聚合 credit + payment stats；某模块离线段为 null。
const billingOverviewSchema = z.object({
  credit: z
    .object({
      accountsTotal: z.number(),
      accountsActive: z.number(),
      balanceSumMicros: z.string(),
      heldSumMicros: z.string(),
      grantedTotalMicros: z.string(),
      spentTotalMicros: z.string(),
    })
    .nullable(),
  payment: z
    .object({
      ordersTotal: z.number(),
      ordersPaid: z.number(),
      ordersPending: z.number(),
      ordersRefunded: z.number(),
      ordersCanceled: z.number(),
      revenueByCurrency: z.array(z.object({ currency: z.string(), amountMinor: z.string() })),
    })
    .nullable(),
});
type BillingOverview = z.infer<typeof billingOverviewSchema>;

// 微单位 → 积分（÷10000）；最小货币单位 → 金额（÷100）。仅展示用（admin 量级 Number 足够）。
const toCredits = (micros: string): string => (Number(micros) / 10000).toLocaleString(undefined, { maximumFractionDigits: 2 });
const toMoney = (minor: string): string => (Number(minor) / 100).toFixed(2);

export default function Page(): React.ReactElement {
  const { me, sites } = useAdmin();
  const [pending, setPending] = useState<number | null>(null);
  const [billing, setBilling] = useState<BillingOverview | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const rows = await apiGet("/api/approvals", pendingSchema);
        setPending(rows.filter((r) => r.status === "pending").length);
      } catch {
        setPending(null);
      }
    })();
    (async () => {
      try {
        setBilling(await apiGet("/api/billing-overview", billingOverviewSchema));
      } catch {
        setBilling(null);
      }
    })();
  }, []);

  const revenueText =
    billing?.payment && billing.payment.revenueByCurrency.length > 0
      ? billing.payment.revenueByCurrency.map((r) => `${toMoney(r.amountMinor)} ${r.currency}`).join(" · ")
      : "—";

  const scope = me?.scopeSites?.includes("*") ? "全部站点" : `${me?.scopeSites?.length ?? 0} 个站点`;

  return (
    <PageContainer
      header={{ title: "运营概览" }}
      content={
        <span>
          {me?.email ?? "…"}
          {me ? (
            <>
              <Tag color="green">{me.roleKey}</Tag>
              <span style={{ color: "rgba(0,0,0,0.45)" }}>作用域 {scope}</span>
            </>
          ) : null}
        </span>
      }
    >
      <StatisticCard.Group direction="row" style={{ marginBottom: 16 }}>
        <StatisticCard statistic={{ title: "接入站点", value: sites.length, suffix: "个" }} />
        <StatisticCard.Divider />
        <Link href="/approvals" style={{ flex: 1 }}>
          <StatisticCard
            statistic={{
              title: "待审批",
              value: pending ?? "—",
              valueStyle: { color: (pending ?? 0) > 0 ? "#d48806" : undefined },
              description: <span style={{ color: "rgba(0,0,0,0.45)" }}>maker-checker 队列</span>,
            }}
          />
        </Link>
        <StatisticCard.Divider />
        <StatisticCard statistic={{ title: "我的角色", value: me?.roleKey ?? "—" }} />
      </StatisticCard.Group>

      {/* 计费总览（B2c）：营收 / 累计发放·消费 / 当前余额 / 订单 / 账户。模块离线段显 —。 */}
      <ProCard title="计费总览" bordered headerBordered style={{ marginBottom: 16 }}>
        <StatisticCard.Group direction="row">
          <StatisticCard
            statistic={{ title: "已支付营收", value: revenueText, description: <span style={{ color: "rgba(0,0,0,0.45)" }}>paid 订单合计</span> }}
          />
          <StatisticCard.Divider />
          <StatisticCard
            statistic={{
              title: "订单",
              value: billing?.payment ? `${billing.payment.ordersPaid}/${billing.payment.ordersTotal}` : "—",
              description: <span style={{ color: "rgba(0,0,0,0.45)" }}>已付/总 · 待付 {billing?.payment?.ordersPending ?? "—"}</span>,
            }}
          />
          <StatisticCard.Divider />
          <StatisticCard
            statistic={{ title: "累计发放", value: billing?.credit ? toCredits(billing.credit.grantedTotalMicros) : "—", suffix: "积分" }}
          />
          <StatisticCard.Divider />
          <StatisticCard
            statistic={{ title: "累计消费", value: billing?.credit ? toCredits(billing.credit.spentTotalMicros) : "—", suffix: "积分" }}
          />
          <StatisticCard.Divider />
          <StatisticCard
            statistic={{
              title: "当前余额总额",
              value: billing?.credit ? toCredits(billing.credit.balanceSumMicros) : "—",
              suffix: "积分",
              description: <span style={{ color: "rgba(0,0,0,0.45)" }}>冻结 {billing?.credit ? toCredits(billing.credit.heldSumMicros) : "—"}</span>,
            }}
          />
          <StatisticCard.Divider />
          <StatisticCard
            statistic={{
              title: "积分账户",
              value: billing?.credit ? `${billing.credit.accountsActive}/${billing.credit.accountsTotal}` : "—",
              description: <span style={{ color: "rgba(0,0,0,0.45)" }}>活跃/总</span>,
            }}
          />
        </StatisticCard.Group>
      </ProCard>

      <ProCard title="快捷入口" bordered headerBordered>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
          {ENTRIES.map((e) => (
            <Link key={e.href} href={e.href}>
              <ProCard hoverable bordered size="small" style={{ height: "100%" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 20, color: "#2f6b4f" }}>{e.icon}</span>
                  <div>
                    <div style={{ fontWeight: 600 }}>{e.label}</div>
                    <div style={{ fontSize: 12, color: "rgba(0,0,0,0.45)" }}>{e.desc}</div>
                  </div>
                </div>
              </ProCard>
            </Link>
          ))}
        </div>
      </ProCard>
    </PageContainer>
  );
}
