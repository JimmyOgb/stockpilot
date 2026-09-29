/**
 * StockPilot — Independent GenLayer Verification Adapter
 *
 * Implements the independent verification gate between deterministic strategy evaluation
 * and downstream execution simulation:
 * - Operates strictly as an independent verifier.
 * - NEVER executes trades, signs transactions, holds private keys, or submits Binance orders.
 * - Constructs canonical, deterministic evidence payloads and computes cryptographic evidence hashes.
 * - Validates internal consistency across allocation weights, drift basis points, trade direction,
 *   market sessions, spread risk boundaries, and circuit breaker limits.
 * - Dispatches verification requests to the GenLayer intelligent contract.
 * - Parses structured responses defensively using a custom comparator (NOT strict_eq on LLM output).
 * - Fails closed on any RPC error, timeout, malformed payload, missing evidence, or consensus disagreement.
 * - Records immutable audit entries with zero sensitive credential leakage.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  GenLayerVerificationInput,
  CanonicalEvidencePayload,
  GenLayerContractResponse,
  GenLayerRuleChecks,
  VerificationResult,
  GenLayerVerificationAuditRecord,
  VerificationEvidence
} from '../types/index.js';
import { IVerificationAdapter } from './adapter.js';

export interface GenLayerAdapterConfig {
  rpcUrl?: string;
  verifierContractAddress?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * Builds a deterministic canonical evidence payload from verification input.
 */
export function buildCanonicalEvidencePayload(input: GenLayerVerificationInput): CanonicalEvidencePayload {
  const proposalId = input.proposalId || `prop-${input.timestamp}-${Math.abs(input.proposal.tradeAmountUsd).toFixed(0)}`;
  const strategy = input.strategy;
  const stockBalance = input.balances.stock;
  const stableBalance = input.balances.stable;
  const marketData = input.marketData;
  const proposal = input.proposal;
  const snapshot = input.snapshot;

  return {
    version: '1.0.0',
    proposalId,
    strategyId: strategy.id,
    targetStockWeightBps: strategy.targetStockWeightBps,
    targetStableWeightBps: strategy.targetStableWeightBps,
    driftThresholdBps: strategy.driftThresholdBps,
    maxSingleTradeUsd: strategy.maxSingleTradeUsd,
    maxSpreadBps: strategy.maxSpreadBps ?? 200,
    stockSymbol: strategy.stockSymbol,
    stockContractAddress: strategy.stockAddress,
    stableSymbol: strategy.stableSymbol,
    stableContractAddress: strategy.stableAddress,
    stockBalanceRaw: stockBalance.rawAmount,
    stockBalanceFormatted: stockBalance.formattedAmount,
    stockBalanceVerificationStatus: stockBalance.verificationStatus,
    stableBalanceRaw: stableBalance.rawAmount,
    stableBalanceFormatted: stableBalance.formattedAmount,
    stableBalanceVerificationStatus: stableBalance.verificationStatus,
    stockTokenPrice: marketData.stockTokenPrice,
    stockReferencePrice: marketData.stockReferencePrice,
    spread: marketData.stockReferencePrice && marketData.stockReferencePrice > 0
      ? (marketData.stockTokenPrice - marketData.stockReferencePrice) / marketData.stockReferencePrice
      : null,
    spreadBps: marketData.stockReferencePrice && marketData.stockReferencePrice > 0
      ? Math.round(((marketData.stockTokenPrice - marketData.stockReferencePrice) / marketData.stockReferencePrice) * 10000)
      : null,
    marketState: input.marketStatus.state,
    quoteTimestamp: marketData.quoteTimestamp,
    quoteAgeSeconds: Math.max(0, Math.floor((input.timestamp - marketData.quoteTimestamp) / 1000)),
    currentStockWeightBps: snapshot ? snapshot.currentStockWeightBps : 0,
    currentStableWeightBps: snapshot ? snapshot.currentStableWeightBps : 0,
    totalValueUsd: snapshot ? snapshot.totalValueUsd : 0,
    calculatedDriftBps: snapshot
      ? Math.abs(snapshot.currentStockWeightBps - strategy.targetStockWeightBps)
      : 0,
    proposedAction: proposal.action,
    proposedTradeAmountUsd: proposal.tradeAmountUsd,
    proposedApproxTokenAmount: proposal.approxTokenAmount,
    proposedSlippageLimitBps: proposal.slippageLimitBps,
    sourceAsset: proposal.sourceAsset,
    targetAsset: proposal.targetAsset,
    evidenceTimestamp: input.timestamp
  };
}

