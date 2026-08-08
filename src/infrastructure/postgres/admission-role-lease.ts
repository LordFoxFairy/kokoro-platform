import { isPlatformAdmissionLeasedRole } from "./client.js";
import { compareUtf8Bytewise } from "./split-worker-authority.js";

export interface AdmissionRoleLeaseQueryClient {
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows?: readonly Record<string, unknown>[] }>;
}

export interface AdmissionRoleLeaseFinalization {
  readonly configureAuthority: () => Promise<void>;
  readonly verifyAuthority: () => Promise<void>;
}

export interface AdmissionRoleLeaseInput {
  readonly targetRole: string;
  readonly migratorRole: string;
  readonly databaseName: string;
}

interface AdmissionRoleIdentity {
  readonly roleName: string;
  readonly roleOid: string;
}

interface AdmissionRoleAuthorityState extends AdmissionRoleIdentity {
  readonly leaseState: "active" | "draining";
  readonly leaseEpoch: string;
  readonly pendingRoleName: string | null;
  readonly pendingRoleOid: string | null;
  readonly retiringRoles: readonly AdmissionRoleIdentity[];
}

interface AdmissionRoleTransition {
  readonly mode: "bootstrap" | "reconcile" | "rotate";
  readonly targetRole: string;
  readonly targetRoleOid: string;
  readonly currentState: AdmissionRoleAuthorityState | null;
  readonly retiringRoles: readonly AdmissionRoleIdentity[];
}

