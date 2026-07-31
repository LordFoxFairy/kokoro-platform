SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- Memory is feature-off. These are accepted role kinds, not activated identities.
ALTER TABLE platform.runtime_role_identity_authority
  DROP CONSTRAINT runtime_role_identity_authority_role_kind_check;
ALTER TABLE platform.runtime_role_identity_authority
  ADD CONSTRAINT runtime_role_identity_authority_role_kind_check CHECK (role_kind IN (
    'commerce-worker','site-worker','asset-worker','admin-worker',
    'identity-worker','authorization-maintenance',
    'memory_public','memory_runtime','memory_worker'
  ));

CREATE TABLE platform.memory_space (
  site_ref TEXT NOT NULL,
  space_ref TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('user','project','agent_product')),
  parent_space_ref TEXT,
  parent_space_generation BIGINT CHECK (parent_space_generation > 0),
  parent_learning_generation BIGINT CHECK (parent_learning_generation > 0),
  parent_revocation_epoch BIGINT CHECK (parent_revocation_epoch > 0),
  subject_ref TEXT,
  subject_generation BIGINT CHECK (subject_generation > 0),
  project_ref TEXT,
  agent_option_ref TEXT,
  product_surface_ref TEXT,
  feature_policy_revision_ref TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version > 0),
  space_generation BIGINT NOT NULL CHECK (space_generation > 0),
  learning_generation BIGINT NOT NULL CHECK (learning_generation > 0),
  revocation_epoch BIGINT NOT NULL CHECK (revocation_epoch > 0),
  minimum_learnable_source_origin_seq BIGINT NOT NULL
    CHECK (minimum_learnable_source_origin_seq >= 0),
  learning_state TEXT NOT NULL CHECK (learning_state IN ('active','paused')),
  use_state TEXT NOT NULL CHECK (use_state IN ('active','paused')),
  state TEXT NOT NULL CHECK (state IN ('active','deleted')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (site_ref,space_ref),
  UNIQUE NULLS NOT DISTINCT (site_ref,scope_kind,parent_space_ref,parent_space_generation,
    parent_learning_generation,parent_revocation_epoch,subject_ref,subject_generation,
    project_ref,agent_option_ref,product_surface_ref),
  FOREIGN KEY (site_ref) REFERENCES platform.authorization_site(site_ref),
  FOREIGN KEY (subject_ref,site_ref)
    REFERENCES platform.authorization_subject(subject_ref,site_ref),
  FOREIGN KEY (project_ref,site_ref)
    REFERENCES platform.authorization_project(project_ref,site_ref),
  FOREIGN KEY (site_ref,parent_space_ref)
    REFERENCES platform.memory_space(site_ref,space_ref),
  CHECK (
    (scope_kind='user' AND parent_space_ref IS NULL AND parent_space_generation IS NULL
      AND parent_learning_generation IS NULL AND parent_revocation_epoch IS NULL AND subject_ref IS NOT NULL
      AND subject_generation IS NOT NULL AND project_ref IS NULL
      AND agent_option_ref IS NULL AND product_surface_ref IS NULL)
    OR
    (scope_kind='project' AND parent_space_ref IS NULL AND parent_space_generation IS NULL
      AND parent_learning_generation IS NULL AND parent_revocation_epoch IS NULL AND subject_ref IS NULL
      AND subject_generation IS NULL AND project_ref IS NOT NULL
      AND agent_option_ref IS NULL AND product_surface_ref IS NULL)
    OR
    (scope_kind='agent_product' AND parent_space_ref IS NOT NULL
      AND parent_space_generation IS NOT NULL AND parent_learning_generation IS NOT NULL
      AND parent_revocation_epoch IS NOT NULL
      AND agent_option_ref IS NOT NULL AND product_surface_ref IS NOT NULL
      AND (
        (project_ref IS NULL AND subject_ref IS NOT NULL AND subject_generation IS NOT NULL)
        OR
        (project_ref IS NOT NULL AND subject_ref IS NULL AND subject_generation IS NULL)
      ))
  )
);
CREATE INDEX memory_space_subject_scope_idx
  ON platform.memory_space(site_ref,subject_ref,subject_generation,scope_kind,state);