/**
 * Computes a deterministic SHA-256 hash of the canonical evidence payload.
 * Sorts object keys alphabetically to guarantee determinism across environments.
 */
export function computeEvidenceHash(payload: CanonicalEvidencePayload): string {
  const sortedKeys = Object.keys(payload).sort() as Array<keyof CanonicalEvidencePayload>;
  const orderedObj: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    orderedObj[k] = payload[k];
  }
  const canonicalJson = JSON.stringify(orderedObj);
  return '0x' + createHash('sha256').update(canonicalJson).digest('hex');
}

/**
 * Validates the canonical evidence payload locally against deterministic risk invariants.
 * Returns failure reasons before dispatching to external validator.
 */
export function validateEvidencePayload(payload: CanonicalEvidencePayload): { valid: boolean; reason?: string } {
  if (payload.stockBalanceVerificationStatus !== 'VERIFIED' || payload.stableBalanceVerificationStatus !== 'VERIFIED') {
    return { valid: false, reason: 'Balance reconciliation did not produce VERIFIED evidence.' };
  }
  // 1. Zero/Empty Portfolio Check (Zero Mock Policy)
  if (
    (payload.stockBalanceRaw === '0' || payload.stockBalanceRaw === '0n') &&
    (payload.stableBalanceRaw === '0' || payload.stableBalanceRaw === '0n')
  ) {
    return {
      valid: false,
      reason: 'Both stock and stablecoin balances are zero. Zero/empty portfolio data cannot be converted into a valid rebalance.'
    };
  }

  // 2. Total valuation check
  if (payload.totalValueUsd <= 0 || !Number.isFinite(payload.totalValueUsd)) {
    return {
      valid: false,
      reason: 'Total portfolio valuation is zero or negative. Mathematical weights cannot be derived.'
    };
  }

  // 3. Price validity check
  if (payload.stockTokenPrice <= 0 || !Number.isFinite(payload.stockTokenPrice)) {
    return {
      valid: false,
      reason: `Stock token price is invalid or non-positive: ${payload.stockTokenPrice}.`
    };
  }

  // 4. Quote freshness check
  if (!Number.isInteger(payload.quoteAgeSeconds) || payload.quoteAgeSeconds < 0 || payload.quoteAgeSeconds > 900) {
    return {
      valid: false,
      reason: `Quote age of ${payload.quoteAgeSeconds}s exceeds max allowable staleness of 900s.`
    };
  }

  // 5. Market session check
  if (payload.stockReferencePrice === null || payload.stockReferencePrice <= 0 || payload.spreadBps === null) {
    return { valid: false, reason: 'Price/reference price evidence is unavailable or invalid.' };
  }

  const derivedSpread = (payload.stockTokenPrice - payload.stockReferencePrice) / payload.stockReferencePrice;
  const derivedSpreadBps = Math.round(derivedSpread * 10000);
  if (Math.abs(derivedSpreadBps - payload.spreadBps) > 0 || Math.abs(derivedSpread - (payload.spread ?? NaN)) > 1e-12) {
    return { valid: false, reason: 'Spread evidence does not match token/reference prices.' };
  }

  if (payload.marketState === 'REFERENCE_STALE') {
    return {
      valid: false,
      reason: 'Market oracle or reference price is stale (REFERENCE_STALE). Proposal rejected.'
    };
  }

  if (payload.marketState === 'MARKET_CLOSED' && payload.proposedAction !== 'NONE') {
    return {
      valid: false,
      reason: 'Market session is closed. Spot trading proposal rejected under conservative safety policy.'
    };
  }

  // 6. Mathematical reconciliation
  const computedStockVal = payload.stockBalanceFormatted * payload.stockTokenPrice;
  const computedStableVal = payload.stableBalanceFormatted * 1.0;
  const computedTotal = computedStockVal + computedStableVal;

  if (computedTotal > 0) {
    const computedWeight = Math.round((computedStockVal / computedTotal) * 10000);
    const computedDrift = Math.abs(computedWeight - payload.targetStockWeightBps);

    // Verify snapshot weight alignment (tolerance: 2 bps)
    if (Math.abs(computedWeight - payload.currentStockWeightBps) > 2) {
      return {
        valid: false,
        reason: `Allocation math mismatch: computed stock weight ${computedWeight} bps does not match snapshot ${payload.currentStockWeightBps} bps.`
      };
    }

    if (Math.abs(computedDrift - payload.calculatedDriftBps) > 2) {
      return {
        valid: false,
        reason: `Drift math mismatch: computed drift ${computedDrift} bps does not match reported ${payload.calculatedDriftBps} bps.`
      };
    }

    // 7. Drift threshold vs proposed action
    if (computedDrift < payload.driftThresholdBps) {
      if (payload.proposedAction !== 'NONE') {
        return {
          valid: false,
          reason: `Drift ${computedDrift} bps is strictly within threshold ${payload.driftThresholdBps} bps, but proposal specifies ${payload.proposedAction}.`
        };
      }
    } else {
      // 8. Direction consistency
      const expectedAction = computedWeight > payload.targetStockWeightBps ? 'SELL_STOCK' : 'BUY_STOCK';
      if (payload.proposedAction !== expectedAction) {
        return {
          valid: false,
          reason: `Direction mismatch: portfolio requires ${expectedAction} but proposal specifies ${payload.proposedAction}.`
        };
      }
    }
  }

  // 9. Spread boundary check
  if (
    payload.proposedAction === 'BUY_STOCK' &&
    payload.spreadBps !== null &&
    payload.spreadBps !== undefined &&
    payload.spreadBps > payload.maxSpreadBps
  ) {
    return {
      valid: false,
      reason: `Token/reference spread (${payload.spreadBps} bps) exceeds maximum allowed spread (${payload.maxSpreadBps} bps) for BUY_STOCK.`
    };
  }

  // 10. Circuit breaker check
  if (payload.proposedTradeAmountUsd > payload.maxSingleTradeUsd) {
    return {
      valid: false,
      reason: `Proposed trade amount $${payload.proposedTradeAmountUsd.toFixed(2)} USD exceeds max single trade circuit breaker $${payload.maxSingleTradeUsd.toFixed(2)} USD.`
    };
  }

  return { valid: true };
}

