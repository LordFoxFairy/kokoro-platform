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
  AppstoreOutlined,
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
import { LocaleProvider, useLocale, useT } from "@/lib/i18n/context";
import type { MessageKey } from "@/lib/i18n/messages";

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
  labelKey: MessageKey;
  href: string;
  icon: React.ReactNode;
  perm: string | null;
}

// 导航文案走 i18n（labelKey）；此处只声明结构，渲染时经 useT 解析。
const NAV: { groupKey: MessageKey | null; items: NavItem[] }[] = [
  { groupKey: null, items: [{ labelKey: "nav.overview", href: "/", icon: <DashboardOutlined />, perm: null }] },
  {
    groupKey: "nav.group.business",
    items: [
      { labelKey: "nav.users", href: "/users", icon: <UserOutlined />, perm: null },
      { labelKey: "nav.teams", href: "/teams", icon: <TeamOutlined />, perm: null },
      { labelKey: "nav.credit", href: "/credit", icon: <WalletOutlined />, perm: "credit.account.read" },
      { labelKey: "nav.payment", href: "/payment", icon: <CreditCardOutlined />, perm: "payment.order.read" },
      { labelKey: "nav.sites", href: "/sites", icon: <GlobalOutlined />, perm: "site.read" },
      { labelKey: "nav.models", href: "/models", icon: <ApiOutlined />, perm: "model.read" },
      { labelKey: "nav.hub", href: "/hub", icon: <AppstoreOutlined />, perm: "hub.skill.read" },
    ],
  },
  {
    groupKey: "nav.group.ops",
    items: [
      { labelKey: "nav.approvals", href: "/approvals", icon: <CheckCircleOutlined />, perm: null },
      { labelKey: "nav.audit", href: "/audit", icon: <FileTextOutlined />, perm: null },
      { labelKey: "nav.operators", href: "/operators", icon: <SafetyOutlined />, perm: "operator.read" },
    ],
  },
];

interface MenuRoute {
  path: string;
  name: string;
  icon?: React.ReactNode;
  routes?: MenuRoute[];
}

function AppShellInner({ children }: { children: React.ReactNode }): React.ReactElement {
  const t = useT();
  const { locale, setLocale } = useLocale();
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
    const mapped: MenuRoute[] = items.map((i) => ({ path: i.href, name: t(i.labelKey), icon: i.icon }));
    return section.groupKey
      ? [{ path: `/__${section.groupKey}`, name: t(section.groupKey), routes: mapped }]
      : mapped;
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
                        label: t("ui.logout"),
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
                placeholder={t("ui.selectSite")}
                style={{ width: 200 }}
                variant="filled"
                options={sites.map((s) => ({ value: s.id, label: s.name ?? s.key ?? s.id }))}
                notFoundContent={t("ui.noSite")}
              />,
              <Select
                key="locale"
                aria-label={t("ui.language")}
                value={locale}
                onChange={setLocale}
                style={{ width: 92 }}
                variant="filled"
                options={[
                  { value: "zh", label: "中文" },
                  { value: "en", label: "English" },
                ]}
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

export function AppShell({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <LocaleProvider>
      <AppShellInner>{children}</AppShellInner>
    </LocaleProvider>
  );
}
