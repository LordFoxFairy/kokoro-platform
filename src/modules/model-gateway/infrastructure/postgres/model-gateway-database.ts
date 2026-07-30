import { Pool } from "pg";
import type {
  ModelGatewayFrameWaiter,
  ModelGatewayUnitOfWork,
  ModelInvocationAuthorization,
} from "../../application/model-gateway-service.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
} from "../../../../shared/unit-of-work/platform-transaction.js";

interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}
interface ModelGatewayPoolClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult>;
  on?(event: "notification", listener: (message: Readonly<{
    channel: string;
    payload?: string;
  }>) => void): this;
  on?(event: "error", listener: (error: Error) => void): this;
  on?(event: "end", listener: () => void): this;
  release(destroy?: boolean): void;
}
interface ModelGatewayPool {
  connect(): Promise<ModelGatewayPoolClient>;
  query?(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult>;
  end(): Promise<void>;
}

export type ModelGatewayDatabaseConfig = Readonly<{
  url: string;
  expectedDatabaseUser: string;
  expectedDatabaseName: string;
  migratorDatabaseUser: string;
  applicationName: "kokoro-platform-model-gateway";
  poolMax: number;
}>;

interface AuthorizationRow extends Record<string, unknown> {
  modelAuthorizationHandle: string;
  siteId: string;
  executionManifestRef: string;
  authorizationSegmentRef: string;
  authorizedGatewayModel: string;
  adapterKind: string;
  expiresAt: Date | string;
}

export class PostgresModelGatewayDatabase implements ModelGatewayUnitOfWork, ModelGatewayFrameWaiter {
  readonly #frameWaiters = new Map<string, Set<Readonly<{
    afterSequence: bigint;
    wake: () => void;
  }>>>();
  readonly #latestFrameSequences = new Map<string, bigint>();
  #frameListener: ModelGatewayPoolClient | null = null;
  #frameListenerHealthy = false;
  #frameWaiterCount = 0;

  constructor(private readonly dependencies: Readonly<{
    pool: ModelGatewayPool;
    expectedDatabaseUser: string;
    expectedDatabaseName: string;
    migratorDatabaseUser: string;
  }>) {}

  async connect(): Promise<void> {
    if (this.dependencies.pool.query === undefined) {
      throw new Error("MODEL_GATEWAY_DATABASE_POOL_INVALID");
    }
    const result = await this.dependencies.pool.query(RUNTIME_IDENTITY_SQL, [
      this.dependencies.migratorDatabaseUser,
      this.dependencies.expectedDatabaseUser,
    ]);
    if (result.rows.length !== 1 || !validIdentity(result.rows[0] as RuntimeIdentity | undefined, this.dependencies)) {
      throw new Error("MODEL_GATEWAY_DATABASE_ROLE_INVALID");
    }
    await this.#connectFrameListener();
  }

  async disconnect(): Promise<void> {
    const listener = this.#frameListener;
    this.#frameListener = null;
    this.#disableFrameNotifications();
    if (listener !== null) {
      await listener.query(`UNLISTEN ${FRAME_NOTIFICATION_CHANNEL}`).catch(() => undefined);
      listener.release();
    }
    await this.dependencies.pool.end();
  }

  async checkHealth(): Promise<void> {
    if (this.dependencies.pool.query === undefined) {
      throw new Error("MODEL_GATEWAY_DATABASE_POOL_INVALID");
    }
    await this.dependencies.pool.query(
      `SELECT "schemaVersion" FROM platform.platform_foundation WHERE singleton=TRUE`,
    );
    if (!this.#frameListenerHealthy) {
      throw new Error("MODEL_GATEWAY_FRAME_LISTENER_UNAVAILABLE");
    }
  }

