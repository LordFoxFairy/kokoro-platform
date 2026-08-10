export const ASSET_RELATIONS = [
  "asset_upload_intent",
  "asset_upload_session",
  "asset_quota_account",
  "asset_quota_reservation",
  "asset_multipart_upload",
  "asset_multipart_part",
  "asset_blob_candidate",
  "asset_cleanup_group",
  "asset_object_cleanup",
  "asset_object_cleanup_receipt",
  "asset_upload_rejection",
  "asset_scan_evaluation",
  "asset_promotion_intent",
  "asset_blob",
  "asset_resource",
  "asset_version",
  "asset_reference",
  "asset_eligibility_projection",
  "asset_promotion_receipt",
] as const;

export const ASSET_API_MUTABLE_RELATIONS = [
  "asset_upload_intent",
  "asset_upload_session",
  "asset_quota_account",
  "asset_quota_reservation",
] as const;

export const ASSET_API_OWNER_READ_RELATIONS = [
  "asset_blob_candidate",
  "asset_upload_rejection",
  "asset_promotion_intent",
  "asset_resource",
  "asset_version",
  "asset_eligibility_projection",
] as const;

export const ASSET_API_RELATIONS = [
  ...ASSET_API_MUTABLE_RELATIONS,
  ...ASSET_API_OWNER_READ_RELATIONS,
] as const;

export const ASSET_WORKER_INSERT_RELATIONS = ASSET_RELATIONS.slice(6);

export const ASSET_WORKER_UPDATE_RELATIONS = [
  "asset_upload_intent",
  "asset_upload_session",
  "asset_quota_account",
  "asset_quota_reservation",
  "asset_blob_candidate",
  "asset_cleanup_group",
  "asset_object_cleanup",
  "asset_promotion_intent",
] as const;

export const ADMISSION_RELATIONS = [
  "admission_command",
  "capability_projection_command",
  "admission_session_execution_binding",
  "admission_execution_manifest",
  "admission_launch_profile_snapshot",
  "admission_capability_catalog_snapshot",
  "admission_media_access_authorization",
] as const;

export const MEDIA_CONTROL_ADMIN_RELATIONS = [
  "media_operation_definition_revision",
  "site_release_media_definition",
] as const;

export const CREDIT_USAGE_RELATIONS = [
  "credit_rating_policy_revision",
  "credit_rating_snapshot",
  "credit_usage_attempt_intent",
  "credit_attempt_usage_evidence",
  "credit_usage_segment_closure",
  "credit_usage_closure_evidence",
  "credit_usage_settlement",
  "credit_rated_usage",
  "credit_usage_settlement_source",
  "credit_usage_variance",
  "credit_usage_reconciliation",
  "credit_usage_command_receipt",
] as const;

export const MODEL_GATEWAY_ADMISSION_RELATIONS = [
  "model_gateway_execution_authorization",
] as const;

export const ADMISSION_MODEL_GATEWAY_SELECT_COLUMNS = [
  "site_ref",
  "execution_manifest_ref",
  "state",
  "authorization_handle",
] as const;

export const ADMISSION_MODEL_GATEWAY_UPDATE_COLUMNS = [
  "state",
  "updated_at",
] as const;

export const SITE_PUBLICATION_ADMISSION_SELECT_RELATIONS = [
  "command_receipt",
  "site_project_binding",
  "site_release_candidate_authority",
  "site_release_candidate_authorization",
  "site_publication_revision",
  "site_release_producer_trust_revision",
  "site_release_checker_trust_revision",
  "site_release_provenance_attestation",
  "site_release_evidence_checker_decision",
] as const;

export const SITE_PUBLICATION_ADMISSION_INSERT_RELATIONS = [
  "command_receipt",
  "site_publication_revision",
  "site_release_provenance_attestation",
  "site_release_evidence_checker_decision",
] as const;

export const SITE_PUBLICATION_ADMISSION_UPDATE_RELATIONS = [
  "command_receipt",
] as const;

export const ADMISSION_SELECT_RELATIONS = [
  ...ADMISSION_RELATIONS,
  ...CREDIT_USAGE_RELATIONS,
  ...MODEL_GATEWAY_ADMISSION_RELATIONS,
  ...SITE_PUBLICATION_ADMISSION_SELECT_RELATIONS,
  "site",
  "site_release",
  "authorization_site",
  "authorization_site_release",
  "authorization_product_binding",
  "authorization_subject",
  "authorization_identity_session",
  "authorization_project",
  "authorization_project_membership",
  "authorization_session_access_grant",
  "identity_personal_bootstrap",
  "identity_execution_space",
  "identity_namespace_allocation_intent",
  "commerce_billing_account",
  "credit_account",
  "credit_grant",
  "credit_hold",
  "credit_hold_allocation",
  "credit_journal_transaction",
  "credit_journal_entry",
  "credit_execution_budget_root",
  "credit_budget_allocation",
  "credit_budget_allocation_revision",
  "credit_authorization_segment",
  "credit_budget_operation_receipt",
  "asset_resource",
  "asset_version",
  "asset_eligibility_projection",
] as const;

