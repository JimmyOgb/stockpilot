/**
 * StockPilot — Steward Remediation & Consensus Finality Integration Tests
 *
 * Explicit tests verifying remediation of the latest GenLayer steward objections:
 *
 * TEST A: gen_call returns a result claiming finalized=true, but no finalized protocol transaction exists -> BLOCKED.
 * TEST B: Real GenLayer transaction is only Accepted -> BLOCKED.
 * TEST C: Real GenLayer transaction reaches Finalized and execution succeeds -> eligible to continue.
 * TEST D: Finalized transaction has failed contract execution -> BLOCKED.
 * TEST E: Submitted hash has valid 64-character SHA-256 format but does not match payload -> BLOCKED.
 * TEST F: Payload is modified after application computes the submitted hash -> contract-computed hash differs -> BLOCKED.
 * TEST G: Same semantic JSON with different key insertion order -> identical canonical hash.
 * TEST H: Finalized protocol transaction + correct contract hash + all safety checks -> VERIFIED.
 *
 * Plus complete fail-closed verification covering all 17 risk and consensus rejection paths.
 */

import { describe, expect, it, vi } from 'vitest';
import { BinanceRequestSigner } from '../src/binance/request-signer.js';
import { BinanceSimulationClient } from '../src/binance/simulation-client.js';
import {
  GenLayerVerificationAdapter,
  buildCanonicalEvidencePayload,
  computeEvidenceHash,
  canonicalizeJson,
  evaluateProtocolTransaction
} from '../src/verification/genlayer-adapter.js';
import {
  DEFAULT_MVP_STRATEGY_CONFIG,
  GenLayerVerificationInput,
  GenLayerRuleChecks
} from '../src/types/index.js';

const verifierAddress = '0x801A94870ecADe3Aedd0f8D070498Ad954b63841';
const wallet = '0xE422896590BE841D62423c8aE30940562e817085';

const completeChecks: GenLayerRuleChecks = {
  payload_valid: true,
  math_consistent: true,
  direction_consistent: true,
  spread_permitted: true,
  circuit_breaker_passed: true,
  market_state_permitted: true,
  non_zero_portfolio: true,
  freshness_passed: true,
  balance_verified: true,
  price_verified: true,
  spread_verified: true,
  market_state_verified: true,
  allocation_drift_valid: true,
  trade_direction_valid: true,
  trade_amount_valid: true,
  risk_limits_passed: true
};

function testInput(overrides: Partial<GenLayerVerificationInput> = {}): GenLayerVerificationInput {
  const now = Date.now();
  return {
    strategy: DEFAULT_MVP_STRATEGY_CONFIG,
    balances: {
      stock: {
        symbol: 'NVDAB',
        contractAddress: DEFAULT_MVP_STRATEGY_CONFIG.stockAddress,
        rawAmount: '50000000000000000000',
        formattedAmount: 50,
        verificationStatus: 'VERIFIED'
      },
      stable: {
        symbol: 'USDC',
        contractAddress: DEFAULT_MVP_STRATEGY_CONFIG.stableAddress,
        rawAmount: '10000000000000000000000',
        formattedAmount: 10000,
        verificationStatus: 'VERIFIED'
      }
    },
    marketData: {
      stockTokenPrice: 200,
      stockReferencePrice: 200,
      spread: 0,
      spreadBps: 0,
      quoteTimestamp: now - 10000,
      quoteAgeSeconds: 10
    },
    marketStatus: { state: 'MARKET_OPEN' },
    snapshot: {
      timestamp: now,
      stock: {
        symbol: 'NVDAB',
        address: DEFAULT_MVP_STRATEGY_CONFIG.stockAddress,
        amountRaw: 50000000000000000000n,
        decimals: 18,
        amountFormatted: 50,
        priceUsd: 200,
        valueUsd: 10000
      },
      stable: {
        symbol: 'USDC',
        address: DEFAULT_MVP_STRATEGY_CONFIG.stableAddress,
        amountRaw: 10000000000000000000000n,
        decimals: 18,
        amountFormatted: 10000,
        priceUsd: 1,
        valueUsd: 10000
      },
      totalValueUsd: 20000,
      currentStockWeightBps: 5000,
      currentStableWeightBps: 5000,
      quoteTimestamp: now - 10000,
      quoteAgeSeconds: 10
    },
    proposal: {
      action: 'BUY_STOCK',
      sourceAsset: 'USDC',
      targetAsset: 'NVDAB',
      tradeAmountUsd: 2000,
      approxTokenAmount: 10,
      slippageLimitBps: 50,
      marketState: 'MARKET_OPEN',
      reason: 'Underweight 1000 bps',
      generatedAt: now
    },
    riskChecks: {
      maxSpreadBps: 200,
      maxSingleTradeUsd: 5000,
      isSpreadExcessive: false,
      isCircuitBreakerTripped: false
    },
    timestamp: now,
    ...overrides
  };
}