  async waitForFrame(
    invocationRef: string,
    afterSequence: bigint,
    signal: AbortSignal,
    maximumWaitMs: number,
  ): Promise<void> {
    if (!UUID.test(invocationRef) || afterSequence < 0n ||
        !Number.isInteger(maximumWaitMs) || maximumWaitMs < 10 || maximumWaitMs > 10_000) {
      throw new Error("MODEL_GATEWAY_FRAME_WAIT_INVALID");
    }
    if (signal.aborted || (this.#latestFrameSequences.get(invocationRef) ?? 0n) > afterSequence) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      let registered = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        if (registered) {
          const invocationWaiters = this.#frameWaiters.get(invocationRef);
          invocationWaiters?.delete(waiter);
          this.#frameWaiterCount -= 1;
          if (invocationWaiters?.size === 0) this.#frameWaiters.delete(invocationRef);
        }
        resolve();
      };
      const waiter = Object.freeze({ afterSequence, wake: finish });
      const timer = setTimeout(finish, maximumWaitMs);
      timer.unref();
      signal.addEventListener("abort", finish, { once: true });

      if (this.#frameListenerHealthy && this.#frameWaiterCount < MAXIMUM_FRAME_WAITERS) {
        const invocationWaiters = this.#frameWaiters.get(invocationRef) ?? new Set();
        invocationWaiters.add(waiter);
        this.#frameWaiters.set(invocationRef, invocationWaiters);
        this.#frameWaiterCount += 1;
        registered = true;
      }
      if ((this.#latestFrameSequences.get(invocationRef) ?? 0n) > afterSequence) finish();
    });
  }