async function withMigrationTransaction<Result>(
  client: AdmissionRoleLeaseQueryClient,
  name: string,
  work: () => Promise<Result>,
): Promise<Result> {
  const savepoint = quoteCatalogIdentifier(name);
  let ownsTransaction = false;
  try {
    await client.query(`SAVEPOINT ${savepoint}`);
  } catch (error) {
    if (!hasSqlState(error, "25P01")) throw error;
    await client.query("BEGIN");
    ownsTransaction = true;
  }

  try {
    const result = await work();
    if (ownsTransaction) await client.query("COMMIT");
    else await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    if (ownsTransaction) {
      await client.query("ROLLBACK").catch(() => undefined);
    } else {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => undefined);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`).catch(() => undefined);
    }
    throw error;
  }
}

function hasSqlState(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { readonly code?: unknown }).code === code;
}

async function prepareAdmissionRoleTransitionState(
  client: AdmissionRoleLeaseQueryClient,
  input: AdmissionRoleLeaseInput,
): Promise<AdmissionRoleTransition> {
  return withMigrationTransaction(client, "admission_role_transition_prepare", async () => {
    const transition = await resolveAdmissionRoleTransition(client, input, true, "prepare");
    let prepared = transition;
    if (transition.mode === "rotate" && transition.currentState?.leaseState === "active") {
      const state = transition.currentState;
      await client.query(
        `UPDATE platform.runtime_role_identity_authority
         SET lease_state='draining',pending_role_name=$1,pending_role_oid=$2::bigint,
             retiring_role_names=$3::text[],retiring_role_oids=$4::bigint[],
             draining_started_at=clock_timestamp()
         WHERE role_kind='admission' AND role_name=$5 AND role_oid=$6::bigint
           AND lease_state='active' AND lease_epoch=$7::bigint
         RETURNING role_name
         /* admissionRoleTransitionPrepare */`,
        [
          transition.targetRole,
          transition.targetRoleOid,
          transition.retiringRoles.map(({ roleName }) => roleName),
          transition.retiringRoles.map(({ roleOid }) => roleOid),
          state.roleName,
          state.roleOid,
          state.leaseEpoch,
        ],
      ).then((result) => {
        if (result.rows?.length !== 1) {
          throw new Error("PLATFORM_ADMISSION_ROLE_TRANSITION_STATE_INVALID");
        }
      });
      prepared = Object.freeze({
        ...transition,
        currentState: Object.freeze({
          ...state,
          leaseState: "draining" as const,
          pendingRoleName: transition.targetRole,
          pendingRoleOid: transition.targetRoleOid,
          retiringRoles: transition.retiringRoles,
        }),
      });
    } else if (transition.mode === "rotate" && transition.currentState === null) {
      throw new Error("PLATFORM_ADMISSION_ROLE_TRANSITION_STATE_INVALID");
    }
    await fenceAdmissionRoleConnections(client, input.databaseName, prepared.retiringRoles);
    return prepared;
  });
}

export async function prepareAdmissionRoleLease(
  client: AdmissionRoleLeaseQueryClient,
  input: AdmissionRoleLeaseInput,
): Promise<void> {
  const transition = await prepareAdmissionRoleTransitionState(client, input);
  await assertAdmissionRoleBackendsDrained(client, transition.retiringRoles);
}

async function lockAdmissionRoleTransitionForFinalize(
  client: AdmissionRoleLeaseQueryClient,
  input: Readonly<{ targetRole: string; migratorRole: string }>,
): Promise<AdmissionRoleTransition> {
  const transition = await resolveAdmissionRoleTransition(client, input, true, "finalize");
  await assertAdmissionRoleBackendsDrained(client, transition.retiringRoles);
  return transition;
}

async function resolveAdmissionRoleTransition(
  client: AdmissionRoleLeaseQueryClient,
  input: Readonly<{ targetRole: string; migratorRole: string }>,
  lockState: boolean,
  phase: "prepare" | "finalize",
): Promise<AdmissionRoleTransition> {
  const target = await readAdmissionTargetRole(client, input.targetRole);
  const state = await readAdmissionRoleAuthorityState(client, lockState);
  const discovered = await discoverRetiringAdmissionRoles(client, input.targetRole);

  if (state === null) {
    const retiringRoles = mergeAdmissionRoleIdentities(discovered);
    await assertAdmissionRoleIdentityEnvelope(client, target, retiringRoles);
    return Object.freeze({
      mode: "bootstrap" as const,
      targetRole: target.roleName,
      targetRoleOid: target.roleOid,
      currentState: null,
      retiringRoles,
    });
  }

  if (state.leaseState === "draining") {
    if (state.pendingRoleName !== input.targetRole) {
      throw new Error("PLATFORM_ADMISSION_ROLE_TRANSITION_TARGET_MISMATCH");
    }
    if (state.pendingRoleOid !== target.roleOid) {
      throw new Error("PLATFORM_ADMISSION_ROLE_TARGET_OID_MISMATCH");
    }
    const retiringRoles = mergeAdmissionRoleIdentities(state.retiringRoles, discovered);
    await assertAdmissionRoleIdentityEnvelope(client, target, retiringRoles);
    if (!sameAdmissionRoleIdentities(retiringRoles, state.retiringRoles)) {
      if (phase === "finalize") {
        throw new Error("PLATFORM_ADMISSION_ROLE_TRANSITION_TOMBSTONE_STALE");
      }
      await client.query(
        `UPDATE platform.runtime_role_identity_authority
         SET retiring_role_names=$1::text[],retiring_role_oids=$2::bigint[]
         WHERE role_kind='admission' AND lease_state='draining'
           AND pending_role_name=$3 AND pending_role_oid=$4::bigint
         RETURNING role_name
         /* admissionRoleTransitionPrepare */`,
        [
          retiringRoles.map(({ roleName }) => roleName),
          retiringRoles.map(({ roleOid }) => roleOid),
          target.roleName,
          target.roleOid,
        ],
      ).then((result) => {
        if (result.rows?.length !== 1) {
          throw new Error("PLATFORM_ADMISSION_ROLE_TRANSITION_STATE_INVALID");
        }
      });
    }
    return Object.freeze({
      mode: "rotate" as const,
      targetRole: target.roleName,
      targetRoleOid: target.roleOid,
      currentState: Object.freeze({ ...state, retiringRoles }),
      retiringRoles,
    });
  }

  if (state.roleName === target.roleName) {
    if (state.roleOid !== target.roleOid) {
      throw new Error("PLATFORM_ADMISSION_ROLE_TARGET_OID_MISMATCH");
    }
    const retiringRoles = mergeAdmissionRoleIdentities(discovered);
    await assertAdmissionRoleIdentityEnvelope(client, target, retiringRoles);
    return Object.freeze({
      mode: "reconcile" as const,
      targetRole: target.roleName,
      targetRoleOid: target.roleOid,
      currentState: state,
      retiringRoles,
    });
  }

  if (phase === "finalize") {
    throw new Error("PLATFORM_ADMISSION_ROLE_TRANSITION_NOT_PREPARED");
  }
  const retiringRoles = mergeAdmissionRoleIdentities([
    Object.freeze({ roleName: state.roleName, roleOid: state.roleOid }),
  ], discovered);
  await assertAdmissionRoleIdentityEnvelope(client, target, retiringRoles);
  return Object.freeze({
    mode: "rotate" as const,
    targetRole: target.roleName,
    targetRoleOid: target.roleOid,
    currentState: state,
    retiringRoles,
  });
}

async function readAdmissionTargetRole(
  client: AdmissionRoleLeaseQueryClient,
  targetRole: string,
): Promise<AdmissionRoleIdentity> {
  const result = await client.query(
    `SELECT runtime_role.rolname AS "roleName",runtime_role.oid::text AS "roleOid"
     FROM pg_roles runtime_role WHERE runtime_role.rolname=$1
     /* admissionRoleTargetIdentity */`,
    [targetRole],
  );
  const row = result.rows?.[0];
  if (result.rows?.length !== 1 || row === undefined) {
    throw new Error("PLATFORM_ADMISSION_ROLE_TARGET_OID_MISMATCH");
  }
  return parseAdmissionRoleIdentity(
    row,
    "PLATFORM_ADMISSION_ROLE_TARGET_OID_MISMATCH",
  );
}

async function readAdmissionRoleAuthorityState(
  client: AdmissionRoleLeaseQueryClient,
  lockState: boolean,
): Promise<AdmissionRoleAuthorityState | null> {
  const result = await client.query(
    `SELECT authority.role_name AS "roleName",authority.role_oid::text AS "roleOid",
            authority.lease_state AS "leaseState",authority.lease_epoch::text AS "leaseEpoch",
            authority.pending_role_name AS "pendingRoleName",
            authority.pending_role_oid::text AS "pendingRoleOid",
            authority.retiring_role_names AS "retiringRoleNames",
            authority.retiring_role_oids::text[] AS "retiringRoleOids"
     FROM platform.runtime_role_identity_authority authority
     WHERE authority.role_kind='admission'
     ${lockState ? "FOR UPDATE" : ""}
     /* admissionRoleTransitionAuthority */`,
  );
  if (result.rows === undefined || result.rows.length === 0) return null;
  if (result.rows.length !== 1) {
    throw new Error("PLATFORM_ADMISSION_ROLE_TRANSITION_STATE_INVALID");
  }
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("PLATFORM_ADMISSION_ROLE_TRANSITION_STATE_INVALID");
  }
  const identity = parseAdmissionRoleIdentity(
    row,
    "PLATFORM_ADMISSION_ROLE_TRANSITION_STATE_INVALID",
  );
  const leaseState = row.leaseState;
  const leaseEpoch = requireRoleOid(
    row.leaseEpoch,
    "PLATFORM_ADMISSION_ROLE_TRANSITION_STATE_INVALID",
  );
  const pendingRoleName = row.pendingRoleName;
  const pendingRoleOid = row.pendingRoleOid;
  const retiringRoleNames = requireStringArray(
    row.retiringRoleNames,
    "PLATFORM_ADMISSION_ROLE_TRANSITION_STATE_INVALID",
  );
  const retiringRoleOids = requireStringArray(
    row.retiringRoleOids,
    "PLATFORM_ADMISSION_ROLE_TRANSITION_STATE_INVALID",
  );
  if (
    (leaseState !== "active" && leaseState !== "draining") ||
    (pendingRoleName !== null && typeof pendingRoleName !== "string") ||
    (pendingRoleOid !== null && typeof pendingRoleOid !== "string") ||
    retiringRoleNames.length !== retiringRoleOids.length
  ) {
    throw new Error("PLATFORM_ADMISSION_ROLE_TRANSITION_STATE_INVALID");
  }
  const retiringRoles = retiringRoleNames.map((roleName, index) =>
    Object.freeze({
      roleName: requireRole(roleName, "PLATFORM_ADMISSION_RETIRING_ROLE"),
      roleOid: requireRoleOid(
        retiringRoleOids[index],
        "PLATFORM_ADMISSION_ROLE_TRANSITION_STATE_INVALID",
      ),
    }));
  if (
    (leaseState === "active" &&
      (pendingRoleName !== null || pendingRoleOid !== null || retiringRoles.length !== 0)) ||
    (leaseState === "draining" &&
      (!isPlatformAdmissionLeasedRole(String(pendingRoleName)) ||
        pendingRoleOid === null || retiringRoles.length === 0))
  ) {
    throw new Error("PLATFORM_ADMISSION_ROLE_TRANSITION_STATE_INVALID");
  }
  return Object.freeze({
    ...identity,
    leaseState,
    leaseEpoch,
    pendingRoleName,
    pendingRoleOid: pendingRoleOid === null ? null : requireRoleOid(
      pendingRoleOid,
      "PLATFORM_ADMISSION_ROLE_TRANSITION_STATE_INVALID",
    ),
    retiringRoles: Object.freeze(retiringRoles),
  });
}

async function discoverRetiringAdmissionRoles(
  client: AdmissionRoleLeaseQueryClient,
  targetRole: string,
): Promise<readonly AdmissionRoleIdentity[]> {
  const discovered = await client.query(
    `WITH admission_identity_routine AS (
       SELECT to_regprocedure('platform.admission_role_identity_is_current()') AS oid
     ), routine_grantee AS (
       SELECT DISTINCT acl.grantee
       FROM admission_identity_routine identity_routine
       JOIN pg_proc routine ON routine.oid=identity_routine.oid
       CROSS JOIN LATERAL aclexplode(
         COALESCE(routine.proacl,acldefault('f',routine.proowner))
       ) acl
       WHERE acl.grantee<>0 AND acl.grantee<>routine.proowner
         AND acl.privilege_type='EXECUTE'
     )
     SELECT DISTINCT runtime_role.rolname AS "roleName",runtime_role.oid::text AS "roleOid"
     FROM pg_roles runtime_role
     WHERE runtime_role.rolname<>$1 AND (
       runtime_role.rolname='platform_admission'
       OR runtime_role.oid IN (SELECT grantee FROM routine_grantee)
     )
     ORDER BY runtime_role.rolname
     /* retiredAdmissionRoleDiscovery */`,
    [targetRole],
  );
  return Object.freeze((discovered.rows ?? []).map((row) =>
    parseAdmissionRoleIdentity(row, "PLATFORM_RETIRED_ADMISSION_ROLE_DISCOVERY_INVALID")));
}

function mergeAdmissionRoleIdentities(
  ...groups: readonly (readonly AdmissionRoleIdentity[])[]
): readonly AdmissionRoleIdentity[] {
  const byName = new Map<string, AdmissionRoleIdentity>();
  const byOid = new Map<string, string>();
  for (const identity of groups.flat()) {
    const roleName = requireRole(identity.roleName, "PLATFORM_ADMISSION_RETIRING_ROLE");
    const roleOid = requireRoleOid(
      identity.roleOid,
      "PLATFORM_ADMISSION_RETIRED_ROLE_OID_MISMATCH",
    );
    const prior = byName.get(roleName);
    if (prior !== undefined && prior.roleOid !== roleOid) {
      throw new Error("PLATFORM_ADMISSION_RETIRED_ROLE_OID_MISMATCH");
    }
    const priorName = byOid.get(roleOid);
    if (priorName !== undefined && priorName !== roleName) {
      throw new Error("PLATFORM_ADMISSION_RETIRED_ROLE_OID_MISMATCH");
    }
    byName.set(roleName, Object.freeze({ roleName, roleOid }));
    byOid.set(roleOid, roleName);
  }
  if (byName.size > 16) {
    throw new Error("PLATFORM_ADMISSION_ROLE_TRANSITION_TOMBSTONE_INVALID");
  }
  return Object.freeze([...byName.values()].sort((left, right) =>
    compareUtf8Bytewise(left.roleName, right.roleName)));
}

function sameAdmissionRoleIdentities(
  left: readonly AdmissionRoleIdentity[],
  right: readonly AdmissionRoleIdentity[],
): boolean {
  return left.length === right.length && left.every((identity, index) =>
    identity.roleName === right[index]?.roleName && identity.roleOid === right[index]?.roleOid);
}

function parseAdmissionRoleIdentity(
  row: Readonly<Record<string, unknown>>,
  errorCode: string,
): AdmissionRoleIdentity {
  if (typeof row.roleName !== "string") throw new Error(errorCode);
  return Object.freeze({
    roleName: requireRole(row.roleName, "PLATFORM_ADMISSION_DATABASE_ROLE"),
    roleOid: requireRoleOid(row.roleOid, errorCode),
  });
}

function requireRoleOid(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(errorCode);
  }
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) throw new Error(errorCode);
  return parsed.toString();
}

function requireStringArray(value: unknown, errorCode: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(errorCode);
  }
  return Object.freeze([...value] as string[]);
}

async function assertAdmissionRoleIdentityEnvelope(
  client: AdmissionRoleLeaseQueryClient,
  target: AdmissionRoleIdentity,
  retiringRoles: readonly AdmissionRoleIdentity[],
): Promise<void> {
  const expected = [target, ...retiringRoles].map((identity) => ({
    roleName: identity.roleName,
    roleOid: identity.roleOid,
    target: identity.roleName === target.roleName,
  }));
  const result = await client.query(
    `WITH expected AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb)
         AS identity("roleName" text,"roleOid" text,target boolean)
     )
     SELECT expected."roleName",expected."roleOid",expected.target,
            runtime_role.oid::text AS "actualRoleOid",
            runtime_role.rolcanlogin AS "canLogin",
            runtime_role.rolsuper AS "isSuperuser",
            runtime_role.rolcreatedb AS "canCreateDatabase",
            runtime_role.rolcreaterole AS "canCreateRole",
            runtime_role.rolreplication AS "canReplicate",
            runtime_role.rolbypassrls AS "canBypassRls",
            runtime_role.rolinherit AS "inheritsPrivileges",
            EXISTS (SELECT 1 FROM pg_auth_members membership
              WHERE membership.member=runtime_role.oid) AS "hasInboundMembership",
            EXISTS (SELECT 1 FROM pg_auth_members membership
              WHERE membership.roleid=runtime_role.oid) AS "hasOutboundMembership",
            EXISTS (SELECT 1 FROM pg_database database_row
              WHERE database_row.datdba=runtime_role.oid) AS "ownsAnyDatabase",
            EXISTS (
              SELECT 1 FROM pg_database database_row
              CROSS JOIN LATERAL aclexplode(COALESCE(
                database_row.datacl,acldefault('d',database_row.datdba)
              )) acl
              WHERE database_row.datname=current_database() AND acl.grantee=0
                AND acl.privilege_type='CONNECT'
            ) AS "publicCanConnect"
     FROM expected
     LEFT JOIN pg_roles runtime_role ON runtime_role.rolname=expected."roleName"
     ORDER BY expected."roleName"
     /* admissionRoleMembershipAuthority */`,
    [JSON.stringify(expected)],
  );
  if (result.rows?.length !== expected.length) {
    throw new Error("PLATFORM_ADMISSION_ROLE_ENVELOPE_INVALID");
  }
  for (const row of result.rows) {
    const expectedRole = expected.find(({ roleName }) => roleName === row.roleName);
    if (expectedRole === undefined) {
      throw new Error("PLATFORM_ADMISSION_ROLE_ENVELOPE_INVALID");
    }
    if (row.actualRoleOid === null) {
      if (expectedRole.target) throw new Error("PLATFORM_ADMISSION_ROLE_TARGET_OID_MISMATCH");
      continue;
    }
    if (row.actualRoleOid !== expectedRole.roleOid) {
      throw new Error(expectedRole.target
        ? "PLATFORM_ADMISSION_ROLE_TARGET_OID_MISMATCH"
        : "PLATFORM_ADMISSION_RETIRED_ROLE_OID_MISMATCH");
    }
    if (row.hasInboundMembership === true || row.hasOutboundMembership === true) {
      throw new Error("PLATFORM_ADMISSION_ROLE_MEMBERSHIP_INVALID");
    }
    if (row.publicCanConnect !== false) {
      throw new Error("PLATFORM_ADMISSION_DATABASE_PUBLIC_CONNECT_INVALID");
    }
    if (
      row.canLogin !== true || row.isSuperuser !== false ||
      row.canCreateDatabase !== false || row.canCreateRole !== false ||
      row.canReplicate !== false || row.canBypassRls !== false ||
      row.inheritsPrivileges !== false || row.ownsAnyDatabase !== false
    ) {
      throw new Error("PLATFORM_ADMISSION_ROLE_ENVELOPE_INVALID");
    }
  }
}

async function assertAdmissionRoleBackendsDrained(
  client: AdmissionRoleLeaseQueryClient,
  retiringRoles: readonly AdmissionRoleIdentity[],
): Promise<void> {
  if (retiringRoles.length === 0) return;
  const result = await client.query(
    `SELECT activity.usename AS "roleName",count(*)::text AS "backendCount"
     FROM pg_stat_activity activity
     WHERE activity.usename=ANY($1::text[]) AND activity.pid<>pg_backend_pid()
     GROUP BY activity.usename
     ORDER BY activity.usename
     /* admissionRoleBackendDrain */`,
    [retiringRoles.map(({ roleName }) => roleName)],
  );
  if ((result.rows?.length ?? 0) !== 0) {
    throw new Error("PLATFORM_ADMISSION_ROLE_DRAIN_REQUIRED");
  }
}

async function fenceAdmissionRoleConnections(
  client: AdmissionRoleLeaseQueryClient,
  databaseName: string,
  retiringRoles: readonly AdmissionRoleIdentity[],
): Promise<void> {
  const existing = await readExistingRetiringAdmissionRoles(client, retiringRoles);
  for (const identity of existing) {
    await client.query(
      `REVOKE CONNECT ON DATABASE ${quoteRoleIdentifier(databaseName)} ` +
        `FROM ${quoteRoleIdentifier(identity.roleName)}`,
    );
  }
}

async function finalizeAdmissionRoleIdentityAuthority(
  client: AdmissionRoleLeaseQueryClient,
  transition: AdmissionRoleTransition,
): Promise<void> {
  let result: Awaited<ReturnType<AdmissionRoleLeaseQueryClient["query"]>>;
  if (transition.mode === "bootstrap") {
    result = await client.query(
      `INSERT INTO platform.runtime_role_identity_authority
         (role_kind,role_name,role_oid,lease_state,lease_epoch,pending_role_name,
          pending_role_oid,retiring_role_names,retiring_role_oids,draining_started_at,recorded_at)
       VALUES ('admission',$1,$2::bigint,'active',1,NULL,NULL,
         '{}'::text[],'{}'::bigint[],NULL,now())
       ON CONFLICT (role_kind) DO NOTHING
       RETURNING role_name
       /* admissionRoleTransitionFinalize */`,
      [transition.targetRole, transition.targetRoleOid],
    );
  } else if (transition.mode === "reconcile") {
    result = await client.query(
      `UPDATE platform.runtime_role_identity_authority
       SET recorded_at=now()
       WHERE role_kind='admission' AND role_name=$1 AND role_oid=$2::bigint
         AND lease_state='active' AND pending_role_name IS NULL AND pending_role_oid IS NULL
         AND retiring_role_names='{}'::text[] AND retiring_role_oids='{}'::bigint[]
       RETURNING role_name
       /* admissionRoleTransitionFinalize */`,
      [transition.targetRole, transition.targetRoleOid],
    );
  } else {
    const state = transition.currentState;
    if (state === null) throw new Error("PLATFORM_ADMISSION_ROLE_TRANSITION_STATE_INVALID");
    result = await client.query(
      `UPDATE platform.runtime_role_identity_authority
       SET role_name=$1,role_oid=$2::bigint,lease_state='active',lease_epoch=lease_epoch+1,
           pending_role_name=NULL,pending_role_oid=NULL,
           retiring_role_names='{}'::TEXT[],retiring_role_oids='{}'::BIGINT[],
           draining_started_at=NULL,recorded_at=now()
       WHERE role_kind='admission' AND role_name=$3 AND role_oid=$4::bigint
         AND lease_state='draining' AND lease_epoch=$5::bigint
         AND pending_role_name=$1 AND pending_role_oid=$2::bigint
       RETURNING role_name
       /* admissionRoleTransitionFinalize */`,
      [
        transition.targetRole,
        transition.targetRoleOid,
        state.roleName,
        state.roleOid,
        state.leaseEpoch,
      ],
    );
  }
  if (result.rows?.length !== 1) {
    throw new Error("PLATFORM_ADMISSION_ROLE_TRANSITION_STATE_INVALID");
  }
}

async function retireAdmissionRoleAuthority(
  client: AdmissionRoleLeaseQueryClient,
  input: Readonly<{
    retiringRoles: readonly AdmissionRoleIdentity[];
    targetRole: string;
    targetRoleOid: string;
    migratorRole: string;
    databaseName: string;
  }>,
): Promise<void> {
  if (input.retiringRoles.length === 0) return;
  const existing = await readExistingRetiringAdmissionRoles(client, input.retiringRoles);
  for (const identity of existing) {
    if (identity.roleName === input.targetRole || identity.roleOid === input.targetRoleOid) {
      throw new Error("PLATFORM_ADMISSION_RETIRED_ROLE_OID_MISMATCH");
    }
    const role = quoteRoleIdentifier(identity.roleName);
    await client.query(
      `REVOKE CONNECT,CREATE,TEMPORARY ON DATABASE ` +
        `${quoteRoleIdentifier(input.databaseName)} FROM ${role}`,
    );
    await client.query(`REVOKE CREATE,USAGE ON SCHEMA public FROM ${role}`);
    await client.query(`REVOKE ALL ON SCHEMA platform FROM ${role}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA platform FROM ${role}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA platform FROM ${role}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA platform FROM ${role}`);
    for (const scope of ["", " IN SCHEMA platform"] as const) {
      for (const objectKind of ["TABLES", "SEQUENCES", "FUNCTIONS"] as const) {
        await client.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteRoleIdentifier(input.migratorRole)}` +
            `${scope} REVOKE ALL ON ${objectKind} FROM ${role}`,
        );
      }
    }
  }
}

