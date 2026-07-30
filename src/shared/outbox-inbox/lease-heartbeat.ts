export interface LeaseHeartbeatOptions {
  readonly intervalMs: number;
  readonly renewalTimeoutMs?: number;
  readonly timeoutCode: string;
}

/**
 * Maintains exactly one lease renewal at a time. A slow renewal cannot create a
 * backlog, and stop is deliberately non-blocking because database promises are
 * not generally cancellable after they have entered a driver.
 */
export class SingleFlightLeaseHeartbeat {
  readonly #abort = new AbortController();
  readonly #intervalMs: number;
  readonly #renewalTimeoutMs: number;
  readonly #timeoutCode: string;
  #failure: unknown;
  #lost = false;
  #renewal: Promise<void> | undefined;
  #started = false;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly renew: () => Promise<void>,
    options: LeaseHeartbeatOptions,
  ) {
    this.#intervalMs = positiveInteger(options.intervalMs, "OUTBOX_LEASE_HEARTBEAT_INVALID");
    this.#renewalTimeoutMs = positiveInteger(
      options.renewalTimeoutMs ?? Math.min(options.intervalMs, 5_000),
      "OUTBOX_LEASE_RENEWAL_TIMEOUT_INVALID",
    );
    if (!/^[A-Z][A-Z0-9_]{2,127}$/u.test(options.timeoutCode)) {
      throw new Error("OUTBOX_LEASE_RENEWAL_TIMEOUT_CODE_INVALID");
    }
    this.#timeoutCode = options.timeoutCode;
  }

  get signal(): AbortSignal { return this.#abort.signal; }
  get lost(): boolean { return this.#lost; }
  get failure(): unknown { return this.#failure; }

  start(): void {
    if (this.#started) throw new Error("OUTBOX_LEASE_HEARTBEAT_ALREADY_STARTED");
    this.#started = true;
    this.beginRenewal();
  }

  async assertOwned(): Promise<void> {
    await this.#renewal;
    this.assertNotLost();
  }

  assertNotLost(): void {
    if (this.#lost) throw this.#failure;
  }

  stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    return Promise.resolve();
  }

  private beginRenewal(): void {
    if (this.#stopped || this.#lost || this.#renewal !== undefined) return;
    const operation = within(this.renew(), this.#renewalTimeoutMs, this.#timeoutCode);
    const renewal = operation.then(
      () => undefined,
      (error: unknown) => {
        if (this.#stopped || this.#lost) return;
        this.#lost = true;
        this.#failure = error;
        this.#abort.abort(error);
      },
    ).finally(() => {
      if (this.#renewal === renewal) this.#renewal = undefined;
      if (!this.#stopped && !this.#lost) {
        this.#timer = setTimeout(() => {
          this.#timer = undefined;
          this.beginRenewal();
        }, this.#intervalMs);
        this.#timer.unref();
      }
    });
    this.#renewal = renewal;
  }
}

function within(operation: Promise<void>, timeoutMs: number, code: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    timer.unref();
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 100_000) throw new Error(code);
  return value;
}