CREATE INDEX memory_space_project_scope_idx
  ON platform.memory_space(site_ref,project_ref,scope_kind,state)
  WHERE project_ref IS NOT NULL;
CREATE INDEX memory_space_parent_idx
  ON platform.memory_space(site_ref,parent_space_ref) WHERE parent_space_ref IS NOT NULL;

CREATE TABLE platform.memory_entry (
  site_ref TEXT NOT NULL,
  space_ref TEXT NOT NULL,
  entry_ref TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version > 0),
  current_revision BIGINT NOT NULL CHECK (current_revision > 0),
  current_revision_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','deleted')),
  category TEXT NOT NULL CHECK (category IN ('fact','preference','profile')),
  feature_policy_revision_ref TEXT NOT NULL,
  space_generation BIGINT NOT NULL CHECK (space_generation > 0),
  learning_generation BIGINT NOT NULL CHECK (learning_generation > 0),
  revocation_epoch BIGINT NOT NULL CHECK (revocation_epoch > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL CHECK (updated_at >= created_at),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (site_ref,space_ref,entry_ref),
  UNIQUE (site_ref,entry_ref),
  FOREIGN KEY (site_ref,space_ref) REFERENCES platform.memory_space(site_ref,space_ref),
  CHECK (
    (state='active' AND deleted_at IS NULL)
    OR (state='deleted' AND deleted_at IS NOT NULL AND deleted_at=updated_at)
  )
);
CREATE INDEX memory_entry_current_idx
  ON platform.memory_entry(site_ref,space_ref,state,current_revision);

CREATE TABLE platform.memory_revision (
  site_ref TEXT NOT NULL,
  space_ref TEXT NOT NULL,
  entry_ref TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  revision_ref TEXT NOT NULL,
  protected_ciphertext BYTEA,
  protection_key_revision TEXT,
  envelope_digest CHAR(64) CHECK (envelope_digest IS NULL OR envelope_digest ~ '^[a-f0-9]{64}$'),
  reason TEXT NOT NULL CHECK (reason IN ('explicit','corrected')),
  supersedes_revision BIGINT,
  supersedes_revision_ref TEXT,
  feature_policy_revision_ref TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (site_ref,space_ref,entry_ref,revision),
  UNIQUE (site_ref,revision_ref),
  UNIQUE (site_ref,space_ref,entry_ref,revision,revision_ref),
  FOREIGN KEY (site_ref,space_ref,entry_ref)
    REFERENCES platform.memory_entry(site_ref,space_ref,entry_ref) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (site_ref,space_ref,entry_ref,supersedes_revision,supersedes_revision_ref)
    REFERENCES platform.memory_revision(site_ref,space_ref,entry_ref,revision,revision_ref),
  CHECK (
    (protected_ciphertext IS NULL AND protection_key_revision IS NULL AND envelope_digest IS NULL)
    OR
    (protected_ciphertext IS NOT NULL AND octet_length(protected_ciphertext) BETWEEN 1 AND 65536
      AND protection_key_revision IS NOT NULL AND envelope_digest IS NOT NULL)
  ),
  CHECK (
    (revision=1 AND reason='explicit' AND supersedes_revision IS NULL
      AND supersedes_revision_ref IS NULL)
    OR
    (revision>1 AND reason='corrected' AND supersedes_revision=revision-1
      AND supersedes_revision_ref IS NOT NULL)
  )
);
ALTER TABLE platform.memory_entry
  ADD CONSTRAINT memory_entry_current_revision_fk
  FOREIGN KEY (site_ref,space_ref,entry_ref,current_revision,current_revision_ref)
  REFERENCES platform.memory_revision(site_ref,space_ref,entry_ref,revision,revision_ref)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE platform.memory_provenance (
  site_ref TEXT NOT NULL,
  space_ref TEXT NOT NULL,
  entry_ref TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  revision_ref TEXT NOT NULL,
  provenance_ref TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind='authenticated_user_command'),
  source_ref TEXT NOT NULL,
  source_digest CHAR(64) NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  actor_subject_ref TEXT NOT NULL,
  actor_subject_generation BIGINT NOT NULL CHECK (actor_subject_generation > 0),
  actor_project_ref TEXT,
  actor_membership_epoch BIGINT CHECK (actor_membership_epoch > 0),
  actor_authorization_epoch BIGINT CHECK (actor_authorization_epoch > 0),
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (site_ref,space_ref,entry_ref,revision,provenance_ref),
  UNIQUE (site_ref,provenance_ref),
  UNIQUE (site_ref,space_ref,entry_ref,revision,source_kind,source_ref),
  FOREIGN KEY (site_ref,space_ref,entry_ref,revision,revision_ref)
    REFERENCES platform.memory_revision(site_ref,space_ref,entry_ref,revision,revision_ref),
  FOREIGN KEY (actor_subject_ref,site_ref)
    REFERENCES platform.authorization_subject(subject_ref,site_ref),
  FOREIGN KEY (actor_project_ref,site_ref)
    REFERENCES platform.authorization_project(project_ref,site_ref),
  FOREIGN KEY (actor_project_ref,actor_subject_ref)
    REFERENCES platform.authorization_project_membership(project_ref,subject_ref),
  CHECK (
    (actor_project_ref IS NULL AND actor_membership_epoch IS NULL
      AND actor_authorization_epoch IS NULL)
    OR
    (actor_project_ref IS NOT NULL AND actor_membership_epoch IS NOT NULL
      AND actor_authorization_epoch IS NOT NULL)
  )
);

