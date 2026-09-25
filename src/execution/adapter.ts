/**
 * Execution Adapter Interface
 * Dispatches verified spot transactions via Binance Web3 Wallet / Agentic Wallet.
 * Strictly spot only.
 */

import { RebalanceProposal, VerificationResult, ExecutionReceipt } from '../types/index.js';

export interface IExecutionAdapter {
  /**
   * Executes verified spot swap on BSC Mainnet.
   * Throws or fails closed if proposal is not accompanied by ALLOW verification.
   */
  executeSpotRebalance(
    proposal: RebalanceProposal,
    verification: VerificationResult
  ): Promise<ExecutionReceipt>;
}
