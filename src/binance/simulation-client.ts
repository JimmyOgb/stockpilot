/**
 * StockPilot — Typed Binance Web3 Transaction Preflight & Simulation Client
 *
 * Implements the deterministic transaction preflight & simulation layer:
 * - Sequential Gating: REAL TELEMETRY -> DETERMINISTIC STRATEGY -> GENLAYER VERIFICATION -> BINANCE TRANSACTION SIMULATION -> AGENTIC WALLET EXECUTION
 * - Enforces GenLayer verification boundary: Accepts ONLY proposals that have already passed GenLayer verification.
 * - Zero Mock Policy: Validates against official Binance Web3 API schema with zero fake/mocked values in runtime.
 * - Read-Only Preflight: NEVER signs, broadcasts, executes trades, or moves funds.
 * - Defensive fail-closed error handling for:
 *   * Unverified proposals
 *   * Hash or proposal ID mismatches
 *   * Market closed, paused, or halted states
 *   * Stale price quotes
 *   * Spread risk breaches & circuit breakers
 *   * Invalid or zero-address wallets
 *   * Non-positive trade amounts
 *   * Transaction reverts with revert reasons
 *   * Missing or invalid gas/fee data
 *   * API risk blocks (KYT) and rate limits
 * - Immutable SHA-256 audit logging of every preflight simulation evaluation.
 *
 * Official Binance Web3 Transaction API endpoints:
 * - POST /build/api/v1/dex/pre-transaction/simulate
 * - GET  /build/api/v1/dex/pre-transaction/gas-price
 * - GET  /build/api/v1/dex/pre-transaction/supported/chain
 */

import { createHash, randomUUID } from 'node:crypto';
import { BinanceRequestSigner } from './request-signer.js';
import { isValidEvmAddress, ZERO_ADDRESS } from './wallet-balance-client.js';
import { computeEvidenceHash } from '../verification/genlayer-adapter.js';
import {
  SimulationStatus,
  SimulationDecision,
  BinanceSimulationRequest,
  SimulationPreflightInput,
  BinanceSimulationResult,
  BinanceSimulationAuditRecord
} from '../types/index.js';