CREATE TABLE platform.memory_command_receipt (
  receipt_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_ref TEXT NOT NULL,
  owner_scope_kind TEXT NOT NULL CHECK (owner_scope_kind IN ('user','project')),
  owner_subject_ref TEXT,
  owner_subject_generation BIGINT CHECK (owner_subject_generation > 0),
  owner_project_ref TEXT,
  caller_subject_ref TEXT NOT NULL,
  caller_subject_generation BIGINT NOT NULL CHECK (caller_subject_generation > 0),
  caller_membership_epoch BIGINT CHECK (caller_membership_epoch > 0),
  caller_authorization_epoch BIGINT CHECK (caller_authorization_epoch > 0),
  command_ref TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN (
    'remember','correct','forget','pause_learning','resume_learning','pause_use','resume_use','reset',
    'rebind_policy'
  )),
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result_kind TEXT NOT NULL CHECK (result_kind IN ('remembered','corrected','forgotten',
    'learning_paused','learning_resumed','use_paused','use_resumed','reset','policy_rebound')),
  result_space_ref TEXT NOT NULL,
  result_space_version BIGINT NOT NULL CHECK (result_space_version > 0),
  result_entry_ref TEXT,
  result_entry_version BIGINT CHECK (result_entry_version > 0),
  result_revision_ref TEXT,
  result_revision BIGINT CHECK (result_revision > 0),
  result_space_generation BIGINT CHECK (result_space_generation > 0),
  result_learning_generation BIGINT CHECK (result_learning_generation > 0),
  result_revocation_epoch BIGINT CHECK (result_revocation_epoch > 0),
  result_minimum_source_origin_seq BIGINT CHECK (result_minimum_source_origin_seq >= 0),
  result_learning_state TEXT CHECK (result_learning_state IN ('active','paused')),
  result_use_state TEXT CHECK (result_use_state IN ('active','paused')),
  result_previous_feature_policy_revision_ref TEXT,
  result_feature_policy_revision_ref TEXT,
  recorded_at TIMESTAMPTZ NOT NULL,
  UNIQUE NULLS NOT DISTINCT (site_ref,owner_scope_kind,owner_subject_ref,
    owner_subject_generation,owner_project_ref,command_ref),
  FOREIGN KEY (site_ref) REFERENCES platform.authorization_site(site_ref),
  FOREIGN KEY (owner_subject_ref,site_ref)
    REFERENCES platform.authorization_subject(subject_ref,site_ref),
  FOREIGN KEY (owner_project_ref,site_ref)
    REFERENCES platform.authorization_project(project_ref,site_ref),
  FOREIGN KEY (caller_subject_ref,site_ref)
    REFERENCES platform.authorization_subject(subject_ref,site_ref),
  FOREIGN KEY (owner_project_ref,caller_subject_ref)
    REFERENCES platform.authorization_project_membership(project_ref,subject_ref),
  CHECK (
    (owner_scope_kind='user' AND owner_subject_ref IS NOT NULL
      AND owner_subject_generation IS NOT NULL AND owner_project_ref IS NULL
      AND caller_subject_ref=owner_subject_ref
      AND caller_subject_generation=owner_subject_generation
      AND caller_membership_epoch IS NULL AND caller_authorization_epoch IS NULL)
    OR
    (owner_scope_kind='project' AND owner_subject_ref IS NULL
      AND owner_subject_generation IS NULL AND owner_project_ref IS NOT NULL
      AND caller_membership_epoch IS NOT NULL AND caller_authorization_epoch IS NOT NULL)
  ),
  CHECK (
    (result_kind IN ('remembered','corrected')
      AND result_entry_ref IS NOT NULL AND result_entry_version IS NOT NULL
      AND result_revision_ref IS NOT NULL AND result_revision IS NOT NULL
      AND result_space_generation IS NULL AND result_learning_generation IS NULL
      AND result_revocation_epoch IS NULL AND result_minimum_source_origin_seq IS NULL
      AND result_learning_state IS NULL AND result_use_state IS NULL
      AND result_previous_feature_policy_revision_ref IS NULL
      AND result_feature_policy_revision_ref IS NULL)
    OR
    (result_kind='forgotten'
      AND result_entry_ref IS NOT NULL AND result_entry_version IS NOT NULL
      AND result_revision_ref IS NULL AND result_revision IS NULL
      AND result_space_generation IS NULL AND result_learning_generation IS NULL
      AND result_revocation_epoch IS NOT NULL AND result_minimum_source_origin_seq IS NULL
      AND result_learning_state IS NULL AND result_use_state IS NULL
      AND result_previous_feature_policy_revision_ref IS NULL
      AND result_feature_policy_revision_ref IS NULL)
    OR
    (result_kind IN ('learning_paused','learning_resumed','use_paused','use_resumed','reset')
      AND result_entry_ref IS NULL AND result_entry_version IS NULL
      AND result_revision_ref IS NULL AND result_revision IS NULL
      AND result_space_generation IS NOT NULL AND result_learning_generation IS NOT NULL
      AND result_revocation_epoch IS NOT NULL AND result_minimum_source_origin_seq IS NOT NULL
      AND result_learning_state IS NOT NULL AND result_use_state IS NOT NULL
      AND result_previous_feature_policy_revision_ref IS NULL
      AND result_feature_policy_revision_ref IS NULL)
    OR
    (result_kind='policy_rebound' AND result_entry_ref IS NULL AND result_entry_version IS NULL
      AND result_revision_ref IS NULL AND result_revision IS NULL
      AND result_space_generation IS NOT NULL AND result_learning_generation IS NOT NULL
      AND result_revocation_epoch IS NOT NULL AND result_minimum_source_origin_seq IS NOT NULL
      AND result_learning_state='paused' AND result_use_state='paused'
      AND result_previous_feature_policy_revision_ref IS NOT NULL
      AND result_feature_policy_revision_ref IS NOT NULL
      AND result_previous_feature_policy_revision_ref<>result_feature_policy_revision_ref)
  ),
  CHECK (
    (operation='remember' AND result_kind='remembered')
    OR (operation='correct' AND result_kind='corrected')
    OR (operation='forget' AND result_kind='forgotten')
    OR (operation='pause_learning' AND result_kind='learning_paused')
    OR (operation='resume_learning' AND result_kind='learning_resumed')
    OR (operation='pause_use' AND result_kind='use_paused')
    OR (operation='resume_use' AND result_kind='use_resumed')
    OR (operation='reset' AND result_kind='reset')
    OR (operation='rebind_policy' AND result_kind='policy_rebound')
  )
);
CREATE INDEX memory_command_receipt_owner_idx
  ON platform.memory_command_receipt(site_ref,owner_scope_kind,owner_subject_ref,
    owner_subject_generation,owner_project_ref,recorded_at);