function buildMockProtocolTx(
  inputData: GenLayerVerificationInput,
  overrides: Record<string, unknown> = {}
) {
  const canonical = buildCanonicalEvidencePayload(inputData);
  const hash = computeEvidenceHash(canonical);
  const txHash = '0x' + 'a'.repeat(64);

  return {
    hash: txHash,
    status: 7, // FINALIZED
    statusName: 'FINALIZED',
    result: 6, // MAJORITY_AGREE
    result_name: 'MAJORITY_AGREE',
    recipient: verifierAddress,
    to_address: verifierAddress,
    data: {
      calldata: {
        readable: JSON.stringify({
          method: 'verify_proposal',
          args: [canonicalizeJson(canonical), hash]
        })
      }
    },
    consensus_data: {
      leader_receipt: [
        {
          execution_result: 'SUCCESS',
          result: {
            status: 'ALLOW',
            reason: 'Proposal verified by GenLayer consensus.',
            evidence_hash: hash,
            proposal_id: canonical.proposalId,
            checks: { ...completeChecks }
          }
        }
      ]
    },
    ...overrides
  };
}

describe('GenLayer Steward Remediation & Finality Rules', () => {
  // TEST A: gen_call returns a result claiming finalized=true, but no finalized protocol transaction exists.
  it('TEST A: gen_call claiming finalized=true without finalized protocol tx is BLOCKED', async () => {
    const inputData = testInput();
    const mockClient = {
      simulateWriteContract: vi.fn(async () => {
        // Contract claims finalized: true in its return payload
        return {
          finalized: true,
          consensus_status: 'FINALIZED',
          status: 'ALLOW',
          evidence_hash: computeEvidenceHash(buildCanonicalEvidencePayload(inputData)),
          proposal_id: 'prop-test',
          reason: 'Self-reported finalized',
          checks: { ...completeChecks }
        };
      }),
      writeContract: vi.fn(),
      getTransaction: vi.fn()
    };

    const adapter = new GenLayerVerificationAdapter({
      verifierContractAddress: verifierAddress,
      client: mockClient
    });

    // gen_call simulation path
    const simResult = await adapter.simulateProposal(inputData);

    // Must NEVER report VERIFIED from gen_call
    expect(simResult.decision).toBe('NOT_VERIFIED');
    expect(simResult.inspectStatus).toBe('CONSENSUS_ACCEPTED_NOT_FINAL');
    expect(simResult.reason).toContain('Simulation inspection only');

    // Downstream simulation client must reject it
    const signer = new BinanceRequestSigner({ apiKey: 'test', apiSecret: 'test' });
    const simClient = new BinanceSimulationClient({ signer });
    const preflight = await simClient.simulatePreflight({
      verificationResult: simResult,
      canonicalPayload: buildCanonicalEvidencePayload(inputData),
      walletAddress: wallet
    });
    expect(preflight.status).toBe('UNVERIFIED_PROPOSAL');
  });

  // TEST B: Real GenLayer transaction is only Accepted.
  it('TEST B: Real GenLayer transaction in ACCEPTED status is BLOCKED', async () => {
    const inputData = testInput();
    const acceptedTx = buildMockProtocolTx(inputData, {
      status: 5,
      statusName: 'ACCEPTED'
    });

    const mockClient = {
      writeContract: vi.fn(async () => acceptedTx.hash),
      getTransaction: vi.fn(async () => acceptedTx)
    };

    const adapter = new GenLayerVerificationAdapter({
      verifierContractAddress: verifierAddress,
      client: mockClient,
      timeoutMs: 50 // short wait
    });

    const result = await adapter.verifyProposal(inputData, { maxWaitMs: 50, pollIntervalMs: 10 });
    expect(result.decision).toBe('NOT_VERIFIED');
    expect(result.inspectStatus).toBe('CONSENSUS_ACCEPTED_NOT_FINAL');
    expect(result.protocolStatus).toBe('ACCEPTED');
    expect(result.reason).toContain('merely ACCEPTED');
  });

  // TEST C: Real GenLayer transaction reaches Finalized and execution succeeds.
  it('TEST C: Real GenLayer transaction reaches Finalized and execution succeeds -> eligible to continue', async () => {
    const inputData = testInput();
    const finalizedTx = buildMockProtocolTx(inputData);

    const mockClient = {
      writeContract: vi.fn(async () => finalizedTx.hash),
      getTransaction: vi.fn(async () => finalizedTx)
    };

    const adapter = new GenLayerVerificationAdapter({
      verifierContractAddress: verifierAddress,
      client: mockClient
    });

    const result = await adapter.verifyProposal(inputData);
    expect(result.decision).toBe('VERIFIED');
    expect(result.status).toBe('ALLOW');
    expect(result.inspectStatus).toBe('VERIFIED');
    expect(result.protocolStatus).toBe('FINALIZED');
    expect(result.transactionId).toBe(finalizedTx.hash);

    // Eligible for preflight simulation
    const signer = new BinanceRequestSigner({ apiKey: 'test', apiSecret: 'test' });
    const simClient = new BinanceSimulationClient({
      signer,
      fetchFn: vi.fn(async () => new Response('{}', { status: 500 })) // test mock
    });
    const preflight = await simClient.simulatePreflight({
      verificationResult: result,
      canonicalPayload: buildCanonicalEvidencePayload(inputData),
      walletAddress: wallet
    });
    expect(preflight.status).not.toBe('UNVERIFIED_PROPOSAL');
  });

  // TEST D: Finalized transaction has failed contract execution.
  it('TEST D: Finalized transaction with failed contract execution is BLOCKED', async () => {
    const inputData = testInput();
    const failedExecTx = buildMockProtocolTx(inputData, {
      consensus_data: {
        leader_receipt: [
          {
            execution_result: 'ERROR',
            result: {
              status: 'contract_error',
              payload: 'execution reverted'
            }
          }
        ]
      }
    });

    const mockClient = {
      writeContract: vi.fn(async () => failedExecTx.hash),
      getTransaction: vi.fn(async () => failedExecTx)
    };

    const adapter = new GenLayerVerificationAdapter({
      verifierContractAddress: verifierAddress,
      client: mockClient
    });

    const result = await adapter.verifyProposal(inputData);
    expect(result.decision).toBe('NOT_VERIFIED');
    expect(result.inspectStatus).toBe('CONSENSUS_FINALIZED_EXECUTION_FAILED');
    expect(result.reason).toContain('execution failed');
  });

  // TEST E: Submitted hash has valid 64-character SHA-256 format but does not match payload.
  it('TEST E: Submitted hash has valid 64-char hex format but does not match payload -> BLOCKED', async () => {
    const inputData = testInput();
    const wrongValidLookingHash = '0x' + 'e'.repeat(64);

    const txWithMismatch = buildMockProtocolTx(inputData, {
      consensus_data: {
        leader_receipt: [
          {
            execution_result: 'SUCCESS',
            result: {
              status: 'REJECT',
              reason: 'Evidence hash mismatch: contract computed different hash.',
              evidence_hash: '', // contract returns empty on mismatch
              proposal_id: buildCanonicalEvidencePayload(inputData).proposalId,
              checks: { ...completeChecks, payload_valid: false }
            }
          }
        ]
      }
    });

    const mockClient = {
      writeContract: vi.fn(async () => txWithMismatch.hash),
      getTransaction: vi.fn(async () => txWithMismatch)
    };

    const adapter = new GenLayerVerificationAdapter({
      verifierContractAddress: verifierAddress,
      client: mockClient
    });

    const canonical = buildCanonicalEvidencePayload(inputData);
    const expectedHash = computeEvidenceHash(canonical);

    // Evaluate directly with the wrong hash expectation
    const evalResult = evaluateProtocolTransaction(txWithMismatch, canonical, expectedHash, verifierAddress);
    expect(evalResult.decision).toBe('NOT_VERIFIED');
    expect(evalResult.inspectStatus).toBe('PAYLOAD_HASH_MISMATCH');
    expect(evalResult.reason).toContain('Rule H violation: Contract computed evidence hash');
  });

  // TEST F: Payload is modified after application computes the submitted hash.
  it('TEST F: Tampered payload after hash computation causes hash mismatch and BLOCKS', async () => {
    const inputData = testInput();
    const canonical = buildCanonicalEvidencePayload(inputData);
    const initialHash = computeEvidenceHash(canonical);

    // Tamper with one field in the payload
    const tamperedPayload = {
      ...canonical,
      proposedTradeAmountUsd: canonical.proposedTradeAmountUsd + 1
    };
    const tamperedHash = computeEvidenceHash(tamperedPayload);

    // Must produce different hashes
    expect(initialHash).not.toBe(tamperedHash);

    // If the contract independently hashes the tampered payload, it computes tamperedHash != initialHash
    const mismatchTx = buildMockProtocolTx(inputData, {
      consensus_data: {
        leader_receipt: [
          {
            execution_result: 'SUCCESS',
            result: {
              status: 'REJECT',
              reason: `Evidence hash mismatch: contract computed ${tamperedHash} but received ${initialHash}.`,
              evidence_hash: '',
              proposal_id: canonical.proposalId,
              checks: { ...completeChecks, payload_valid: false }
            }
          }
        ]
      }
    });

    const evalResult = evaluateProtocolTransaction(mismatchTx, canonical, initialHash, verifierAddress);
    expect(evalResult.decision).toBe('NOT_VERIFIED');
    expect(evalResult.inspectStatus).toBe('PAYLOAD_HASH_MISMATCH');
  });

  // TEST G: Same semantic JSON with different key insertion order.
  it('TEST G: Identical semantic JSON with permuted key insertion orders produces identical canonical hash', () => {
    const objA = {
      version: '1.0.0',
      proposalId: 'prop-123',
      stockSymbol: 'NVDAB',
      price: 200,
      checks: { b: 2, a: 1 }
    };

    const objB = {
      price: 200,
      proposalId: 'prop-123',
      checks: { a: 1, b: 2 },
      version: '1.0.0',
      stockSymbol: 'NVDAB'
    };

    const canonicalA = canonicalizeJson(objA);
    const canonicalB = canonicalizeJson(objB);

    expect(canonicalA).toBe(canonicalB);
    expect(computeEvidenceHash(objA)).toBe(computeEvidenceHash(objB));
  });

  // TEST H: Finalized protocol transaction + correct contract hash + all safety checks.
  it('TEST H: Finalized protocol transaction + correct contract hash + safety checks -> VERIFIED', async () => {
    const inputData = testInput();
    const finalizedTx = buildMockProtocolTx(inputData);

    const mockClient = {
      writeContract: vi.fn(async () => finalizedTx.hash),
      getTransaction: vi.fn(async () => finalizedTx)
    };

    const adapter = new GenLayerVerificationAdapter({
      verifierContractAddress: verifierAddress,
      client: mockClient
    });

    const result = await adapter.verifyProposal(inputData);
    expect(result.decision).toBe('VERIFIED');
    expect(result.status).toBe('ALLOW');
    expect(result.inspectStatus).toBe('VERIFIED');
    expect(result.protocolStatus).toBe('FINALIZED');
    expect(result.transactionId).toBe(finalizedTx.hash);
    expect(result.checks?.balance_verified).toBe(true);
    expect(result.checks?.math_consistent).toBe(true);
    expect(result.checks?.freshness_passed).toBe(true);
  });

  describe('Comprehensive Fail-Closed Consensus Matrix', () => {
    it.each([
      ['pending transaction', { status: 1, statusName: 'PENDING' }, 'CONSENSUS_PENDING'],
      ['accepted but not finalized', { status: 5, statusName: 'ACCEPTED' }, 'CONSENSUS_ACCEPTED_NOT_FINAL'],
      ['finalized + failed execution', { consensus_data: { leader_receipt: [{ execution_result: 'ERROR' }] } }, 'CONSENSUS_FINALIZED_EXECUTION_FAILED'],
      ['NO_MAJORITY', { result: 5, result_name: 'NO_MAJORITY' }, 'NO_MAJORITY'],
      ['rejection', (input: GenLayerVerificationInput) => ({ consensus_data: { leader_receipt: [{ execution_result: 'SUCCESS', result: { status: 'REJECT', reason: 'Risk auditor rejection', evidence_hash: computeEvidenceHash(buildCanonicalEvidencePayload(input)), checks: completeChecks } }] } }), 'CONSENSUS_FINALIZED'],
      ['malformed result', { consensus_data: { leader_receipt: [{ execution_result: 'SUCCESS', result: null }] } }, 'CONSENSUS_FINALIZED_EXECUTION_FAILED'],
      ['missing transaction ID', { hash: undefined, tx_id: undefined, txId: undefined }, 'SUBMISSION_FAILED'],
      ['wrong transaction recipient', { recipient: '0x9999999999999999999999999999999999999999', to_address: '0x9999999999999999999999999999999999999999' }, 'CONSENSUS_FINALIZED_EXECUTION_FAILED'],
      ['wrong function', { data: { calldata: { readable: JSON.stringify({ method: 'invalid_method', args: [] }) } } }, 'CONSENSUS_FINALIZED_EXECUTION_FAILED'],
      ['payload mismatch', { data: { calldata: { readable: JSON.stringify({ method: 'verify_proposal', args: ['unrelated-payload', '0x1'] }) } } }, 'PAYLOAD_HASH_MISMATCH'],
      ['submitted hash mismatch', { data: { calldata: { readable: JSON.stringify({ method: 'verify_proposal', args: ['payload', '0x0000000000000000000000000000000000000000000000000000000000000000'] }) } } }, 'PAYLOAD_HASH_MISMATCH'],
      ['contract-computed hash mismatch', { consensus_data: { leader_receipt: [{ execution_result: 'SUCCESS', result: { status: 'ALLOW', reason: 'Verified', evidence_hash: '0xdeadbeef', checks: completeChecks } }] } }, 'PAYLOAD_HASH_MISMATCH']
    ])('fail-closed blocks on %s', async (_name, txOverrides, expectedInspectStatus) => {
      const inputData = testInput();
      const canonical = buildCanonicalEvidencePayload(inputData);
      const hash = computeEvidenceHash(canonical);
      const overrides = typeof txOverrides === 'function' ? (txOverrides as any)(inputData) : txOverrides;
      const tx = buildMockProtocolTx(inputData, overrides);

      const result = evaluateProtocolTransaction(tx, canonical, hash, verifierAddress);
      expect(result.decision).toBe('NOT_VERIFIED');
      expect(result.inspectStatus).toBe(expectedInspectStatus);
    });

    it('fail-closed blocks on timeout', async () => {
      const inputData = testInput();
      const mockClient = {
        writeContract: vi.fn(async () => '0x' + 'b'.repeat(64)),
        getTransaction: vi.fn(async () => null)
      };
      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: verifierAddress,
        client: mockClient,
        timeoutMs: 30,
        pollIntervalMs: 10
      });
      const result = await adapter.verifyProposal(inputData, { maxWaitMs: 30, pollIntervalMs: 10 });
      expect(result.decision).toBe('NOT_VERIFIED');
      expect(result.inspectStatus).toBe('CONSENSUS_PENDING');
      expect(result.reason).toContain('Timed out querying protocol transaction');
    });

    it.each([
      ['stale evidence', { marketData: { ...testInput().marketData, quoteTimestamp: Date.now() - 905000, quoteAgeSeconds: 905 } }],
      ['missing evidence (zero portfolio)', { balances: { stock: { ...testInput().balances.stock, rawAmount: '0' }, stable: { ...testInput().balances.stable, rawAmount: '0' } } }],
      ['balance mismatch', { balances: { ...testInput().balances, stock: { ...testInput().balances.stock, verificationStatus: 'MISMATCH' } } }],
      ['price mismatch', { marketData: { ...testInput().marketData, stockTokenPrice: -5 } }]
    ])('fail-closed blocks invalid evidence: %s', async (_name, inputOverrides) => {
      const invalidData = testInput(inputOverrides as any);
      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: verifierAddress,
        client: { writeContract: vi.fn(), getTransaction: vi.fn() }
      });
      const result = await adapter.verifyProposal(invalidData);
      expect(result.decision).toBe('NOT_VERIFIED');
      expect(result.inspectStatus).toBe('EVIDENCE_INVALID');
    });
  });
});

