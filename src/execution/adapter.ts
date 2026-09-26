/**
 * Execution Adapter Interface & Exports
 * Dispatches verified spot transactions via Binance Agentic Wallet.
 * Strictly spot only.
 */

import {
  RebalanceProposal,
  VerificationResult,
  ExecutionReceipt,
  ExecutionPreflightInput
} from '../types/index.js';

export interface IExecutionAdapter {
  /**
   * Executes verified spot rebalance across all pre-execution gates and Agentic Wallet policies.
   */
  executeSpotRebalance(
    input: ExecutionPreflightInput
  ): Promise<ExecutionReceipt>;
  executeSpotRebalance(
    proposal: RebalanceProposal,
    verification: VerificationResult
  ): Promise<ExecutionReceipt>;
  executeSpotRebalance(
    inputOrProposal: ExecutionPreflightInput | RebalanceProposal,
    maybeVerification?: VerificationResult
  ): Promise<ExecutionReceipt>;
}

export * from './binance-agentic-wallet-client.js';
export * from './agentic-execution-adapter.js';

