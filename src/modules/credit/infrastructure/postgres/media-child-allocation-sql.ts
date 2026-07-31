export const PARENT_ALLOCATION_FRESH_LOAD_SQL = `/* credit-parent-allocation-fresh-load */
SELECT allocation.site_ref AS "siteId",allocation.billing_account_ref AS "billingAccountId",
       allocation.credit_account_ref AS "creditAccountId",allocation.unit,
       allocation.liability_merchant_account_ref AS "liabilityMerchantAccountId",
       allocation.execution_budget_root_ref AS "executionBudgetRootRef",
       root.state AS "executionBudgetRootState",root.credit_hold_ref AS "creditHoldRef",
       hold.state AS "creditHoldState",hold.expires_at AS "creditHoldExpiresAt",
       allocation.budget_allocation_ref AS "parentAllocationRef",allocation.is_root AS "isRoot",
       allocation.audience,
       COALESCE((SELECT sum(segment.maximum_amount)
                 FROM platform.credit_authorization_segment segment
                 WHERE segment.site_ref=allocation.site_ref
                   AND segment.budget_allocation_ref=allocation.budget_allocation_ref
                   AND segment.state='reserved'),0)::text AS "reservedSegmentStock",
       revision.revision::text AS revision,revision.allocation_epoch::text AS "allocationEpoch",
       revision.credit_ceiling::text AS "creditCeiling",
       revision.unassigned_stock::text AS "unassignedStock",
       revision.active_child_reserved_stock::text AS "activeChildReservedStock",
       revision.committed_stock::text AS "committedStock",
       revision.captured_cumulative::text AS "capturedCumulative",
       revision.returned_to_parent_cumulative::text AS "returnedToParentCumulative",
       revision.state AS "allocationState"
FROM platform.credit_budget_allocation allocation
JOIN platform.credit_budget_allocation_revision revision
  ON revision.budget_allocation_ref=allocation.budget_allocation_ref
 AND revision.revision=allocation.current_revision
JOIN platform.credit_execution_budget_root root
  ON root.execution_budget_root_ref=allocation.execution_budget_root_ref
 AND root.site_ref=allocation.site_ref
JOIN platform.credit_hold hold
  ON hold.credit_hold_ref=root.credit_hold_ref AND hold.site_ref=root.site_ref
WHERE allocation.site_ref=$1 AND allocation.execution_budget_root_ref=$2::uuid
  AND allocation.budget_allocation_ref=$3::uuid`;