  async scanDispatchCandidates(limit: number): Promise<readonly Readonly<{
    modelAuthorizationHandle: string;
    logicalCallRef: string;
  }>[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 128 || this.dependencies.pool.query === undefined) {
      throw new Error("MODEL_GATEWAY_DISPATCH_SCAN_INVALID");
    }
    const result = await this.dependencies.pool.query(
      `SELECT authorization_handle AS "modelAuthorizationHandle",
              logical_call_ref AS "logicalCallRef"
         FROM platform.list_model_gateway_dispatch_candidates($1)`,
      [limit],
    );
    return Object.freeze(result.rows.map((row) => {
      const candidate = row as Partial<{
        modelAuthorizationHandle: string;
        logicalCallRef: string;
      }>;
      if (typeof candidate.modelAuthorizationHandle !== "string" ||
          typeof candidate.logicalCallRef !== "string") {
        throw new Error("MODEL_GATEWAY_DISPATCH_SCAN_INVALID");
      }
      return Object.freeze({
        modelAuthorizationHandle: candidate.modelAuthorizationHandle,
        logicalCallRef: candidate.logicalCallRef,
      });
    }));
  }

  async execute<Result>(
    scope: Parameters<ModelGatewayUnitOfWork["execute"]>[0],
    work: Parameters<ModelGatewayUnitOfWork["execute"]>[1],
  ): Promise<Result> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(scope.modelAuthorizationHandle)) {
      throw new Error("MODEL_GATEWAY_AUTHORIZATION_HANDLE_INVALID");
    }
    const client = await this.dependencies.pool.connect();
    let began = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      began = true;
      const authorizationRows = await client.query(
        `SELECT authorization_handle AS "modelAuthorizationHandle",site_ref AS "siteId",
                execution_manifest_ref AS "executionManifestRef",
                authorization_segment_ref AS "authorizationSegmentRef",
                gateway_model AS "authorizedGatewayModel",adapter_kind AS "adapterKind",
                expires_at AS "expiresAt"
           FROM platform.resolve_model_gateway_authorization($1,$2)`,
        [scope.modelAuthorizationHandle, scope.operation],
      );
      if (authorizationRows.rows.length !== 1) {
        throw new Error("MODEL_GATEWAY_AUTHORIZATION_NOT_FOUND");
      }
      const authorizationRow = authorizationRows.rows[0] as AuthorizationRow | undefined;
      if (authorizationRow === undefined) throw new Error("MODEL_GATEWAY_AUTHORIZATION_NOT_FOUND");
      const authorization = mapAuthorization(
        authorizationRow,
        scope.modelAuthorizationHandle,
        scope.operation,
      );
      await client.query(
        `SELECT set_config('app.operation',$1,true),set_config('app.site_id',$2,true),
                set_config('app.workload_kind','platform_model_gateway',true),
                set_config('app.actor_kind','workload',true),
                set_config('app.scopes','["model:invoke"]',true)`,
        [`model-gateway.${scope.operation}`, authorization.siteId],
      );
      const lease = issuePlatformTransaction({
        query: async (statement, values = []) =>
          (await client.query(statement, values)).rows as never,
        execute: async (statement, values = []) =>
          (await client.query(statement, values)).rowCount ?? 0,
      });
      try {
        const result = await work(lease.transaction, authorization) as Result;
        await client.query("COMMIT");
        began = false;
        return result;
      } finally {
        revokePlatformTransaction(lease);
      }
    } catch (error) {
      if (began) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #connectFrameListener(): Promise<void> {
    if (this.#frameListener !== null) return;
    const listener = await this.dependencies.pool.connect();
    if (listener.on === undefined) {
      listener.release(true);
      throw new Error("MODEL_GATEWAY_FRAME_LISTENER_INVALID");
    }
    listener.on("notification", (message) => this.#recordFrameNotification(message));
    listener.on("error", () => this.#disableFrameNotifications());
    listener.on("end", () => this.#disableFrameNotifications());
    try {
      await listener.query(`LISTEN ${FRAME_NOTIFICATION_CHANNEL}`);
    } catch (error) {
      listener.release(true);
      throw error;
    }
    this.#frameListener = listener;
    this.#frameListenerHealthy = true;
  }

  #recordFrameNotification(message: Readonly<{ channel: string; payload?: string }>): void {
    if (message.channel !== FRAME_NOTIFICATION_CHANNEL || message.payload === undefined) return;
    const match = FRAME_NOTIFICATION_PAYLOAD.exec(message.payload);
    if (match === null) return;
    const invocationRef = match[1];
    const sequenceText = match[2];
    if (invocationRef === undefined || sequenceText === undefined) return;
    const sequence = BigInt(sequenceText);
    const previous = this.#latestFrameSequences.get(invocationRef) ?? 0n;
    if (sequence <= previous) return;
    if (!this.#latestFrameSequences.has(invocationRef) &&
        this.#latestFrameSequences.size >= MAXIMUM_TRACKED_INVOCATIONS) {
      const oldest = this.#latestFrameSequences.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#latestFrameSequences.delete(oldest);
    }
    this.#latestFrameSequences.delete(invocationRef);
    this.#latestFrameSequences.set(invocationRef, sequence);
    for (const waiter of [...(this.#frameWaiters.get(invocationRef) ?? [])]) {
      if (sequence > waiter.afterSequence) waiter.wake();
    }
  }

  #disableFrameNotifications(): void {
    this.#frameListenerHealthy = false;
    for (const waiters of this.#frameWaiters.values()) {
      for (const waiter of [...waiters]) waiter.wake();
    }
  }
}

const FRAME_NOTIFICATION_CHANNEL = "kokoro_model_gateway_frame";
const FRAME_NOTIFICATION_PAYLOAD = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([1-9][0-9]{0,18})$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAXIMUM_FRAME_WAITERS = 4_096;
const MAXIMUM_TRACKED_INVOCATIONS = 8_192;

export function loadModelGatewayDatabaseConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ModelGatewayDatabaseConfig {
  if (environment.PLATFORM_DATABASE_CREDENTIAL_CLASS !== "model-gateway") {
    throw new Error("PLATFORM_DATABASE_CREDENTIAL_CLASS_REQUIRED:model-gateway");
  }
  const value = environment.DATABASE_URL_PLATFORM;
  if (value === undefined) throw new Error("DATABASE_URL_PLATFORM_REQUIRED");
  const url = postgresUrl(value);
  const expectedDatabaseUser = identifier(
    environment.PLATFORM_DATABASE_MODEL_GATEWAY_ROLE,
    "PLATFORM_DATABASE_MODEL_GATEWAY_ROLE",
  );
  const expectedDatabaseName = identifier(
    environment.PLATFORM_DATABASE_EXPECTED_DATABASE,
    "PLATFORM_DATABASE_EXPECTED_DATABASE",
  );
  const migratorDatabaseUser = identifier(
    environment.PLATFORM_DATABASE_MIGRATOR_ROLE,
    "PLATFORM_DATABASE_MIGRATOR_ROLE",
  );
  if (decodeURIComponent(url.username) !== expectedDatabaseUser) {
    throw new Error("PLATFORM_DATABASE_URL_USER_MISMATCH");
  }
  if (decodeURIComponent(url.pathname.slice(1)) !== expectedDatabaseName) {
    throw new Error("PLATFORM_DATABASE_URL_NAME_MISMATCH");
  }
  if (expectedDatabaseUser === migratorDatabaseUser) {
    throw new Error("PLATFORM_RUNTIME_ROLE_MUST_DIFFER_FROM_MIGRATOR");
  }
  return Object.freeze({
    url: value,
    expectedDatabaseUser,
    expectedDatabaseName,
    migratorDatabaseUser,
    applicationName: "kokoro-platform-model-gateway",
    poolMax: 16,
  });
}

export function createPostgresModelGatewayDatabase(
  config: ModelGatewayDatabaseConfig,
): PostgresModelGatewayDatabase {
  const pool = new Pool({
    connectionString: config.url,
    max: config.poolMax,
    connectionTimeoutMillis: 5_000,
    application_name: config.applicationName,
    options: "-c statement_timeout=15000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=10000",
  });
  return new PostgresModelGatewayDatabase({
    pool: pool as unknown as ModelGatewayPool,
    expectedDatabaseUser: config.expectedDatabaseUser,
    expectedDatabaseName: config.expectedDatabaseName,
    migratorDatabaseUser: config.migratorDatabaseUser,
  });
}

function mapAuthorization(
  row: AuthorizationRow,
  expectedHandle: string,
  operation: "prepare" | "attach" | "claim" | "frame" | "finalize" | "unknown",
): ModelInvocationAuthorization {
  const expiresAt = row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt;
  if (row.modelAuthorizationHandle !== expectedHandle || row.adapterKind !== "litellm" ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      (operation === "prepare" && Date.parse(expiresAt) <= Date.now())) {
    throw new Error("MODEL_GATEWAY_AUTHORIZATION_INVALID");
  }
  for (const value of [row.siteId, row.executionManifestRef, row.authorizationSegmentRef,
    row.authorizedGatewayModel]) {
    if (value.length < 1 || value.length > 256 || /[\0\r\n]/u.test(value)) {
      throw new Error("MODEL_GATEWAY_AUTHORIZATION_INVALID");
    }
  }
  return Object.freeze({
    modelAuthorizationHandle: row.modelAuthorizationHandle,
    siteId: row.siteId,
    executionManifestRef: row.executionManifestRef,
    authorizationSegmentRef: row.authorizationSegmentRef,
    authorizedGatewayModel: row.authorizedGatewayModel,
    expiresAt: new Date(expiresAt).toISOString(),
  });
}

interface RuntimeIdentity extends Record<string, unknown> {
  currentUser: string;
  currentDatabase: string;
  serverMajor: number;
  databaseOwner: string;
  isSuperuser: boolean;
  canCreateDatabase: boolean;
  canCreateRole: boolean;
  canReplicate: boolean;
  canBypassRls: boolean;
  inheritsPrivileges: boolean;
  hasAnyMembership: boolean;
  isMigratorMember: boolean;
  canCreateDatabaseObject: boolean;
  canUseSchema: boolean;
  canCreateSchema: boolean;
  canReadFoundation: boolean;
  canMutateFoundation: boolean;
  canExecuteAuthorizationResolver: boolean;
  canExecuteDispatchScanner: boolean;
  hasRequiredGatewayWrites: boolean;
}

function validIdentity(
  row: RuntimeIdentity | undefined,
  expected: Readonly<{ expectedDatabaseUser: string; expectedDatabaseName: string; migratorDatabaseUser: string }>,
): boolean {
  return row !== undefined && row.currentUser === expected.expectedDatabaseUser &&
    row.currentDatabase === expected.expectedDatabaseName && row.databaseOwner === expected.migratorDatabaseUser &&
    row.serverMajor === 18 && row.isSuperuser === false && row.canCreateDatabase === false &&
    row.canCreateRole === false && row.canReplicate === false && row.canBypassRls === false &&
    row.inheritsPrivileges === false && row.hasAnyMembership === false && row.isMigratorMember === false &&
    row.canCreateDatabaseObject === false && row.canUseSchema === true && row.canCreateSchema === false &&
    row.canReadFoundation === true && row.canMutateFoundation === false &&
    row.canExecuteAuthorizationResolver === true && row.canExecuteDispatchScanner === true &&
    row.hasRequiredGatewayWrites === true;
}

function postgresUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("DATABASE_URL_PLATFORM_INVALID"); }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol) || url.username.length < 1 ||
      url.pathname.length < 2) throw new Error("DATABASE_URL_PLATFORM_INVALID");
  return url;
}
function identifier(value: string | undefined, name: string): string {
  if (value === undefined || !/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) throw new Error(`${name}_INVALID`);
  return value;
}

