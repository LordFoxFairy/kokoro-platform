---
architectureIndex: 1
rootId: service.platform.admin-control
owners:
  - "@LordFoxFairy"
---

# Admin control

Owns operator command admission, immutable decisions, maker/checker approvals, command receipts, post-effect reviews and terminal
execution review. `AdminCommandService` executes local non-dangerous owners or records approval/review facts in the caller-owned
transaction; those local facts are not duplicated into an outbox.

Only an approved dangerous effect crosses the transaction boundary. `AdminApprovalService` writes the approval transition and
enqueues one `admin-execution` request through `AdminExecutionQueuePort`; `AdminExecutionService` revalidates both authorities before
the Admin worker invokes the frozen local owner command. Rejection is terminal local state and never creates a queue item.

Application code depends on the narrow queue port, command receipt port and owner repositories. Generic outbox operations and
PostgreSQL adapters stay in composition/infrastructure. Add a new asynchronous effect only when a named worker consumes it; admission,
decision, receipt and audit facts alone are not queue events.

The Admin worker locks `admin_operator_authority` only through the role-, workload-, operation- and admin-execution-fenced
PostgreSQL routine. Its database role never receives broad UPDATE authority on the operator authority table.
