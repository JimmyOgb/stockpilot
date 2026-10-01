/**
 * StockPilot — Independent GenLayer Verification Adapter
 *
 * Implements the independent verification gate between deterministic strategy evaluation
 * and downstream execution simulation:
 * - Operates strictly as an independent verifier.
 * - NEVER executes trades, signs transactions, holds private keys, or submits Binance orders.
 * - Constructs canonical, deterministic evidence payloads and computes cryptographic evidence hashes.
 * - Enforces identical canonicalization rules (UTF-8, sorted keys, stable compact separators).
 * - Dispatches verification requests as real consensus writes to the GenLayer intelligent contract.
 * - Queries and verifies protocol transaction lifecycle using protocol transaction IDs.
 * - Requires real FINALIZED protocol consensus and SUCCESS execution; rejects ACCEPTED, PENDING, NO_MAJORITY.
 * - Never trusts self-reported contract return fields as proof of finalization.
 * - Records immutable audit entries with zero sensitive credential leakage.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  createClient,
  createAccount,
  generatePrivateKey,
  abi,
  decodeLocalnetTransaction
} from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import {
  GenLayerVerificationInput,
  CanonicalEvidencePayload,
  GenLayerContractResponse,
  GenLayerRuleChecks,
  VerificationResult,
  VerificationInspectStatus,
  GenLayerVerificationAuditRecord,
  VerificationEvidence
} from '../types/index.js';
import { IVerificationAdapter } from './adapter.js';

export interface GenLayerAdapterConfig {
  rpcUrl?: string;
  verifierContractAddress?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  privateKey?: `0x${string}`;
  client?: any;
  fetchFn?: typeof fetch;
}

/**
 * Builds a deterministic canonical evidence payload from verification input.
 * Fully binds all critical portfolio, price, spread, freshness, and risk evidence.
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
 * Deterministically canonicalizes a JSON-serializable value.
 * Identical canonicalization rule across TypeScript, Python contract, and tests:
 * - UTF-8 encoded
 * - Recursively sorted keys for all objects / mappings
 * - No insignificant whitespace (separators: ',' and ':')
 * - Compact and deterministic across key insertion orders
 */
export function canonicalizeJson(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map(canonicalizeJson).join(',') + ']';
  }
  const keys = Object.keys(val as Record<string, unknown>).sort();
  const pairs = keys.map(k => `${JSON.stringify(k)}:${canonicalizeJson((val as Record<string, unknown>)[k])}`);
  return '{' + pairs.join(',') + '}';
}

/**
 * Computes a deterministic SHA-256 hash of the canonical evidence payload.
 * Outputs '0x' followed by 64 lowercase hexadecimal characters.
 */
export function computeEvidenceHash(payload: CanonicalEvidencePayload | Record<string, unknown>): string {
  const canonicalJson = canonicalizeJson(payload);
  return '0x' + createHash('sha256').update(Buffer.from(canonicalJson, 'utf8')).digest('hex');
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
 * Helper to convert Maps (from Calldata decoding) into plain JavaScript objects recursively.
 */
function mapToObject(data: unknown): unknown {
  if (data instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of data.entries()) {
      obj[String(k)] = mapToObject(v);
    }
    return obj;
  }
  if (Array.isArray(data)) {
    return data.map(mapToObject);
  }
  return data;
}

/**
 * Defensive parser for leader receipt contract output.
 * Handles decoded Maps, raw Base64 calldata, payload readable JSON, or direct objects.
 */