const RUNTIME_IDENTITY_SQL = `
  SELECT current_user AS "currentUser",current_database() AS "currentDatabase",
    current_setting('server_version_num')::int/10000 AS "serverMajor",
    owner.rolname AS "databaseOwner",runtime.rolsuper AS "isSuperuser",
    runtime.rolcreatedb AS "canCreateDatabase",runtime.rolcreaterole AS "canCreateRole",
    runtime.rolreplication AS "canReplicate",runtime.rolbypassrls AS "canBypassRls",
    runtime.rolinherit AS "inheritsPrivileges",
    EXISTS (SELECT 1 FROM pg_auth_members member WHERE member.member=runtime.oid) AS "hasAnyMembership",
    pg_has_role(current_user,$1,'MEMBER') AS "isMigratorMember",
    has_database_privilege(current_user,current_database(),'CREATE') AS "canCreateDatabaseObject",
    has_schema_privilege(current_user,'platform','USAGE') AS "canUseSchema",
    has_schema_privilege(current_user,'platform','CREATE') AS "canCreateSchema",
    has_table_privilege(current_user,'platform.platform_foundation','SELECT') AS "canReadFoundation",
    has_table_privilege(current_user,'platform.platform_foundation','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS "canMutateFoundation",
    has_function_privilege(current_user,'platform.resolve_model_gateway_authorization(TEXT,TEXT)','EXECUTE') AS "canExecuteAuthorizationResolver",
    has_function_privilege(current_user,'platform.list_model_gateway_dispatch_candidates(INTEGER)','EXECUTE') AS "canExecuteDispatchScanner",
    (has_table_privilege(current_user, 'platform.model_gateway_invocation', 'SELECT') AND has_table_privilege(current_user, 'platform.model_gateway_invocation', 'INSERT'))
      AND has_column_privilege(current_user,'platform.model_gateway_invocation','state','UPDATE')
      AND has_column_privilege(current_user,'platform.model_gateway_invocation','response_envelope','UPDATE')
      AND has_column_privilege(current_user,'platform.model_gateway_invocation','evidence_ref','UPDATE')
      AND has_column_privilege(current_user,'platform.model_gateway_invocation','source_digest','UPDATE')
      AND has_column_privilege(current_user,'platform.model_gateway_invocation','owner_evidence_ref','UPDATE')
      AND has_column_privilege(current_user,'platform.model_gateway_invocation','fence_epoch','UPDATE')
      AND has_column_privilege(current_user,'platform.model_gateway_invocation','updated_at','UPDATE')
      AND (has_table_privilege(current_user, 'platform.model_gateway_attempt_usage_fact', 'SELECT') AND has_table_privilege(current_user, 'platform.model_gateway_attempt_usage_fact', 'INSERT'))
      AND (has_table_privilege(current_user, 'platform.model_gateway_outbox', 'SELECT') AND has_table_privilege(current_user, 'platform.model_gateway_outbox', 'INSERT'))
      AND (has_table_privilege(current_user, 'platform.model_gateway_frame', 'SELECT') AND has_table_privilege(current_user, 'platform.model_gateway_frame', 'INSERT'))
      AND has_table_privilege(current_user,'platform.model_gateway_dispatch_queue','INSERT')
      AND NOT has_table_privilege(current_user,'platform.model_gateway_dispatch_queue','SELECT')
      AND has_column_privilege(current_user,'platform.model_gateway_dispatch_queue','state','UPDATE')
      AND has_column_privilege(current_user,'platform.model_gateway_dispatch_queue','dispatch_owner_ref','UPDATE')
      AND has_column_privilege(current_user,'platform.model_gateway_dispatch_queue','dispatch_lease_expires_at','UPDATE')
      AND has_column_privilege(current_user,'platform.model_gateway_dispatch_queue','updated_at','UPDATE')
      AND has_table_privilege(current_user,'platform.model_gateway_capacity','SELECT')
      AND has_column_privilege(current_user,'platform.model_gateway_capacity','active_count','UPDATE')
      AND has_column_privilege(current_user,'platform.model_gateway_capacity','queued_count','UPDATE')
      AND (has_table_privilege(current_user, 'platform.credit_usage_command_receipt', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_usage_command_receipt', 'INSERT'))
      AND (has_table_privilege(current_user, 'platform.credit_usage_attempt_intent', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_usage_attempt_intent', 'INSERT'))
      AND has_column_privilege(current_user,'platform.credit_usage_attempt_intent','fence_epoch','UPDATE')
      AND has_column_privilege(current_user,'platform.credit_usage_attempt_intent','state','UPDATE')
      AND has_column_privilege(current_user,'platform.credit_usage_attempt_intent','owner_evidence_ref','UPDATE')
      AND has_column_privilege(current_user,'platform.credit_usage_attempt_intent','provisional_customer_amount','UPDATE')
      AND has_column_privilege(current_user,'platform.credit_usage_attempt_intent','updated_at','UPDATE')
      AND (has_table_privilege(current_user, 'platform.credit_attempt_usage_evidence', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_attempt_usage_evidence', 'INSERT'))
      AND has_table_privilege(current_user,'platform.credit_rating_policy_revision','SELECT')
      AND has_table_privilege(current_user,'platform.credit_rating_snapshot','SELECT')
      AND has_table_privilege(current_user,'platform.credit_authorization_segment','SELECT')
      AND has_table_privilege(current_user,'platform.credit_budget_allocation','SELECT')
      AND has_table_privilege(current_user,'platform.credit_budget_allocation_revision','SELECT')
      AND has_table_privilege(current_user,'platform.credit_execution_budget_root','SELECT')
      AND has_table_privilege(current_user,'platform.credit_hold','SELECT')
      AND NOT has_table_privilege(current_user,'platform.outbox_event','SELECT')
      AND NOT has_table_privilege(current_user,'platform.outbox_event','INSERT') AS "hasRequiredGatewayWrites"
  FROM pg_roles runtime,pg_database database_row
  JOIN pg_roles owner ON owner.oid=database_row.datdba
  WHERE runtime.rolname=current_user AND database_row.datname=current_database() AND runtime.rolname=$2`;
