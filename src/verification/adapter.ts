/**
 * Verification Layer Adapter Interface
 * Evaluates proposed rebalances against independent verification rules (GenLayer).
 * NEVER executes trades.
 */

import {
  VerificationEvidence,
  GenLayerVerificationInput,
  VerificationResult
} from '../types/index.js';

export interface IVerificationAdapter {
  /**
   * Submits evidence packet to verification layer and awaits consensus / rule evaluation.
   */
  verifyProposal(evidence: VerificationEvidence | GenLayerVerificationInput): Promise<VerificationResult>;
}
