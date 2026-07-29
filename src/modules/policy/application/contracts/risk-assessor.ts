import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { VerifiedRiskDecisionSnapshot } from "../../domain/index.js";

export interface RiskAssessmentRequest {
  readonly operation: string;
  readonly resourceDigest: string;
  readonly requestDigest: string;
  readonly context: VerifiedRequestSecurityContext;
}

/** Must be invoked before opening PlatformUnitOfWork. */
export interface RiskAssessor {
  assess(request: RiskAssessmentRequest): Promise<VerifiedRiskDecisionSnapshot>;
}