/**
 * GenLayerVerificationAdapter
 * Independent verification adapter bridging StockPilot's deterministic engine with GenLayer.
 */
export class GenLayerVerificationAdapter implements IVerificationAdapter {
  private readonly rpcUrl: string;
  private readonly verifierContractAddress: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly auditTrail: GenLayerVerificationAuditRecord[] = [];

  constructor(config?: GenLayerAdapterConfig) {
    this.rpcUrl = config?.rpcUrl || process.env.GENLAYER_RPC_URL || 'https://studio.genlayer.com/api';
    this.verifierContractAddress = config?.verifierContractAddress || process.env.GENLAYER_VERIFIER_CONTRACT || '';
    this.timeoutMs = config?.timeoutMs ?? 15000;
    this.fetchFn = config?.fetchFn || globalThis.fetch;
  }

  /**
   * Returns immutable copies of all audit records recorded during adapter operation.
   */
  public getAuditTrail(): GenLayerVerificationAuditRecord[] {
    return [...this.auditTrail];
  }

  /**
   * Submits evidence packet to verification layer and awaits consensus / rule evaluation.
   */
  public async verifyProposal(evidence: VerificationEvidence | GenLayerVerificationInput): Promise<VerificationResult> {
    const verifiedAt = Date.now();

    // 1. Normalize input to GenLayerVerificationInput if needed
    let verificationInput: GenLayerVerificationInput;
    if ('balances' in evidence && 'marketData' in evidence) {
      verificationInput = evidence as GenLayerVerificationInput;
    } else {
      // Legacy VerificationEvidence fallback conversion
      const legacy = evidence as VerificationEvidence;
      verificationInput = {
        strategy: {
          id: legacy.strategyId,
          name: legacy.strategyId,
          userPrompt: '',
          stockSymbol: legacy.proposal.sourceAsset === 'USDC' ? legacy.proposal.targetAsset : legacy.proposal.sourceAsset,
          stockAddress: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
          stableSymbol: 'USDC',
          stableAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
          targetStockWeightBps: legacy.targetStockWeightBps,
          targetStableWeightBps: 10000 - legacy.targetStockWeightBps,
          driftThresholdBps: 500,
          maxSingleTradeUsd: 5000,
          maxSpreadBps: 200
        },
        balances: {
          stock: {
            symbol: 'NVDAB',
            contractAddress: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
            rawAmount: '30000000000000000000',
            formattedAmount: 30,
            verificationStatus: 'VERIFIED'
          },
          stable: {
            symbol: 'USDC',
            contractAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
            rawAmount: '4000000000000000000000',
            formattedAmount: 4000,
            verificationStatus: 'VERIFIED'
          }
        },
        marketData: {
          stockTokenPrice: 200.0,
          stockReferencePrice: 200.0,
          spread: 0.0,
          spreadBps: 0,
          quoteTimestamp: legacy.timestamp,
          quoteAgeSeconds: legacy.quoteAgeSeconds
        },
        marketStatus: {
          state: legacy.marketState
        },
        snapshot: null,
        proposal: legacy.proposal,
        riskChecks: {
          maxSpreadBps: 200,
          maxSingleTradeUsd: 5000,
          isSpreadExcessive: false,
          isCircuitBreakerTripped: false
        },
        timestamp: legacy.timestamp
      };
    }

    // 2. Build canonical evidence payload & compute evidence hash
    const canonicalPayload = buildCanonicalEvidencePayload(verificationInput);
    const evidenceHash = computeEvidenceHash(canonicalPayload);
    const proposalId = canonicalPayload.proposalId;

    // 3. Local pre-verification validation
    const localValidation = validateEvidencePayload(canonicalPayload);
    if (!localValidation.valid) {
      const rejectResult: VerificationResult = {
        status: 'REJECT',
        decision: 'NOT_VERIFIED',
        evidenceHash,
        proposalId,
        reason: `Pre-verification gate rejected proposal: ${localValidation.reason}`,
        verifiedAt,
        checks: {
          payload_valid: false,
          math_consistent: false,
          direction_consistent: false,
          spread_permitted: false,
          circuit_breaker_passed: false,
          market_state_permitted: false,
          non_zero_portfolio: false,
          freshness_passed: false,
          balance_verified: false,
          price_verified: false,
          spread_verified: false,
          market_state_verified: false,
          allocation_drift_valid: false,
          trade_direction_valid: false,
          trade_amount_valid: false,
          risk_limits_passed: false
        }
      };
      this.recordAudit(rejectResult, canonicalPayload);
      return rejectResult;
    }

    // 4. Contract Address Check
    const contractAddress = this.verifierContractAddress.trim();
    if (!contractAddress || contractAddress === '0x0000000000000000000000000000000000000000') {
      const unconfiguredResult: VerificationResult = {
        status: 'REJECT',
        decision: 'NOT_VERIFIED',
        evidenceHash,
        proposalId,
        reason: 'GenLayer verification unconfigured: GENLAYER_VERIFIER_CONTRACT is missing or zero address. Fail closed.',
        verifiedAt
      };
      this.recordAudit(unconfiguredResult, canonicalPayload);
      return unconfiguredResult;
    }

    // 5. External GenLayer RPC Contract Invocation
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const requestBody = {
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 1000000),
        method: 'gen_call',
        params: [
          {
            to: contractAddress,
            data: {
              method: 'verify_proposal',
              args: [JSON.stringify(canonicalPayload), evidenceHash]
            }
          },
          'latest'
        ]
      };

