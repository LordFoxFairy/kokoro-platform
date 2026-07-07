// 积分以 micros(1e-6) 存储，展示转人类可读；非法值回退 0。
export function formatMicros(raw: string | null | undefined): string {
  const n = Number(raw ?? 0);
  return (Number.isFinite(n) ? n / 1e6 : 0).toLocaleString("zh-CN", { maximumFractionDigits: 6 });
}

export function availableMicros(balance: string | null | undefined, held: string | null | undefined): string {
  const b = Number(balance ?? 0);
  const h = Number(held ?? 0);
  return String((Number.isFinite(b) ? b : 0) - (Number.isFinite(h) ? h : 0));
}
