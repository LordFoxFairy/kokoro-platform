import { describe, expect, it } from "vitest";

import { PersonalBootstrapAuthorizationMutation } from "../../src/modules/identity/application/services/personal-bootstrap-authorization-mutation.js";
import { issuePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";

describe("personal bootstrap authorization mutation", () => {
  it("reserves both contiguous events before either owner mutation", async () => {
    const order: string[] = [];
    const publisher = {
      async reserveOwnerMutations() {
        order.push("global-site-batch-reserved");
        return [
          { siteRef: "site-1", streamSequence: 4n, aggregateSequence: 7n },
          { siteRef: "site-1", streamSequence: 5n, aggregateSequence: 8n },
        ];
      },
      async publishSubjectCurrent() { order.push("subject-published"); },
      async publishProjectMembershipCurrent() { order.push("membership-published"); },
    };
    const transaction = issuePlatformTransaction({ async query() { return []; }, async execute() { return 0; } }).transaction;
    await new PersonalBootstrapAuthorizationMutation(publisher).execute(
      transaction,
      { siteRef: "site-1", correlationId: "correlation-1" },
      async () => {
        order.push("owners-mutated");
        return {
          subject: {
            siteRef: "site-1", subjectRef: "subject-1", state: "active" as const,
            subjectGeneration: "1", restrictionEpoch: "1",
            updatedAt: "2026-07-29T00:00:00.000Z", retainUntil: "2026-07-29T00:05:00.000Z",
          },
          membership: {
            siteRef: "site-1", subjectRef: "subject-1", projectRef: "project-1", state: "active" as const,
            membershipEpoch: "1", authorizationEpoch: "1",
            updatedAt: "2026-07-29T00:00:00.000Z", retainUntil: "2026-07-29T00:05:00.000Z",
          },
        };
      },
    );
    expect(order).toEqual([
      "global-site-batch-reserved", "owners-mutated", "subject-published", "membership-published",
    ]);
  });
});