CREATE FUNCTION platform.validate_memory_command_actor_authority()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $function$
DECLARE
  actor_site_ref TEXT;
  actor_subject_ref TEXT;
  actor_subject_generation BIGINT;
  actor_project_ref TEXT;
  actor_membership_epoch BIGINT;
  actor_authorization_epoch BIGINT;
  actor_space_ref TEXT;
BEGIN
  IF TG_TABLE_NAME='memory_provenance' THEN
    actor_site_ref := NEW.site_ref;
    actor_subject_ref := NEW.actor_subject_ref;
    actor_subject_generation := NEW.actor_subject_generation;
    actor_project_ref := NEW.actor_project_ref;
    actor_membership_epoch := NEW.actor_membership_epoch;
    actor_authorization_epoch := NEW.actor_authorization_epoch;
    actor_space_ref := NEW.space_ref;
  ELSE
    actor_site_ref := NEW.site_ref;
    actor_subject_ref := NEW.caller_subject_ref;
    actor_subject_generation := NEW.caller_subject_generation;
    actor_project_ref := NEW.owner_project_ref;
    actor_membership_epoch := NEW.caller_membership_epoch;
    actor_authorization_epoch := NEW.caller_authorization_epoch;
    actor_space_ref := NEW.result_space_ref;
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM platform.authorization_subject subject_row
       WHERE subject_row.site_ref=actor_site_ref
         AND subject_row.subject_ref=actor_subject_ref
         AND subject_row.subject_generation=actor_subject_generation
         AND subject_row.state='active'
     )
     OR (actor_project_ref IS NOT NULL AND NOT EXISTS (
       SELECT 1
       FROM platform.authorization_project project
       JOIN platform.authorization_project_membership membership
         ON membership.project_ref=project.project_ref
       WHERE project.site_ref=actor_site_ref AND project.project_ref=actor_project_ref
         AND project.state='active' AND membership.subject_ref=actor_subject_ref
         AND membership.state='active' AND membership.membership_epoch=actor_membership_epoch
         AND membership.authorization_epoch=actor_authorization_epoch
     ))
     OR NOT EXISTS (
       SELECT 1 FROM platform.memory_space space
       WHERE space.site_ref=actor_site_ref AND space.space_ref=actor_space_ref
         AND space.state='active' AND (
           (actor_project_ref IS NULL AND space.project_ref IS NULL
             AND space.subject_ref=actor_subject_ref
             AND space.subject_generation=actor_subject_generation)
           OR
           (actor_project_ref IS NOT NULL AND space.project_ref=actor_project_ref
             AND space.subject_ref IS NULL)
         )
     ) THEN
    RAISE EXCEPTION 'MEMORY_COMMAND_ACTOR_AUTHORITY_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION platform.validate_memory_command_actor_authority() FROM PUBLIC;