export interface BinanceSimulationClientConfig {
  signer: BinanceRequestSigner;
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class BinanceSimulationClient {
  private readonly signer: BinanceRequestSigner;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly auditTrail: BinanceSimulationAuditRecord[] = [];

  constructor(config: BinanceSimulationClientConfig) {
    if (!config || !config.signer) {
      throw new Error('BinanceSimulationClient requires a valid BinanceRequestSigner instance.');
    }
    this.signer = config.signer;
    const rawBase = (config.baseUrl ?? 'https://web3.binance.com/build').replace(/\/+$/, '');
    this.baseUrl = rawBase.endsWith('/build') ? rawBase : `${rawBase}/build`;
    this.timeoutMs = config.timeoutMs ?? 10000;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  /**
   * Returns an immutable copy of the preflight simulation audit records.
   */
  public getAuditTrail(): readonly BinanceSimulationAuditRecord[] {
    return Object.freeze([...this.auditTrail]);
  }

  /**
   * Clears the in-memory audit trail (primarily for test teardown).
   */
  public clearAuditTrail(): void {
    this.auditTrail.length = 0;
  }

  /**
   * Queries the current recommended gas price from the Binance Web3 Transaction API.
   * Endpoint: GET /build/api/v1/dex/pre-transaction/gas-price?binanceChainId=56
   */
  public async getGasPrice(binanceChainId = '56'): Promise<{
    gasPriceWei: string;
    gasPriceGwei: number;
    raw: Record<string, unknown>;
  } | null> {
    try {
      const endpointPath = '/api/v1/dex/pre-transaction/gas-price';
      const requestPath = `/build${endpointPath}`;
      const queryParams = { binanceChainId };
      const queryString = this.signer.canonicalizeQueryParams(queryParams);
      const fullUrl = `${this.baseUrl}${endpointPath}?${queryString}`;

      const headers = this.signer.signRequest({
        method: 'GET',
        requestPath,
        queryParams,
        recvWindow: 60000
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchFn(fullUrl, {
          method: 'GET',
          headers: {
            ...headers,
            Accept: 'application/json'
          },
          signal: controller.signal
        });

        if (!response.ok) {
          return null;
        }

        const json = (await response.json()) as Record<string, any>;
        if (json && typeof json === 'object' && json.code === 0 && json.data) {
          const rawPrice = json.data.gasPrice ?? json.data.standard ?? json.data.fast;
          if (rawPrice !== undefined && rawPrice !== null) {
            const priceStr = String(rawPrice).trim();
            const numericWei = Number(priceStr);
            if (Number.isFinite(numericWei) && numericWei > 0) {
              return {
                gasPriceWei: priceStr,
                gasPriceGwei: numericWei / 1e9,
                raw: json.data as Record<string, unknown>
              };
            }
          }
        }
        return null;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;
    }
  }

  /**
   * Executes a preflight transaction simulation for an already verified deterministic proposal.
   *
   * Sequential Gating Rules:
   * 1. Proposal MUST have decision === 'VERIFIED' and status === 'ALLOW' from GenLayer.
   * 2. Proposal action MUST NOT be 'NONE'.
   * 3. Evidence hash in verification result MUST match re-computed SHA-256 hash of canonical payload.
   * 4. Proposal IDs MUST match.
   * 5. Market state MUST be 'OPEN'.
   * 6. Price quote MUST NOT be stale (age <= maxAllowedQuoteAgeSeconds, default 60s).
   * 7. Spread MUST NOT exceed maxSpreadBps.
   * 8. Wallet address MUST be a valid, non-zero EVM address.
   * 9. Trade amounts MUST be positive numbers.
   * 10. Simulation on Binance Web3 API MUST succeed without revert or risk block.
   * 11. Gas & fee data MUST be present and valid.
   */
  public async simulatePreflight(input: SimulationPreflightInput): Promise<BinanceSimulationResult> {
    const now = Date.now();
    const { verificationResult, canonicalPayload, walletAddress } = input;
    const maxQuoteAge = input.maxAllowedQuoteAgeSeconds ?? 60;
    const proposalId = canonicalPayload?.proposalId ?? verificationResult?.proposalId ?? 'UNKNOWN';

    // -----------------------------------------------------------------------
    // GATE 1: GenLayer Verification Check
    // -----------------------------------------------------------------------
    if (!verificationResult) {
      return this.recordFailure({
        proposalId,
        evidenceHash: 'UNKNOWN',
        decision: 'SIMULATION_FAILED',
        status: 'UNVERIFIED_PROPOSAL',
        reason: 'Preflight simulation rejected: verification result is missing.',
        simulatedAt: now
      });
    }

    if (verificationResult.decision !== 'VERIFIED' || verificationResult.status !== 'ALLOW') {
      return this.recordFailure({
        proposalId,
        evidenceHash: verificationResult.evidenceHash || 'UNKNOWN',
        decision: 'SIMULATION_FAILED',
        status: 'UNVERIFIED_PROPOSAL',
        reason: `Preflight simulation rejected: proposal has not passed GenLayer verification (decision: ${verificationResult.decision}, status: ${verificationResult.status}).`,
        simulatedAt: now
      });
    }

    // -----------------------------------------------------------------------
    // GATE 2: Canonical Payload & Proposal Existence
    // -----------------------------------------------------------------------
    if (!canonicalPayload) {
      return this.recordFailure({
        proposalId,
        evidenceHash: verificationResult.evidenceHash,
        decision: 'SIMULATION_FAILED',
        status: 'UNVERIFIED_PROPOSAL',
        reason: 'Preflight simulation rejected: canonical evidence payload is missing.',
        simulatedAt: now
      });
    }

    // -----------------------------------------------------------------------
    // GATE 3: Action Check (NO_ACTION does not simulate)
    // -----------------------------------------------------------------------
    if (canonicalPayload.proposedAction === 'NONE') {
      return this.recordFailure({
        proposalId: canonicalPayload.proposalId,
        evidenceHash: verificationResult.evidenceHash,
        decision: 'SIMULATION_FAILED',
        status: 'NO_ACTION_PROPOSAL',
        reason: 'Preflight simulation skipped: proposed action is NONE. No transaction needed.',
        simulatedAt: now
      });
    }

    // -----------------------------------------------------------------------
    // GATE 4: Cryptographic Hash Verification
    // -----------------------------------------------------------------------
    let computedHash: string;
    try {
      computedHash = computeEvidenceHash(canonicalPayload);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return this.recordFailure({
        proposalId: canonicalPayload.proposalId,
        evidenceHash: verificationResult.evidenceHash,
        decision: 'SIMULATION_FAILED',
        status: 'HASH_MISMATCH',
        reason: `Evidence hash computation failed: ${errMsg}`,
        simulatedAt: now
      });
    }

    if (computedHash.toLowerCase() !== verificationResult.evidenceHash.toLowerCase()) {
      return this.recordFailure({
        proposalId: canonicalPayload.proposalId,
        evidenceHash: verificationResult.evidenceHash,
        decision: 'SIMULATION_FAILED',
        status: 'HASH_MISMATCH',
        reason: `Cryptographic tamper detection: verification evidence hash (${verificationResult.evidenceHash}) does not match computed payload hash (${computedHash}).`,
        simulatedAt: now
      });
    }

    // -----------------------------------------------------------------------
    // GATE 5: Proposal ID Consistency Check
    // -----------------------------------------------------------------------
    if (
      verificationResult.proposalId &&
      verificationResult.proposalId !== canonicalPayload.proposalId
    ) {
      return this.recordFailure({
        proposalId: canonicalPayload.proposalId,
        evidenceHash: computedHash,
        decision: 'SIMULATION_FAILED',
        status: 'ID_MISMATCH',
        reason: `Proposal ID mismatch: verification result ID (${verificationResult.proposalId}) does not match payload ID (${canonicalPayload.proposalId}).`,
        simulatedAt: now
      });
    }

    // -----------------------------------------------------------------------
    // GATE 6: Market Status Check
    // -----------------------------------------------------------------------
    if (canonicalPayload.marketState !== 'MARKET_OPEN') {
      return this.recordFailure({
        proposalId: canonicalPayload.proposalId,
        evidenceHash: computedHash,
        decision: 'SIMULATION_FAILED',
        status: 'MARKET_CLOSED',
        reason: `Market state is ${canonicalPayload.marketState}. Simulation and trading are prohibited outside of active market sessions.`,
        simulatedAt: now
      });
    }

    // -----------------------------------------------------------------------
    // GATE 7: Quote Freshness Check
    // -----------------------------------------------------------------------
    if (
      typeof canonicalPayload.quoteAgeSeconds !== 'number' ||
      !Number.isFinite(canonicalPayload.quoteAgeSeconds) ||
      canonicalPayload.quoteAgeSeconds > maxQuoteAge
    ) {
      return this.recordFailure({
        proposalId: canonicalPayload.proposalId,
        evidenceHash: computedHash,
        decision: 'SIMULATION_FAILED',
        status: 'STALE_QUOTE',
        reason: `Telemetry quote is stale (${canonicalPayload.quoteAgeSeconds}s old > max allowed ${maxQuoteAge}s). Preflight simulation aborted.`,
        simulatedAt: now
      });
    }

    // -----------------------------------------------------------------------
    // GATE 8: Spread Risk Check
    // -----------------------------------------------------------------------
    if (
      canonicalPayload.spreadBps !== null &&
      canonicalPayload.spreadBps !== undefined &&
      canonicalPayload.spreadBps > canonicalPayload.maxSpreadBps
    ) {
      return this.recordFailure({
        proposalId: canonicalPayload.proposalId,
        evidenceHash: computedHash,
        decision: 'SIMULATION_FAILED',
        status: 'SPREAD_RISK_BREACH',
        reason: `Spread risk breach: observed spread (${canonicalPayload.spreadBps} bps) exceeds maximum allowed spread (${canonicalPayload.maxSpreadBps} bps).`,
        simulatedAt: now
      });
    }

    // -----------------------------------------------------------------------
    // GATE 9: Wallet Address Validation (Zero-Address & Format)
    // -----------------------------------------------------------------------
    if (!walletAddress || !isValidEvmAddress(walletAddress, { allowZeroAddress: false })) {
      const isZero = walletAddress?.toLowerCase() === ZERO_ADDRESS.toLowerCase();
      return this.recordFailure({
        proposalId: canonicalPayload.proposalId,
        evidenceHash: computedHash,
        decision: 'SIMULATION_FAILED',
        status: 'INVALID_WALLET',
        reason: isZero
          ? 'Simulation rejected: wallet address is the zero address (0x000...000).'
          : `Simulation rejected: invalid EVM wallet address format ("${walletAddress}").`,
        simulatedAt: now
      });
    }

    // -----------------------------------------------------------------------
    // GATE 10: Trade Amount Validity Check
    // -----------------------------------------------------------------------
    if (
      !Number.isFinite(canonicalPayload.proposedTradeAmountUsd) ||
      canonicalPayload.proposedTradeAmountUsd <= 0 ||
      !Number.isFinite(canonicalPayload.proposedApproxTokenAmount) ||
      canonicalPayload.proposedApproxTokenAmount <= 0
    ) {
      return this.recordFailure({
        proposalId: canonicalPayload.proposalId,
        evidenceHash: computedHash,
        decision: 'SIMULATION_FAILED',
        status: 'INVALID_TRADE_AMOUNT',
        reason: `Proposed trade amounts are non-positive or non-finite (USD: ${canonicalPayload.proposedTradeAmountUsd}, tokens: ${canonicalPayload.proposedApproxTokenAmount}).`,
        simulatedAt: now
      });
    }

    // -----------------------------------------------------------------------
    // CONSTRUCT DETERMINISTIC SIMULATION REQUEST
    // -----------------------------------------------------------------------
    const targetAddress =
      canonicalPayload.proposedAction === 'BUY_STOCK'
        ? canonicalPayload.stableContractAddress
        : canonicalPayload.stockContractAddress;

    const simulationRequest: BinanceSimulationRequest = {
      binanceChainId: input.customTx?.binanceChainId ?? '56',
      fromAddress: input.customTx?.fromAddress ?? walletAddress,
      toAddress: input.customTx?.toAddress ?? targetAddress,
      calldata: input.customTx?.calldata ?? '0x',
      value: input.customTx?.value ?? '0',
      gasLimit: input.customTx?.gasLimit ?? '300000',
      gasPrice: input.customTx?.gasPrice
    };

    // -----------------------------------------------------------------------
    // DISPATCH TO OFFICIAL BINANCE WEB3 TRANSACTION SIMULATION API
    // Endpoint: POST /build/api/v1/dex/pre-transaction/simulate
    // -----------------------------------------------------------------------
    const endpointPath = '/api/v1/dex/pre-transaction/simulate';
    const requestPath = `/build${endpointPath}`;
    const fullUrl = `${this.baseUrl}${endpointPath}`;

    const requestBody = {
      binanceChainId: simulationRequest.binanceChainId,
      address: simulationRequest.fromAddress,
      from: simulationRequest.fromAddress,
      to: simulationRequest.toAddress,
      data: simulationRequest.calldata || '0x',
      value: simulationRequest.value || '0',
      ...(simulationRequest.gasLimit ? { gasLimit: simulationRequest.gasLimit } : {}),
      ...(simulationRequest.gasPrice ? { gasPrice: simulationRequest.gasPrice } : {})
    };

    const bodyString = JSON.stringify(requestBody);

    const headers = this.signer.signRequest({
      method: 'POST',
      requestPath,
      body: bodyString,
      recvWindow: 60000
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let httpStatus = 0;
    let rawResponse: Record<string, unknown> | null = null;

    try {
      const response = await this.fetchFn(fullUrl, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: bodyString,
        signal: controller.signal
      });

      httpStatus = response.status;
      rawResponse = (await response.json()) as Record<string, unknown>;
    } catch (err: unknown) {
      clearTimeout(timer);
      const isAbort = (err as { name?: string })?.name === 'AbortError';
      const errMsg = err instanceof Error ? err.message : String(err);
      return this.recordFailure({
        proposalId: canonicalPayload.proposalId,
        evidenceHash: computedHash,
        decision: 'SIMULATION_FAILED',
        status: 'NETWORK_ERROR',
        reason: isAbort
          ? `Binance Web3 simulation request timed out after ${this.timeoutMs}ms.`
          : `Binance Web3 simulation network error: ${errMsg}`,
        simulatedAt: now,
        rawResponse
      });
    } finally {
      clearTimeout(timer);
    }

    // -----------------------------------------------------------------------
    // DEFENSIVE RESPONSE PARSING & VALIDATION
    // -----------------------------------------------------------------------
    if (httpStatus !== 200 || !rawResponse) {
      return this.recordFailure({
        proposalId: canonicalPayload.proposalId,
        evidenceHash: computedHash,
        decision: 'SIMULATION_FAILED',
        status: 'SIMULATION_ERROR',
        reason: `Binance Web3 simulation returned non-200 HTTP status (${httpStatus}).`,
        simulatedAt: now,
        rawResponse
      });
    }

    const code = Number(rawResponse.code);
    const msg = String(rawResponse.msg ?? 'Unknown message');

    // Handle Binance error codes
    if (code !== 0) {
      // Risk / KYT codes: 40311, 40312, 40313, 40314, 40434
      if ([40311, 40312, 40313, 40314, 40434].includes(code)) {
        return this.recordFailure({
          proposalId: canonicalPayload.proposalId,
          evidenceHash: computedHash,
          decision: 'SIMULATION_FAILED',
          status: 'RISK_BLOCKED',
          reason: `Binance KYT / risk control blocked simulation [code ${code}]: ${msg}`,
          simulatedAt: now,
          rawResponse
        });
      }

      // Rate limit code: 42900
      if (code === 42900) {
        return this.recordFailure({
          proposalId: canonicalPayload.proposalId,
          evidenceHash: computedHash,
          decision: 'SIMULATION_FAILED',
          status: 'RATE_LIMITED',
          reason: `Binance Web3 rate limit exceeded [code ${code}]: ${msg}`,
          simulatedAt: now,
          rawResponse
        });
      }

      return this.recordFailure({
        proposalId: canonicalPayload.proposalId,
        evidenceHash: computedHash,
        decision: 'SIMULATION_FAILED',
        status: 'SIMULATION_ERROR',
        reason: `Binance Web3 simulation API error [code ${code}]: ${msg}`,
        simulatedAt: now,
        rawResponse
      });
    }

    // Parse simulation data
    const data = (rawResponse.data ?? {}) as Record<string, unknown>;

    // Check for simulation revert / failure status
    const simStatus = String(data.status ?? '').toUpperCase();
    const simCode = String(data.simulationCode ?? '');
    const revertReason =
      data.revertReason !== undefined && data.revertReason !== null
        ? String(data.revertReason)
        : null;
    const simErrorDetail =
      data.simulationErrorDetail !== undefined && data.simulationErrorDetail !== null
        ? String(data.simulationErrorDetail)
        : null;

    const isRevert =
      simStatus === 'REVERT' ||
      simStatus === 'FAILED' ||
      (simCode.length > 0 && simCode !== '000000000' && simCode !== '0') ||
      revertReason !== null;

    if (isRevert) {
      const explicitReason = revertReason || simErrorDetail || `Simulation failed with code: ${simCode || simStatus}`;
      return this.recordFailure({
        proposalId: canonicalPayload.proposalId,
        evidenceHash: computedHash,
        decision: 'SIMULATION_FAILED',
        status: 'REVERT',
        reason: `Transaction preflight reverted on-chain: ${explicitReason}`,
        revertReason: explicitReason,
        simulatedAt: now,
        rawResponse
      });
    }

    // Parse gas used
    let gasUsed: bigint | null = null;
    if (data.gasUsed !== undefined && data.gasUsed !== null) {
      try {
        const rawGas = String(data.gasUsed).trim();
        const parsed = BigInt(rawGas);
        if (parsed > 0n) {
          gasUsed = parsed;
        }
      } catch {
        gasUsed = null;
      }
    }

    // Parse gas limit
    let gasLimit: bigint | null = null;
    if (data.gasLimit !== undefined && data.gasLimit !== null) {
      try {
        const rawLimit = String(data.gasLimit).trim();
        const parsed = BigInt(rawLimit);
        if (parsed > 0n) {
          gasLimit = parsed;
        }
      } catch {
        gasLimit = null;
      }
    }

    // Parse gas price
    let gasPriceGwei: number | null = null;
    let gasPriceWei = 0;
    if (data.gasPrice !== undefined && data.gasPrice !== null) {
      const parsed = Number(String(data.gasPrice).trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        gasPriceWei = parsed;
        gasPriceGwei = parsed / 1e9;
      }
    }

    // Fail closed if gas data is completely missing or non-positive
    if (gasUsed === null || gasUsed <= 0n) {
      return this.recordFailure({
        proposalId: canonicalPayload.proposalId,
        evidenceHash: computedHash,
        decision: 'SIMULATION_FAILED',
        status: 'MISSING_FEE_DATA',
        reason: 'Simulation succeeded but response lacks valid gasUsed telemetry.',
        simulatedAt: now,
        rawResponse
      });
    }

    // Calculate estimated fees
    let estimatedFeeBnb: number | null = null;
    if (data.estimatedFee !== undefined && data.estimatedFee !== null) {
      const feeNum = Number(String(data.estimatedFee).trim());
      if (Number.isFinite(feeNum) && feeNum > 0) {
        estimatedFeeBnb = feeNum;
      }
    }

    if (estimatedFeeBnb === null && gasPriceWei > 0 && gasUsed > 0n) {
      estimatedFeeBnb = (Number(gasUsed) * gasPriceWei) / 1e18;
    }

    // Build canonical simulation record for SHA-256 hashing
    const canonicalRecord = {
      proposalId: canonicalPayload.proposalId,
      evidenceHash: computedHash,
      binanceChainId: simulationRequest.binanceChainId,
      fromAddress: simulationRequest.fromAddress,
      toAddress: simulationRequest.toAddress,
      gasUsed: gasUsed.toString(),
      gasPriceGwei,
      estimatedFeeBnb,
      simulatedAt: now,
      decision: 'SIMULATED_OK' as SimulationDecision,
      status: 'SUCCESS' as SimulationStatus
    };

    const simulationHash =
      '0x' + createHash('sha256').update(JSON.stringify(canonicalRecord)).digest('hex');

    // Record successful audit trail entry
    const auditRecord: BinanceSimulationAuditRecord = {
      auditId: `sim-audit-${randomUUID()}`,
      proposalId: canonicalPayload.proposalId,
      evidenceHash: computedHash,
      simulationHash,
      decision: 'SIMULATED_OK',
      status: 'SUCCESS',
      gasUsed: gasUsed.toString(),
      gasPriceGwei,
      estimatedFeeBnb: estimatedFeeBnb !== null ? estimatedFeeBnb.toFixed(8) : null,
      simulatedAt: now,
      reason: 'Transaction preflight simulation succeeded with valid gas and fee parameters.'
    };
    this.auditTrail.push(auditRecord);

    return {
      decision: 'SIMULATED_OK',
      status: 'SUCCESS',
      simulationHash,
      proposalId: canonicalPayload.proposalId,
      evidenceHash: computedHash,
      gasUsed,
      gasLimit,
      gasPriceGwei,
      estimatedFeeBnb,
      estimatedFeeUsd: null,
      revertReason: null,
      rawResponse,
      simulatedAt: now,
      reason: 'Transaction preflight simulation succeeded with valid gas and fee parameters.'
    };
  }

  /**
   * Records a failed simulation outcome and creates an immutable audit trail entry.
   */
  private recordFailure(params: {
    proposalId: string;
    evidenceHash: string;
    decision: SimulationDecision;
    status: SimulationStatus;
    reason: string;
    simulatedAt: number;
    revertReason?: string | null;
    rawResponse?: Record<string, unknown> | null;
  }): BinanceSimulationResult {
    const canonicalFailRecord = {
      proposalId: params.proposalId,
      evidenceHash: params.evidenceHash,
      decision: params.decision,
      status: params.status,
      reason: params.reason,
      simulatedAt: params.simulatedAt
    };

    const simulationHash =
      '0x' + createHash('sha256').update(JSON.stringify(canonicalFailRecord)).digest('hex');

    const auditRecord: BinanceSimulationAuditRecord = {
      auditId: `sim-audit-${randomUUID()}`,
      proposalId: params.proposalId,
      evidenceHash: params.evidenceHash,
      simulationHash,
      decision: params.decision,
      status: params.status,
      gasUsed: null,
      gasPriceGwei: null,
      estimatedFeeBnb: null,
      simulatedAt: params.simulatedAt,
      reason: params.reason
    };
    this.auditTrail.push(auditRecord);

    return {
      decision: params.decision,
      status: params.status,
      simulationHash,
      proposalId: params.proposalId,
      evidenceHash: params.evidenceHash,
      gasUsed: null,
      gasLimit: null,
      gasPriceGwei: null,
      estimatedFeeBnb: null,
      estimatedFeeUsd: null,
      revertReason: params.revertReason ?? null,
      rawResponse: params.rawResponse ?? null,
      simulatedAt: params.simulatedAt,
      reason: params.reason
    };
  }
}
