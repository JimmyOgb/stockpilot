/**
 * StockPilot Strategy & Risk Engine Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateMarketState,
  calculatePortfolioSnapshot,
  calculateDrift,
  generateRebalanceProposal
} from '../src/strategy/risk-engine.js';
import { StrategyConfig, PortfolioBalance } from '../src/types/index.js';

describe('Deterministic Strategy & Risk Engine', () => {
  const sampleStrategy: StrategyConfig = {
    id: 'strat-nvda-usdc-60-40',
    name: 'NVIDIA 60/40 Core',
    userPrompt: 'Keep 60% tokenized NVIDIA and 40% USDC. Rebalance when the stock allocation drifts more than 5%.',
    stockSymbol: 'bNVDA',
    stockAddress: '0x1111111111111111111111111111111111111111',
    stableSymbol: 'USDC',
    stableAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    targetStockWeightBps: 6000, // 60.0%
    targetStableWeightBps: 4000, // 40.0%
    driftThresholdBps: 500,     // 5.0%
    maxSingleTradeUsd: 5000     // $5,000 USD circuit breaker
  };

  describe('calculatePortfolioSnapshot', () => {
    it('accurately computes portfolio weights and values in basis points', () => {
      const stock: PortfolioBalance = {
        symbol: 'bNVDA',
        address: sampleStrategy.stockAddress,
        amountRaw: 50000000000000000000n, // 50 tokens
        decimals: 18,
        amountFormatted: 50,
        priceUsd: 120, // $6,000 value
        valueUsd: 0
      };

      const stable: PortfolioBalance = {
        symbol: 'USDC',
        address: sampleStrategy.stableAddress,
        amountRaw: 4000000000000000000000n, // 4,000 USDC
        decimals: 18,
        amountFormatted: 4000,
        priceUsd: 1.0, // $4,000 value
        valueUsd: 0
      };

      const now = 1727250000000;
      const snapshot = calculatePortfolioSnapshot(stock, stable, now, now);

      expect(snapshot.stock.valueUsd).toBe(6000);
      expect(snapshot.stable.valueUsd).toBe(4000);
      expect(snapshot.totalValueUsd).toBe(10000);
      expect(snapshot.currentStockWeightBps).toBe(6000);
      expect(snapshot.currentStableWeightBps).toBe(4000);
      expect(snapshot.quoteAgeSeconds).toBe(0);
    });
  });

  describe('calculateDrift', () => {
    it('detects balanced portfolio when actual matches target exactly', () => {
      const drift = calculateDrift(6000, sampleStrategy);
      expect(drift.driftBps).toBe(0);
      expect(drift.exceedsThreshold).toBe(false);
      expect(drift.driftDirection).toBe('BALANCED');
    });

    it('identifies overweight stock when stock drifts above target + threshold', () => {
      // 66% stock (6600 bps) vs 60% target (6000 bps) -> 600 bps drift (> 500 bps threshold)
      const drift = calculateDrift(6600, sampleStrategy);
      expect(drift.driftBps).toBe(600);
      expect(drift.exceedsThreshold).toBe(true);
      expect(drift.driftDirection).toBe('OVERWEIGHT_STOCK');
    });

    it('identifies underweight stock when stock drifts below target - threshold', () => {
      // 53% stock (5300 bps) vs 60% target (6000 bps) -> 700 bps drift (> 500 bps threshold)
      const drift = calculateDrift(5300, sampleStrategy);
      expect(drift.driftBps).toBe(700);
      expect(drift.exceedsThreshold).toBe(true);
      expect(drift.driftDirection).toBe('UNDERWEIGHT_STOCK');
    });

    it('ignores drift when it is strictly below threshold', () => {
      // 62% stock (6200 bps) vs 60% target (6000 bps) -> 200 bps drift (< 500 bps threshold)
      const drift = calculateDrift(6200, sampleStrategy);
      expect(drift.driftBps).toBe(200);
      expect(drift.exceedsThreshold).toBe(false);
      expect(drift.driftDirection).toBe('OVERWEIGHT_STOCK');
    });
  });

  describe('evaluateMarketState', () => {
    it('returns REFERENCE_STALE when reference price age exceeds max staleness', () => {
      const state = evaluateMarketState({
        referenceTimestamp: 1000000,
        currentTimestamp: 1000000 + (901 * 1000), // 901 seconds old
        maxStalenessSeconds: 900
      });
      expect(state).toBe('REFERENCE_STALE');
    });

    it('returns MARKET_CLOSED on a Saturday', () => {
      // 2026-09-26 15:00 UTC is a Saturday
      const saturdayTimestamp = Date.UTC(2026, 8, 26, 15, 0, 0);
      const state = evaluateMarketState({
        referenceTimestamp: saturdayTimestamp,
        currentTimestamp: saturdayTimestamp,
        maxStalenessSeconds: 900
      });
      expect(state).toBe('MARKET_CLOSED');
    });

    it('returns MARKET_OPEN during US market hours on a Wednesday', () => {
      // 2026-09-23 15:00 UTC is a Wednesday (11:00 AM Eastern Time - market open)
      const wednesdayOpenTimestamp = Date.UTC(2026, 8, 23, 15, 0, 0);
      const state = evaluateMarketState({
        referenceTimestamp: wednesdayOpenTimestamp,
        currentTimestamp: wednesdayOpenTimestamp,
        maxStalenessSeconds: 900
      });
      expect(state).toBe('MARKET_OPEN');
    });

    it('returns MARKET_CLOSED after hours on a Wednesday', () => {
      // 2026-09-23 23:00 UTC is a Wednesday (7:00 PM Eastern Time - market closed)
      const wednesdayNightTimestamp = Date.UTC(2026, 8, 23, 23, 0, 0);
      const state = evaluateMarketState({
        referenceTimestamp: wednesdayNightTimestamp,
        currentTimestamp: wednesdayNightTimestamp,
        maxStalenessSeconds: 900
      });
      expect(state).toBe('MARKET_CLOSED');
    });
  });

  describe('generateRebalanceProposal', () => {
    it('fails closed when market state is REFERENCE_STALE', () => {
      const stock: PortfolioBalance = {
        symbol: 'bNVDA',
        address: sampleStrategy.stockAddress,
        amountRaw: 70000000000000000000n,
        decimals: 18,
        amountFormatted: 70,
        priceUsd: 100, // $7,000 value
        valueUsd: 7000
      };
      const stable: PortfolioBalance = {
        symbol: 'USDC',
        address: sampleStrategy.stableAddress,
        amountRaw: 3000000000000000000000n,
        decimals: 18,
        amountFormatted: 3000,
        priceUsd: 1.0, // $3,000 value
        valueUsd: 3000
      };

      const now = Date.now();
      const snapshot = calculatePortfolioSnapshot(stock, stable, now - 1000000, now);

      const proposal = generateRebalanceProposal({
        snapshot,
        strategy: sampleStrategy,
        marketState: 'REFERENCE_STALE'
      });

      expect(proposal.action).toBe('NONE');
      expect(proposal.reason).toContain('REFERENCE_STALE');
      expect(proposal.tradeAmountUsd).toBe(0);
    });

    it('proposes SELL_STOCK when overweight stock and market is open', () => {
      // $7,000 stock (70%) + $3,000 stable (30%) = $10,000 total. Target: $6,000 stock (60%).
      // Delta to sell: $1,000 stock.
      const stock: PortfolioBalance = {
        symbol: 'bNVDA',
        address: sampleStrategy.stockAddress,
        amountRaw: 70000000000000000000n,
        decimals: 18,
        amountFormatted: 70,
        priceUsd: 100,
        valueUsd: 7000
      };
      const stable: PortfolioBalance = {
        symbol: 'USDC',
        address: sampleStrategy.stableAddress,
        amountRaw: 3000000000000000000000n,
        decimals: 18,
        amountFormatted: 3000,
        priceUsd: 1.0,
        valueUsd: 3000
      };

      const now = Date.now();
      const snapshot = calculatePortfolioSnapshot(stock, stable, now, now);

      const proposal = generateRebalanceProposal({
        snapshot,
        strategy: sampleStrategy,
        marketState: 'MARKET_OPEN',
        maxSlippageOpenBps: 50,
        maxSlippageClosedBps: 25
      });

      expect(proposal.action).toBe('SELL_STOCK');
      expect(proposal.sourceAsset).toBe('bNVDA');
      expect(proposal.targetAsset).toBe('USDC');
      expect(proposal.tradeAmountUsd).toBe(1000);
      expect(proposal.approxTokenAmount).toBe(10); // $1000 / $100 price = 10 tokens
      expect(proposal.slippageLimitBps).toBe(50);
    });

    it('applies tighter slippage limits when MARKET_CLOSED', () => {
      const stock: PortfolioBalance = {
        symbol: 'bNVDA',
        address: sampleStrategy.stockAddress,
        amountRaw: 70000000000000000000n,
        decimals: 18,
        amountFormatted: 70,
        priceUsd: 100,
        valueUsd: 7000
      };
      const stable: PortfolioBalance = {
        symbol: 'USDC',
        address: sampleStrategy.stableAddress,
        amountRaw: 3000000000000000000000n,
        decimals: 18,
        amountFormatted: 3000,
        priceUsd: 1.0,
        valueUsd: 3000
      };

      const now = Date.now();
      const snapshot = calculatePortfolioSnapshot(stock, stable, now, now);

      const proposal = generateRebalanceProposal({
        snapshot,
        strategy: sampleStrategy,
        marketState: 'MARKET_CLOSED',
        maxSlippageOpenBps: 50,
        maxSlippageClosedBps: 25
      });

      expect(proposal.action).toBe('SELL_STOCK');
      expect(proposal.slippageLimitBps).toBe(25); // Tighter slippage in MARKET_CLOSED
    });

    it('proposes BUY_STOCK when underweight stock', () => {
      // $5,000 stock (50%) + $5,000 stable (50%) = $10,000 total. Target: $6,000 stock (60%).
      // Delta to buy: $1,000 stock. Drift = 1000 bps (> 500 bps threshold)
      const stock: PortfolioBalance = {
        symbol: 'bNVDA',
        address: sampleStrategy.stockAddress,
        amountRaw: 50000000000000000000n,
        decimals: 18,
        amountFormatted: 50,
        priceUsd: 100,
        valueUsd: 5000
      };
      const stable: PortfolioBalance = {
        symbol: 'USDC',
        address: sampleStrategy.stableAddress,
        amountRaw: 5000000000000000000000n,
        decimals: 18,
        amountFormatted: 5000,
        priceUsd: 1.0,
        valueUsd: 5000
      };

      const now = Date.now();
      const snapshot = calculatePortfolioSnapshot(stock, stable, now, now);

      const proposal = generateRebalanceProposal({
        snapshot,
        strategy: sampleStrategy,
        marketState: 'MARKET_OPEN'
      });

      expect(proposal.action).toBe('BUY_STOCK');
      expect(proposal.sourceAsset).toBe('USDC');
      expect(proposal.targetAsset).toBe('bNVDA');
      expect(proposal.tradeAmountUsd).toBe(1000);
      expect(proposal.approxTokenAmount).toBe(10);
    });

    it('caps proposed trade at maxSingleTradeUsd circuit breaker', () => {
      // $20,000 total: $2,000 stock (10%) + $18,000 stable (90%). Target 60% = $12,000 stock.
      // Delta = $10,000. But maxSingleTradeUsd is $5,000.
      const stock: PortfolioBalance = {
        symbol: 'bNVDA',
        address: sampleStrategy.stockAddress,
        amountRaw: 20000000000000000000n,
        decimals: 18,
        amountFormatted: 20,
        priceUsd: 100,
        valueUsd: 2000
      };
      const stable: PortfolioBalance = {
        symbol: 'USDC',
        address: sampleStrategy.stableAddress,
        amountRaw: 18000000000000000000000n,
        decimals: 18,
        amountFormatted: 18000,
        priceUsd: 1.0,
        valueUsd: 18000
      };

      const now = Date.now();
      const snapshot = calculatePortfolioSnapshot(stock, stable, now, now);

      const proposal = generateRebalanceProposal({
        snapshot,
        strategy: sampleStrategy,
        marketState: 'MARKET_OPEN'
      });

      expect(proposal.tradeAmountUsd).toBe(5000); // Capped at maxSingleTradeUsd
    });
  });
});
