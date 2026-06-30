import type { AuditEntry, AuditSink } from "./gateway.js";

// 运营审计落点的 seam。本增量：进程内留存 + stdout 落痕；持久化 DB sink 为下一增量替换实现。
export class ConsoleAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    process.stdout.write(`[audit] ${JSON.stringify(entry)}\n`);
  }
}