CREATE TRIGGER validate_memory_provenance_actor_authority_trigger
  BEFORE INSERT ON platform.memory_provenance
  FOR EACH ROW EXECUTE FUNCTION platform.validate_memory_command_actor_authority();
CREATE TRIGGER validate_memory_receipt_actor_authority_trigger
  BEFORE INSERT ON platform.memory_command_receipt
  FOR EACH ROW EXECUTE FUNCTION platform.validate_memory_command_actor_authority();

CREATE FUNCTION platform.validate_memory_scope_authority()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $function$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM platform.authorization_site site
       WHERE site.site_ref=NEW.site_ref AND site.state='active'
     )
     OR NOT EXISTS (
       SELECT 1 FROM platform.authorization_site_release release
       WHERE release.site_ref=NEW.site_ref AND release.state='active'
         AND release.feature_policy_revision=NEW.feature_policy_revision_ref
     )
     OR NOT EXISTS (
       SELECT 1
       WHERE (NEW.subject_ref IS NULL OR EXISTS (
         SELECT 1 FROM platform.authorization_subject subject_row
         WHERE subject_row.subject_ref=NEW.subject_ref AND subject_row.site_ref=NEW.site_ref
           AND subject_row.subject_generation=NEW.subject_generation AND subject_row.state='active'
       )) AND (NEW.project_ref IS NULL OR EXISTS (
         SELECT 1 FROM platform.authorization_project project
         WHERE project.project_ref=NEW.project_ref AND project.site_ref=NEW.site_ref
           AND project.state='active'
       ))
     ) THEN
    RAISE EXCEPTION 'MEMORY_SCOPE_AUTHORITY_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION platform.validate_memory_scope_authority() FROM PUBLIC;