export const MEDIA_CHILD_ALLOCATION_FRESH_LOAD_SQL = `/* credit-media-child-allocation-fresh-load */
SELECT child.site_ref AS "siteId",child.billing_account_ref AS "billingAccountId",
       child.credit_account_ref AS "creditAccountId",child.unit,
       child.liability_merchant_account_ref AS "liabilityMerchantAccountId",
       child.execution_budget_root_ref AS "executionBudgetRootRef",
       root.state AS "executionBudgetRootState",root.credit_hold_ref AS "creditHoldRef",
       hold.state AS "creditHoldState",hold.expires_at AS "creditHoldExpiresAt",
       parent.budget_allocation_ref AS "parentAllocationRef",
       parent_revision.revision::text AS "parentRevision",
       parent_revision.allocation_epoch::text AS "parentAllocationEpoch",
       parent_revision.credit_ceiling::text AS "parentCreditCeiling",
       parent_revision.unassigned_stock::text AS "parentUnassignedStock",
       parent_revision.active_child_reserved_stock::text AS "parentActiveChildReservedStock",
       parent_revision.committed_stock::text AS "parentCommittedStock",
       parent_revision.captured_cumulative::text AS "parentCapturedCumulative",
       parent_revision.returned_to_parent_cumulative::text AS "parentReturnedToParentCumulative",
       parent_revision.state AS "parentAllocationState",
       child.budget_allocation_ref AS "childAllocationRef",child.audience AS "childAudience",
       child.purpose AS "childPurpose",child.operation_ref AS "mediaOperationRef",
       child.surface_ref AS "surfaceRef",child.capability_key AS "capabilityKey",
       child.agent_ref AS "agentRef",child.expires_at AS "expiresAt",
       child_revision.revision::text AS "childRevision",
       child_revision.allocation_epoch::text AS "childAllocationEpoch",
       child_revision.credit_ceiling::text AS "childCreditCeiling",
       child_revision.unassigned_stock::text AS "childUnassignedStock",
       child_revision.active_child_reserved_stock::text AS "childActiveChildReservedStock",
       child_revision.committed_stock::text AS "childCommittedStock",
       child_revision.captured_cumulative::text AS "childCapturedCumulative",
       child_revision.returned_to_parent_cumulative::text AS "childReturnedToParentCumulative",
       child_revision.state AS "childAllocationState",
       child_revision.terminal_receipt_digest AS "terminalReceiptDigest",
       child_revision.parent_applied_revision::text AS "parentAppliedRevision",
       (SELECT count(*) FROM platform.credit_authorization_segment segment
        WHERE segment.site_ref=child.site_ref AND segment.budget_allocation_ref=child.budget_allocation_ref
          AND segment.state='reserved')::text AS "reservedAuthorizationCount",
       (SELECT count(*) FROM platform.credit_authorization_segment segment
        WHERE segment.site_ref=child.site_ref AND segment.budget_allocation_ref=child.budget_allocation_ref
          AND segment.state='committed')::text AS "committedAuthorizationCount",
       (SELECT count(*) FROM platform.credit_authorization_segment segment
        WHERE segment.site_ref=child.site_ref AND segment.budget_allocation_ref=child.budget_allocation_ref
          AND segment.state='rating_pending')::text AS "ratingPendingCount",
       (SELECT count(*) FROM platform.credit_authorization_segment segment
        WHERE segment.site_ref=child.site_ref AND segment.budget_allocation_ref=child.budget_allocation_ref
          AND segment.state='reconciliation_required')::text AS "reconciliationRequiredCount",
       prior_return.result AS "priorReturnResult",
       prior_return."priorReturnResultDigest",prior_return."priorReturnOperationKind",
       prior_return."priorReturnBusinessOperationKey",prior_return."priorReturnRequestDigest",
       prior_return."priorReturnExecutionBudgetRootRef",prior_return."priorReturnAuthorizationSegmentRef",
       prior_return."priorReturnParentAllocationRef",prior_return."priorReturnChildAllocationRef",
       prior_return."priorReturnParentBeforeRevision",prior_return."priorReturnParentAfterRevision",
       prior_return."priorReturnChildBeforeRevision",prior_return."priorReturnChildAfterRevision",
       prior_return."priorReturnCreditAmount",prior_return."priorReturnOwnerClosureEvidenceRef"
FROM platform.credit_budget_allocation child
JOIN platform.credit_budget_allocation parent
  ON parent.budget_allocation_ref=child.parent_allocation_ref
 AND parent.site_ref=child.site_ref
 AND parent.execution_budget_root_ref=child.execution_budget_root_ref
JOIN platform.credit_budget_allocation_revision child_revision
  ON child_revision.budget_allocation_ref=child.budget_allocation_ref
 AND child_revision.revision=child.current_revision
JOIN platform.credit_budget_allocation_revision parent_revision
  ON parent_revision.budget_allocation_ref=parent.budget_allocation_ref
 AND parent_revision.revision=parent.current_revision
JOIN platform.credit_execution_budget_root root
  ON root.execution_budget_root_ref=child.execution_budget_root_ref AND root.site_ref=child.site_ref
JOIN platform.credit_hold hold
  ON hold.credit_hold_ref=root.credit_hold_ref AND hold.site_ref=root.site_ref
LEFT JOIN LATERAL (
  SELECT receipt.result,receipt.result_digest AS "priorReturnResultDigest",
         receipt.operation_kind AS "priorReturnOperationKind",
         receipt.business_operation_key AS "priorReturnBusinessOperationKey",
         receipt.request_digest AS "priorReturnRequestDigest",
         receipt.execution_budget_root_ref AS "priorReturnExecutionBudgetRootRef",
         receipt.authorization_segment_ref AS "priorReturnAuthorizationSegmentRef",
         receipt.parent_allocation_ref AS "priorReturnParentAllocationRef",
         receipt.child_allocation_ref AS "priorReturnChildAllocationRef",
         receipt.parent_before_revision::text AS "priorReturnParentBeforeRevision",
         receipt.parent_after_revision::text AS "priorReturnParentAfterRevision",
         receipt.child_before_revision::text AS "priorReturnChildBeforeRevision",
         receipt.child_after_revision::text AS "priorReturnChildAfterRevision",
         receipt.credit_amount::text AS "priorReturnCreditAmount",
         receipt.owner_closure_evidence_ref AS "priorReturnOwnerClosureEvidenceRef"
  FROM platform.credit_budget_operation_receipt receipt
  WHERE receipt.site_ref=child.site_ref AND receipt.operation_kind='return_media_child'
    AND receipt.child_allocation_ref=child.budget_allocation_ref
  ORDER BY receipt.completed_at DESC
  LIMIT 1
) prior_return ON TRUE
WHERE child.site_ref=$1 AND child.execution_budget_root_ref=$2::uuid
  AND parent.budget_allocation_ref=$3::uuid AND child.budget_allocation_ref=$4::uuid
  AND child.audience='media' AND child.purpose='media_operation'`;
