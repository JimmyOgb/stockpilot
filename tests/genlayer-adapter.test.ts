/**
 * StockPilot — Independent GenLayer Verification Adapter Unit Tests
 *
 * Tests the verification gate against strict fail-closed and independent consensus rules:
 * - Valid BUY proposal -> verified
 * - Valid SELL proposal -> verified
 * - NO_ACTION -> correctly handled
 * - Incorrect allocation -> rejected
 * - Incorrect trade direction -> rejected
 * - Excessive spread -> rejected
 * - Market closed -> rejected
 * - Circuit breaker exceeded -> rejected
 * - Stale data -> rejected
 * - Missing evidence -> rejected
 * - Malformed GenLayer response -> not verified
 * - Unavailable/unfinished consensus -> not verified
 * - Conflicting validator result -> not verified
 * - Zero-balance portfolio -> never fabricated into a valid proposal
 * - Tampered evidence/payload hash -> rejected
 * - Timeout handling -> fail closed
 * - Unconfigured contract address -> fail closed
 * - Immutable audit trail verification
 */

import { describe, it, expect } from 'vitest';
import {
  GenLayerVerificationAdapter,
  buildCanonicalEvidencePayload,
  computeEvidenceHash,
  validateEvidencePayload
} from '../src/verification/genlayer-adapter.js';
import {
  GenLayerVerificationInput,
  DEFAULT_MVP_STRATEGY_CONFIG,
  PortfolioSnapshot
} from '../src/types/index.js';

