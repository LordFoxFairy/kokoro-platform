import { redirect } from "next/navigation";
import { signIn } from "@/auth";

async function login(formData: FormData): Promise<void> {
  "use server";
  // redirect:false 抑制 next-auth 默认中转页（v5 server-action 流不认 pages.verifyRequest），
  // 发信后手动跳品牌化确认页；redirectTo 仍决定点链接后的落点。
  await signIn("nodemailer", { email: String(formData.get("email")), redirect: false, redirectTo: "/" });
  redirect("/auth/verify");
}

export default function LoginPage(): React.ReactElement {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/* 左：深墨品牌区，呼应后台侧栏轨 */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-sidebar p-12 text-sidebar-foreground lg:flex">
        {/* 品牌 */}
        <div className="relative flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sidebar-primary font-display text-xl font-semibold text-sidebar-primary-foreground shadow-sm">
            K
          </div>
          <div className="flex flex-col leading-none">
            <span className="font-display text-lg font-semibold text-sidebar-accent-foreground">Kokoro</span>
            <span className="mt-1 text-[11px] text-sidebar-foreground/50">管理后台</span>
          </div>
        </div>

        {/* 产品陈述 */}
        <div className="relative">
          <h1 className="text-4xl font-semibold leading-tight text-sidebar-accent-foreground">
            一个控制台，
            <br />
            管好整个平台。
          </h1>
          <p className="mt-5 max-w-md text-sm leading-relaxed text-sidebar-foreground/55">
            站点 · 用户 · 积分 · 支付 · 模型 —— 统一收口。权限分级、多租户隔离、maker-checker 审批与全程审计，生产级运营中枢。
          </p>
        </div>

        {/* 页脚 */}
        <div className="relative flex items-center gap-2 text-xs text-sidebar-foreground/40">
          <span className="inline-block size-1.5 rounded-full bg-sidebar-primary" />
          仅限授权运营 · 全程审计留痕
        </div>
      </div>

      {/* 右：登录表单 */}
      <div className="flex items-center justify-center bg-background px-6 py-12">
        <div className="w-full max-w-sm">
          {/* 移动端顶部品牌（左面板在窄屏隐藏） */}
          <div className="mb-10 flex items-center gap-2.5 lg:hidden">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary font-display text-lg font-semibold text-primary-foreground">
              K
            </div>
            <span className="font-display text-lg font-semibold text-foreground">Kokoro</span>
          </div>

          <h2 className="text-2xl font-semibold text-foreground">运营登录</h2>
          <p className="mt-2 text-sm text-muted-foreground">输入运营邮箱，我们发送一次性登录链接。</p>

          <form action={login} className="mt-7 space-y-3">
            <input
              name="email"
              type="email"
              required
              placeholder="you@kokoro.local"
              className="h-11 w-full rounded-lg border border-input bg-card px-3.5 text-sm text-foreground shadow-sm transition focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <button
              type="submit"
              className="h-11 w-full rounded-lg bg-primary text-sm font-medium text-primary-foreground shadow-sm transition hover:opacity-90"
            >
              发送登录链接
            </button>
          </form>

          <p className="mt-8 text-xs text-muted-foreground/60">仅限已授权运营账号 · 链接短时有效</p>
        </div>
      </div>
    </div>
  );
}