export const ADMISSION_INSERT_RELATIONS = [
  "admission_command",
  "capability_projection_command",
  "admission_session_execution_binding",
  "admission_execution_manifest",
  "admission_capability_catalog_snapshot",
  "admission_media_access_authorization",
  "outbox_event",
  "credit_hold",
  "credit_hold_allocation",
  "credit_journal_transaction",
  "credit_journal_entry",
  "credit_execution_budget_root",
  "credit_budget_allocation",
  "credit_budget_allocation_revision",
  "credit_authorization_segment",
  "credit_budget_operation_receipt",
  "credit_rating_snapshot",
  "credit_usage_segment_closure",
  "credit_usage_closure_evidence",
  "credit_usage_settlement",
  "credit_rated_usage",
  "credit_usage_settlement_source",
  "credit_usage_variance",
  "credit_usage_reconciliation",
  "credit_usage_command_receipt",
  "model_gateway_execution_authorization",
  ...SITE_PUBLICATION_ADMISSION_INSERT_RELATIONS,
] as const;

export const ADMISSION_UPDATE_RELATIONS = [
  "admission_command",
  "capability_projection_command",
  "admission_execution_manifest",
  "admission_media_access_authorization",
  "credit_hold",
  "credit_execution_budget_root",
  "credit_authorization_segment",
  "model_gateway_execution_authorization",
  ...SITE_PUBLICATION_ADMISSION_UPDATE_RELATIONS,
] as const;

export const PRODUCT_CATALOG_ADMIN_RELATIONS = [
  "product_catalog_publication_head",
  "product_surface_catalog_revision",
  "launch_product_profile_revision",
  "product_catalog_publication_audit",
  "product_catalog_publication_receipt",
] as const;

export const SITE_PUBLICATION_ADMIN_SELECT_RELATIONS = [
  "site_release_candidate_authority",
  "site_release_candidate_authorization",
  "site_publication_revision",
  "site_effective_access_authority_revision",
  "site_web_build_intent_issuer_revision",
  "site_web_build_intent_issuer_head",
  "site_web_build_intent_envelope",
  "site_release_producer_trust_revision",
  "site_release_certification_envelope",
] as const;

export const SITE_PUBLICATION_ADMIN_INSERT_RELATIONS = [
  "site_release_candidate_authority",
  "site_release_candidate_authorization",
  "site_publication_revision",
  "site_web_build_intent_envelope",
] as const;

export const SITE_PUBLICATION_ADMIN_UPDATE_RELATIONS = [
  "site_release_candidate_authorization",
] as const;

export const ADMIN_INSERT_RELATIONS = [
  "command_receipt",
  "outbox_event",
  "commerce_billing_account",
  "commerce_billing_account_membership",
  "commerce_command",
  "commerce_catalog_product",
  "commerce_catalog_plan",
  "commerce_catalog_plan_version",
  "commerce_credit_program_revision",
  "commerce_entitlement_template_revision",
  "commerce_fulfillment_program_revision",
  "commerce_fulfillment_program_output",
  "commerce_catalog_product_version",
  "commerce_redemption_program_revision",
  "commerce_redemption_program_availability",
  "commerce_code_batch",
  "commerce_redeem_code",
  "commerce_code_batch_approval",
  "commerce_code_secret_export",
  "commerce_audit_entry",
  "credit_rating_policy_revision",
  "site",
  "site_project_binding",
  "site_release",
  "site_activation_attempt",
  "site_traffic_stop_attempt",
  "site_effect_approval",
  "authorization_scoped_site_cursor",
  "authorization_scoped_event_log",
  "admin_command_decision",
  "admin_approval",
  "admin_approval_decision",
  "admin_post_effect_review",
  "admin_oidc_transaction",
  "admin_operator_session",
  "admin_step_up_transaction",
  "admission_capability_catalog_snapshot",
  "admission_launch_profile_snapshot",
  "site_release_media_definition",
  "product_surface_catalog_revision",
  "launch_product_profile_revision",
  "product_catalog_publication_audit",
  "product_catalog_publication_receipt",
  ...SITE_PUBLICATION_ADMIN_INSERT_RELATIONS,
] as const;

export const ADMIN_UPDATE_RELATIONS = [
  "command_receipt",
  "commerce_catalog_epoch_authority",
  "commerce_billing_account",
  "commerce_billing_account_membership",
  "commerce_catalog_product",
  "commerce_catalog_plan",
  "commerce_code_batch",
  "commerce_redemption_program_availability",
  "site",
  "site_project_binding",
  "site_release",
  "site_deployment_binding",
  "site_effect_approval",
  "authorization_scoped_stream_state",
  "authorization_scoped_site_cursor",
  "authorization_site",
  "authorization_product_binding",
  "admin_approval",
  "admin_post_effect_review",
  "admin_oidc_transaction",
  "admin_operator_session",
  "admin_step_up_transaction",
  "product_catalog_publication_head",
  ...SITE_PUBLICATION_ADMIN_UPDATE_RELATIONS,
] as const;