      const response = await this.fetchFn(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errorResult: VerificationResult = {
          status: 'REJECT',
          decision: 'NOT_VERIFIED',
          evidenceHash,
          proposalId,
          reason: `GenLayer verification failed with HTTP status ${response.status}. Fail closed.`,
          verifiedAt
        };
        this.recordAudit(errorResult, canonicalPayload);
        return errorResult;
      }

      const responseJson = await response.json() as Record<string, unknown>;

      // Fail closed on RPC-level error
      if (responseJson.error) {
        const errObj = responseJson.error as { message?: string; code?: number };
        const rpcErrorResult: VerificationResult = {
          status: 'REJECT',
          decision: 'NOT_VERIFIED',
          evidenceHash,
          proposalId,
          reason: `GenLayer RPC error: ${errObj.message || 'Unknown error'} (Code: ${errObj.code || 'N/A'}). Fail closed.`,
          verifiedAt
        };
        this.recordAudit(rpcErrorResult, canonicalPayload);
        return rpcErrorResult;
      }

      // 6. Defensive Structured Response Parsing & Custom Comparator (no strict_eq on LLM)
      const rawResult = responseJson.result;
      const evaluation = this.evaluateContractResponse(rawResult, evidenceHash, proposalId);
      this.recordAudit(evaluation, canonicalPayload);
      return evaluation;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.includes('aborted') || message.includes('timeout');
      const failClosedResult: VerificationResult = {
        status: 'REJECT',
        decision: 'NOT_VERIFIED',
        evidenceHash,
        proposalId,
        reason: isTimeout
          ? `GenLayer verification timed out after ${this.timeoutMs}ms. Fail closed.`
          : `GenLayer network verification error: ${message}. Fail closed.`,
        verifiedAt
      };
      this.recordAudit(failClosedResult, canonicalPayload);
      return failClosedResult;
    }
  }

  /**
   * Custom structured comparator verifying GenLayer contract response.
   * Does NOT rely on strict_eq on LLM text output; validates schema, status, and evidence hash.
   */
  public evaluateContractResponse(
    rawResult: unknown,
    expectedHash: string,
    proposalId: string
  ): VerificationResult {
    const verifiedAt = Date.now();

    // Check for malformed response
    if (!rawResult || typeof rawResult !== 'object') {
      return {
        status: 'REJECT',
        decision: 'NOT_VERIFIED',
        evidenceHash: expectedHash,
        proposalId,
        reason: 'Malformed GenLayer response: result is not a valid object.',
        verifiedAt
      };
    }

    const res = rawResult as Partial<GenLayerContractResponse>;

    // A write is authoritative only after the node reports finalized consensus.
    if (res.finalized !== true || res.consensus_status !== 'FINALIZED') {
      return {
        status: 'REJECT', decision: 'NOT_VERIFIED', evidenceHash: expectedHash, proposalId,
        reason: `GenLayer result is not finalized (finalized=${String(res.finalized)}, consensus_status=${String(res.consensus_status)}).`, verifiedAt
      };
    }

    // Schema field checks
    if (!res.status || (res.status !== 'ALLOW' && res.status !== 'REJECT')) {
      return {
        status: 'REJECT',
        decision: 'NOT_VERIFIED',
        evidenceHash: expectedHash,
        proposalId,
        reason: `Malformed GenLayer response: missing or invalid status "${String(res.status)}".`,
        verifiedAt
      };
    }

    if (res.evidence_hash !== expectedHash) {
      return {
        status: 'REJECT',
        decision: 'NOT_VERIFIED',
        evidenceHash: expectedHash,
        proposalId,
        reason: `Tampered evidence hash: response evidence hash (${res.evidence_hash}) does not match canonical payload hash (${expectedHash}).`,
        verifiedAt
      };
    }

    const requiredChecks: Array<keyof GenLayerRuleChecks> = [
      'payload_valid', 'math_consistent', 'direction_consistent', 'spread_permitted',
      'circuit_breaker_passed', 'market_state_permitted', 'non_zero_portfolio',
      'freshness_passed', 'balance_verified', 'price_verified', 'spread_verified',
      'market_state_verified', 'allocation_drift_valid', 'trade_direction_valid',
      'trade_amount_valid', 'risk_limits_passed'
    ];
    if (!res.checks || requiredChecks.some((key) => typeof res.checks?.[key] !== 'boolean')) {
      return { status: 'REJECT', decision: 'NOT_VERIFIED', evidenceHash: expectedHash, proposalId,
        reason: 'Malformed GenLayer response: complete safety checks are required.', verifiedAt };
    }
    if (res.proposal_id !== proposalId || typeof res.reason !== 'string' || res.reason.trim() === '') {
      return { status: 'REJECT', decision: 'NOT_VERIFIED', evidenceHash: expectedHash, proposalId,
        reason: 'Malformed GenLayer response: proposal_id and non-empty reason are required.', verifiedAt };
    }
    const checks = res.checks as GenLayerRuleChecks;

    if (res.status === 'ALLOW' && requiredChecks.some((key) => checks[key] !== true)) {
      return { status: 'REJECT', decision: 'NOT_VERIFIED', evidenceHash: expectedHash, proposalId,
        reason: 'GenLayer ALLOW response contains a failed safety check.', verifiedAt, checks };
    }
    if (res.status === 'ALLOW') {
      return {
        status: 'ALLOW',
        decision: 'VERIFIED',
        evidenceHash: expectedHash,
        proposalId,
        reason: res.reason || 'Proposal verified by GenLayer consensus.',
        verifiedAt,
        checks
      };
    }

    return {
      status: 'REJECT',
      decision: 'NOT_VERIFIED',
      evidenceHash: expectedHash,
      proposalId,
      reason: res.reason || 'Proposal rejected by GenLayer validator consensus.',
      verifiedAt,
      checks
    };
  }

  /**
   * Persists an immutable audit record for the verification operation.
   */
  private recordAudit(result: VerificationResult, payload: CanonicalEvidencePayload): void {
    const record: GenLayerVerificationAuditRecord = {
      auditId: `audit-${randomUUID()}`,
      proposalId: result.proposalId || payload.proposalId,
      strategyId: payload.strategyId,
      evidenceHash: result.evidenceHash,
      canonicalPayload: payload,
      status: result.status,
      decision: result.decision,
      reason: result.reason,
      verifiedAt: result.verifiedAt,
      contractAddress: this.verifierContractAddress,
      rpcUrl: this.rpcUrl
    };
    this.auditTrail.push(record);
  }
}
