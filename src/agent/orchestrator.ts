/**
 * StockPilot Agent Orchestrator
 * Coordinates: Data Fetch -> Strategy/Risk Evaluation -> GenLayer Verification -> Binance Web3 Wallet Execution -> Audit Logging.
 */

import { StrategyConfig, SystemHealthStatus } from '../types/index.js';
import { IBinanceWeb3Client } from '../binance/client.js';
import { IVerificationAdapter } from '../verification/adapter.js';
import { IExecutionAdapter } from '../execution/adapter.js';
import { IAuditStore } from '../storage/audit-log.js';

export class AgentOrchestrator {
  constructor(
    private binanceClient: IBinanceWeb3Client,
    private verifier: IVerificationAdapter,
    private executor: IExecutionAdapter,
    private auditStore: IAuditStore
  ) {}

  /**
   * Runs a single deterministic evaluation cycle for a strategy.
   * Enforces fail-closed behavior at every gate.
   */
  public async evaluateStrategy(strategy: StrategyConfig): Promise<void> {
    // Pipeline implementation will be wired during agent integration phase
    console.log(`[AgentOrchestrator] Evaluating strategy: ${strategy.name} (${strategy.id})`);
  }
}
