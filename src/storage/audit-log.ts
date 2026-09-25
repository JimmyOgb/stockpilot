/**
 * Persistence & Audit Store
 * Stores evaluation cycles, market state observations, verification results, and transaction receipts.
 */

import {
  PortfolioSnapshot,
  MarketState,
  RebalanceProposal,
  VerificationResult,
  ExecutionReceipt
} from '../types/index.js';

export interface AuditRecord {
  id: string;
  timestamp: number;
  strategyId: string;
  marketState: MarketState;
  snapshot: PortfolioSnapshot;
  proposal?: RebalanceProposal;
  verification?: VerificationResult;
  receipt?: ExecutionReceipt;
  failClosedReason?: string;
}

export interface IAuditStore {
  appendRecord(record: AuditRecord): Promise<void>;
  getRecords(strategyId?: string, limit?: number): Promise<AuditRecord[]>;
}
