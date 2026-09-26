/**
 * Persistence & Audit Store
 * Stores evaluation cycles, market state observations, verification results, and transaction receipts.
 */

import {
  PortfolioSnapshot,
  MarketState,
  RebalanceProposal,
  VerificationResult,
  ExecutionReceipt,
  ExecutionAuditRecord
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
  executionAudit?: ExecutionAuditRecord;
}

export interface IAuditStore {
  appendRecord(record: AuditRecord): Promise<void>;
  getRecords(strategyId?: string, limit?: number): Promise<AuditRecord[]>;
  appendExecutionRecord(record: ExecutionAuditRecord): Promise<void>;
  getExecutionRecords(strategyId?: string, limit?: number): Promise<ExecutionAuditRecord[]>;
}

export class InMemoryAuditStore implements IAuditStore {
  private readonly records: AuditRecord[] = [];
  private readonly executionRecords: ExecutionAuditRecord[] = [];

  public async appendRecord(record: AuditRecord): Promise<void> {
    this.records.push(Object.freeze({ ...record }));
  }

  public async getRecords(strategyId?: string, limit?: number): Promise<AuditRecord[]> {
    let result = strategyId
      ? this.records.filter(r => r.strategyId === strategyId)
      : this.records;
    if (limit && limit > 0) {
      result = result.slice(-limit);
    }
    return [...result];
  }

  public async appendExecutionRecord(record: ExecutionAuditRecord): Promise<void> {
    this.executionRecords.push(Object.freeze({ ...record }));
  }

  public async getExecutionRecords(strategyId?: string, limit?: number): Promise<ExecutionAuditRecord[]> {
    let result = strategyId
      ? this.executionRecords.filter(r => r.strategyId === strategyId)
      : this.executionRecords;
    if (limit && limit > 0) {
      result = result.slice(-limit);
    }
    return [...result];
  }

  public clear(): void {
    this.records.length = 0;
    this.executionRecords.length = 0;
  }
}

