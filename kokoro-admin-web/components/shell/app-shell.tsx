"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { App, ConfigProvider, Dropdown, Select } from "antd";
import zhCN from "antd/locale/zh_CN";
import { ProLayout } from "@ant-design/pro-components";
import {
  ApiOutlined,
  CheckCircleOutlined,
  CreditCardOutlined,
  DashboardOutlined,
  FileTextOutlined,
  GlobalOutlined,
  LogoutOutlined,
  SafetyOutlined,
  TeamOutlined,
  UserOutlined,
  WalletOutlined,
} from "@ant-design/icons";
import { apiGet } from "@/lib/api";
import {
  manifestsSchema,
  meSchema,
  permits,
  sitesSchema,
  type Me,
  type ModuleManifest,
  type Site,
} from "@/lib/schemas";
import { antdTheme, proLayoutToken } from "@/lib/theme";

interface AdminCtx {
  me: Me | null;
  sites: Site[];
  siteId: string;
  setSiteId: (id: string) => void;
  can: (permission: string | null) => boolean;
  manifests: ModuleManifest[];
  reloadSites: () => void;
}

const AdminContext = createContext<AdminCtx | null>(null);

export function useAdmin(): AdminCtx {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error("useAdmin must be used within AppShell");
  return ctx;
}

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
  perm: string | null;
}

const NAV: { group: string | null; items: NavItem[] }[] = [
  { group: null, items: [{ label: "概览", href: "/", icon: <DashboardOutlined />, perm: null }] },
  {
    group: "业务",
    items: [
      { label: "用户", href: "/users", icon: <UserOutlined />, perm: null },
      { label: "团队", href: "/teams", icon: <TeamOutlined />, perm: null },
      { label: "积分", href: "/credit", icon: <WalletOutlined />, perm: "credit.account.read" },
      { label: "支付", href: "/payment", icon: <CreditCardOutlined />, perm: "payment.order.read" },
      { label: "站点", href: "/sites", icon: <GlobalOutlined />, perm: "site.read" },
      { label: "模型", href: "/models", icon: <ApiOutlined />, perm: "model.read" },
    ],
  },
  {
    group: "运营",
    items: [
      { label: "审批", href: "/approvals", icon: <CheckCircleOutlined />, perm: null },
      { label: "审计", href: "/audit", icon: <FileTextOutlined />, perm: null },
      { label: "操作员", href: "/operators", icon: <SafetyOutlined />, perm: "operator.read" },
    ],
  },
];

interface MenuRoute {
  path: string;
  name: string;
  icon?: React.ReactNode;
  routes?: MenuRoute[];
}

export function AppShell({ children }: { children: React.ReactNode }): React.ReactElement {
  const [me, setMe] = useState<Me | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState("");
  const [manifests, setManifests] = useState<ModuleManifest[]>([]);
  const pathname = usePathname();

  const reloadSites = useCallback(() => {
    apiGet("/api/sites", sitesSchema)
      .then((loaded) => {
        setSites(loaded);
        setSiteId((prev) => prev || loaded[0]?.id || "");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    apiGet("/api/me", meSchema).then(setMe).catch(() => {});
    apiGet("/api/manifests", manifestsSchema).then(setManifests).catch(() => {});
    reloadSites();
  }, [reloadSites]);

  const can = (permission: string | null): boolean =>
    permission === null || permits(me?.permissions ?? [], permission);

  const ctx: AdminCtx = { me, sites, siteId, setSiteId, can, manifests, reloadSites };

  // 登录/确认页只给主题、不套 ProLayout。
  if (pathname.startsWith("/login") || pathname.startsWith("/auth/verify")) {
    return (
      <ConfigProvider locale={zhCN} theme={antdTheme}>
        <App>
          <AdminContext.Provider value={ctx}>{children}</AdminContext.Provider>
        </App>
      </ConfigProvider>
    );
  }

  const routes: MenuRoute[] = NAV.flatMap((section): MenuRoute[] => {
    const items = section.items.filter((i) => can(i.perm));
    if (items.length === 0) return [];
    const mapped: MenuRoute[] = items.map((i) => ({ path: i.href, name: i.label, icon: i.icon }));
    return section.group ? [{ path: `/__${section.group}`, name: section.group, routes: mapped }] : mapped;
  });

  return (
    <ConfigProvider locale={zhCN} theme={antdTheme}>
      <App>
        <AdminContext.Provider value={ctx}>
          <ProLayout
            title="Kokoro"
            logo={false}
            layout="mix"
            fixSiderbar
            fixedHeader
            siderWidth={216}
            location={{ pathname }}
            route={{ path: "/", routes }}
            token={proLayoutToken}
            menu={{ type: "group" }}
            menuItemRender={(item, dom) => <Link href={item.path ?? "/"}>{dom}</Link>}
            avatarProps={{
              icon: <UserOutlined />,
              size: "small",
              title: me?.email ?? "…",
              render: (_props, dom) => (
                <Dropdown
                  menu={{
                    items: [
                      { key: "role", label: me?.roleKey ?? "", disabled: true },
                      { type: "divider" },
                      {
                        key: "logout",
                        icon: <LogoutOutlined />,
                        label: "退出登录",
                        onClick: () => signOut({ callbackUrl: "/login" }),
                      },
                    ],
                  }}
                >
                  {dom}
                </Dropdown>
              ),
            }}
            actionsRender={() => [
              <Select
                key="site"
                value={siteId || undefined}
                onChange={setSiteId}
                placeholder="选择站点"
                style={{ width: 200 }}
                variant="filled"
                options={sites.map((s) => ({ value: s.id, label: s.name ?? s.key ?? s.id }))}
                notFoundContent="无站点"
              />,
            ]}
          >
            {children}
          </ProLayout>
        </AdminContext.Provider>
      </App>
    </ConfigProvider>
  );
}