async function readExistingRetiringAdmissionRoles(
  client: AdmissionRoleLeaseQueryClient,
  retiringRoles: readonly AdmissionRoleIdentity[],
): Promise<readonly AdmissionRoleIdentity[]> {
  if (retiringRoles.length === 0) return Object.freeze([]);
  const actual = await client.query(
    `SELECT runtime_role.rolname AS "roleName",runtime_role.oid::text AS "roleOid"
     FROM pg_roles runtime_role WHERE runtime_role.rolname=ANY($1::text[])
     ORDER BY runtime_role.rolname
     /* admissionRetiringRoleIdentity */`,
    [retiringRoles.map(({ roleName }) => roleName)],
  );
  const existing = (actual.rows ?? []).map((row) =>
    parseAdmissionRoleIdentity(row, "PLATFORM_ADMISSION_RETIRED_ROLE_OID_MISMATCH"));
  for (const identity of existing) {
    const expected = retiringRoles.find(({ roleName }) => roleName === identity.roleName);
    if (expected === undefined || expected.roleOid !== identity.roleOid) {
      throw new Error("PLATFORM_ADMISSION_RETIRED_ROLE_OID_MISMATCH");
    }
  }
  return Object.freeze(existing);
}

async function configureAdmissionDatabaseLease(
  client: AdmissionRoleLeaseQueryClient,
  input: Readonly<{ admissionRole: string; migratorRole: string; databaseName: string }>,
): Promise<void> {
  const role = quoteRoleIdentifier(input.admissionRole);
  const database = quoteRoleIdentifier(input.databaseName);
  await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
  await client.query(`REVOKE CREATE,TEMPORARY ON DATABASE ${database} FROM ${role}`);
  await client.query(`REVOKE CREATE,USAGE ON SCHEMA public FROM ${role}`);
  for (const scope of ["", " IN SCHEMA platform"] as const) {
    for (const objectKind of ["TABLES", "SEQUENCES", "FUNCTIONS"] as const) {
      await client.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteRoleIdentifier(input.migratorRole)}` +
          `${scope} REVOKE ALL ON ${objectKind} FROM ${role}`,
      );
    }
  }
}

export async function finalizeAdmissionRoleLease(
  client: AdmissionRoleLeaseQueryClient,
  input: AdmissionRoleLeaseInput,
  finalization: AdmissionRoleLeaseFinalization,
): Promise<void> {
  await withMigrationTransaction(client, "admission_role_transition_finalize", async () => {
    const transition = await lockAdmissionRoleTransitionForFinalize(client, input);
    await retireAdmissionRoleAuthority(client, {
      retiringRoles: transition.retiringRoles,
      targetRole: transition.targetRole,
      targetRoleOid: transition.targetRoleOid,
      migratorRole: input.migratorRole,
      databaseName: input.databaseName,
    });
    await configureAdmissionDatabaseLease(client, {
      admissionRole: transition.targetRole,
      migratorRole: input.migratorRole,
      databaseName: input.databaseName,
    });
    await finalization.configureAuthority();
    await finalizeAdmissionRoleIdentityAuthority(client, transition);
    await finalization.verifyAuthority();
    await assertRetiredAdmissionRoleAuthority(client, transition.retiringRoles);
    await assertAdmissionDefaultAuthority(client, {
      currentRole: transition.targetRole,
      retiringRoles: transition.retiringRoles,
    });
  });
}

async function assertRetiredAdmissionRoleAuthority(
  client: AdmissionRoleLeaseQueryClient,
  retiringRoles: readonly AdmissionRoleIdentity[],
): Promise<void> {
  if (retiringRoles.length === 0) return;
  const result = await client.query(
    `WITH expected AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb)
         AS identity("roleName" text,"roleOid" text)
     ), retired AS (
       SELECT expected."roleName",expected."roleOid",runtime_role.oid,runtime_role.rolname
       FROM expected LEFT JOIN pg_roles runtime_role ON runtime_role.rolname=expected."roleName"
     )
     SELECT NOT EXISTS (
       SELECT 1 FROM retired WHERE
         (oid IS NOT NULL AND oid::text<>"roleOid")
         OR (oid IS NOT NULL AND (
           has_database_privilege(rolname,current_database(),'CONNECT,CREATE,TEMPORARY')
           OR has_schema_privilege(rolname,'platform','USAGE,CREATE')
           OR EXISTS (
             SELECT 1 FROM pg_class relation
             CROSS JOIN LATERAL aclexplode(relation.relacl) acl
             WHERE relation.relnamespace=to_regnamespace('platform') AND acl.grantee=retired.oid
           )
           OR EXISTS (
             SELECT 1 FROM pg_attribute attribute
             CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
             WHERE attribute.attrelid IN (
               SELECT oid FROM pg_class WHERE relnamespace=to_regnamespace('platform')
             ) AND acl.grantee=retired.oid
           )
           OR EXISTS (
             SELECT 1 FROM pg_proc routine
             CROSS JOIN LATERAL aclexplode(routine.proacl) acl
             WHERE routine.pronamespace=to_regnamespace('platform') AND acl.grantee=retired.oid
           )
           OR EXISTS (
             SELECT 1 FROM pg_default_acl defaults
             CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
             WHERE acl.grantee=retired.oid
           )
           OR EXISTS (
             SELECT 1 FROM pg_policy policy WHERE retired.oid=ANY(policy.polroles)
           )
         ))
     ) AS "retiredAdmissionRoleAuthorityClosed"
     /* retiredAdmissionRoleAuthorityClosed */`,
    [JSON.stringify(retiringRoles)],
  );
  if (
    result.rows?.length !== 1 ||
    result.rows[0]?.retiredAdmissionRoleAuthorityClosed !== true
  ) {
    throw new Error("PLATFORM_RETIRED_ADMISSION_ROLE_AUTHORITY_INVALID");
  }
}

async function assertAdmissionDefaultAuthority(
  client: AdmissionRoleLeaseQueryClient,
  input: Readonly<{
    currentRole: string;
    retiringRoles: readonly AdmissionRoleIdentity[];
  }>,
): Promise<void> {
  const protectedRoles = [input.currentRole, ...input.retiringRoles.map(({ roleName }) => roleName)];
  const result = await client.query(
    `WITH protected_role AS (
       SELECT runtime_role.oid FROM pg_roles runtime_role
       WHERE runtime_role.rolname=ANY($1::text[])
     ), platform_creator AS (
       SELECT owner.oid FROM pg_roles owner
       WHERE NOT owner.rolsuper
         AND has_schema_privilege(owner.rolname,'platform','CREATE')
     ), object_kind AS (
       SELECT * FROM (VALUES ('r'::"char"),('S'::"char"),('f'::"char")) kind(object_type)
     ), global_default AS (
       SELECT creator.oid AS owner_oid,kind.object_type,
              COALESCE(defaults.defaclacl,acldefault(kind.object_type,creator.oid)) AS acl
       FROM platform_creator creator CROSS JOIN object_kind kind
       LEFT JOIN pg_default_acl defaults ON defaults.defaclrole=creator.oid
         AND defaults.defaclnamespace=0 AND defaults.defaclobjtype=kind.object_type
     ), schema_default AS (
       SELECT defaults.defaclrole AS owner_oid,defaults.defaclobjtype AS object_type,
              defaults.defaclacl AS acl
       FROM pg_default_acl defaults
       WHERE defaults.defaclnamespace=to_regnamespace('platform')
         AND defaults.defaclrole IN (SELECT oid FROM platform_creator)
     )
     SELECT NOT EXISTS (
       SELECT 1 FROM pg_default_acl defaults
       CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
       WHERE acl.grantee IN (SELECT oid FROM protected_role)
     ) AND NOT EXISTS (
       SELECT 1 FROM (
         SELECT * FROM global_default UNION ALL SELECT * FROM schema_default
       ) defaults
       CROSS JOIN LATERAL aclexplode(defaults.acl) acl
       WHERE acl.grantee=0 OR acl.grantee IN (SELECT oid FROM protected_role)
     ) AS "admissionDefaultAuthorityClosed"
     /* admissionDefaultAuthorityClosed */`,
    [protectedRoles],
  );
  if (result.rows?.length !== 1 || result.rows[0]?.admissionDefaultAuthorityClosed !== true) {
    throw new Error("PLATFORM_ADMISSION_DEFAULT_AUTHORITY_INVALID");
  }
}

function requireRole(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error(`${name}_REQUIRED`);
  }
  return value;
}

function quoteCatalogIdentifier(value: string): string {
  return `"${requireRole(value, "PLATFORM_ADMISSION_SQL_IDENTIFIER")}"`;
}

function quoteRoleIdentifier(value: string): string {
  return quoteCatalogIdentifier(value);
}
