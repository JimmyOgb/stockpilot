/**
 * StockPilot — Agentic Wallet Live Execution Adapter Unit Tests
 *
 * Comprehensive tests for the final live execution boundary:
 * 1. Valid fully verified proposal reaches approval boundary
 * 2. Unverified GenLayer proposal blocked (fail-closed)
 * 3. Failed simulation blocked (fail-closed)
 * 4. Hash mismatch blocked (canonical evidence hash mismatch)
 * 5. Proposal ID mismatch blocked
 * 6. Stale quote blocked (> maxAllowedQuoteAgeSeconds)
 * 7. Market closed blocked (underlying session closed)
 * 8. Excessive spread blocked (> maxSpreadBps)
 * 9. Strategy circuit breaker blocked (> $5,000)
 * 10. Tiny live execution cap blocked (> tinyExecutionCapUsd)
 * 11. Invalid or zero-address wallet blocked
 * 12. Wallet policy rejection: daily spending limit quota exceeded
 * 13. Wallet policy rejection: wallet status UNCONNECTED / disconnected
 * 14. Wallet policy rejection: wallet LOCKED
 * 15. Wallet policy rejection: token not on allowlist when tradeAllTokens is false
 * 16. Insufficient balance blocked (zero NVDAB and zero USDC -> EXECUTION_BLOCKED_INSUFFICIENT_LIVE_BALANCE)
 * 17. Insufficient balance blocked for specific trade direction (insufficient USDC for BUY)
 * 18. User approval denied -> EXECUTION_BLOCKED
 * 19. User approval granted + safe dry run -> EXECUTION_CONFIRMED (isDryRun: true)
 * 20. Live execution switch disabled (allowLiveExecution = false) -> EXECUTION_BLOCKED
 * 21. Successful live execution: submitted -> pending -> confirmed with valid BSC receipt (0x1)
 * 22. Execution pending: order remains PENDING after polling limit
 * 23. Execution failure: order status FAILED from Agentic Wallet
 * 24. Receipt confirmation failure: on-chain status 0x0 (reverted) -> EXECUTION_FAILED
 * 25. Ambiguous network response: lost response / network exception -> EXECUTION_UNKNOWN
 * 26. Ambiguous receipt query: receipt query network error -> EXECUTION_UNKNOWN
 * 27. Duplicate execution prevented (idempotency key protection)
 * 28. No private key or secret leakage across receipts, audit records, or error messages
 * 29. Legacy / shorthand (proposal, verification) call fails closed
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AgenticExecutionAdapter,
  IBinanceAgenticWalletClient,
  GateEvaluationResult
} from '../src/execution/adapter.js';
import { InMemoryAuditStore } from '../src/storage/audit-log.js';
import {
  buildCanonicalEvidencePayload,
  computeEvidenceHash
} from '../src/verification/genlayer-adapter.js';
import {
  DEFAULT_MVP_STRATEGY_CONFIG,
  ExecutionPreflightInput,
  CanonicalEvidencePayload,
  VerificationResult,
  BinanceSimulationResult,
  AgenticWalletStatus,
  AgenticWalletSettings,
  AgenticWalletTxLock,
  AgenticWalletBalanceItem,
  AgenticMarketOrderDetail,
  BscTransactionReceipt,
  UserApprovalDecision
} from '../src/types/index.js';

describe('Agentic Wallet Live Execution Adapter', () => {
  const dummyWallet = '0xE422896590BE841D62423c8aE30940562e817085';
  const stockContract = '0x02fca66c1d1afb4e2a7884261eb00f63598a7436';
  const stableContract = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';

  let mockWalletClient: IBinanceAgenticWalletClient;
  let auditStore: InMemoryAuditStore;
  let adapter: AgenticExecutionAdapter;

  const validCanonicalPayload: CanonicalEvidencePayload = {
    version: '1.0.0',
    proposalId: 'prop-exec-test-1001',
    strategyId: DEFAULT_MVP_STRATEGY_CONFIG.id,
    targetStockWeightBps: 6000,
    targetStableWeightBps: 4000,
    driftThresholdBps: 500,
    maxSingleTradeUsd: 5000,
    maxSpreadBps: 200,
    stockSymbol: 'NVDAB',
    stockContractAddress: stockContract,
    stableSymbol: 'USDC',
    stableContractAddress: stableContract,
    stockBalanceRaw: '50000000000000000000',
    stockBalanceFormatted: 50,
    stableBalanceRaw: '10000000000000000000000',
    stableBalanceFormatted: 10000,
    stockTokenPrice: 200,
    stockReferencePrice: 200,
    spread: 0,
    spreadBps: 0,
    marketState: 'MARKET_OPEN',
    quoteTimestamp: Date.now() - 10000,
    quoteAgeSeconds: 10,
    currentStockWeightBps: 5000,
    currentStableWeightBps: 5000,
    totalValueUsd: 20000,
    calculatedDriftBps: 1000,
    proposedAction: 'BUY_STOCK',
    proposedTradeAmountUsd: 20.0, // Well within tiny cap of $25.00
    proposedApproxTokenAmount: 0.1,
    proposedSlippageLimitBps: 50,
    sourceAsset: 'USDC',
    targetAsset: 'NVDAB',
    evidenceTimestamp: Date.now()
  };

  const validEvidenceHash = computeEvidenceHash(validCanonicalPayload);

  const validVerificationResult: VerificationResult = {
    decision: 'VERIFIED',
    status: 'ALLOW',
    evidenceHash: validEvidenceHash,
    proposalId: validCanonicalPayload.proposalId,
    reason: 'Deterministic rebalance rules fully satisfied and verified.',
    verifiedAt: Date.now(),
    checks: {
      payload_valid: true,
      math_consistent: true,
      direction_consistent: true,
      spread_permitted: true,
      circuit_breaker_passed: true,
      market_state_permitted: true,
      non_zero_portfolio: true
    }
  };

  const validSimulationResult: BinanceSimulationResult = {
    decision: 'SIMULATED_OK',
    status: 'SUCCESS',
    simulationHash: 'sim-hash-valid-1001',
    proposalId: validCanonicalPayload.proposalId,
    evidenceHash: validEvidenceHash,
    gasUsed: 142000n,
    gasLimit: 300000n,
    gasPriceGwei: 3.0,
    estimatedFeeBnb: 0.000426,
    estimatedFeeUsd: 0.25,
    revertReason: null,
    rawResponse: { simulated: true },
    simulatedAt: Date.now(),
    reason: 'Binance preflight simulation succeeded without revert.'
  };

  const defaultUserApproval: UserApprovalDecision = {
    approved: true,
    approvedBy: 'authorized-operator',
    approvedAt: Date.now(),
    notes: 'Approved via StockPilot interactive terminal.'
  };

  function createMockWalletClient(overrides?: Partial<IBinanceAgenticWalletClient>): IBinanceAgenticWalletClient {
    return {
      getWalletStatus: vi.fn(async (): Promise<AgenticWalletStatus> => ({ status: 'CONNECTED' })),
      getWalletSettings: vi.fn(async (): Promise<AgenticWalletSettings> => ({
        dailyLimit: 50000,
        quotaUsed: 0,
        quotaLeft: 50000,
        tradeAllTokens: true,
        abnormalTxnHandling: 'AutoReject'
      })),
      getTxLock: vi.fn(async (): Promise<AgenticWalletTxLock> => ({ status: 'UNLOCKED' })),
      getBalances: vi.fn(async (): Promise<AgenticWalletBalanceItem[]> => [
        { symbol: 'NVDAB', address: stockContract, binanceChainId: '56', balance: '50.0' },
        { symbol: 'USDC', address: stableContract, binanceChainId: '56', balance: '10000.0' }
      ]),
      getApprovals: vi.fn(async () => []),
      getMarketOrderQuote: vi.fn(async () => ({
        fromCoinSymbol: 'USDC',
        fromCoinAmount: '20.0',
        toCoinSymbol: 'NVDAB',
        toCoinAmount: '0.1',
        slippage: '0.5'
      })),
      submitMarketOrderSwap: vi.fn(async () => ({ orderId: 'baw-order-998877' })),
      getMarketOrderDetail: vi.fn(async (orderId: string): Promise<AgenticMarketOrderDetail> => ({
        orderId,
        chain: '56',
        fromToken: stableContract,
        fromTokenQty: '20.0',
        toToken: stockContract,
        toTokenQty: '0.1',
        status: 'FINISHED',
        txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
      })),
      getBscTransactionReceipt: vi.fn(async (txHash: string): Promise<BscTransactionReceipt> => ({
        transactionHash: txHash,
        blockNumber: 42000001,
        blockHash: '0xabcdeffedcba1234567890abcdeffedcba1234567890abcdeffedcba12345678',
        from: dummyWallet,
        to: stockContract,
        status: '0x1',
        gasUsed: '142000',
        cumulativeGasUsed: '142000'
      })),
      ...overrides
    };
  }

  function createValidInput(overrides?: Partial<ExecutionPreflightInput>): ExecutionPreflightInput {
    return {
      strategy: DEFAULT_MVP_STRATEGY_CONFIG,
      canonicalPayload: { ...validCanonicalPayload },
      verificationResult: { ...validVerificationResult },
      simulationResult: { ...validSimulationResult },
      walletAddress: dummyWallet,
      userApproval: defaultUserApproval,
      options: {
        tinyExecutionCapUsd: 25.0,
        maxAllowedQuoteAgeSeconds: 900,
        isDryRun: false
      },
      ...overrides
    };
  }

  beforeEach(() => {
    mockWalletClient = createMockWalletClient();
    auditStore = new InMemoryAuditStore();
    adapter = new AgenticExecutionAdapter({
      walletClient: mockWalletClient,
      auditStore,
      allowLiveExecution: false, // Default fail-closed
      tinyExecutionCapUsd: 25.0,
      maxAllowedQuoteAgeSeconds: 900,
      requireUserApproval: true
    });
  });

  describe('Hard Pre-Execution Gates & Boundary Validation', () => {
    it('1. Valid fully verified proposal reaches approval boundary when user approval is missing', async () => {
      const input = createValidInput({ userApproval: undefined });
      const receipt = await adapter.executeSpotRebalance(input);

      expect(receipt.state).toBe('APPROVAL_REQUIRED');
      expect(receipt.proposalId).toBe(validCanonicalPayload.proposalId);
      expect(receipt.requestedAmount).toBe(20.0);
      expect(receipt.direction).toBe('BUY_STOCK');
      expect(receipt.blockReason).toBeNull();
      expect(mockWalletClient.submitMarketOrderSwap).not.toHaveBeenCalled();
    });

    it('2. Unverified GenLayer proposal blocked fail-closed', async () => {
      const input = createValidInput({
        verificationResult: {
          ...validVerificationResult,
          decision: 'NOT_VERIFIED',
          status: 'REJECT'
        }
      });
      const receipt = await adapter.executeSpotRebalance(input);

      expect(receipt.state).toBe('EXECUTION_BLOCKED');
      expect(receipt.blockReason).toBe('EXECUTION_BLOCKED_UNVERIFIED_PROPOSAL');
      expect(mockWalletClient.submitMarketOrderSwap).not.toHaveBeenCalled();

      // Verify audit record was created
      const audits = await auditStore.getExecutionRecords();
      expect(audits.length).toBe(1);
      expect(audits[0].finalExecutionStatus).toBe('EXECUTION_BLOCKED');
    });

    it('3. Failed simulation blocked fail-closed', async () => {
      const input = createValidInput({
        simulationResult: {
          ...validSimulationResult,
          decision: 'SIMULATION_FAILED',
          status: 'REVERT',
          reason: 'Execution reverted: PancakeRouter INSUFFICIENT_OUTPUT_AMOUNT'
        }
      });
      const receipt = await adapter.executeSpotRebalance(input);

      expect(receipt.state).toBe('EXECUTION_BLOCKED');
      expect(receipt.blockReason).toBe('EXECUTION_BLOCKED_SIMULATION_FAILED');
      expect(receipt.failureReason).toContain('INSUFFICIENT_OUTPUT_AMOUNT');
      expect(mockWalletClient.submitMarketOrderSwap).not.toHaveBeenCalled();
    });

    it('4. Canonical evidence hash mismatch blocked', async () => {
      const input = createValidInput({
        verificationResult: {
          ...validVerificationResult,
          evidenceHash: '0x0000000000000000000000000000000000000000000000000000000000000000'
        }
      });
      const receipt = await adapter.executeSpotRebalance(input);

      expect(receipt.state).toBe('EXECUTION_BLOCKED');
      expect(receipt.blockReason).toBe('EXECUTION_BLOCKED_HASH_MISMATCH');
      expect(receipt.failureReason).toContain('canonical evidence hash mismatch');
      expect(mockWalletClient.submitMarketOrderSwap).not.toHaveBeenCalled();
    });

    it('5. Proposal ID mismatch blocked', async () => {
      const input = createValidInput({
        verificationResult: {
          ...validVerificationResult,
          proposalId: 'prop-different-id-9999'
        }
      });
      const receipt = await adapter.executeSpotRebalance(input);

      expect(receipt.state).toBe('EXECUTION_BLOCKED');
      expect(receipt.blockReason).toBe('EXECUTION_BLOCKED_ID_MISMATCH');
      expect(mockWalletClient.submitMarketOrderSwap).not.toHaveBeenCalled();
    });

    it('6. Stale quote blocked (> maxAllowedQuoteAgeSeconds)', async () => {
      const input = createValidInput({
        canonicalPayload: {
          ...validCanonicalPayload,
          quoteAgeSeconds: 901
        }
      });
      // Re-hash verification to match modified canonical payload
      const modifiedHash = computeEvidenceHash(input.canonicalPayload);
      input.verificationResult.evidenceHash = modifiedHash;
      input.simulationResult.evidenceHash = modifiedHash;

      const receipt = await adapter.executeSpotRebalance(input);

      expect(receipt.state).toBe('EXECUTION_BLOCKED');
      expect(receipt.blockReason).toBe('EXECUTION_BLOCKED_STALE_QUOTE');
      expect(receipt.failureReason).toContain('price quote is stale');
      expect(mockWalletClient.submitMarketOrderSwap).not.toHaveBeenCalled();
    });

    it('7. Market closed state blocked (underlying market session is MARKET_CLOSED)', async () => {
      const input = createValidInput({
        canonicalPayload: {
          ...validCanonicalPayload,
          marketState: 'MARKET_CLOSED'
        }
      });
      const modifiedHash = computeEvidenceHash(input.canonicalPayload);
      input.verificationResult.evidenceHash = modifiedHash;
      input.simulationResult.evidenceHash = modifiedHash;

      const receipt = await adapter.executeSpotRebalance(input);

      expect(receipt.state).toBe('EXECUTION_BLOCKED');
      expect(receipt.blockReason).toBe('EXECUTION_BLOCKED_MARKET_CLOSED');
      expect(receipt.failureReason).toContain('MARKET_CLOSED');
      expect(mockWalletClient.submitMarketOrderSwap).not.toHaveBeenCalled();
    });

    it('8. Excessive spread blocked (> maxSpreadBps)', async () => {
      const input = createValidInput({
        canonicalPayload: {
          ...validCanonicalPayload,
          spreadBps: 250,
          maxSpreadBps: 200
        }
      });
      const modifiedHash = computeEvidenceHash(input.canonicalPayload);
      input.verificationResult.evidenceHash = modifiedHash;
      input.simulationResult.evidenceHash = modifiedHash;

      const receipt = await adapter.executeSpotRebalance(input);

      expect(receipt.state).toBe('EXECUTION_BLOCKED');
      expect(receipt.blockReason).toBe('EXECUTION_BLOCKED_SPREAD_EXCESSIVE');
      expect(receipt.failureReason).toContain('spread (250 bps) exceeds');
      expect(mockWalletClient.submitMarketOrderSwap).not.toHaveBeenCalled();
    });

    it('9. Strategy circuit breaker blocked (> $5,000 maximum)', async () => {
      const input = createValidInput({
        canonicalPayload: {
          ...validCanonicalPayload,
          proposedTradeAmountUsd: 5001.0
        }
      });
      const modifiedHash = computeEvidenceHash(input.canonicalPayload);
      input.verificationResult.evidenceHash = modifiedHash;
      input.simulationResult.evidenceHash = modifiedHash;

      const receipt = await adapter.executeSpotRebalance(input);

      expect(receipt.state).toBe('EXECUTION_BLOCKED');
      expect(receipt.blockReason).toBe('EXECUTION_BLOCKED_CIRCUIT_BREAKER');
      expect(mockWalletClient.submitMarketOrderSwap).not.toHaveBeenCalled();
    });

    it('10. Tiny live execution cap blocked (> $25.00 for initial live milestone)', async () => {
      const input = createValidInput({
        canonicalPayload: {
          ...validCanonicalPayload,
          proposedTradeAmountUsd: 50.0 // Exceeds tiny cap of 25.0
        }
      });
      const modifiedHash = computeEvidenceHash(input.canonicalPayload);
      input.verificationResult.evidenceHash = modifiedHash;
      input.simulationResult.evidenceHash = modifiedHash;

      const receipt = await adapter.executeSpotRebalance(input);

      expect(receipt.state).toBe('EXECUTION_BLOCKED');
      expect(receipt.blockReason).toBe('EXECUTION_BLOCKED_EXCEEDS_TINY_CAP');
      expect(receipt.failureReason).toContain('exceeds configured tiny live execution cap');
      expect(mockWalletClient.submitMarketOrderSwap).not.toHaveBeenCalled();
    });

    it('11. Invalid or zero-address wallet blocked fail-closed', async () => {
      const inputZero = createValidInput({ walletAddress: '0x0000000000000000000000000000000000000000' });
      const receiptZero = await adapter.executeSpotRebalance(inputZero);
      expect(receiptZero.state).toBe('EXECUTION_BLOCKED');
      expect(receiptZero.blockReason).toBe('EXECUTION_BLOCKED_INVALID_WALLET');

      const inputInvalid = createValidInput({ walletAddress: '0xinvalid-hex-address' });
      const receiptInvalid = await adapter.executeSpotRebalance(inputInvalid);
      expect(receiptInvalid.state).toBe('EXECUTION_BLOCKED');
      expect(receiptInvalid.blockReason).toBe('EXECUTION_BLOCKED_INVALID_WALLET');
    });
  });

  describe('Agentic Wallet Policy & Balance Controls', () => {
    it('12. Wallet policy rejection: daily spending limit quota exceeded', async () => {
      const customClient = createMockWalletClient({
        getWalletSettings: vi.fn(async (): Promise<AgenticWalletSettings> => ({
          dailyLimit: 50000,
          quotaUsed: 49990,
          quotaLeft: 10.0, // Remaining quota is only $10, but trade needs $20
          tradeAllTokens: true,
          abnormalTxnHandling: 'AutoReject'
        }))
      });
      const customAdapter = new AgenticExecutionAdapter({
        walletClient: customClient,
        auditStore,
        allowLiveExecution: false
      });

      const input = createValidInput();
      const receipt = await customAdapter.executeSpotRebalance(input);

      expect(receipt.state).toBe('EXECUTION_BLOCKED');
      expect(receipt.blockReason).toBe('EXECUTION_BLOCKED_WALLET_POLICY_REJECT');
      expect(receipt.failureReason).toContain('daily spending limit quota exceeded');
    });

    it('13. Wallet policy rejection: wallet status is UNCONNECTED', async () => {
      const disconnectedClient = createMockWalletClient({
        getWalletStatus: vi.fn(async (): Promise<AgenticWalletStatus> => ({ status: 'UNCONNECTED' }))
      });
      const customAdapter = new AgenticExecutionAdapter({
        walletClient: disconnectedClient,
        auditStore
      });

      const receipt = await customAdapter.executeSpotRebalance(createValidInput());

      expect(receipt.state).toBe('EXECUTION_BLOCKED');
      expect(receipt.blockReason).toBe('EXECUTION_BLOCKED_WALLET_DISCONNECTED');
      expect(receipt.failureReason).toContain('UNCONNECTED');
    });

    it('14. Wallet policy rejection: wallet is LOCKED (tx-lock LOCKED)', async () => {
      const lockedClient = createMockWalletClient({
        getTxLock: vi.fn(async (): Promise<AgenticWalletTxLock> => ({ status: 'LOCKED' }))
      });
      const customAdapter = new AgenticExecutionAdapter({
        walletClient: lockedClient,
        auditStore
      });

      const receipt = await customAdapter.executeSpotRebalance(createValidInput());

      expect(receipt.state).toBe('EXECUTION_BLOCKED');
      expect(receipt.blockReason).toBe('EXECUTION_BLOCKED_WALLET_LOCKED');
      expect(receipt.failureReason).toContain('Agentic Wallet is LOCKED');
    });

    it('15. Wallet policy rejection: token not on allowlist when tradeAllTokens is false', async () => {
      const restrictedClient = createMockWalletClient({
        getWalletSettings: vi.fn(async (): Promise<AgenticWalletSettings> => ({
          dailyLimit: 50000,
          quotaUsed: 0,
          quotaLeft: 50000,
          tradeAllTokens: false,
          allowedTokens: [stableContract], // Only USDC allowed, NVDAB is not
          abnormalTxnHandling: 'AutoReject'
        }))
      });
      const customAdapter = new AgenticExecutionAdapter({
        walletClient: restrictedClient,
        auditStore
      });

      const receipt = await customAdapter.executeSpotRebalance(createValidInput());

      expect(receipt.state).toBe('EXECUTION_BLOCKED');
      expect(receipt.blockReason).toBe('EXECUTION_BLOCKED_WALLET_POLICY_REJECT');
      expect(receipt.failureReason).toContain('token allowlist');
    });

    it('16. Insufficient balance blocked: wallet has ZERO NVDAB and ZERO USDC -> EXECUTION_BLOCKED_INSUFFICIENT_LIVE_BALANCE', async () => {
      const zeroBalanceClient = createMockWalletClient({
        getBalances: vi.fn(async (): Promise<AgenticWalletBalanceItem[]> => [
          { symbol: 'NVDAB', address: stockContract, binanceChainId: '56', balance: '0.0' },
          { symbol: 'USDC', address: stableContract, binanceChainId: '56', balance: '0.0' }
        ])
      });
      const customAdapter = new AgenticExecutionAdapter({
        walletClient: zeroBalanceClient,
        auditStore
      });

      const receipt = await customAdapter.executeSpotRebalance(createValidInput());

      expect(receipt.state).toBe('EXECUTION_BLOCKED');
      expect(receipt.blockReason).toBe('EXECUTION_BLOCKED_INSUFFICIENT_LIVE_BALANCE');
      expect(receipt.failureReason).toContain('zero live balance for both NVDAB and USDC');
      expect(zeroBalanceClient.submitMarketOrderSwap).not.toHaveBeenCalled();
    });

    it('17. Insufficient balance blocked for specific trade direction (insufficient USDC for BUY)', async () => {
      const partialBalanceClient = createMockWalletClient({
        getBalances: vi.fn(async (): Promise<AgenticWalletBalanceItem[]> => [
          { symbol: 'NVDAB', address: stockContract, binanceChainId: '56', balance: '10.0' },
          { symbol: 'USDC', address: stableContract, binanceChainId: '56', balance: '5.0' } // Needs 20.0 USDC
        ])
      });
      const customAdapter = new AgenticExecutionAdapter({
        walletClient: partialBalanceClient,
        auditStore
      });

      const receipt = await customAdapter.executeSpotRebalance(createValidInput());

      expect(receipt.state).toBe('EXECUTION_BLOCKED');
      expect(receipt.blockReason).toBe('EXECUTION_BLOCKED_INSUFFICIENT_LIVE_BALANCE');
      expect(receipt.failureReason).toContain('insufficient USDC balance');
      expect(partialBalanceClient.submitMarketOrderSwap).not.toHaveBeenCalled();
    });
  });

  describe('Approval Boundary, Dry-Run & Live Execution Switch', () => {
    it('18. User approval denied -> EXECUTION_BLOCKED with EXECUTION_BLOCKED_USER_APPROVAL_DENIED', async () => {
      const input = createValidInput({
        userApproval: {
          approved: false,
          approvedBy: 'security-officer',
          approvedAt: Date.now(),
          notes: 'Excessive volatility detected manually.'
        }
      });
      const receipt = await adapter.executeSpotRebalance(input);

      expect(receipt.state).toBe('EXECUTION_BLOCKED');
      expect(receipt.blockReason).toBe('EXECUTION_BLOCKED_USER_APPROVAL_DENIED');
      expect(receipt.failureReason).toContain('User explicitly rejected rebalance execution');
      expect(mockWalletClient.submitMarketOrderSwap).not.toHaveBeenCalled();
    });

    it('19. User approval granted + safe dry run -> EXECUTION_CONFIRMED with dry-run flags', async () => {
      const input = createValidInput({
        options: {
          isDryRun: true,
          tinyExecutionCapUsd: 25.0
        }
      });
      const receipt = await adapter.executeSpotRebalance(input);

      expect(receipt.state).toBe('EXECUTION_CONFIRMED');
      expect(receipt.isDryRun).toBe(true);
      expect(receipt.orderId).toContain('dryrun-order-');
      expect(receipt.txHash).toMatch(/^0x[a-f0-9]{64}$/);
      expect(receipt.bscReceipt?.status).toBe('0x1');
      expect(mockWalletClient.submitMarketOrderSwap).not.toHaveBeenCalled();

      // Audit trail should record dry-run execution
      const audits = await auditStore.getExecutionRecords();
      expect(audits.length).toBe(1);
      expect(audits[0].isDryRun).toBe(true);
      expect(audits[0].finalExecutionStatus).toBe('EXECUTION_CONFIRMED');
    });

    it('20. Live execution switch disabled (allowLiveExecution = false) blocks live trade fail-closed', async () => {
      // adapter initialized with allowLiveExecution: false
      const input = createValidInput({
        options: { isDryRun: false }
      });
      const receipt = await adapter.executeSpotRebalance(input);

      expect(receipt.state).toBe('EXECUTION_BLOCKED');
      expect(receipt.blockReason).toBe('EXECUTION_BLOCKED_LIVE_EXECUTION_DISABLED');
      expect(receipt.failureReason).toContain('allowLiveExecution = false');
      expect(mockWalletClient.submitMarketOrderSwap).not.toHaveBeenCalled();
    });
  });

  describe('Live Spot Execution & On-Chain Receipt Lifecycle', () => {
    let liveAdapter: AgenticExecutionAdapter;

    beforeEach(() => {
      liveAdapter = new AgenticExecutionAdapter({
        walletClient: mockWalletClient,
        auditStore,
        allowLiveExecution: true, // Live execution explicitly enabled
        tinyExecutionCapUsd: 25.0,
        maxAllowedQuoteAgeSeconds: 900,
        maxPollingAttempts: 3,
        pollingIntervalMs: 50,
        requireUserApproval: true
      });
    });

    it('21. Successful live execution: submitted -> pending -> confirmed with valid BSC receipt (0x1)', async () => {
      const input = createValidInput({ options: { isDryRun: false } });
      const receipt = await liveAdapter.executeSpotRebalance(input);

      expect(receipt.state).toBe('EXECUTION_CONFIRMED');
      expect(receipt.orderId).toBe('baw-order-998877');
      expect(receipt.txHash).toBe('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
      expect(receipt.actualExecutedAmount).toBe(0.1);
      expect(receipt.bscReceipt?.status).toBe('0x1');
      expect(mockWalletClient.submitMarketOrderSwap).toHaveBeenCalledWith(expect.objectContaining({
        binanceChainId: '56',
        fromToken: stableContract,
        toToken: stockContract,
        fromTokenQty: 20.0
      }));

      // Confirm audit logging
      const audits = await auditStore.getExecutionRecords();
      expect(audits.length).toBe(1);
      expect(audits[0].finalExecutionStatus).toBe('EXECUTION_CONFIRMED');
      expect(audits[0].executionOrderId).toBe('baw-order-998877');
      expect(audits[0].txHash).toBe(receipt.txHash);
    });

    it('22. Execution pending: order remains PENDING after polling limit reached', async () => {
      const pendingClient = createMockWalletClient({
        getMarketOrderDetail: vi.fn(async (orderId: string): Promise<AgenticMarketOrderDetail> => ({
          orderId,
          status: 'PENDING',
          txHash: null
        }))
      });
      const pendingAdapter = new AgenticExecutionAdapter({
        walletClient: pendingClient,
        auditStore,
        allowLiveExecution: true,
        maxPollingAttempts: 2,
        pollingIntervalMs: 10
      });

      const receipt = await pendingAdapter.executeSpotRebalance(createValidInput());

      expect(receipt.state).toBe('EXECUTION_PENDING');
      expect(receipt.orderId).toBe('baw-order-998877');
      expect(receipt.txHash).toBeNull();
      expect(receipt.failureReason).toContain('still pending after 2 polling attempts');
    });

    it('23. Execution failure: order status FAILED from Agentic Wallet', async () => {
      const failedClient = createMockWalletClient({
        getMarketOrderDetail: vi.fn(async (orderId: string): Promise<AgenticMarketOrderDetail> => ({
          orderId,
          status: 'FAILED',
          txHash: null,
          failReason: 'Slippage tolerance exceeded'
        }))
      });
      const failedAdapter = new AgenticExecutionAdapter({
        walletClient: failedClient,
        auditStore,
        allowLiveExecution: true,
        maxPollingAttempts: 2,
        pollingIntervalMs: 10
      });

      const receipt = await failedAdapter.executeSpotRebalance(createValidInput());

      expect(receipt.state).toBe('EXECUTION_FAILED');
      expect(receipt.orderId).toBe('baw-order-998877');
      expect(receipt.failureReason).toContain('failed on-chain or at router');
    });

    it('24. Receipt confirmation failure: on-chain status 0x0 (reverted) -> EXECUTION_FAILED', async () => {
      const revertedClient = createMockWalletClient({
        getBscTransactionReceipt: vi.fn(async (txHash: string): Promise<BscTransactionReceipt> => ({
          transactionHash: txHash,
          blockNumber: 42000002,
          blockHash: '0xrevertedblockhash1234567890abcdef',
          from: dummyWallet,
          to: stockContract,
          status: '0x0', // REVERTED
          gasUsed: '80000',
          cumulativeGasUsed: '80000'
        }))
      });
      const revertedAdapter = new AgenticExecutionAdapter({
        walletClient: revertedClient,
        auditStore,
        allowLiveExecution: true
      });

      const receipt = await revertedAdapter.executeSpotRebalance(createValidInput());

      expect(receipt.state).toBe('EXECUTION_FAILED');
      expect(receipt.bscReceipt?.status).toBe('0x0');
      expect(receipt.failureReason).toContain('reverted on-chain (status 0x0)');
    });

    it('25. Ambiguous network response: lost response after swap dispatch -> EXECUTION_UNKNOWN', async () => {
      const timeoutClient = createMockWalletClient({
        submitMarketOrderSwap: vi.fn(async () => {
          throw new Error('ETIMEDOUT: Connection timed out waiting for Binance Web3 response');
        })
      });
      const timeoutAdapter = new AgenticExecutionAdapter({
        walletClient: timeoutClient,
        auditStore,
        allowLiveExecution: true
      });

      const receipt = await timeoutAdapter.executeSpotRebalance(createValidInput());

      expect(receipt.state).toBe('EXECUTION_UNKNOWN');
      expect(receipt.failureReason).toContain('ETIMEDOUT');
      expect(receipt.orderId).toBeNull();
    });

    it('26. Ambiguous receipt query: receipt query network error -> EXECUTION_UNKNOWN', async () => {
      const ambiguousReceiptClient = createMockWalletClient({
        getBscTransactionReceipt: vi.fn(async () => {
          throw new Error('BSC RPC timeout: Gateway disconnected');
        })
      });
      const ambiguousAdapter = new AgenticExecutionAdapter({
        walletClient: ambiguousReceiptClient,
        auditStore,
        allowLiveExecution: true
      });

      const receipt = await ambiguousAdapter.executeSpotRebalance(createValidInput());

      expect(receipt.state).toBe('EXECUTION_UNKNOWN');
      expect(receipt.failureReason).toContain('Failed to confirm BSC transaction receipt');
    });

    it('27. Duplicate execution prevented by SHA-256 idempotency key', async () => {
      const input = createValidInput();

      // First run executes
      const firstReceipt = await liveAdapter.executeSpotRebalance(input);
      expect(firstReceipt.state).toBe('EXECUTION_CONFIRMED');

      // Immediate retry of the identical proposal
      const secondReceipt = await liveAdapter.executeSpotRebalance(input);
      expect(secondReceipt.state).toBe('EXECUTION_BLOCKED');
      expect(secondReceipt.blockReason).toBe('EXECUTION_BLOCKED_DUPLICATE_EXECUTION');
      expect(secondReceipt.failureReason).toContain('proposal already executed');
      expect(mockWalletClient.submitMarketOrderSwap).toHaveBeenCalledTimes(1); // Not called twice!
    });
  });

  describe('Security, Hygiene & Legacy Handlers', () => {
    it('28. No private key or secret leakage across receipts and audit logs', async () => {
      const input = createValidInput();
      const receipt = await adapter.executeSpotRebalance(input);

      const receiptJson = JSON.stringify(receipt).toLowerCase();
      expect(receiptJson).not.toContain('privatekey');
      expect(receiptJson).not.toContain('private_key');
      expect(receiptJson).not.toContain('secret');
      expect(receiptJson).not.toContain('seedphrase');
      expect(receiptJson).not.toContain('mnemonic');

      const audits = await auditStore.getExecutionRecords();
      for (const record of audits) {
        const auditJson = JSON.stringify(record).toLowerCase();
        expect(auditJson).not.toContain('privatekey');
        expect(auditJson).not.toContain('secret');
        expect(auditJson).not.toContain('seedphrase');
      }
    });

    it('29. Legacy / shorthand (proposal, verification) call fails closed', async () => {
      const legacyProposal = {
        action: 'BUY_STOCK' as const,
        sourceAsset: 'USDC',
        targetAsset: 'NVDAB',
        tradeAmountUsd: 20,
        approxTokenAmount: 0.1,
        slippageLimitBps: 50,
        marketState: 'MARKET_OPEN' as const,
        reason: 'Legacy call',
        generatedAt: Date.now()
      };

      const receipt = await adapter.executeSpotRebalance(legacyProposal as any, validVerificationResult as any);

      expect(receipt.state).toBe('EXECUTION_BLOCKED');
      expect(receipt.blockReason).toBe('EXECUTION_BLOCKED_SIMULATION_FAILED');
      expect(receipt.failureReason).toContain('simulationResult and canonicalPayload is required');
    });

    it('30. buildUserApprovalRequest constructs complete structured request', () => {
      const input = createValidInput();
      const req = adapter.buildUserApprovalRequest(input);

      expect(req.proposalId).toBe(validCanonicalPayload.proposalId);
      expect(req.strategyId).toBe(validCanonicalPayload.strategyId);
      expect(req.action).toBe('BUY_STOCK');
      expect(req.sourceAsset).toBe('USDC');
      expect(req.targetAsset).toBe('NVDAB');
      expect(req.fromTokenAddress).toBe(stableContract);
      expect(req.toTokenAddress).toBe(stockContract);
      expect(req.tradeAmountUsd).toBe(20.0);
      expect(req.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
      expect(req.isTinyLiveCapEnforced).toBe(true);
    });
  });
});
