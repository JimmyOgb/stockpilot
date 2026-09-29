import { describe, expect, it, vi } from 'vitest';
import { BinanceRequestSigner } from '../src/binance/request-signer.js';
import { BinanceSimulationClient } from '../src/binance/simulation-client.js';
import { GenLayerVerificationAdapter, buildCanonicalEvidencePayload, computeEvidenceHash } from '../src/verification/genlayer-adapter.js';
import { DEFAULT_MVP_STRATEGY_CONFIG, GenLayerVerificationInput } from '../src/types/index.js';

const wallet = '0xE422896590BE841D62423c8aE30940562e817085';
const checks = {
  payload_valid: true, math_consistent: true, direction_consistent: true, spread_permitted: true,
  circuit_breaker_passed: true, market_state_permitted: true, non_zero_portfolio: true,
  freshness_passed: true, balance_verified: true, price_verified: true, spread_verified: true,
  market_state_verified: true, allocation_drift_valid: true, trade_direction_valid: true,
  trade_amount_valid: true, risk_limits_passed: true
};

function input(overrides: Partial<GenLayerVerificationInput> = {}): GenLayerVerificationInput {
  const now = Date.now();
  return {
    strategy: DEFAULT_MVP_STRATEGY_CONFIG,
    balances: {
      stock: { symbol: 'NVDAB', contractAddress: DEFAULT_MVP_STRATEGY_CONFIG.stockAddress, rawAmount: '50000000000000000000', formattedAmount: 50, verificationStatus: 'VERIFIED' },
      stable: { symbol: 'USDC', contractAddress: DEFAULT_MVP_STRATEGY_CONFIG.stableAddress, rawAmount: '10000000000000000000000', formattedAmount: 10000, verificationStatus: 'VERIFIED' }
    },
    marketData: { stockTokenPrice: 200, stockReferencePrice: 200, spread: 0, spreadBps: 0, quoteTimestamp: now - 10000, quoteAgeSeconds: 10 },
    marketStatus: { state: 'MARKET_OPEN' },
    snapshot: { timestamp: now, stock: { symbol: 'NVDAB', address: DEFAULT_MVP_STRATEGY_CONFIG.stockAddress, amountRaw: 50000000000000000000n, decimals: 18, amountFormatted: 50, priceUsd: 200, valueUsd: 10000 }, stable: { symbol: 'USDC', address: DEFAULT_MVP_STRATEGY_CONFIG.stableAddress, amountRaw: 10000000000000000000000n, decimals: 18, amountFormatted: 10000, priceUsd: 1, valueUsd: 10000 }, totalValueUsd: 20000, currentStockWeightBps: 5000, currentStableWeightBps: 5000, quoteTimestamp: now - 10000, quoteAgeSeconds: 10 },
    proposal: { action: 'BUY_STOCK', sourceAsset: 'USDC', targetAsset: 'NVDAB', tradeAmountUsd: 20, approxTokenAmount: 0.1, slippageLimitBps: 50, marketState: 'MARKET_OPEN', reason: 'drift', generatedAt: now },
    riskChecks: { maxSpreadBps: 200, maxSingleTradeUsd: 5000, isSpreadExcessive: false, isCircuitBreakerTripped: false }, timestamp: now,
    ...overrides
  };
}

function responseFor(result: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 }));
}

async function runWorkflow(testInput: GenLayerVerificationInput, result: unknown) {
  const verifier = new GenLayerVerificationAdapter({ verifierContractAddress: '0x1111111111111111111111111111111111111111', fetchFn: responseFor(result) });
  const verification = await verifier.verifyProposal(testInput);
  const signer = new BinanceRequestSigner({ apiKey: 'test-key', apiSecret: 'test-secret' });
  const simulation = new BinanceSimulationClient({ signer, fetchFn: vi.fn(async () => new Response('{}', { status: 500 })) });
  const canonicalPayload = buildCanonicalEvidencePayload(testInput);
  const simulated = await simulation.simulatePreflight({ verificationResult: verification, canonicalPayload, walletAddress: wallet });
  return { verification, simulated };
}

describe('Steward remediation application workflow', () => {
  it('allows simulation only for finalized accepted consensus', async () => {
    const workflowInput = input();
    const canonical = buildCanonicalEvidencePayload(workflowInput);
    const result = await runWorkflow(workflowInput, { finalized: true, consensus_status: 'FINALIZED', status: 'ALLOW', reason: 'accepted', evidence_hash: computeEvidenceHash(canonical), proposal_id: canonical.proposalId, checks });
    expect(result.verification.decision).toBe('VERIFIED');
    expect(result.verification.status).toBe('ALLOW');
    expect(result.simulated.status).not.toBe('UNVERIFIED_PROPOSAL');
  });

  it.each([
    ['NO_MAJORITY', { error: { message: 'NO_MAJORITY' } }],
    ['PENDING', { finalized: false, consensus_status: 'PENDING', status: 'ALLOW' }],
    ['hash mismatch', { finalized: true, consensus_status: 'FINALIZED', status: 'ALLOW', reason: 'bad', evidence_hash: '0x' + '0'.repeat(64), proposal_id: 'wrong', checks }],
    ['malformed', { finalized: true, consensus_status: 'FINALIZED', status: 'ALLOW', reason: 'bad', evidence_hash: 'bad', proposal_id: 'wrong' }],
    ['missing check', { finalized: true, consensus_status: 'FINALIZED', status: 'ALLOW', reason: 'bad', evidence_hash: '0x' + '0'.repeat(64), proposal_id: 'wrong', checks: { ...checks, balance_verified: undefined } }]
  ])('blocks %s before simulation', async (_name, result) => {
    const run = await runWorkflow(input(), result);
    expect(run.verification.decision).toBe('NOT_VERIFIED');
    expect(run.simulated.status).toBe('UNVERIFIED_PROPOSAL');
  });

  it.each([
    ['balance', { balances: { ...input().balances, stock: { ...input().balances.stock, verificationStatus: 'MISMATCH' } } }],
    ['price', { marketData: { ...input().marketData, stockTokenPrice: 0 } }],
    ['spread', { marketData: { ...input().marketData, stockTokenPrice: 210 } }],
    ['market state', { marketStatus: { state: 'MARKET_CLOSED' } }],
    ['freshness', { marketData: { ...input().marketData, quoteTimestamp: Date.now() - 901000 } }],
    ['trade amount', { proposal: { ...input().proposal, tradeAmountUsd: 6000 } }]
  ])('blocks tampered %s evidence', async (_name, overrides) => {
    const run = await runWorkflow(input(overrides), {});
    expect(run.verification.decision).toBe('NOT_VERIFIED');
    expect(run.simulated.status).toBe('UNVERIFIED_PROPOSAL');
  });
});
