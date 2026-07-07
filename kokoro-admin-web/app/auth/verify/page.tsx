import { MailCheck } from "lucide-react";

export default function VerifyPage(): React.ReactElement {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 text-center shadow-[0_4px_24px_rgba(30,40,30,0.05)]">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <MailCheck className="size-6" />
        </div>
        <h1 className="mt-4 font-display text-xl font-semibold text-foreground">查收登录链接</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          已发送一次性登录链接（dev 环境见服务端 console）。点击链接即可完成登录。
        </p>
      </div>
    </div>
  );
}