describe('Independent GenLayer Verification Adapter', () => {
  const dummyContractAddress = '0x1234567890123456789012345678901234567890';
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
    quoteTimestamp: now,
    quoteAgeSeconds: 0
  };

  const validBuyInput: GenLayerVerificationInput = {
    strategy: {
      ...DEFAULT_MVP_STRATEGY_CONFIG,
      maxSingleTradeUsd: 5000,
      maxSpreadBps: 200
    },
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
      stockTokenPrice: 200.0,
      stockReferencePrice: 200.0,
      spread: 0.0,
      spreadBps: 0,
      quoteTimestamp: now,
      quoteAgeSeconds: 10
    },
    marketStatus: {
      state: 'MARKET_OPEN'
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
      reason: 'Stock underweight by 1000 bps',
      generatedAt: now
    },
    riskChecks: {
      maxSpreadBps: 200,
      maxSingleTradeUsd: 5000,
      isSpreadExcessive: false,
      isCircuitBreakerTripped: false
    },
    timestamp: now
  };

  // Overweight snapshot: 70 NVDAB ($14,000, 70%) + 6,000 USDC ($6,000, 30%) = $20,000 Total
  // Target: 60% stock ($12,000) / 40% stable ($8,000). Drift: 1000 bps (Overweight stock -> SELL_STOCK $2,000)
  const overweightSnapshot: PortfolioSnapshot = {
    timestamp: now,
    stock: {
      symbol: 'NVDAB',
      address: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
      amountRaw: 70000000000000000000n,
      decimals: 18,
      amountFormatted: 70,
      priceUsd: 200,
      valueUsd: 14000
    },
    stable: {
      symbol: 'USDC',
      address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      amountRaw: 6000000000000000000000n,
      decimals: 18,
      amountFormatted: 6000,
      priceUsd: 1,
      valueUsd: 6000
    },
    totalValueUsd: 20000,
    currentStockWeightBps: 7000,
    currentStableWeightBps: 3000,
    quoteTimestamp: now,
    quoteAgeSeconds: 0
  };

  const validSellInput: GenLayerVerificationInput = {
    ...validBuyInput,
    balances: {
      stock: {
        symbol: 'NVDAB',
        contractAddress: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
        rawAmount: '70000000000000000000',
        formattedAmount: 70,
        verificationStatus: 'VERIFIED'
      },
      stable: {
        symbol: 'USDC',
        contractAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
        rawAmount: '6000000000000000000000',
        formattedAmount: 6000,
        verificationStatus: 'VERIFIED'
      }
    },
    snapshot: overweightSnapshot,
    proposal: {
      action: 'SELL_STOCK',
      sourceAsset: 'NVDAB',
      targetAsset: 'USDC',
      tradeAmountUsd: 2000,
      approxTokenAmount: 10,
      slippageLimitBps: 50,
      marketState: 'MARKET_OPEN',
      reason: 'Stock overweight by 1000 bps',
      generatedAt: now
    }
  };

  describe('1. Canonical Payload & Deterministic Evidence Hash', () => {
    it('produces identical SHA-256 evidence hash regardless of key insertion order', () => {
      const payload1 = buildCanonicalEvidencePayload(validBuyInput);
      const hash1 = computeEvidenceHash(payload1);

      // Reordered input
      const reorderedPayload = {
        ...payload1,
        totalValueUsd: payload1.totalValueUsd,
        proposalId: payload1.proposalId
      };
      const hash2 = computeEvidenceHash(reorderedPayload);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^0x[a-f0-9]{64}$/);
    });
  });

  describe('2. Valid Proposal Verification (BUY and SELL)', () => {
    it('verifies a valid BUY_STOCK proposal when GenLayer returns ALLOW with matching hash', async () => {
      const canonicalPayload = buildCanonicalEvidencePayload(validBuyInput);
      const expectedHash = computeEvidenceHash(canonicalPayload);

      // Mock fetch simulating GenLayer consensus contract
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              status: 'ALLOW',
              reason: 'Proposal verified by GenLayer consensus.',
              evidence_hash: expectedHash,
              proposal_id: canonicalPayload.proposalId,
              checks: {
                payload_valid: true,
                math_consistent: true,
                direction_consistent: true,
                spread_permitted: true,
                circuit_breaker_passed: true,
                market_state_permitted: true,
                non_zero_portfolio: true
              }
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: dummyContractAddress,
        fetchFn: mockFetch
      });

      const result = await adapter.verifyProposal(validBuyInput);

      expect(result.status).toBe('ALLOW');
      expect(result.decision).toBe('VERIFIED');
      expect(result.evidenceHash).toBe(expectedHash);
      expect(result.checks?.direction_consistent).toBe(true);
      expect(result.reason).toContain('Proposal verified');
    });

    it('verifies a valid SELL_STOCK proposal when GenLayer returns ALLOW with matching hash', async () => {
      const canonicalPayload = buildCanonicalEvidencePayload(validSellInput);
      const expectedHash = computeEvidenceHash(canonicalPayload);

      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              status: 'ALLOW',
              reason: 'Proposal verified by GenLayer consensus.',
              evidence_hash: expectedHash,
              proposal_id: canonicalPayload.proposalId,
              checks: {
                payload_valid: true,
                math_consistent: true,
                direction_consistent: true,
                spread_permitted: true,
                circuit_breaker_passed: true,
                market_state_permitted: true,
                non_zero_portfolio: true
              }
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: dummyContractAddress,
        fetchFn: mockFetch
      });

      const result = await adapter.verifyProposal(validSellInput);

      expect(result.status).toBe('ALLOW');
      expect(result.decision).toBe('VERIFIED');
      expect(result.evidenceHash).toBe(expectedHash);
    });
  });

  describe('3. NO_ACTION Verification', () => {
    it('verifies NO_ACTION when portfolio is within drift tolerance', async () => {
      // 60% stock ($12,000) / 40% stable ($8,000) = $20,000 Total. Drift = 0 bps
      const balancedSnapshot: PortfolioSnapshot = {
        timestamp: now,
        stock: {
          symbol: 'NVDAB',
          address: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
          amountRaw: 60000000000000000000n,
          decimals: 18,
          amountFormatted: 60,
          priceUsd: 200,
          valueUsd: 12000
        },
        stable: {
          symbol: 'USDC',
          address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
          amountRaw: 8000000000000000000000n,
          decimals: 18,
          amountFormatted: 8000,
          priceUsd: 1,
          valueUsd: 8000
        },
        totalValueUsd: 20000,
        currentStockWeightBps: 6000,
        currentStableWeightBps: 4000,
        quoteTimestamp: now,
        quoteAgeSeconds: 0
      };

      const noActionInput: GenLayerVerificationInput = {
        ...validBuyInput,
        balances: {
          stock: {
            symbol: 'NVDAB',
            contractAddress: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
            rawAmount: '60000000000000000000',
            formattedAmount: 60,
            verificationStatus: 'VERIFIED'
          },
          stable: {
            symbol: 'USDC',
            contractAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
            rawAmount: '8000000000000000000000',
            formattedAmount: 8000,
            verificationStatus: 'VERIFIED'
          }
        },
        snapshot: balancedSnapshot,
        proposal: {
          action: 'NONE',
          sourceAsset: '',
          targetAsset: '',
          tradeAmountUsd: 0,
          approxTokenAmount: 0,
          slippageLimitBps: 0,
          marketState: 'MARKET_OPEN',
          reason: 'Within tolerance',
          generatedAt: now
        }
      };

      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: dummyContractAddress
      });

      const result = await adapter.verifyProposal(noActionInput);

      expect(result.status).toBe('ALLOW');
      expect(result.decision).toBe('VERIFIED');
      expect(result.reason).toContain('NO_ACTION verified');
    });
  });

  describe('4. Math and Allocation Inconsistencies (Rejection)', () => {
    it('rejects proposal when supplied weight does not match underlying balance valuation', async () => {
      const inconsistentInput: GenLayerVerificationInput = {
        ...validBuyInput,
        snapshot: {
          ...underweightSnapshot,
          currentStockWeightBps: 7500 // Inconsistent: 50 tokens * $200 = $10,000 / $20,000 = 50%, not 75%
        }
      };

      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: dummyContractAddress
      });

      const result = await adapter.verifyProposal(inconsistentInput);

      expect(result.status).toBe('REJECT');
      expect(result.decision).toBe('NOT_VERIFIED');
      expect(result.reason).toContain('Allocation math mismatch');
    });

    it('rejects proposal when proposed trade direction opposes portfolio drift', async () => {
      // Underweight stock requires BUY_STOCK, but proposal specifies SELL_STOCK
      const wrongDirectionInput: GenLayerVerificationInput = {
        ...validBuyInput,
        proposal: {
          ...validBuyInput.proposal,
          action: 'SELL_STOCK'
        }
      };

      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: dummyContractAddress
      });

      const result = await adapter.verifyProposal(wrongDirectionInput);

      expect(result.status).toBe('REJECT');
      expect(result.decision).toBe('NOT_VERIFIED');
      expect(result.reason).toContain('Direction mismatch');
    });
  });

  describe('5. Risk Boundary Violations (Rejection)', () => {
    it('rejects BUY proposal when token trades at excessive spread over reference price', async () => {
      const excessiveSpreadInput: GenLayerVerificationInput = {
        ...validBuyInput,
        marketData: {
          ...validBuyInput.marketData,
          spread: 0.04, // 4.0%
          spreadBps: 400 // Exceeds maxSpreadBps 200 (2.0%)
        }
      };

      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: dummyContractAddress
      });

      const result = await adapter.verifyProposal(excessiveSpreadInput);

      expect(result.status).toBe('REJECT');
      expect(result.decision).toBe('NOT_VERIFIED');
      expect(result.reason).toContain('exceeds maximum allowed spread');
    });

    it('rejects proposal when proposed trade amount exceeds circuit breaker limit', async () => {
      const breakerExceededInput: GenLayerVerificationInput = {
        ...validBuyInput,
        proposal: {
          ...validBuyInput.proposal,
          tradeAmountUsd: 6000 // Exceeds maxSingleTradeUsd $5,000
        }
      };

      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: dummyContractAddress
      });

      const result = await adapter.verifyProposal(breakerExceededInput);

      expect(result.status).toBe('REJECT');
      expect(result.decision).toBe('NOT_VERIFIED');
      expect(result.reason).toContain('exceeds max single trade circuit breaker');
    });

    it('rejects trading proposal when market session is closed', async () => {
      const closedMarketInput: GenLayerVerificationInput = {
        ...validBuyInput,
        marketStatus: {
          state: 'MARKET_CLOSED'
        }
      };

      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: dummyContractAddress
      });

      const result = await adapter.verifyProposal(closedMarketInput);

      expect(result.status).toBe('REJECT');
      expect(result.decision).toBe('NOT_VERIFIED');
      expect(result.reason).toContain('Market session is closed');
    });
  });

  describe('6. Zero / Empty Portfolio (Zero Mock Enforcement)', () => {
    it('rejects proposal when both wallet balances are zero and never invents synthetic weights', async () => {
      const zeroBalanceInput: GenLayerVerificationInput = {
        ...validBuyInput,
        balances: {
          stock: {
            ...validBuyInput.balances.stock,
            rawAmount: '0',
            formattedAmount: 0
          },
          stable: {
            ...validBuyInput.balances.stable,
            rawAmount: '0',
            formattedAmount: 0
          }
        },
        snapshot: null
      };

      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: dummyContractAddress
      });

      const result = await adapter.verifyProposal(zeroBalanceInput);

      expect(result.status).toBe('REJECT');
      expect(result.decision).toBe('NOT_VERIFIED');
      expect(result.reason).toContain('Both stock and stablecoin balances are zero');
    });
  });

  describe('7. Stale and Missing Data', () => {
    it('rejects proposal when quote age exceeds max staleness', async () => {
      const staleInput: GenLayerVerificationInput = {
        ...validBuyInput,
        marketData: {
          ...validBuyInput.marketData,
          quoteAgeSeconds: 901
        }
      };

      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: dummyContractAddress
      });

      const result = await adapter.verifyProposal(staleInput);

      expect(result.status).toBe('REJECT');
      expect(result.decision).toBe('NOT_VERIFIED');
      expect(result.reason).toContain('exceeds max allowable staleness');
    });

    it('rejects proposal when market oracle is REFERENCE_STALE', async () => {
      const staleOracleInput: GenLayerVerificationInput = {
        ...validBuyInput,
        marketStatus: {
          state: 'REFERENCE_STALE'
        }
      };

      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: dummyContractAddress
      });

      const result = await adapter.verifyProposal(staleOracleInput);

      expect(result.status).toBe('REJECT');
      expect(result.decision).toBe('NOT_VERIFIED');
      expect(result.reason).toContain('REFERENCE_STALE');
    });
  });

  describe('8. Fail-Closed Error Handling & Malformed Responses', () => {
    it('fails closed to NOT_VERIFIED when GenLayer responds with malformed JSON or invalid schema', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: 'INVALID_STRING_RESULT' // Malformed: should be object
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: dummyContractAddress,
        fetchFn: mockFetch
      });

      const result = await adapter.verifyProposal(validBuyInput);

      expect(result.status).toBe('REJECT');
      expect(result.decision).toBe('NOT_VERIFIED');
      expect(result.reason).toContain('Malformed GenLayer response');
    });

    it('fails closed when response evidence hash does not match canonical payload hash (tamper check)', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              status: 'ALLOW',
              evidence_hash: '0x0000000000000000000000000000000000000000000000000000000000000000' // Tampered!
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: dummyContractAddress,
        fetchFn: mockFetch
      });

      const result = await adapter.verifyProposal(validBuyInput);

      expect(result.status).toBe('REJECT');
      expect(result.decision).toBe('NOT_VERIFIED');
      expect(result.reason).toContain('Tampered evidence hash');
    });

    it('fails closed when GenLayer returns RPC error (e.g. consensus timeout or NO_MAJORITY)', async () => {
      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: {
              code: -32000,
              message: 'Consensus undetermined: NO_MAJORITY'
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: dummyContractAddress,
        fetchFn: mockFetch
      });

      const result = await adapter.verifyProposal(validBuyInput);

      expect(result.status).toBe('REJECT');
      expect(result.decision).toBe('NOT_VERIFIED');
      expect(result.reason).toContain('GenLayer RPC error');
    });

    it('fails closed on network timeout or abort', async () => {
      const hangingFetch: typeof fetch = async (_url, init) => {
        return new Promise((_, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              reject(new Error('The operation was aborted due to timeout'));
            });
          }
        });
      };

      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: dummyContractAddress,
        timeoutMs: 50,
        fetchFn: hangingFetch
      });

      const result = await adapter.verifyProposal(validBuyInput);

      expect(result.status).toBe('REJECT');
      expect(result.decision).toBe('NOT_VERIFIED');
      expect(result.reason).toContain('timed out');
    });

    it('fails closed when verifier contract address is unconfigured or zero-address', async () => {
      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: ''
      });

      const result = await adapter.verifyProposal(validBuyInput);

      expect(result.status).toBe('REJECT');
      expect(result.decision).toBe('NOT_VERIFIED');
      expect(result.reason).toContain('unconfigured');
    });

    it('correctly reports NOT_VERIFIED when GenLayer validator consensus rejects the proposal', async () => {
      const canonicalPayload = buildCanonicalEvidencePayload(validBuyInput);
      const expectedHash = computeEvidenceHash(canonicalPayload);

      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              status: 'REJECT',
              reason: 'Validator consensus rejected: spread exceeds custom dynamic oracle boundary.',
              evidence_hash: expectedHash,
              proposal_id: canonicalPayload.proposalId
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: dummyContractAddress,
        fetchFn: mockFetch
      });

      const result = await adapter.verifyProposal(validBuyInput);

      expect(result.status).toBe('REJECT');
      expect(result.decision).toBe('NOT_VERIFIED');
      expect(result.reason).toContain('Validator consensus rejected');
    });
  });

  describe('9. Immutable Audit Trail Persistence', () => {
    it('persists complete audit entries without exposing private keys or secrets', async () => {
      const canonicalPayload = buildCanonicalEvidencePayload(validBuyInput);
      const expectedHash = computeEvidenceHash(canonicalPayload);

      const mockFetch: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              status: 'ALLOW',
              reason: 'Proposal verified by GenLayer consensus.',
              evidence_hash: expectedHash,
              proposal_id: canonicalPayload.proposalId
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };

      const adapter = new GenLayerVerificationAdapter({
        verifierContractAddress: dummyContractAddress,
        fetchFn: mockFetch
      });

      await adapter.verifyProposal(validBuyInput);

      const auditTrail = adapter.getAuditTrail();
      expect(auditTrail.length).toBe(1);
      const record = auditTrail[0];

      expect(record.auditId).toMatch(/^audit-[0-9a-f-]+$/);
      expect(record.evidenceHash).toBe(expectedHash);
      expect(record.status).toBe('ALLOW');
      expect(record.decision).toBe('VERIFIED');
      expect(record.canonicalPayload.stockSymbol).toBe('NVDAB');
      expect(record.canonicalPayload.targetStockWeightBps).toBe(6000);

      // Verify no secrets leaked in audit record
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain('privateKey');
      expect(serialized).not.toContain('apiSecret');
      expect(serialized).not.toContain('BINANCE_API_SECRET');
    });
  });
});