CREATE TRIGGER validate_memory_scope_authority_trigger
  BEFORE INSERT OR UPDATE OF feature_policy_revision_ref ON platform.memory_space
  FOR EACH ROW EXECUTE FUNCTION platform.validate_memory_scope_authority();

CREATE FUNCTION platform.validate_memory_agent_product_parent()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, platform
AS $function$
DECLARE
  parent_row platform.memory_space%ROWTYPE;
BEGIN
  IF NEW.scope_kind <> 'agent_product' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO parent_row
  FROM platform.memory_space parent
  WHERE parent.site_ref=NEW.site_ref AND parent.space_ref=NEW.parent_space_ref
    AND parent.scope_kind IN ('user','project') AND parent.state='active';
  IF NOT FOUND
     OR parent_row.subject_ref IS DISTINCT FROM NEW.subject_ref
     OR parent_row.subject_generation IS DISTINCT FROM NEW.subject_generation
     OR parent_row.project_ref IS DISTINCT FROM NEW.project_ref THEN
    RAISE EXCEPTION 'MEMORY_PARENT_SCOPE_INVALID' USING ERRCODE='23514';
  END IF;
  IF parent_row.space_generation<>NEW.parent_space_generation
     OR parent_row.learning_generation<>NEW.parent_learning_generation
     OR parent_row.revocation_epoch<>NEW.parent_revocation_epoch
     OR parent_row.feature_policy_revision_ref<>NEW.feature_policy_revision_ref THEN
    RAISE EXCEPTION 'MEMORY_PARENT_FENCE_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION platform.validate_memory_agent_product_parent() FROM PUBLIC;
CREATE TRIGGER validate_memory_agent_product_parent_trigger
  BEFORE INSERT OR UPDATE ON platform.memory_space
  FOR EACH ROW EXECUTE FUNCTION platform.validate_memory_agent_product_parent();

