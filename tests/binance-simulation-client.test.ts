/**
 * StockPilot — Binance Web3 Transaction Simulation Client Unit Tests
 *
 * Tests the preflight simulation layer against strict sequential gating and fail-closed rules:
 * 1. Valid BUY proposal simulation -> SUCCESS
 * 2. Valid SELL proposal simulation -> SUCCESS
 * 3. NO_ACTION proposal -> rejected (no simulation dispatched)
 * 4. NOT_VERIFIED GenLayer decision -> rejected fail-closed
 * 5. REJECT GenLayer status -> rejected fail-closed
 * 6. Missing verification result -> rejected fail-closed
 * 7. Evidence hash mismatch (tampered payload) -> rejected fail-closed
 * 8. Proposal ID mismatch -> rejected fail-closed
 * 9. Market closed state -> rejected fail-closed
 * 10. Reference price stale state -> rejected fail-closed
 * 11. Stale quote age (> maxAllowed) -> rejected fail-closed
 * 12. Spread risk breach (> maxSpreadBps) -> rejected fail-closed
 * 13. Invalid EVM wallet address format -> rejected fail-closed
 * 14. Zero-address wallet (0x000...000) -> rejected fail-closed
 * 15. Non-positive trade amount -> rejected fail-closed
 * 16. Binance API error response (e.g. 40001, 50000) -> rejected fail-closed
 * 17. Binance KYT risk block code (e.g. 40311) -> rejected RISK_BLOCKED
 * 18. Rate limit response (42900) -> rejected RATE_LIMITED
 * 19. Simulation REVERT on-chain -> rejected REVERT with explicit reason
 * 20. Missing or invalid gas/fee data -> rejected MISSING_FEE_DATA
 * 21. HTTP non-200 status -> rejected SIMULATION_ERROR
 * 22. Network timeout / abort -> rejected NETWORK_ERROR
 * 23. Immutable audit trail accumulation and verification
 * 24. Pre-transaction getGasPrice helper method
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BinanceSimulationClient } from '../src/binance/simulation-client.js';
import { BinanceRequestSigner } from '../src/binance/request-signer.js';
import {
  buildCanonicalEvidencePayload,
  computeEvidenceHash
} from '../src/verification/genlayer-adapter.js';
import {
  GenLayerVerificationInput,
  DEFAULT_MVP_STRATEGY_CONFIG,
  PortfolioSnapshot,
  VerificationResult,
  CanonicalEvidencePayload,
  SimulationPreflightInput
} from '../src/types/index.js';

describe('Binance Web3 Transaction Preflight & Simulation Client', () => {
  const dummyWallet = '0xE422896590BE841D62423c8aE30940562e817085';
  const dummySigner = new BinanceRequestSigner({
    apiKey: 'test-api-key-1234567890',
    apiSecret: 'test-api-secret-1234567890abcdef'
  });

  const now = 1727250000000;

  // Base snapshot: 50 NVDAB ($10,000, 50%) + 10,000 USDC ($10,000, 50%) = $20,000 Total
  // Target: 60% stock ($12,000) / 40% stable ($8,000). Drift: 1000 bps (Underweight stock -> BUY_STOCK $2,000)
  const underweightSnapshot: PortfolioSnapshot = {
    timestamp: now,
    stock: {
      symbol: 'NVDAB',
      address: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
      amountRaw: 50000000000000000000n,
      decimals: 18,
      amountFormatted: 50,
      priceUsd: 200,
      valueUsd: 10000
    },
    stable: {
      symbol: 'USDC',
      address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      amountRaw: 10000000000000000000000n,
      decimals: 18,
      amountFormatted: 10000,
      priceUsd: 1,
      valueUsd: 10000
    },
    totalValueUsd: 20000,
    currentStockWeightBps: 5000,
    currentStableWeightBps: 5000,
    quoteTimestamp: now - 15000, // 15 seconds old
    quoteAgeSeconds: 15
  };

  const validBuyInput: GenLayerVerificationInput = {
    strategy: DEFAULT_MVP_STRATEGY_CONFIG,
    balances: {
      stock: {
        symbol: 'NVDAB',
        contractAddress: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
        rawAmount: '50000000000000000000',
        formattedAmount: 50,
        verificationStatus: 'VERIFIED'
      },
      stable: {
        symbol: 'USDC',
        contractAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
        rawAmount: '10000000000000000000000',
        formattedAmount: 10000,
        verificationStatus: 'VERIFIED'
      }
    },
    marketData: {
      stockTokenPrice: 200,
      stockReferencePrice: 199.5,
      spread: 0.0025,
      spreadBps: 25,
      quoteTimestamp: now - 15000,
      quoteAgeSeconds: 15
    },
    marketStatus: {
      state: 'MARKET_OPEN',
      openState: true
    },
    snapshot: underweightSnapshot,
    proposal: {
      action: 'BUY_STOCK',
      sourceAsset: 'USDC',
      targetAsset: 'NVDAB',
      tradeAmountUsd: 2000,
      approxTokenAmount: 10,
      slippageLimitBps: 50,
      marketState: 'MARKET_OPEN',
      reason: 'Underweight stock by 1000 bps > threshold 500 bps',
      generatedAt: now
    },
    riskChecks: {
      maxSpreadBps: 200,
      maxSingleTradeUsd: 5000,
      isSpreadExcessive: false,
      isCircuitBreakerTripped: false
    },
    timestamp: now,
    proposalId: 'prop-buy-test-001'
  };

  function createValidPreflightSetup() {
    const canonicalPayload = buildCanonicalEvidencePayload(validBuyInput);
    const evidenceHash = computeEvidenceHash(canonicalPayload);
    const verificationResult: VerificationResult = {
      status: 'ALLOW',
      decision: 'VERIFIED',
      evidenceHash,
      proposalId: canonicalPayload.proposalId,
      reason: 'Deterministic invariants and consensus verified.',
      verifiedAt: now
    };
    return { canonicalPayload, verificationResult };
  }

  it('1. Valid BUY proposal simulation succeeds with official Binance schema', async () => {
    const { canonicalPayload, verificationResult } = createValidPreflightSetup();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        msg: 'success',
        data: {
          status: 'SUCCESS',
          simulationCode: '000000000',
          gasUsed: '125430',
          gasLimit: '300000',
          gasPrice: '3000000000',
          estimatedFee: '0.00037629',
          revertReason: null
        }
      })
    });

    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    expect(result.decision).toBe('SIMULATED_OK');
    expect(result.status).toBe('SUCCESS');
    expect(result.gasUsed).toBe(125430n);
    expect(result.gasLimit).toBe(300000n);
    expect(result.gasPriceGwei).toBe(3);
    expect(result.estimatedFeeBnb).toBeCloseTo(0.00037629, 6);
    expect(result.simulationHash.startsWith('0x')).toBe(true);
    expect(result.revertReason).toBeNull();
    expect(client.getAuditTrail().length).toBe(1);
    expect(client.getAuditTrail()[0].decision).toBe('SIMULATED_OK');

    // Confirm that fetch was called with authenticated headers
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://web3.binance.com/build/api/v1/dex/pre-transaction/simulate');
    expect(options.method).toBe('POST');
    expect(options.headers['X-OC-APIKEY']).toBe('test-api-key-1234567890');
    expect(options.headers['X-OC-SIGN']).toBeDefined();
    const body = JSON.parse(options.body);
    expect(body.binanceChainId).toBe('56');
    expect(body.address).toBe(dummyWallet);
  });

  it('2. Valid SELL proposal simulation succeeds', async () => {
    const sellInput: GenLayerVerificationInput = {
      ...validBuyInput,
      proposal: {
        action: 'SELL_STOCK',
        sourceAsset: 'NVDAB',
        targetAsset: 'USDC',
        tradeAmountUsd: 1500,
        approxTokenAmount: 7.5,
        slippageLimitBps: 50,
        marketState: 'MARKET_OPEN',
        reason: 'Overweight stock',
        generatedAt: now
      },
      proposalId: 'prop-sell-test-002'
    };

    const canonicalPayload = buildCanonicalEvidencePayload(sellInput);
    const evidenceHash = computeEvidenceHash(canonicalPayload);
    const verificationResult: VerificationResult = {
      status: 'ALLOW',
      decision: 'VERIFIED',
      evidenceHash,
      proposalId: canonicalPayload.proposalId,
      reason: 'Sell rebalance verified',
      verifiedAt: now
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        msg: 'success',
        data: {
          status: 'SUCCESS',
          simulationCode: '000000000',
          gasUsed: '98400',
          gasLimit: '250000',
          gasPrice: '3000000000',
          estimatedFee: '0.0002952',
          revertReason: null
        }
      })
    });

    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    expect(result.decision).toBe('SIMULATED_OK');
    expect(result.status).toBe('SUCCESS');
    expect(result.gasUsed).toBe(98400n);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.to).toBe(canonicalPayload.stockContractAddress);
  });

  it('3. Rejects proposal when action is NONE (NO_ACTION) without API dispatch', async () => {
    const noneInput: GenLayerVerificationInput = {
      ...validBuyInput,
      proposal: {
        action: 'NONE',
        sourceAsset: 'USDC',
        targetAsset: 'NVDAB',
        tradeAmountUsd: 0,
        approxTokenAmount: 0,
        slippageLimitBps: 50,
        marketState: 'MARKET_OPEN',
        reason: 'Allocation within threshold',
        generatedAt: now
      },
      proposalId: 'prop-none-003'
    };

    const canonicalPayload = buildCanonicalEvidencePayload(noneInput);
    const evidenceHash = computeEvidenceHash(canonicalPayload);
    const verificationResult: VerificationResult = {
      status: 'ALLOW',
      decision: 'VERIFIED',
      evidenceHash,
      proposalId: canonicalPayload.proposalId,
      reason: 'No action needed',
      verifiedAt: now
    };

    const mockFetch = vi.fn();
    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('NO_ACTION_PROPOSAL');
    expect(result.reason).toContain('NONE');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(client.getAuditTrail().length).toBe(1);
    expect(client.getAuditTrail()[0].status).toBe('NO_ACTION_PROPOSAL');
  });

  it('4. Rejects when GenLayer decision is NOT_VERIFIED', async () => {
    const { canonicalPayload, verificationResult } = createValidPreflightSetup();
    verificationResult.decision = 'NOT_VERIFIED';

    const mockFetch = vi.fn();
    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('UNVERIFIED_PROPOSAL');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('5. Rejects when GenLayer status is REJECT', async () => {
    const { canonicalPayload, verificationResult } = createValidPreflightSetup();
    verificationResult.status = 'REJECT';

    const mockFetch = vi.fn();
    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('UNVERIFIED_PROPOSAL');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('6. Rejects when verificationResult is undefined or null', async () => {
    const { canonicalPayload } = createValidPreflightSetup();

    const mockFetch = vi.fn();
    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult: null as unknown as VerificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('UNVERIFIED_PROPOSAL');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('7. Rejects when evidenceHash does not match computed payload hash (tamper detection)', async () => {
    const { canonicalPayload, verificationResult } = createValidPreflightSetup();
    // Tamper with the evidence hash
    verificationResult.evidenceHash = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    const mockFetch = vi.fn();
    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('HASH_MISMATCH');
    expect(result.reason).toContain('Cryptographic tamper detection');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('8. Rejects when proposal IDs do not match', async () => {
    const { canonicalPayload, verificationResult } = createValidPreflightSetup();
    verificationResult.proposalId = 'different-proposal-id-999';

    const mockFetch = vi.fn();
    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('ID_MISMATCH');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('9. Rejects when marketState is MARKET_CLOSED', async () => {
    const closedInput = {
      ...validBuyInput,
      marketStatus: { state: 'MARKET_CLOSED' as const },
      proposal: {
        ...validBuyInput.proposal,
        marketState: 'MARKET_CLOSED' as const
      }
    };
    const canonicalPayload = buildCanonicalEvidencePayload(closedInput);
    const evidenceHash = computeEvidenceHash(canonicalPayload);
    const verificationResult: VerificationResult = {
      status: 'ALLOW',
      decision: 'VERIFIED',
      evidenceHash,
      proposalId: canonicalPayload.proposalId,
      reason: 'Verified',
      verifiedAt: now
    };

    const mockFetch = vi.fn();
    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('MARKET_CLOSED');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('10. Rejects when marketState is REFERENCE_STALE', async () => {
    const staleInput = {
      ...validBuyInput,
      marketStatus: { state: 'REFERENCE_STALE' as const },
      proposal: {
        ...validBuyInput.proposal,
        marketState: 'REFERENCE_STALE' as const
      }
    };
    const canonicalPayload = buildCanonicalEvidencePayload(staleInput);
    const evidenceHash = computeEvidenceHash(canonicalPayload);
    const verificationResult: VerificationResult = {
      status: 'ALLOW',
      decision: 'VERIFIED',
      evidenceHash,
      proposalId: canonicalPayload.proposalId,
      reason: 'Verified',
      verifiedAt: now
    };

    const mockFetch = vi.fn();
    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('MARKET_CLOSED');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('11. Rejects when quote telemetry is stale (quoteAgeSeconds > maxAllowedQuoteAgeSeconds)', async () => {
    const staleQuoteInput = {
      ...validBuyInput,
      marketData: {
        ...validBuyInput.marketData,
        quoteAgeSeconds: 95
      }
    };
    const canonicalPayload = buildCanonicalEvidencePayload(staleQuoteInput);
    const evidenceHash = computeEvidenceHash(canonicalPayload);
    const verificationResult: VerificationResult = {
      status: 'ALLOW',
      decision: 'VERIFIED',
      evidenceHash,
      proposalId: canonicalPayload.proposalId,
      reason: 'Verified',
      verifiedAt: now
    };

    const mockFetch = vi.fn();
    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet,
      maxAllowedQuoteAgeSeconds: 60
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('STALE_QUOTE');
    expect(result.reason).toContain('stale');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('12. Rejects when spread exceeds maximum allowable spread limit', async () => {
    const excessiveSpreadInput = {
      ...validBuyInput,
      marketData: {
        ...validBuyInput.marketData,
        spreadBps: 350
      },
      strategy: {
        ...validBuyInput.strategy,
        maxSpreadBps: 200
      }
    };
    const canonicalPayload = buildCanonicalEvidencePayload(excessiveSpreadInput);
    const evidenceHash = computeEvidenceHash(canonicalPayload);
    const verificationResult: VerificationResult = {
      status: 'ALLOW',
      decision: 'VERIFIED',
      evidenceHash,
      proposalId: canonicalPayload.proposalId,
      reason: 'Verified',
      verifiedAt: now
    };

    const mockFetch = vi.fn();
    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('SPREAD_RISK_BREACH');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('13. Rejects invalid EVM wallet address format', async () => {
    const { canonicalPayload, verificationResult } = createValidPreflightSetup();

    const mockFetch = vi.fn();
    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: '0xinvalid-format-not-an-evm-address'
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('INVALID_WALLET');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('14. Rejects zero address wallet (0x000...000)', async () => {
    const { canonicalPayload, verificationResult } = createValidPreflightSetup();

    const mockFetch = vi.fn();
    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: '0x0000000000000000000000000000000000000000'
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('INVALID_WALLET');
    expect(result.reason).toContain('zero address');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('15. Rejects non-positive trade amounts', async () => {
    const zeroTradeInput = {
      ...validBuyInput,
      proposal: {
        ...validBuyInput.proposal,
        tradeAmountUsd: 0,
        approxTokenAmount: 0
      }
    };
    const canonicalPayload = buildCanonicalEvidencePayload(zeroTradeInput);
    const evidenceHash = computeEvidenceHash(canonicalPayload);
    const verificationResult: VerificationResult = {
      status: 'ALLOW',
      decision: 'VERIFIED',
      evidenceHash,
      proposalId: canonicalPayload.proposalId,
      reason: 'Verified',
      verifiedAt: now
    };

    const mockFetch = vi.fn();
    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('INVALID_TRADE_AMOUNT');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('16. Rejects on Binance API parameter/server error codes (e.g. 40001, 50000)', async () => {
    const { canonicalPayload, verificationResult } = createValidPreflightSetup();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 40001,
        msg: 'Parameter [binanceChainId] error: unsupported chain'
      })
    });

    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('SIMULATION_ERROR');
    expect(result.reason).toContain('[code 40001]');
  });

  it('17. Rejects on Binance KYT compliance risk block codes (40311, 40312, 40434)', async () => {
    const { canonicalPayload, verificationResult } = createValidPreflightSetup();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 40311,
        msg: 'Transaction rejected due to high-risk address'
      })
    });

    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('RISK_BLOCKED');
    expect(result.reason).toContain('KYT / risk control blocked');
  });

  it('18. Rejects on Binance rate limit error code (42900)', async () => {
    const { canonicalPayload, verificationResult } = createValidPreflightSetup();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 42900,
        msg: 'Request rate limit exceeded. Please reduce request frequency.'
      })
    });

    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('RATE_LIMITED');
    expect(result.reason).toContain('rate limit exceeded');
  });

  it('19. Fails closed when on-chain simulation reverts with reason', async () => {
    const { canonicalPayload, verificationResult } = createValidPreflightSetup();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        msg: 'success',
        data: {
          status: 'REVERT',
          simulationCode: '351805',
          gasUsed: '21000',
          revertReason: 'execution reverted: ERC20: transfer amount exceeds balance'
        }
      })
    });

    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('REVERT');
    expect(result.revertReason).toBe('execution reverted: ERC20: transfer amount exceeds balance');
    expect(result.reason).toContain('reverted on-chain');
  });

  it('20. Fails closed when simulation response lacks valid gasUsed telemetry', async () => {
    const { canonicalPayload, verificationResult } = createValidPreflightSetup();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        msg: 'success',
        data: {
          status: 'SUCCESS',
          simulationCode: '000000000',
          gasUsed: '0', // Invalid zero gas
          gasPrice: '3000000000'
        }
      })
    });

    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('MISSING_FEE_DATA');
    expect(result.reason).toContain('lacks valid gasUsed');
  });

  it('21. Fails closed on HTTP non-200 status', async () => {
    const { canonicalPayload, verificationResult } = createValidPreflightSetup();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        code: 50001,
        msg: 'Service temporarily unavailable'
      })
    });

    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('SIMULATION_ERROR');
    expect(result.reason).toContain('non-200 HTTP status (503)');
  });

  it('22. Fails closed on network timeout or fetch rejection', async () => {
    const { canonicalPayload, verificationResult } = createValidPreflightSetup();

    const mockFetch = vi.fn().mockRejectedValue(new Error('Network connection reset by peer'));

    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const result = await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    expect(result.decision).toBe('SIMULATION_FAILED');
    expect(result.status).toBe('NETWORK_ERROR');
    expect(result.reason).toContain('Network connection reset by peer');
  });

  it('23. Verifies immutable audit trail recording and reset', async () => {
    const { canonicalPayload, verificationResult } = createValidPreflightSetup();

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        msg: 'success',
        data: {
          status: 'SUCCESS',
          simulationCode: '000000000',
          gasUsed: '120000',
          gasLimit: '300000',
          gasPrice: '3000000000',
          estimatedFee: '0.00036'
        }
      })
    });

    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    expect(client.getAuditTrail().length).toBe(0);

    await client.simulatePreflight({
      verificationResult,
      canonicalPayload,
      walletAddress: dummyWallet
    });

    const trail = client.getAuditTrail();
    expect(trail.length).toBe(1);
    expect(trail[0].auditId.startsWith('sim-audit-')).toBe(true);
    expect(trail[0].decision).toBe('SIMULATED_OK');
    expect(trail[0].gasUsed).toBe('120000');
    expect(trail[0].simulationHash.startsWith('0x')).toBe(true);

    client.clearAuditTrail();
    expect(client.getAuditTrail().length).toBe(0);
  });

  it('24. getGasPrice helper retrieves and normalizes gas price', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        code: 0,
        msg: 'success',
        data: {
          gasPrice: '3000000000',
          standard: '3000000000',
          fast: '3500000000'
        }
      })
    });

    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const gasInfo = await client.getGasPrice('56');
    expect(gasInfo).not.toBeNull();
    expect(gasInfo?.gasPriceWei).toBe('3000000000');
    expect(gasInfo?.gasPriceGwei).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/api/v1/dex/pre-transaction/gas-price?binanceChainId=56');
  });

  it('25. getGasPrice returns null gracefully on API error or network failure', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ code: 50000, msg: 'Internal server error' })
    });

    const client = new BinanceSimulationClient({
      signer: dummySigner,
      fetchFn: mockFetch as unknown as typeof fetch
    });

    const gasInfo = await client.getGasPrice('56');
    expect(gasInfo).toBeNull();
  });
});
