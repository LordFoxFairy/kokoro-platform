# Commerce command workflow

Every effectful command uses the same order:

1. validate the branded request context against the command identity;
2. open one `PlatformUnitOfWork` and claim/lock the generic idempotency receipt;
3. recheck the live Site, Release, workload binding, Site security/policy epochs, subject, session, and CSRF boundary evidence;
4. enter only the required nodes of `COMMERCE_LOCK_ORDER` in ascending order;
5. write business truth, audit, receipt result, and outbox association before the transaction commits.

The CSRF gate recognizes only SHA-256 evidence issued as `csrf_verification` by `kokoro-platform-public`. Until an HTTP boundary
performs that verification and writes the signed evidence into `VerifiedRequestSecurityContext`, Commerce commands fail closed.