export function parseLeaderReceiptResult(rawResult: unknown): Record<string, unknown> | null {
  if (!rawResult) return null;
  if (rawResult instanceof Map) {
    return mapToObject(rawResult) as Record<string, unknown>;
  }
  if (typeof rawResult === 'object') {
    const obj = rawResult as Record<string, unknown>;
    if (typeof obj.raw === 'string') {
      try {
        const buf = Buffer.from(obj.raw, 'base64');
        const sliceData = buf[0] === 0 ? buf.subarray(1) : buf;
        const decoded = abi.calldata.decode(new Uint8Array(sliceData));
        return mapToObject(decoded) as Record<string, unknown>;
      } catch {
        // Fall back to readable if calldata decode fails
      }
    }
    if (obj.payload && typeof obj.payload === 'object') {
      const payload = obj.payload as Record<string, unknown>;
      if (typeof payload.readable === 'string') {
        try {
          return JSON.parse(payload.readable) as Record<string, unknown>;
        } catch {
          // ignore
        }
      }
    }
    return obj;
  }
  if (typeof rawResult === 'string') {
    try {
      return JSON.parse(rawResult) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Extracts method name and arguments from transaction calldata.
 */
export function extractCalldata(tx: unknown): { method?: string; args?: unknown[] } | null {
  if (!tx || typeof tx !== 'object') return null;
  const t = tx as Record<string, unknown>;
  const data = (t.data || {}) as Record<string, unknown>;
  if (data.calldata && typeof data.calldata === 'object') {
    const cd = data.calldata as Record<string, unknown>;
    if (typeof cd.readable === 'string') {
      try {
        const parsed = JSON.parse(cd.readable) as { method?: string; args?: unknown[] };
        return parsed;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

/**
 * Evaluates a protocol transaction against the 10 Finalized Acceptance Rules (A-J).
 * Authoritative: derives status strictly from the protocol transaction lifecycle, never self-reported fields.
 */
export function evaluateProtocolTransaction(
  tx: unknown,
  expectedPayload: CanonicalEvidencePayload,
  expectedHash: string,
  verifierContractAddress: string
): VerificationResult {
  const verifiedAt = Date.now();
  const proposalId = expectedPayload.proposalId;

  if (!tx || typeof tx !== 'object') {
    return {
      status: 'REJECT',
      decision: 'NOT_VERIFIED',
      inspectStatus: 'CONSENSUS_FINALIZED_EXECUTION_FAILED',
      evidenceHash: expectedHash,
      proposalId,
      reason: 'Malformed protocol transaction: response is not a valid transaction object.',
      verifiedAt
    };
  }

  const txObj = tx as Record<string, unknown>;
  const transactionId = (txObj.hash || txObj.tx_id || txObj.txId) as string | undefined;

  // Rule A: Real GenLayer transaction ID exists
  if (!transactionId || typeof transactionId !== 'string' || !transactionId.startsWith('0x')) {
    return {
      status: 'REJECT',
      decision: 'NOT_VERIFIED',
      inspectStatus: 'SUBMISSION_FAILED',
      evidenceHash: expectedHash,
      proposalId,
      reason: 'Rule A violation: Real GenLayer transaction ID does not exist. Fail closed.',
      verifiedAt
    };
  }

  // Extract protocol lifecycle state
  const rawStatus = txObj.status;
  const statusName = String(txObj.statusName || txObj.status_name || '');
  const rawResult = txObj.result;
  const resultName = String(txObj.result_name || txObj.resultName || '');

  // Rule B: Protocol transaction must be Finalized
  // Status: 1 = PENDING, 5 = ACCEPTED, 7 = FINALIZED
  if (rawStatus === 1 || statusName === 'PENDING') {
    return {
      status: 'REJECT',
      decision: 'NOT_VERIFIED',
      inspectStatus: 'CONSENSUS_PENDING',
      transactionId,
      protocolStatus: 'PENDING',
      evidenceHash: expectedHash,
      proposalId,
      reason: `Rule B violation: Protocol transaction ${transactionId} is currently PENDING. Fail closed.`,
      verifiedAt
    };
  }

  if (rawStatus === 5 || statusName === 'ACCEPTED') {
    return {
      status: 'REJECT',
      decision: 'NOT_VERIFIED',
      inspectStatus: 'CONSENSUS_ACCEPTED_NOT_FINAL',
      transactionId,
      protocolStatus: 'ACCEPTED',
      evidenceHash: expectedHash,
      proposalId,
      reason: `Rule B violation: Protocol transaction ${transactionId} is merely ACCEPTED, not FINALIZED. Fail closed.`,
      verifiedAt
    };
  }

  if (rawResult === 5 || resultName === 'NO_MAJORITY') {
    return {
      status: 'REJECT',
      decision: 'NOT_VERIFIED',
      inspectStatus: 'NO_MAJORITY',
      transactionId,
      protocolStatus: statusName || String(rawStatus),
      evidenceHash: expectedHash,
      proposalId,
      reason: `Rule B violation: Protocol transaction ${transactionId} produced NO_MAJORITY. Fail closed.`,
      verifiedAt
    };
  }

  const isFinalized = rawStatus === 7 || statusName === 'FINALIZED';
  if (!isFinalized) {
    return {
      status: 'REJECT',
      decision: 'NOT_VERIFIED',
      inspectStatus: 'CONSENSUS_PENDING',
      transactionId,
      protocolStatus: statusName || String(rawStatus),
      evidenceHash: expectedHash,
      proposalId,
      reason: `Rule B violation: Protocol transaction ${transactionId} has status ${statusName || rawStatus}; must be FINALIZED. Fail closed.`,
      verifiedAt
    };
  }

  // Consensus agreement check
  if (rawResult !== undefined && rawResult !== 6 && resultName !== 'MAJORITY_AGREE') {
    return {
      status: 'REJECT',
      decision: 'NOT_VERIFIED',
      inspectStatus: 'NO_MAJORITY',
      transactionId,
      protocolStatus: 'FINALIZED',
      evidenceHash: expectedHash,
      proposalId,
      reason: `Rule B violation: Protocol transaction ${transactionId} did not achieve MAJORITY_AGREE (result=${resultName || rawResult}). Fail closed.`,
      verifiedAt
    };
  }

  // Rule D: Finalized transaction targeted the configured RebalanceVerifier
  const recipient = String(txObj.recipient || txObj.to_address || txObj.to || '').toLowerCase();
  const configuredTarget = verifierContractAddress.trim().toLowerCase();
  if (configuredTarget && (!recipient || recipient !== configuredTarget)) {
    return {
      status: 'REJECT',
      decision: 'NOT_VERIFIED',
      inspectStatus: 'CONSENSUS_FINALIZED_EXECUTION_FAILED',
      transactionId,
      protocolStatus: 'FINALIZED',
      evidenceHash: expectedHash,
      proposalId,
      reason: `Rule D violation: Transaction recipient (${recipient}) does not match configured verifier contract (${configuredTarget}). Fail closed.`,
      verifiedAt
    };
  }

  // Rule E & F: Calldata method and payload checks
  let decodedTx = txObj;
  try {
    decodedTx = decodeLocalnetTransaction(txObj as any) as Record<string, unknown>;
  } catch {
    // fallback
  }

  const calldata = extractCalldata(decodedTx) || extractCalldata(txObj);
  if (calldata) {
    if (calldata.method && calldata.method !== 'verify_proposal') {
      return {
        status: 'REJECT',
        decision: 'NOT_VERIFIED',
        inspectStatus: 'CONSENSUS_FINALIZED_EXECUTION_FAILED',
        transactionId,
        protocolStatus: 'FINALIZED',
        evidenceHash: expectedHash,
        proposalId,
        reason: `Rule E violation: Expected method "verify_proposal", but transaction called "${calldata.method}". Fail closed.`,
        verifiedAt
      };
    }
    if (Array.isArray(calldata.args) && calldata.args.length > 0) {
      const submittedArg0 = typeof calldata.args[0] === 'string' ? calldata.args[0] : JSON.stringify(calldata.args[0]);
      if (!submittedArg0.includes(proposalId)) {
        return {
          status: 'REJECT',
          decision: 'NOT_VERIFIED',
          inspectStatus: 'PAYLOAD_HASH_MISMATCH',
          transactionId,
          protocolStatus: 'FINALIZED',
          evidenceHash: expectedHash,
          proposalId,
          reason: `Rule F violation: Calldata does not contain expected proposalId "${proposalId}". Fail closed.`,
          verifiedAt
        };
      }
    }
  }

  // Rule C: Protocol transaction execution result is successful
  const consensusData = txObj.consensus_data as Record<string, unknown> | undefined;
  const leaderReceipt = Array.isArray(consensusData?.leader_receipt) ? consensusData?.leader_receipt[0] as Record<string, unknown> | undefined : undefined;
  const execResult = String(leaderReceipt?.execution_result || txObj.tx_execution_result_name || txObj.txExecutionResultName || '');

  if (execResult && execResult !== 'SUCCESS' && execResult !== 'FINISHED_WITH_RETURN') {
    return {
      status: 'REJECT',
      decision: 'NOT_VERIFIED',
      inspectStatus: 'CONSENSUS_FINALIZED_EXECUTION_FAILED',
      transactionId,
      protocolStatus: 'FINALIZED',
      evidenceHash: expectedHash,
      proposalId,
      reason: `Rule C violation: Transaction execution failed with status "${execResult}". Fail closed.`,
      verifiedAt
    };
  }

  // Rule G & H & I & J: Parse contract return output
  const rawLeaderResult = leaderReceipt?.result ?? txObj.result_payload;
  const contractOutput = parseLeaderReceiptResult(rawLeaderResult);

  if (!contractOutput || typeof contractOutput !== 'object') {
    return {
      status: 'REJECT',
      decision: 'NOT_VERIFIED',
      inspectStatus: 'CONSENSUS_FINALIZED_EXECUTION_FAILED',
      transactionId,
      protocolStatus: 'FINALIZED',
      evidenceHash: expectedHash,
      proposalId,
      reason: 'Rule C violation: Contract returned empty or unparseable output. Fail closed.',
      verifiedAt
    };
  }

  // Rule G & H: Contract independently computed SHA-256(payload_json) and equals submitted hash
  const contractComputedHash = String(contractOutput.evidence_hash || '');
  if (!contractComputedHash || contractComputedHash.toLowerCase() !== expectedHash.toLowerCase()) {
    return {
      status: 'REJECT',
      decision: 'NOT_VERIFIED',
      inspectStatus: 'PAYLOAD_HASH_MISMATCH',
      transactionId,
      protocolStatus: 'FINALIZED',
      evidenceHash: expectedHash,
      proposalId,
      reason: `Rule H violation: Contract computed evidence hash (${contractComputedHash}) does not match expected canonical hash (${expectedHash}). Fail closed.`,
      verifiedAt
    };
  }

  // Rule I: Returned verification decision is valid
  const contractStatus = String(contractOutput.status || '');
  if (contractStatus !== 'ALLOW') {
    return {
      status: 'REJECT',
      decision: 'NOT_VERIFIED',
      inspectStatus: 'CONSENSUS_FINALIZED',
      transactionId,
      protocolStatus: 'FINALIZED',
      evidenceHash: expectedHash,
      proposalId,
      reason: String(contractOutput.reason || 'Proposal rejected by GenLayer validator consensus.'),
      verifiedAt,
      checks: contractOutput.checks as GenLayerRuleChecks | undefined
    };
  }

  // Rule J: All safety checks pass
  const requiredChecks: Array<keyof GenLayerRuleChecks> = [
    'payload_valid', 'math_consistent', 'direction_consistent', 'spread_permitted',
    'circuit_breaker_passed', 'market_state_permitted', 'non_zero_portfolio',
    'freshness_passed', 'balance_verified', 'price_verified', 'spread_verified',
    'market_state_verified', 'allocation_drift_valid', 'trade_direction_valid',
    'trade_amount_valid', 'risk_limits_passed'
  ];

  const checks = (contractOutput.checks || {}) as Record<string, unknown>;
  const missingOrFailedCheck = requiredChecks.find(key => checks[key] !== true);
  if (missingOrFailedCheck) {
    return {
      status: 'REJECT',
      decision: 'NOT_VERIFIED',
      inspectStatus: 'CONSENSUS_FINALIZED',
      transactionId,
      protocolStatus: 'FINALIZED',
      evidenceHash: expectedHash,
      proposalId,
      reason: `Rule J violation: Safety check "${missingOrFailedCheck}" failed or was not true. Fail closed.`,
      verifiedAt,
      checks: checks as unknown as GenLayerRuleChecks
    };
  }

  // All rules A through J satisfied
  return {
    status: 'ALLOW',
    decision: 'VERIFIED',
    inspectStatus: 'VERIFIED',
    transactionId,
    protocolStatus: 'FINALIZED',
    evidenceHash: expectedHash,
    proposalId,
    reason: String(contractOutput.reason || 'Proposal verified by GenLayer consensus.'),
    verifiedAt,
    checks: checks as unknown as GenLayerRuleChecks
  };
}

/**
 * GenLayerVerificationAdapter
 * Independent verification adapter bridging StockPilot's deterministic engine with GenLayer consensus.
 */
export class GenLayerVerificationAdapter implements IVerificationAdapter {
  private readonly rpcUrl: string;
  private readonly verifierContractAddress: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly client: any;
  private readonly auditTrail: GenLayerVerificationAuditRecord[] = [];

  constructor(config?: GenLayerAdapterConfig) {
    this.rpcUrl = config?.rpcUrl || process.env.GENLAYER_RPC_URL || 'https://studio.genlayer.com/api';
    this.verifierContractAddress = config?.verifierContractAddress !== undefined
      ? config.verifierContractAddress
      : (process.env.GENLAYER_VERIFIER_CONTRACT || '0x801A94870ecADe3Aedd0f8D070498Ad954b63841');
    this.timeoutMs = config?.timeoutMs ?? 25000;
    this.pollIntervalMs = config?.pollIntervalMs ?? 1000;

    if (config?.client) {
      this.client = config.client;
    } else {
      const privateKey = config?.privateKey || (process.env.GENLAYER_PRIVATE_KEY as `0x${string}`) || generatePrivateKey();
      const account = createAccount(privateKey);
      this.client = createClient({
        chain: {
          ...studionet,
          rpcUrls: {
            default: {
              http: [this.rpcUrl]
            }
          }
        },
        endpoint: this.rpcUrl,
        account
      });
    }
  }

  public getAuditTrail(): GenLayerVerificationAuditRecord[] {
    return [...this.auditTrail];
  }

  /**
   * Submits a write transaction to the GenLayer network to verify the proposal.
   * Produces a real GenLayer transaction ID.
   */
  public async submitVerificationProposal(
    canonicalPayload: CanonicalEvidencePayload,
    evidenceHash: string
  ): Promise<{ transactionId: string }> {
    const contractAddress = this.verifierContractAddress.trim() as `0x${string}`;
    if (!contractAddress || contractAddress === '0x0000000000000000000000000000000000000000') {
      throw new Error('GenLayer verifier contract address is missing or zero address.');
    }

    const canonicalJson = canonicalizeJson(canonicalPayload);
    const txHash = await this.client.writeContract({
      address: contractAddress,
      functionName: 'verify_proposal',
      args: [canonicalJson, evidenceHash],
      value: 0n
    });

    return { transactionId: txHash };
  }

  /**
   * Queries protocol transaction data by transaction ID.
   */
  public async queryProtocolTransaction(txId: string): Promise<any> {
    return await this.client.getTransaction({ hash: txId as `0x${string}` });
  }

  /**
   * Submits evidence packet to verification layer, awaits consensus finalization, and verifies lifecycle.
   */
  public async verifyProposal(
    evidence: VerificationEvidence | GenLayerVerificationInput,
    options?: {
      transactionId?: string;
      maxWaitMs?: number;
      pollIntervalMs?: number;
    }
  ): Promise<VerificationResult> {
    const verifiedAt = Date.now();

    // 1. Normalize input
    const verificationInput = 'balances' in evidence && 'marketData' in evidence
      ? evidence as GenLayerVerificationInput
      : this.normalizeLegacyEvidence(evidence as VerificationEvidence);

    // 2. Canonical payload & hash
    const canonicalPayload = buildCanonicalEvidencePayload(verificationInput);
    const evidenceHash = computeEvidenceHash(canonicalPayload);
    const proposalId = canonicalPayload.proposalId;

    // 3. Local pre-verification validation
    const localValidation = validateEvidencePayload(canonicalPayload);
    if (!localValidation.valid) {
      const rejectResult: VerificationResult = {
        status: 'REJECT',
        decision: 'NOT_VERIFIED',
        inspectStatus: 'EVIDENCE_INVALID',
        evidenceHash,
        proposalId,
        reason: `Pre-verification gate rejected proposal: ${localValidation.reason}`,
        verifiedAt,
        checks: this.buildFailedChecks()
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
        inspectStatus: 'SUBMISSION_FAILED',
        evidenceHash,
        proposalId,
        reason: 'GenLayer verification unconfigured: GENLAYER_VERIFIER_CONTRACT is missing or zero address. Fail closed.',
        verifiedAt
      };
      this.recordAudit(unconfiguredResult, canonicalPayload);
      return unconfiguredResult;
    }

    // 5. Submit write transaction or use existing transactionId
    let txId = options?.transactionId;
    if (!txId) {
      try {
        const submitRes = await this.submitVerificationProposal(canonicalPayload, evidenceHash);
        txId = submitRes.transactionId;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const failResult: VerificationResult = {
          status: 'REJECT',
          decision: 'NOT_VERIFIED',
          inspectStatus: 'SUBMISSION_FAILED',
          evidenceHash,
          proposalId,
          reason: `GenLayer write transaction submission failed: ${msg}. Fail closed.`,
          verifiedAt
        };
        this.recordAudit(failResult, canonicalPayload);
        return failResult;
      }
    }

    // 6. Query and poll protocol transaction status
    const maxWaitMs = options?.maxWaitMs ?? this.timeoutMs;
    const pollIntervalMs = options?.pollIntervalMs ?? this.pollIntervalMs;
    const startTime = Date.now();

    let latestTx: any = null;
    while (Date.now() - startTime <= maxWaitMs) {
      try {
        latestTx = await this.queryProtocolTransaction(txId);
        if (latestTx) {
          const rawStatus = latestTx.status;
          const statusName = String(latestTx.statusName || latestTx.status_name || '');
          const isFinalized = rawStatus === 7 || statusName === 'FINALIZED';
          if (isFinalized) {
            break;
          }
        }
      } catch {
        // keep polling
      }
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    if (!latestTx) {
      const timeoutResult: VerificationResult = {
        status: 'REJECT',
        decision: 'NOT_VERIFIED',
        inspectStatus: 'CONSENSUS_PENDING',
        transactionId: txId,
        protocolStatus: 'PENDING',
        evidenceHash,
        proposalId,
        reason: `Timed out querying protocol transaction ${txId}. Fail closed.`,
        verifiedAt
      };
      this.recordAudit(timeoutResult, canonicalPayload);
      return timeoutResult;
    }

    // 7. Authoritative protocol evaluation
    const evaluation = evaluateProtocolTransaction(latestTx, canonicalPayload, evidenceHash, this.verifierContractAddress);
    this.recordAudit(evaluation, canonicalPayload);
    return evaluation;
  }

  /**
   * Simulation / Dry-run inspection using gen_call or simulateWriteContract.
   * Explicitly NOT authoritative proof of consensus finalization.
   */
  public async simulateProposal(
    evidence: VerificationEvidence | GenLayerVerificationInput
  ): Promise<VerificationResult> {
    const verifiedAt = Date.now();
    const verificationInput = 'balances' in evidence && 'marketData' in evidence
      ? evidence as GenLayerVerificationInput
      : this.normalizeLegacyEvidence(evidence as VerificationEvidence);

    const canonicalPayload = buildCanonicalEvidencePayload(verificationInput);
    const evidenceHash = computeEvidenceHash(canonicalPayload);
    const proposalId = canonicalPayload.proposalId;

    const localValidation = validateEvidencePayload(canonicalPayload);
    if (!localValidation.valid) {
      return {
        status: 'REJECT',
        decision: 'NOT_VERIFIED',
        inspectStatus: 'EVIDENCE_INVALID',
        evidenceHash,
        proposalId,
        reason: `Simulation pre-check rejected: ${localValidation.reason}`,
        verifiedAt,
        checks: this.buildFailedChecks()
      };
    }

    try {
      const canonicalJson = canonicalizeJson(canonicalPayload);
      const simRes = await this.client.simulateWriteContract({
        address: this.verifierContractAddress as `0x${string}`,
        functionName: 'verify_proposal',
        args: [canonicalJson, evidenceHash]
      });

      const parsed = parseLeaderReceiptResult(simRes);
      const status = parsed?.status === 'ALLOW' ? 'ALLOW' : 'REJECT';
      return {
        status,
        decision: 'NOT_VERIFIED', // NEVER mark verified from simulation
        inspectStatus: 'CONSENSUS_ACCEPTED_NOT_FINAL',
        evidenceHash,
        proposalId,
        reason: `Simulation inspection only: gen_call simulation is not consensus-finalized. Real write required.`,
        verifiedAt,
        checks: (parsed?.checks as GenLayerRuleChecks) || this.buildFailedChecks()
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'REJECT',
        decision: 'NOT_VERIFIED',
        inspectStatus: 'SUBMISSION_FAILED',
        evidenceHash,
        proposalId,
        reason: `Simulation execution failed: ${msg}. Fail closed.`,
        verifiedAt
      };
    }
  }

  /**
   * Structured response comparator for backwards compatibility.
   * Does NOT treat contract return values as protocol proof of finalization.
   */
  public evaluateContractResponse(
    rawResult: unknown,
    expectedHash: string,
    proposalId: string
  ): VerificationResult {
    const verifiedAt = Date.now();

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

  private normalizeLegacyEvidence(legacy: VerificationEvidence): GenLayerVerificationInput {
    return {
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

  private buildFailedChecks(): GenLayerRuleChecks {
    return {
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
    };
  }

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
      rpcUrl: this.rpcUrl,
      transactionId: result.transactionId,
      protocolStatus: result.protocolStatus,
      inspectStatus: result.inspectStatus
    };
    this.auditTrail.push(record);
  }
}