CREATE FUNCTION platform.guard_memory_space_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, platform
AS $function$
BEGIN
  IF TG_OP='DELETE'
     OR ROW(OLD.site_ref,OLD.space_ref,OLD.scope_kind,OLD.parent_space_ref,OLD.subject_ref,
         OLD.parent_space_generation,OLD.parent_learning_generation,OLD.parent_revocation_epoch,
         OLD.subject_generation,OLD.project_ref,
         OLD.agent_option_ref,OLD.product_surface_ref,OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.site_ref,NEW.space_ref,NEW.scope_kind,NEW.parent_space_ref,NEW.subject_ref,
         NEW.parent_space_generation,NEW.parent_learning_generation,NEW.parent_revocation_epoch,
         NEW.subject_generation,NEW.project_ref,
         NEW.agent_option_ref,NEW.product_surface_ref,NEW.created_at)
     OR NEW.version<>OLD.version+1
     OR NEW.space_generation<OLD.space_generation OR NEW.space_generation>OLD.space_generation+1
     OR NEW.learning_generation<OLD.learning_generation
     OR NEW.learning_generation>OLD.learning_generation+1
     OR NEW.revocation_epoch<OLD.revocation_epoch OR NEW.revocation_epoch>OLD.revocation_epoch+1
     OR NEW.minimum_learnable_source_origin_seq<OLD.minimum_learnable_source_origin_seq
     OR NEW.updated_at<OLD.updated_at
     OR (NEW.feature_policy_revision_ref<>OLD.feature_policy_revision_ref AND
         (NEW.space_generation<>OLD.space_generation+1 OR
          NEW.learning_generation<>OLD.learning_generation+1 OR
          NEW.revocation_epoch<>OLD.revocation_epoch+1 OR
          NEW.learning_state<>'paused' OR NEW.use_state<>'paused'))
     OR OLD.state='deleted'
     OR (OLD.state='active' AND NEW.state NOT IN ('active','deleted'))
     OR (NEW.learning_state<>OLD.learning_state
         AND NEW.learning_generation<>OLD.learning_generation+1)
     OR (OLD.use_state='active' AND NEW.use_state='paused'
         AND NEW.revocation_epoch<>OLD.revocation_epoch+1)
     OR (NEW.space_generation=OLD.space_generation+1
         AND (NEW.learning_generation<>OLD.learning_generation+1
              OR NEW.revocation_epoch<>OLD.revocation_epoch+1)) THEN
    RAISE EXCEPTION 'MEMORY_SPACE_UPDATE_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION platform.guard_memory_space_update() FROM PUBLIC;
CREATE TRIGGER guard_memory_space_update_trigger
  BEFORE UPDATE OR DELETE ON platform.memory_space
  FOR EACH ROW EXECUTE FUNCTION platform.guard_memory_space_update();

CREATE FUNCTION platform.guard_memory_entry_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, platform
AS $function$
BEGIN
  IF TG_OP='DELETE' OR OLD.state='deleted'
     OR ROW(OLD.site_ref,OLD.space_ref,OLD.entry_ref,OLD.category,
            OLD.feature_policy_revision_ref,OLD.space_generation,OLD.learning_generation,OLD.created_at)
        IS DISTINCT FROM
        ROW(NEW.site_ref,NEW.space_ref,NEW.entry_ref,NEW.category,
            NEW.feature_policy_revision_ref,NEW.space_generation,NEW.learning_generation,NEW.created_at)
     OR NEW.version<>OLD.version+1
     OR NEW.revocation_epoch<OLD.revocation_epoch OR NEW.revocation_epoch>OLD.revocation_epoch+1
     OR NEW.updated_at<OLD.updated_at
     OR NOT (
       (NEW.state='active' AND NEW.current_revision=OLD.current_revision+1
         AND NEW.current_revision_ref<>OLD.current_revision_ref
         AND NEW.revocation_epoch=OLD.revocation_epoch AND NEW.deleted_at IS NULL)
       OR
       (NEW.state='deleted' AND NEW.current_revision=OLD.current_revision
         AND NEW.current_revision_ref=OLD.current_revision_ref
         AND NEW.revocation_epoch=OLD.revocation_epoch+1 AND NEW.deleted_at=NEW.updated_at)
     ) THEN
    RAISE EXCEPTION 'MEMORY_ENTRY_UPDATE_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION platform.guard_memory_entry_update() FROM PUBLIC;
CREATE TRIGGER guard_memory_entry_update_trigger
  BEFORE UPDATE OR DELETE ON platform.memory_entry
  FOR EACH ROW EXECUTE FUNCTION platform.guard_memory_entry_update();

CREATE FUNCTION platform.validate_memory_entry_current_fence()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, platform AS $function$
DECLARE space_row platform.memory_space%ROWTYPE; parent_row platform.memory_space%ROWTYPE;
  parent_ref TEXT;
