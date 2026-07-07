import type { ThemeConfig } from "antd";

// 全站 antd 主题：pine 主色 + 深墨侧栏，统一品牌。
export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: "#2f6b4f",
    colorInfo: "#2f6b4f",
    borderRadius: 8,
    fontSize: 14,
  },
};

export const proLayoutToken = {
  sider: {
    colorMenuBackground: "#22302b",
    colorTextMenu: "rgba(255,255,255,0.70)",
    colorTextMenuSelected: "#ffffff",
    colorTextMenuActive: "#ffffff",
    colorBgMenuItemSelected: "rgba(255,255,255,0.12)",
    colorTextMenuTitle: "#ffffff",
    colorTextMenuItemHover: "#ffffff",
  },
  header: {
    colorBgHeader: "#ffffff",
  },
};
