/**
 * StockPilot — Agentic Wallet Live Execution Adapter
 *
 * Implements the final execution boundary using the official Binance Agentic Wallet:
 * - Accepts ONLY proposals that have passed GenLayer verification AND Binance simulation
 * - Enforces 14+ hard pre-execution validation gates
 * - Enforces Binance Agentic Wallet policy checks (spending limits, token allowlists, tx-lock)
 * - Enforces zero live balance guard (EXECUTION_BLOCKED_INSUFFICIENT_LIVE_BALANCE)
 * - Enforces tiny live execution cap for safe initial testing
 * - Enforces explicit user approval boundary (no autonomous live trading without user authorization)
 * - Strictly SPOT ONLY (no perpetuals, leverage, or margin)
 * - Protects against duplicate execution using SHA-256 idempotency keys
 * - Polls market orders to terminal states and confirms BSC on-chain transaction receipts
 * - Distinguishes 7 explicit execution states (fail-closed, never converts uncertainty to success)
 * - Records immutable audit trails with zero credential exposure
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  ExecutionState,
  ExecutionBlockReason,
  ExecutionReceipt,
  ExecutionAuditRecord,
  ExecutionPreflightInput,
  UserApprovalRequest,
  UserApprovalDecision,
  BscTransactionReceipt,
  StrategyConfig,
  RebalanceAction,
  CanonicalEvidencePayload,
  VerificationResult,
  BinanceSimulationResult
} from '../types/index.js';
import { IExecutionAdapter } from './adapter.js';
import { IBinanceAgenticWalletClient } from './binance-agentic-wallet-client.js';
import { IAuditStore } from '../storage/audit-log.js';
import { isValidEvmAddress } from '../binance/wallet-balance-client.js';
import { computeEvidenceHash } from '../verification/genlayer-adapter.js';

export interface AgenticExecutionAdapterConfig {
  walletClient: IBinanceAgenticWalletClient;
  auditStore?: IAuditStore;
  allowLiveExecution?: boolean;         // Default false (fail-closed: intentional block)
  tinyExecutionCapUsd?: number;        // Default $25.00 for initial tiny live transactions
  maxAllowedQuoteAgeSeconds?: number;  // Default 900s
  maxPollingAttempts?: number;         // Default 15 attempts
  pollingIntervalMs?: number;          // Default 2000ms
  requireUserApproval?: boolean;       // Default true
}

export interface GateEvaluationResult {
  canProceed: boolean;
  state: ExecutionState;
  blockReason?: ExecutionBlockReason | string;
  errorMessage?: string;
  idempotencyKey: string;
}

export class AgenticExecutionAdapter implements IExecutionAdapter {
  private readonly walletClient: IBinanceAgenticWalletClient;
  private readonly auditStore?: IAuditStore;
  private readonly allowLiveExecution: boolean;
  private readonly tinyExecutionCapUsd: number;
  private readonly maxAllowedQuoteAgeSeconds: number;
  private readonly maxPollingAttempts: number;
  private readonly pollingIntervalMs: number;
  private readonly requireUserApproval: boolean;

  // In-memory idempotency register to prevent concurrent or repeated execution of identical proposals
  private readonly executedIdempotencyKeys = new Set<string>();

  constructor(config: AgenticExecutionAdapterConfig) {
    if (!config || !config.walletClient) {
      throw new Error('[AgenticExecutionAdapter] Requires an IBinanceAgenticWalletClient instance.');
    }
    this.walletClient = config.walletClient;
    this.auditStore = config.auditStore;
    this.allowLiveExecution = config.allowLiveExecution ?? false;
    this.tinyExecutionCapUsd = config.tinyExecutionCapUsd ?? 25.0; // Deliberately tiny live cap
    this.maxAllowedQuoteAgeSeconds = config.maxAllowedQuoteAgeSeconds ?? 900;
    this.maxPollingAttempts = config.maxPollingAttempts ?? 15;
    this.pollingIntervalMs = config.pollingIntervalMs ?? 2000;
    this.requireUserApproval = config.requireUserApproval ?? true;
  }

  /**
   * Clears the in-memory idempotency register (for testing).
   */
  public clearIdempotencyKeys(): void {
    this.executedIdempotencyKeys.clear();
  }

  /**
   * Derives a deterministic cryptographic idempotency key from proposal, verification, simulation, and wallet identity.
   */
  public computeIdempotencyKey(
    proposalId: string,
    evidenceHash: string,
    simulationHash: string,
    walletAddress: string
  ): string {
    const raw = `${proposalId}:${evidenceHash}:${simulationHash}:${walletAddress.toLowerCase()}`;
    return createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Prepares a structured user approval request for display to the user before live trading.
   */
  public buildUserApprovalRequest(input: ExecutionPreflightInput): UserApprovalRequest {
    const { canonicalPayload, verificationResult, simulationResult, walletAddress } = input;
    const idempotencyKey = this.computeIdempotencyKey(
      canonicalPayload.proposalId,
      verificationResult.evidenceHash,
      simulationResult.simulationHash,
      walletAddress
    );

    const isBuy = canonicalPayload.proposedAction === 'BUY_STOCK';
    const fromTokenAddress = isBuy ? canonicalPayload.stableContractAddress : canonicalPayload.stockContractAddress;
    const toTokenAddress = isBuy ? canonicalPayload.stockContractAddress : canonicalPayload.stableContractAddress;

    return {
      proposalId: canonicalPayload.proposalId,
      strategyId: canonicalPayload.strategyId,
      action: canonicalPayload.proposedAction,
      sourceAsset: canonicalPayload.sourceAsset,
      targetAsset: canonicalPayload.targetAsset,
      fromTokenAddress,
      toTokenAddress,
      tradeAmountUsd: canonicalPayload.proposedTradeAmountUsd,
      approxTokenAmount: canonicalPayload.proposedApproxTokenAmount,
      slippageLimitBps: canonicalPayload.proposedSlippageLimitBps,
      marketPrice: canonicalPayload.stockTokenPrice,
      referencePrice: canonicalPayload.stockReferencePrice,
      spreadBps: canonicalPayload.spreadBps,
      evidenceHash: verificationResult.evidenceHash,
      simulationHash: simulationResult.simulationHash,
      estimatedFeeBnb: simulationResult.estimatedFeeBnb,
      walletAddress,
      idempotencyKey,
      isTinyLiveCapEnforced: canonicalPayload.proposedTradeAmountUsd <= this.tinyExecutionCapUsd,
      requestedAt: Date.now()
    };
  }

  /**
   * Evaluates all pre-execution hard gates and Agentic Wallet policies.
   */
  public async evaluatePreExecutionGates(input: ExecutionPreflightInput): Promise<GateEvaluationResult> {
    const { strategy, canonicalPayload, verificationResult, simulationResult, walletAddress } = input;
    const maxQuoteAge = input.options?.maxAllowedQuoteAgeSeconds ?? this.maxAllowedQuoteAgeSeconds;
    const tinyCap = input.options?.tinyExecutionCapUsd ?? this.tinyExecutionCapUsd;

    // Default idempotency key calculation
    const propId = canonicalPayload?.proposalId ?? verificationResult?.proposalId ?? 'UNKNOWN';
    const evHash = verificationResult?.evidenceHash ?? 'UNKNOWN';
    const simHash = simulationResult?.simulationHash ?? 'UNKNOWN';
    const idempotencyKey = this.computeIdempotencyKey(propId, evHash, simHash, walletAddress || '0x0');

    // 1. Proposal Action Check (NONE action does not execute)
    if (!canonicalPayload || canonicalPayload.proposedAction === 'NONE') {
      return {
        canProceed: false,
        state: 'EXECUTION_BLOCKED',
        blockReason: 'EXECUTION_BLOCKED_FAIL_CLOSED',
        errorMessage: 'Execution blocked: proposed action is NONE. No trade required.',
        idempotencyKey
      };
    }

    // 2. GenLayer Verification Gate
    if (!verificationResult) {
      return {
        canProceed: false,
        state: 'EXECUTION_BLOCKED',
        blockReason: 'EXECUTION_BLOCKED_UNVERIFIED_PROPOSAL',
        errorMessage: 'Execution blocked: GenLayer verification result is missing.',
        idempotencyKey
      };
    }

    if (verificationResult.decision !== 'VERIFIED' || verificationResult.status !== 'ALLOW') {
      return {
        canProceed: false,
        state: 'EXECUTION_BLOCKED',
        blockReason: 'EXECUTION_BLOCKED_UNVERIFIED_PROPOSAL',
        errorMessage: `Execution blocked: proposal not verified by GenLayer (decision: ${verificationResult.decision}, status: ${verificationResult.status}).`,
        idempotencyKey
      };
    }

    // 3. Cryptographic Evidence Hash Integrity
    const recomputedEvidenceHash = computeEvidenceHash(canonicalPayload);
    if (verificationResult.evidenceHash !== recomputedEvidenceHash) {
      return {
        canProceed: false,
        state: 'EXECUTION_BLOCKED',
        blockReason: 'EXECUTION_BLOCKED_HASH_MISMATCH',
        errorMessage: `Execution blocked: canonical evidence hash mismatch. Recomputed: ${recomputedEvidenceHash}, Verification: ${verificationResult.evidenceHash}.`,
        idempotencyKey
      };
    }

    // 4. Proposal ID Integrity
    if (canonicalPayload.proposalId !== verificationResult.proposalId) {
      return {
        canProceed: false,
        state: 'EXECUTION_BLOCKED',
        blockReason: 'EXECUTION_BLOCKED_ID_MISMATCH',
        errorMessage: `Execution blocked: proposal ID mismatch between evidence (${canonicalPayload.proposalId}) and verification (${verificationResult.proposalId}).`,
        idempotencyKey
      };
    }

    // 5. Binance Simulation Check
    if (!simulationResult) {
      return {
        canProceed: false,
        state: 'EXECUTION_BLOCKED',
        blockReason: 'EXECUTION_BLOCKED_SIMULATION_FAILED',
        errorMessage: 'Execution blocked: Binance transaction simulation result is missing.',
        idempotencyKey
      };
    }

    if (simulationResult.decision !== 'SIMULATED_OK' || simulationResult.status !== 'SUCCESS') {
      return {
        canProceed: false,
        state: 'EXECUTION_BLOCKED',
        blockReason: 'EXECUTION_BLOCKED_SIMULATION_FAILED',
        errorMessage: `Execution blocked: Binance pre-transaction simulation failed (decision: ${simulationResult.decision}, status: ${simulationResult.status}, reason: ${simulationResult.reason}).`,
        idempotencyKey
      };
    }

    // 6. Simulation Hash & Identity Consistency
    if (simulationResult.proposalId !== canonicalPayload.proposalId || simulationResult.evidenceHash !== verificationResult.evidenceHash) {
      return {
        canProceed: false,
        state: 'EXECUTION_BLOCKED',
        blockReason: 'EXECUTION_BLOCKED_HASH_MISMATCH',
        errorMessage: 'Execution blocked: simulation identity does not match current proposal or evidence hash.',
        idempotencyKey
      };
    }

    // 7. Market State Check (Market must be OPEN for execution)
    if (canonicalPayload.marketState !== 'MARKET_OPEN') {
      return {
        canProceed: false,
        state: 'EXECUTION_BLOCKED',
        blockReason: 'EXECUTION_BLOCKED_MARKET_CLOSED',
        errorMessage: `Execution blocked: underlying market session is ${canonicalPayload.marketState}. Live execution requires MARKET_OPEN.`,
        idempotencyKey
      };
    }

    // 8. Quote Freshness Check
    if (canonicalPayload.quoteAgeSeconds > maxQuoteAge) {
      return {
        canProceed: false,
        state: 'EXECUTION_BLOCKED',
        blockReason: 'EXECUTION_BLOCKED_STALE_QUOTE',
        errorMessage: `Execution blocked: price quote is stale (${canonicalPayload.quoteAgeSeconds}s > allowed ${maxQuoteAge}s).`,
        idempotencyKey
      };
    }

    // 9. Spread Risk Check
    if (canonicalPayload.spreadBps === null || canonicalPayload.spreadBps > canonicalPayload.maxSpreadBps) {
      return {
        canProceed: false,
        state: 'EXECUTION_BLOCKED',
        blockReason: 'EXECUTION_BLOCKED_SPREAD_EXCESSIVE',
        errorMessage: `Execution blocked: price spread (${canonicalPayload.spreadBps} bps) exceeds maximum allowable limit (${canonicalPayload.maxSpreadBps} bps).`,
        idempotencyKey
      };
    }

    // 10. Strategy Circuit Breaker Check ($5,000 maximum single trade)
    if (canonicalPayload.proposedTradeAmountUsd <= 0 || canonicalPayload.proposedTradeAmountUsd > strategy.maxSingleTradeUsd) {
      return {
        canProceed: false,
        state: 'EXECUTION_BLOCKED',
        blockReason: 'EXECUTION_BLOCKED_CIRCUIT_BREAKER',
        errorMessage: `Execution blocked: proposed trade amount $${canonicalPayload.proposedTradeAmountUsd.toFixed(2)} breaches circuit breaker bound (0 < trade <= $${strategy.maxSingleTradeUsd}).`,
        idempotencyKey
      };
    }

    // 11. Tiny Live Execution Cap Check (Substantially lower than $5,000 for initial live milestone)
    if (canonicalPayload.proposedTradeAmountUsd > tinyCap) {
      return {
        canProceed: false,
        state: 'EXECUTION_BLOCKED',
        blockReason: 'EXECUTION_BLOCKED_EXCEEDS_TINY_CAP',
        errorMessage: `Execution blocked: trade amount $${canonicalPayload.proposedTradeAmountUsd.toFixed(2)} exceeds configured tiny live execution cap ($${tinyCap.toFixed(2)}).`,
        idempotencyKey
      };
    }

    // 12. EVM Wallet Address Validation
    if (!walletAddress || !isValidEvmAddress(walletAddress, { allowZeroAddress: false })) {
      return {
        canProceed: false,
        state: 'EXECUTION_BLOCKED',
        blockReason: 'EXECUTION_BLOCKED_INVALID_WALLET',
        errorMessage: `Execution blocked: wallet address "${walletAddress}" is invalid or zero-address.`,
        idempotencyKey
      };
    }

    // 13. Asset Address Dynamic Validation
    const isBuy = canonicalPayload.proposedAction === 'BUY_STOCK';
    const sourceToken = isBuy ? canonicalPayload.stableContractAddress : canonicalPayload.stockContractAddress;
    const targetToken = isBuy ? canonicalPayload.stockContractAddress : canonicalPayload.stableContractAddress;

    if (!isValidEvmAddress(sourceToken) || !isValidEvmAddress(targetToken)) {
      return {
        canProceed: false,
        state: 'EXECUTION_BLOCKED',
        blockReason: 'EXECUTION_BLOCKED_INVALID_ASSET',
        errorMessage: 'Execution blocked: source or target asset address is invalid EVM contract.',
        idempotencyKey
      };
    }

    // 14. Duplicate Execution Protection (Idempotency Key Check)
    if (this.executedIdempotencyKeys.has(idempotencyKey)) {
      return {
        canProceed: false,
        state: 'EXECUTION_BLOCKED',
        blockReason: 'EXECUTION_BLOCKED_DUPLICATE_EXECUTION',
        errorMessage: `Execution blocked: proposal already executed (idempotency key: ${idempotencyKey}).`,
        idempotencyKey
      };
    }

    // 15. Agentic Wallet Status & Policy Checks
    try {
      const walletStatus = await this.walletClient.getWalletStatus();
      if (walletStatus.status !== 'CONNECTED') {
        return {
          canProceed: false,
          state: 'EXECUTION_BLOCKED',
          blockReason: 'EXECUTION_BLOCKED_WALLET_DISCONNECTED',
          errorMessage: `Execution blocked: Binance Agentic Wallet is not CONNECTED (status: ${walletStatus.status}).`,
          idempotencyKey
        };
      }

      const txLock = await this.walletClient.getTxLock('56');
      if (txLock.status === 'LOCKED') {
        return {
          canProceed: false,
          state: 'EXECUTION_BLOCKED',
          blockReason: 'EXECUTION_BLOCKED_WALLET_LOCKED',
          errorMessage: 'Execution blocked: Agentic Wallet is LOCKED (pending transaction or double-confirmation required in Binance App).',
          idempotencyKey
        };
      }

      const settings = await this.walletClient.getWalletSettings();

      // Check daily spending limit quota
      if (settings.quotaLeft < canonicalPayload.proposedTradeAmountUsd) {
        return {
          canProceed: false,
          state: 'EXECUTION_BLOCKED',
          blockReason: 'EXECUTION_BLOCKED_WALLET_POLICY_REJECT',
          errorMessage: `Execution blocked: daily spending limit quota exceeded (remaining quota $${settings.quotaLeft.toFixed(2)} < required $${canonicalPayload.proposedTradeAmountUsd.toFixed(2)}).`,
          idempotencyKey
        };
      }

      // Check token allowlist if tradeAllTokens is false
      if (!settings.tradeAllTokens && settings.allowedTokens) {
        const allowedLower = settings.allowedTokens.map(a => a.toLowerCase());
        if (!allowedLower.includes(targetToken.toLowerCase()) || !allowedLower.includes(sourceToken.toLowerCase())) {
          return {
            canProceed: false,
            state: 'EXECUTION_BLOCKED',
            blockReason: 'EXECUTION_BLOCKED_WALLET_POLICY_REJECT',
            errorMessage: 'Execution blocked: token is not permitted under Agentic Wallet token allowlist.',
            idempotencyKey
          };
        }
      }

      // Check live balance guard
      const balances = await this.walletClient.getBalances({ binanceChainId: '56' });
      const stockBalanceItem = balances.find(b => b.address.toLowerCase() === canonicalPayload.stockContractAddress.toLowerCase());
      const stableBalanceItem = balances.find(b => b.address.toLowerCase() === canonicalPayload.stableContractAddress.toLowerCase());

      const stockBalance = stockBalanceItem ? parseFloat(stockBalanceItem.balance) || 0 : 0;
      const stableBalance = stableBalanceItem ? parseFloat(stableBalanceItem.balance) || 0 : 0;

      // Requirement 7: If the user's wallet currently has zero NVDAB and zero USDC, DO NOT attempt execution
      if (stockBalance <= 0 && stableBalance <= 0) {
        return {
          canProceed: false,
          state: 'EXECUTION_BLOCKED',
          blockReason: 'EXECUTION_BLOCKED_INSUFFICIENT_LIVE_BALANCE',
          errorMessage: 'Execution blocked: wallet has zero live balance for both NVDAB and USDC (EXECUTION_BLOCKED_INSUFFICIENT_LIVE_BALANCE).',
          idempotencyKey
        };
      }

      // Check balance for specific trade direction
      if (isBuy) {
        if (stableBalance < canonicalPayload.proposedTradeAmountUsd) {
          return {
            canProceed: false,
            state: 'EXECUTION_BLOCKED',
            blockReason: 'EXECUTION_BLOCKED_INSUFFICIENT_LIVE_BALANCE',
            errorMessage: `Execution blocked: insufficient USDC balance ($${stableBalance} < required $${canonicalPayload.proposedTradeAmountUsd}).`,
            idempotencyKey
          };
        }
      } else {
        if (stockBalance < canonicalPayload.proposedApproxTokenAmount) {
          return {
            canProceed: false,
            state: 'EXECUTION_BLOCKED',
            blockReason: 'EXECUTION_BLOCKED_INSUFFICIENT_LIVE_BALANCE',
            errorMessage: `Execution blocked: insufficient NVDAB balance (${stockBalance} < required ${canonicalPayload.proposedApproxTokenAmount}).`,
            idempotencyKey
          };
        }
      }
    } catch (err: unknown) {
      return {
        canProceed: false,
        state: 'EXECUTION_BLOCKED',
        blockReason: 'EXECUTION_BLOCKED_WALLET_POLICY_REJECT',
        errorMessage: `Execution blocked: Agentic Wallet preflight query failed (${(err as Error).message}).`,
        idempotencyKey
      };
    }

    return {
      canProceed: true,
      state: 'APPROVAL_REQUIRED',
      idempotencyKey
    };
  }

  /**
   * Executes a spot rebalancing transaction across the verified boundary.
   *
   * Flow:
   * 1. Evaluates all 15 pre-execution gates.
   * 2. Checks explicit user approval (stops at APPROVAL_REQUIRED if unapproved).
   * 3. Checks live execution switch (fails closed if live execution is disabled).
   * 4. Safe dry-run support if requested.
   * 5. Dispatches market-order swap via official Agentic Wallet.
   * 6. Polls order ID to terminal status (FINISHED / FAILED).
   * 7. Queries BSC RPC to confirm on-chain transaction receipt.
   * 8. Records immutable audit record (never logging secrets).
   */
  public async executeSpotRebalance(input: ExecutionPreflightInput): Promise<ExecutionReceipt>;
  public async executeSpotRebalance(proposal: any, verification: any): Promise<ExecutionReceipt>;
  public async executeSpotRebalance(
    inputOrProposal: ExecutionPreflightInput | any,
    maybeVerification?: any
  ): Promise<ExecutionReceipt> {
    const executionId = `exec-${randomUUID()}`;
    const now = Date.now();

    // Check if called with legacy (proposal, verification)
    if ('action' in inputOrProposal && !('canonicalPayload' in inputOrProposal)) {
      const proposal = inputOrProposal;
      const verification = maybeVerification;
      const failClosedReceipt: ExecutionReceipt = {
        executionId,
        proposalId: 'UNKNOWN',
        strategyId: 'UNKNOWN',
        state: 'EXECUTION_BLOCKED',
        idempotencyKey: 'UNKNOWN',
        requestedAmount: proposal?.tradeAmountUsd || 0,
        direction: proposal?.action || 'NONE',
        tokenContract: '',
        walletAddress: '',
        verificationHash: verification?.evidenceHash || '',
        simulationHash: '',
        submissionTimestamp: null,
        confirmationTimestamp: null,
        blockReason: 'EXECUTION_BLOCKED_SIMULATION_FAILED',
        failureReason: 'Execution blocked: full ExecutionPreflightInput with simulationResult and canonicalPayload is required.',
        isDryRun: false,
        bscReceipt: null,
        executedAt: now,
        errorMessage: 'Execution blocked: simulationResult is missing.'
      };
      await this.recordAudit(failClosedReceipt);
      return failClosedReceipt;
    }

    const input = inputOrProposal as ExecutionPreflightInput;
    const isDryRun = input.options?.isDryRun ?? false;

    const { canonicalPayload, verificationResult, simulationResult, walletAddress } = input;
    const proposalId = canonicalPayload?.proposalId ?? 'UNKNOWN';
    const strategyId = canonicalPayload?.strategyId ?? input.strategy?.id ?? 'UNKNOWN';
    const direction = canonicalPayload?.proposedAction ?? 'NONE';
    const requestedAmount = canonicalPayload?.proposedTradeAmountUsd ?? 0;
    const tokenContract = canonicalPayload?.stockContractAddress ?? '';
    const verificationHash = verificationResult?.evidenceHash ?? '';
    const simulationHash = simulationResult?.simulationHash ?? '';

    // Step 1: Pre-execution Gate Evaluation
    const gateResult = await this.evaluatePreExecutionGates(input);
    const idempotencyKey = gateResult.idempotencyKey;

    if (!gateResult.canProceed) {
      const receipt: ExecutionReceipt = {
        executionId,
        proposalId,
        strategyId,
        state: gateResult.state,
        idempotencyKey,
        requestedAmount,
        direction,
        tokenContract,
        walletAddress,
        verificationHash,
        simulationHash,
        submissionTimestamp: null,
        confirmationTimestamp: null,
        blockReason: gateResult.blockReason,
        failureReason: gateResult.errorMessage,
        isDryRun,
        bscReceipt: null,
        executedAt: now,
        errorMessage: gateResult.errorMessage
      };

      await this.recordAudit(receipt);
      return receipt;
    }

    // Step 2: Explicit User Approval Boundary
    if (this.requireUserApproval) {
      if (!input.userApproval) {
        const approvalRequiredReceipt: ExecutionReceipt = {
          executionId,
          proposalId,
          strategyId,
          state: 'APPROVAL_REQUIRED',
          idempotencyKey,
          requestedAmount,
          direction,
          tokenContract,
          walletAddress,
          verificationHash,
          simulationHash,
          submissionTimestamp: null,
          confirmationTimestamp: null,
          blockReason: null,
          failureReason: null,
          isDryRun,
          bscReceipt: null,
          executedAt: now
        };

        return approvalRequiredReceipt;
      }

      if (!input.userApproval.approved) {
        const deniedReceipt: ExecutionReceipt = {
          executionId,
          proposalId,
          strategyId,
          state: 'EXECUTION_BLOCKED',
          idempotencyKey,
          requestedAmount,
          direction,
          tokenContract,
          walletAddress,
          verificationHash,
          simulationHash,
          submissionTimestamp: null,
          confirmationTimestamp: null,
          blockReason: 'EXECUTION_BLOCKED_USER_APPROVAL_DENIED',
          failureReason: `User explicitly rejected rebalance execution (approver: ${input.userApproval.approvedBy}, notes: ${input.userApproval.notes || 'None'}).`,
          isDryRun,
          bscReceipt: null,
          executedAt: now,
          errorMessage: 'User explicitly denied approval for trade execution.'
        };

        await this.recordAudit(deniedReceipt);
        return deniedReceipt;
      }
    }

    // Step 3: Register Idempotency Key Before Submission
    this.executedIdempotencyKeys.add(idempotencyKey);

    // Step 4: Handle Safe Dry-Run Mode
    if (isDryRun) {
      const dryRunOrderId = `dryrun-order-${Date.now()}`;
      const dryRunTxHash = `0x${createHash('sha256').update(dryRunOrderId).digest('hex')}`;

      const dryRunReceipt: ExecutionReceipt = {
        executionId,
        proposalId,
        strategyId,
        state: 'EXECUTION_CONFIRMED',
        idempotencyKey,
        orderId: dryRunOrderId,
        txHash: dryRunTxHash,
        actualExecutedAmount: requestedAmount,
        requestedAmount,
        direction,
        tokenContract,
        walletAddress,
        verificationHash,
        simulationHash,
        submissionTimestamp: now,
        confirmationTimestamp: Date.now(),
        blockReason: null,
        failureReason: null,
        isDryRun: true,
        bscReceipt: {
          transactionHash: dryRunTxHash,
          blockNumber: 42000000,
          blockHash: `0x${'f'.repeat(64)}`,
          from: walletAddress,
          to: tokenContract,
          status: '0x1',
          gasUsed: '150000',
          cumulativeGasUsed: '150000'
        },
        executedAt: now
      };

      await this.recordAudit(dryRunReceipt);
      return dryRunReceipt;
    }

    // Step 5: Live Execution Protection Switch
    if (!this.allowLiveExecution) {
      const liveBlockedReceipt: ExecutionReceipt = {
        executionId,
        proposalId,
        strategyId,
        state: 'EXECUTION_BLOCKED',
        idempotencyKey,
        requestedAmount,
        direction,
        tokenContract,
        walletAddress,
        verificationHash,
        simulationHash,
        submissionTimestamp: null,
        confirmationTimestamp: null,
        blockReason: 'EXECUTION_BLOCKED_LIVE_EXECUTION_DISABLED',
        failureReason: 'Live execution switch is intentionally disabled (allowLiveExecution = false). Fails closed.',
        isDryRun: false,
        bscReceipt: null,
        executedAt: now,
        errorMessage: 'Live execution disabled in current environment.'
      };

      await this.recordAudit(liveBlockedReceipt);
      return liveBlockedReceipt;
    }

    // Step 6: Dispatch Spot Market-Order Swap via Binance Agentic Wallet
    const isBuy = direction === 'BUY_STOCK';
    const fromToken = isBuy ? canonicalPayload.stableContractAddress : canonicalPayload.stockContractAddress;
    const toToken = isBuy ? canonicalPayload.stockContractAddress : canonicalPayload.stableContractAddress;
    const fromTokenQty = isBuy ? canonicalPayload.proposedTradeAmountUsd : canonicalPayload.proposedApproxTokenAmount;

    let submissionTimestamp: number;
    let orderId: string;

    try {
      submissionTimestamp = Date.now();
      const swapResult = await this.walletClient.submitMarketOrderSwap({
        fromTokenQty,
        fromToken,
        toToken,
        binanceChainId: '56',
        slippage: `${(canonicalPayload.proposedSlippageLimitBps / 100).toFixed(2)}`,
        mev: true,
        gasLevel: 'MEDIUM'
      });

      orderId = swapResult.orderId;
    } catch (err: unknown) {
      const errMsg = (err as Error).message || String(err);
      // Ambiguous network response after submission attempt
      const isNetworkAmbiguous = errMsg.includes('timeout') || errMsg.includes('ECONNRESET') || errMsg.includes('ETIMEDOUT') || errMsg.includes('fetch');

      const failedSubmissionReceipt: ExecutionReceipt = {
        executionId,
        proposalId,
        strategyId,
        state: isNetworkAmbiguous ? 'EXECUTION_UNKNOWN' : 'EXECUTION_FAILED',
        idempotencyKey,
        orderId: null,
        txHash: null,
        actualExecutedAmount: null,
        requestedAmount,
        direction,
        tokenContract,
        walletAddress,
        verificationHash,
        simulationHash,
        submissionTimestamp: Date.now(),
        confirmationTimestamp: null,
        blockReason: null,
        failureReason: errMsg,
        isDryRun: false,
        bscReceipt: null,
        executedAt: now,
        errorMessage: `Swap submission failed: ${errMsg}`
      };

      await this.recordAudit(failedSubmissionReceipt);
      return failedSubmissionReceipt;
    }

    // Step 7: Poll Order Lifecycle to Terminal State (FINISHED / FAILED)
    let terminalOrder: { status: string; txHash?: string | null; toTokenQty?: string } | null = null;

    for (let attempt = 1; attempt <= this.maxPollingAttempts; attempt++) {
      try {
        const orderDetail = await this.walletClient.getMarketOrderDetail(orderId, '56');
        if (orderDetail) {
          if (orderDetail.status === 'FINISHED' || orderDetail.status === 'FAILED') {
            terminalOrder = orderDetail;
            break;
          }
        }
      } catch {
        // Transient lookup failure; keep polling
      }

      if (attempt < this.maxPollingAttempts) {
        await new Promise(res => setTimeout(res, this.pollingIntervalMs));
      }
    }

    // Step 8: Evaluate Terminal State & BSC Receipt
    if (!terminalOrder || terminalOrder.status === 'PENDING') {
      const pendingReceipt: ExecutionReceipt = {
        executionId,
        proposalId,
        strategyId,
        state: 'EXECUTION_PENDING',
        idempotencyKey,
        orderId,
        txHash: terminalOrder?.txHash || null,
        actualExecutedAmount: null,
        requestedAmount,
        direction,
        tokenContract,
        walletAddress,
        verificationHash,
        simulationHash,
        submissionTimestamp,
        confirmationTimestamp: null,
        blockReason: null,
        failureReason: `Order ${orderId} still pending after ${this.maxPollingAttempts} polling attempts.`,
        isDryRun: false,
        bscReceipt: null,
        executedAt: now
      };

      await this.recordAudit(pendingReceipt);
      return pendingReceipt;
    }

    if (terminalOrder.status === 'FAILED') {
      const failedReceipt: ExecutionReceipt = {
        executionId,
        proposalId,
        strategyId,
        state: 'EXECUTION_FAILED',
        idempotencyKey,
        orderId,
        txHash: terminalOrder.txHash || null,
        actualExecutedAmount: null,
        requestedAmount,
        direction,
        tokenContract,
        walletAddress,
        verificationHash,
        simulationHash,
        submissionTimestamp,
        confirmationTimestamp: Date.now(),
        blockReason: null,
        failureReason: `Market order ${orderId} failed on-chain or at router.`,
        isDryRun: false,
        bscReceipt: null,
        executedAt: now,
        errorMessage: 'Binance Agentic Wallet market-order failed.'
      };

      await this.recordAudit(failedReceipt);
      return failedReceipt;
    }

    // Order reported FINISHED — Verify BSC on-chain receipt before marking CONFIRMED
    const txHash = terminalOrder.txHash;
    if (!txHash) {
      const unknownReceipt: ExecutionReceipt = {
        executionId,
        proposalId,
        strategyId,
        state: 'EXECUTION_UNKNOWN',
        idempotencyKey,
        orderId,
        txHash: null,
        actualExecutedAmount: null,
        requestedAmount,
        direction,
        tokenContract,
        walletAddress,
        verificationHash,
        simulationHash,
        submissionTimestamp,
        confirmationTimestamp: null,
        blockReason: null,
        failureReason: `Order ${orderId} reported FINISHED but returned no transaction hash.`,
        isDryRun: false,
        bscReceipt: null,
        executedAt: now,
        errorMessage: 'Missing transaction hash for completed order.'
      };

      await this.recordAudit(unknownReceipt);
      return unknownReceipt;
    }

    let bscReceipt: BscTransactionReceipt | null = null;
    try {
      bscReceipt = await this.walletClient.getBscTransactionReceipt(txHash);
    } catch (err: unknown) {
      // Receipt query network failure
      const receiptUnknownReceipt: ExecutionReceipt = {
        executionId,
        proposalId,
        strategyId,
        state: 'EXECUTION_UNKNOWN',
        idempotencyKey,
        orderId,
        txHash,
        actualExecutedAmount: null,
        requestedAmount,
        direction,
        tokenContract,
        walletAddress,
        verificationHash,
        simulationHash,
        submissionTimestamp,
        confirmationTimestamp: null,
        blockReason: null,
        failureReason: `Failed to confirm BSC transaction receipt: ${(err as Error).message}`,
        isDryRun: false,
        bscReceipt: null,
        executedAt: now,
        errorMessage: 'BSC receipt confirmation query threw ambiguous error.'
      };

      await this.recordAudit(receiptUnknownReceipt);
      return receiptUnknownReceipt;
    }

    if (!bscReceipt) {
      // Transaction hash exists but receipt not yet available on node
      const unconfirmedReceipt: ExecutionReceipt = {
        executionId,
        proposalId,
        strategyId,
        state: 'EXECUTION_PENDING',
        idempotencyKey,
        orderId,
        txHash,
        actualExecutedAmount: null,
        requestedAmount,
        direction,
        tokenContract,
        walletAddress,
        verificationHash,
        simulationHash,
        submissionTimestamp,
        confirmationTimestamp: null,
        blockReason: null,
        failureReason: 'Transaction broadcasted; awaiting on-chain block inclusion.',
        isDryRun: false,
        bscReceipt: null,
        executedAt: now
      };

      await this.recordAudit(unconfirmedReceipt);
      return unconfirmedReceipt;
    }

    // Check EVM receipt status (0x1 = SUCCESS, 0x0 = REVERT)
    const isSuccess = bscReceipt.status === '0x1' || bscReceipt.status === 1;
    const finalState: ExecutionState = isSuccess ? 'EXECUTION_CONFIRMED' : 'EXECUTION_FAILED';
    const executedAmount = terminalOrder.toTokenQty ? parseFloat(terminalOrder.toTokenQty) : requestedAmount;

    const finalReceipt: ExecutionReceipt = {
      executionId,
      proposalId,
      strategyId,
      state: finalState,
      idempotencyKey,
      orderId,
      txHash,
      actualExecutedAmount: isSuccess ? executedAmount : null,
      requestedAmount,
      direction,
      tokenContract,
      walletAddress,
      verificationHash,
      simulationHash,
      submissionTimestamp,
      confirmationTimestamp: Date.now(),
      blockReason: null,
      failureReason: isSuccess ? null : 'BSC transaction reverted on-chain (status 0x0).',
      isDryRun: false,
      bscReceipt,
      executedAt: now,
      errorMessage: isSuccess ? undefined : 'BSC on-chain transaction reverted.'
    };

    await this.recordAudit(finalReceipt);
    return finalReceipt;
  }

  /**
   * Records an immutable audit log entry for this execution cycle.
   */
  private async recordAudit(receipt: ExecutionReceipt): Promise<void> {
    if (!this.auditStore) return;

    const auditRecord: ExecutionAuditRecord = {
      auditId: `audit-${randomUUID()}`,
      proposalId: receipt.proposalId,
      strategyId: receipt.strategyId,
      verificationHash: receipt.verificationHash,
      simulationHash: receipt.simulationHash,
      walletAddress: receipt.walletAddress,
      tokenContract: receipt.tokenContract,
      direction: receipt.direction,
      requestedAmount: receipt.requestedAmount,
      actualExecutedAmount: receipt.actualExecutedAmount ?? null,
      executionOrderId: receipt.orderId ?? null,
      txHash: receipt.txHash ?? null,
      submissionTimestamp: receipt.submissionTimestamp ?? null,
      confirmationTimestamp: receipt.confirmationTimestamp ?? null,
      finalExecutionStatus: receipt.state,
      failureReason: receipt.failureReason ?? null,
      idempotencyKey: receipt.idempotencyKey,
      isDryRun: receipt.isDryRun,
      blockReason: receipt.blockReason ?? null
    };

    await this.auditStore.appendExecutionRecord(auditRecord);
  }
}