BEGIN
  SELECT parent_space_ref INTO parent_ref FROM platform.memory_space
   WHERE site_ref=NEW.site_ref AND space_ref=NEW.space_ref;
  IF parent_ref IS NOT NULL THEN
    SELECT * INTO parent_row FROM platform.memory_space
     WHERE site_ref=NEW.site_ref AND space_ref=parent_ref FOR UPDATE;
  END IF;
  SELECT * INTO space_row FROM platform.memory_space
   WHERE site_ref=NEW.site_ref AND space_ref=NEW.space_ref FOR UPDATE;
  IF NOT FOUND OR space_row.state<>'active'
     OR NEW.feature_policy_revision_ref<>space_row.feature_policy_revision_ref
     OR NEW.space_generation<>space_row.space_generation
     OR NEW.learning_generation<>space_row.learning_generation
     OR (TG_OP='INSERT' AND NEW.revocation_epoch<>space_row.revocation_epoch)
     OR (TG_OP='UPDATE' AND OLD.state='active' AND
         NOT (OLD.revocation_epoch=space_row.revocation_epoch OR
              (NEW.state='deleted' AND OLD.revocation_epoch+1=space_row.revocation_epoch))) THEN
    RAISE EXCEPTION 'MEMORY_ENTRY_FENCE_INVALID' USING ERRCODE='23514';
  END IF;
  IF space_row.scope_kind='agent_product' THEN
    IF parent_row.space_ref IS NULL OR parent_row.state<>'active'
       OR parent_row.space_generation<>space_row.parent_space_generation
       OR parent_row.learning_generation<>space_row.parent_learning_generation
       OR parent_row.revocation_epoch<>space_row.parent_revocation_epoch
       OR parent_row.feature_policy_revision_ref<>space_row.feature_policy_revision_ref THEN
      RAISE EXCEPTION 'MEMORY_PARENT_FENCE_INVALID' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION platform.validate_memory_entry_current_fence() FROM PUBLIC;
CREATE TRIGGER validate_memory_entry_current_fence_trigger BEFORE INSERT OR UPDATE ON platform.memory_entry
  FOR EACH ROW EXECUTE FUNCTION platform.validate_memory_entry_current_fence();

CREATE FUNCTION platform.reject_memory_immutable_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, platform
AS $function$
BEGIN
  RAISE EXCEPTION 'MEMORY_IMMUTABLE_HISTORY' USING ERRCODE='23514';
END
$function$;
REVOKE ALL ON FUNCTION platform.reject_memory_immutable_mutation() FROM PUBLIC;
CREATE TRIGGER reject_memory_revision_mutation_trigger
  BEFORE UPDATE OR DELETE ON platform.memory_revision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_memory_immutable_mutation();
CREATE TRIGGER reject_memory_provenance_mutation_trigger
  BEFORE UPDATE OR DELETE ON platform.memory_provenance
  FOR EACH ROW EXECUTE FUNCTION platform.reject_memory_immutable_mutation();
CREATE TRIGGER reject_memory_command_receipt_mutation_trigger
  BEFORE UPDATE OR DELETE ON platform.memory_command_receipt
  FOR EACH ROW EXECUTE FUNCTION platform.reject_memory_immutable_mutation();

REVOKE ALL ON TABLE platform.memory_space FROM PUBLIC;
REVOKE ALL ON TABLE platform.memory_entry FROM PUBLIC;
REVOKE ALL ON TABLE platform.memory_revision FROM PUBLIC;
REVOKE ALL ON TABLE platform.memory_provenance FROM PUBLIC;
REVOKE ALL ON TABLE platform.memory_command_receipt FROM PUBLIC;
REVOKE ALL ON SEQUENCE platform.memory_command_receipt_receipt_id_seq FROM PUBLIC;

ALTER TABLE platform.memory_space ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_space FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_entry FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_provenance FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_command_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_command_receipt FORCE ROW LEVEL SECURITY;
