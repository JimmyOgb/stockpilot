/**
 * StockPilot — Deterministic Portfolio Strategy Engine Unit Tests
 *
 * Tests the real portfolio decision engine against strict Zero Mock criteria:
 * - Balanced portfolio (NO_ACTION)
 * - NVDAB overweight (REBALANCE_REQUIRED -> SELL_STOCK)
 * - NVDAB underweight (REBALANCE_REQUIRED -> BUY_STOCK)
 * - Threshold boundary (exact 500 bps vs 499 bps)
 * - Zero/empty wallet (INSUFFICIENT_PORTFOLIO_DATA, zero mock preservation)
 * - Missing price data (DATA_UNAVAILABLE)
 * - Stale/invalid data (DATA_UNAVAILABLE)
 * - Market closed (MARKET_CLOSED)
 * - Excessive token/reference spread (RISK_BLOCKED)
 * - Circuit breaker trade size limits
 * - Balance extraction and OO wrapper
 */

import { describe, it, expect } from 'vitest';
import {
  evaluatePortfolioStrategy,
  DeterministicPortfolioEngine,
  extractBalancesFromVerifiedList,
  AssetBalanceInput,
  AssetPriceInput
} from '../src/strategy/portfolio-engine.js';
import {
  StrategyConfig,
  DEFAULT_MVP_STRATEGY_CONFIG
} from '../src/types/index.js';
import { VerifiedTokenBalance } from '../src/binance/wallet-balance-client.js';

describe('Deterministic Portfolio Strategy Engine', () => {
  const mvpStrategy: StrategyConfig = {
    ...DEFAULT_MVP_STRATEGY_CONFIG,
    id: 'strat-nvda-usdc-60-40',
    stockSymbol: 'NVDAB',
    stockAddress: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
    stableSymbol: 'USDC',
    stableAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    targetStockWeightBps: 6000, // 60.0%
    targetStableWeightBps: 4000, // 40.0%
    driftThresholdBps: 500,     // 5.0%
    maxSingleTradeUsd: 5000,    // $5,000 circuit breaker
    maxSpreadBps: 200,          // 2.0%
    allowClosedMarketRebalance: false
  };

  const defaultPriceNow = 1727250000000;

  // Standard live-like prices ($200 NVDAB, $1 USDC)
  const standardStockPrice: AssetPriceInput = {
    tokenPrice: 200.0,
    referencePrice: 200.0,
    spread: 0.0,
    timestamp: defaultPriceNow
  };

  const standardStablePrice: AssetPriceInput = {
    tokenPrice: 1.0,
    priceUsd: 1.0,
    timestamp: defaultPriceNow
  };

  describe('1. Balanced Portfolio', () => {
    it('returns NO_ACTION when portfolio allocation exactly matches 60/40 target', () => {
      // 30 NVDAB * $200 = $6,000 (60%)
      // 4,000 USDC * $1 = $4,000 (40%)
      // Total: $10,000 -> Drift = 0 bps
      const stockBalance: AssetBalanceInput = {
        symbol: 'NVDAB',
        address: mvpStrategy.stockAddress,
        amountRaw: 30000000000000000000n, // 30 tokens
        decimals: 18,
        amountFormatted: 30
      };

      const stableBalance: AssetBalanceInput = {
        symbol: 'USDC',
        address: mvpStrategy.stableAddress,
        amountRaw: 4000000000000000000000n, // 4,000 tokens
        decimals: 18,
        amountFormatted: 4000
      };

      const result = evaluatePortfolioStrategy({
        strategy: mvpStrategy,
        stockBalance,
        stableBalance,
        stockPrice: standardStockPrice,
        stablePrice: standardStablePrice,
        marketState: 'MARKET_OPEN',
        currentTimestamp: defaultPriceNow
      });

      expect(result.state).toBe('NO_ACTION');
      expect(result.snapshot).not.toBeNull();
      expect(result.snapshot?.totalValueUsd).toBe(10000);
      expect(result.snapshot?.currentStockWeightBps).toBe(6000);
      expect(result.snapshot?.currentStableWeightBps).toBe(4000);
      expect(result.drift?.driftBps).toBe(0);
      expect(result.drift?.exceedsThreshold).toBe(false);
      expect(result.proposal?.action).toBe('NONE');
      expect(result.reason).toContain('within drift tolerance');
    });
  });

  describe('2. NVDAB Overweight', () => {
    it('returns REBALANCE_REQUIRED and proposes SELL_STOCK when stock exceeds target + threshold', () => {
      // 35 NVDAB * $200 = $7,000 (70%)
      // 3,000 USDC * $1 = $3,000 (30%)
      // Total: $10,000 -> Stock weight = 7000 bps -> Drift = 1000 bps (> 500 bps threshold)
      // Target stock: 60% of $10,000 = $6,000. Delta to sell: $1,000 USD (5 tokens)
      const stockBalance: AssetBalanceInput = {
        symbol: 'NVDAB',
        address: mvpStrategy.stockAddress,
        amountRaw: 35000000000000000000n,
        decimals: 18,
        amountFormatted: 35
      };

      const stableBalance: AssetBalanceInput = {
        symbol: 'USDC',
        address: mvpStrategy.stableAddress,
        amountRaw: 3000000000000000000000n,
        decimals: 18,
        amountFormatted: 3000
      };

      const result = evaluatePortfolioStrategy({
        strategy: mvpStrategy,
        stockBalance,
        stableBalance,
        stockPrice: standardStockPrice,
        stablePrice: standardStablePrice,
        marketState: 'MARKET_OPEN',
        currentTimestamp: defaultPriceNow
      });

      expect(result.state).toBe('REBALANCE_REQUIRED');
      expect(result.drift?.driftDirection).toBe('OVERWEIGHT_STOCK');
      expect(result.drift?.driftBps).toBe(1000);
      expect(result.proposal).not.toBeNull();
      expect(result.proposal?.action).toBe('SELL_STOCK');
      expect(result.proposal?.sourceAsset).toBe('NVDAB');
      expect(result.proposal?.targetAsset).toBe('USDC');
      expect(result.proposal?.tradeAmountUsd).toBe(1000);
      expect(result.proposal?.approxTokenAmount).toBe(5); // $1000 / $200
      expect(result.proposal?.slippageLimitBps).toBe(50); // Open market default
    });
  });

  describe('3. NVDAB Underweight', () => {
    it('returns REBALANCE_REQUIRED and proposes BUY_STOCK when stock falls below target - threshold', () => {
      // 25 NVDAB * $200 = $5,000 (50%)
      // 5,000 USDC * $1 = $5,000 (50%)
      // Total: $10,000 -> Stock weight = 5000 bps -> Drift = 1000 bps (> 500 bps threshold)
      // Target stock: 60% of $10,000 = $6,000. Delta to buy: $1,000 USD (5 tokens)
      const stockBalance: AssetBalanceInput = {
        symbol: 'NVDAB',
        address: mvpStrategy.stockAddress,
        amountRaw: 25000000000000000000n,
        decimals: 18,
        amountFormatted: 25
      };

      const stableBalance: AssetBalanceInput = {
        symbol: 'USDC',
        address: mvpStrategy.stableAddress,
        amountRaw: 5000000000000000000000n,
        decimals: 18,
        amountFormatted: 5000
      };

      const result = evaluatePortfolioStrategy({
        strategy: mvpStrategy,
        stockBalance,
        stableBalance,
        stockPrice: standardStockPrice,
        stablePrice: standardStablePrice,
        marketState: 'MARKET_OPEN',
        currentTimestamp: defaultPriceNow
      });

      expect(result.state).toBe('REBALANCE_REQUIRED');
      expect(result.drift?.driftDirection).toBe('UNDERWEIGHT_STOCK');
      expect(result.drift?.driftBps).toBe(1000);
      expect(result.proposal).not.toBeNull();
      expect(result.proposal?.action).toBe('BUY_STOCK');
      expect(result.proposal?.sourceAsset).toBe('USDC');
      expect(result.proposal?.targetAsset).toBe('NVDAB');
      expect(result.proposal?.tradeAmountUsd).toBe(1000);
      expect(result.proposal?.approxTokenAmount).toBe(5);
    });
  });

  describe('4. Threshold Boundary', () => {
    it('triggers REBALANCE_REQUIRED when drift exactly equals 500 bps threshold', () => {
      // Target: 6000 bps. 6500 bps stock = exactly 500 bps drift
      // 32.5 NVDAB * $200 = $6,500
      // 3,500 USDC * $1 = $3,500
      // Total = $10,000 (65.00% stock)
      const stockBalance: AssetBalanceInput = {
        symbol: 'NVDAB',
        address: mvpStrategy.stockAddress,
        amountRaw: 32500000000000000000n,
        decimals: 18,
        amountFormatted: 32.5
      };

      const stableBalance: AssetBalanceInput = {
        symbol: 'USDC',
        address: mvpStrategy.stableAddress,
        amountRaw: 3500000000000000000000n,
        decimals: 18,
        amountFormatted: 3500
      };

      const result = evaluatePortfolioStrategy({
        strategy: mvpStrategy,
        stockBalance,
        stableBalance,
        stockPrice: standardStockPrice,
        stablePrice: standardStablePrice,
        marketState: 'MARKET_OPEN',
        currentTimestamp: defaultPriceNow
      });

      expect(result.drift?.driftBps).toBe(500);
      expect(result.drift?.exceedsThreshold).toBe(true);
      expect(result.state).toBe('REBALANCE_REQUIRED');
      expect(result.proposal?.action).toBe('SELL_STOCK');
      expect(result.proposal?.tradeAmountUsd).toBe(500);
    });

    it('returns NO_ACTION when drift is strictly below threshold (499 bps)', () => {
      // Target: 6000 bps. 64.99% stock -> 6499 bps -> Drift = 499 bps (< 500 bps)
      // Stock value: $6,499. Stable value: $3,501. Total: $10,000.
      // Stock amount: 6499 / 200 = 32.495 tokens
      const stockBalance: AssetBalanceInput = {
        symbol: 'NVDAB',
        address: mvpStrategy.stockAddress,
        amountRaw: 32495000000000000000n,
        decimals: 18,
        amountFormatted: 32.495
      };

      const stableBalance: AssetBalanceInput = {
        symbol: 'USDC',
        address: mvpStrategy.stableAddress,
        amountRaw: 3501000000000000000000n,
        decimals: 18,
        amountFormatted: 3501
      };

      const result = evaluatePortfolioStrategy({
        strategy: mvpStrategy,
        stockBalance,
        stableBalance,
        stockPrice: standardStockPrice,
        stablePrice: standardStablePrice,
        marketState: 'MARKET_OPEN',
        currentTimestamp: defaultPriceNow
      });

      expect(result.drift?.driftBps).toBe(499);
      expect(result.drift?.exceedsThreshold).toBe(false);
      expect(result.state).toBe('NO_ACTION');
      expect(result.proposal?.action).toBe('NONE');
    });
  });

  describe('5. Zero / Empty Wallet (Zero Mock Policy)', () => {
    it('returns INSUFFICIENT_PORTFOLIO_DATA when both wallet balances are zero', () => {
      const stockBalance: AssetBalanceInput = {
        symbol: 'NVDAB',
        address: mvpStrategy.stockAddress,
        amountRaw: 0n,
        decimals: 18,
        amountFormatted: 0
      };

      const stableBalance: AssetBalanceInput = {
        symbol: 'USDC',
        address: mvpStrategy.stableAddress,
        amountRaw: 0n,
        decimals: 18,
        amountFormatted: 0
      };

      const result = evaluatePortfolioStrategy({
        strategy: mvpStrategy,
        stockBalance,
        stableBalance,
        stockPrice: standardStockPrice,
        stablePrice: standardStablePrice,
        marketState: 'MARKET_OPEN',
        currentTimestamp: defaultPriceNow
      });

      expect(result.state).toBe('INSUFFICIENT_PORTFOLIO_DATA');
      expect(result.snapshot).toBeNull();
      expect(result.drift).toBeNull();
      expect(result.proposal).toBeNull();
      expect(result.reason).toContain('Both wallet balances are zero');
    });

    it('returns INSUFFICIENT_PORTFOLIO_DATA when total portfolio value is zero', () => {
      const stockBalance: AssetBalanceInput = {
        symbol: 'NVDAB',
        address: mvpStrategy.stockAddress,
        amountRaw: 0n,
        decimals: 18,
        amountFormatted: 0
      };

      const stableBalance: AssetBalanceInput = {
        symbol: 'USDC',
        address: mvpStrategy.stableAddress,
        amountRaw: 0n,
        decimals: 18,
        amountFormatted: 0
      };

      const result = evaluatePortfolioStrategy({
        strategy: mvpStrategy,
        stockBalance,
        stableBalance,
        stockPrice: standardStockPrice,
        stablePrice: standardStablePrice,
        marketState: 'MARKET_OPEN',
        currentTimestamp: defaultPriceNow
      });

      expect(result.state).toBe('INSUFFICIENT_PORTFOLIO_DATA');
    });
  });

  describe('6. Missing Price Data', () => {
    const validStockBalance: AssetBalanceInput = {
      symbol: 'NVDAB',
      address: mvpStrategy.stockAddress,
      amountRaw: 30000000000000000000n,
      decimals: 18,
      amountFormatted: 30
    };

    const validStableBalance: AssetBalanceInput = {
      symbol: 'USDC',
      address: mvpStrategy.stableAddress,
      amountRaw: 4000000000000000000000n,
      decimals: 18,
      amountFormatted: 4000
    };

    it('returns DATA_UNAVAILABLE when stockPrice is null', () => {
      const result = evaluatePortfolioStrategy({
        strategy: mvpStrategy,
        stockBalance: validStockBalance,
        stableBalance: validStableBalance,
        stockPrice: null,
        stablePrice: standardStablePrice,
        marketState: 'MARKET_OPEN',
        currentTimestamp: defaultPriceNow
      });

      expect(result.state).toBe('DATA_UNAVAILABLE');
      expect(result.reason).toContain('Stock token price data is unavailable');
    });

    it('returns DATA_UNAVAILABLE when stockPrice is non-positive or NaN', () => {
      const result = evaluatePortfolioStrategy({
        strategy: mvpStrategy,
        stockBalance: validStockBalance,
        stableBalance: validStableBalance,
        stockPrice: { tokenPrice: 0, timestamp: defaultPriceNow },
        stablePrice: standardStablePrice,
        marketState: 'MARKET_OPEN',
        currentTimestamp: defaultPriceNow
      });

      expect(result.state).toBe('DATA_UNAVAILABLE');
      expect(result.reason).toContain('invalid or non-positive');
    });

    it('returns DATA_UNAVAILABLE when stablePrice is null or non-positive', () => {
      const resultNull = evaluatePortfolioStrategy({
        strategy: mvpStrategy,
        stockBalance: validStockBalance,
        stableBalance: validStableBalance,
        stockPrice: standardStockPrice,
        stablePrice: null,
        marketState: 'MARKET_OPEN',
        currentTimestamp: defaultPriceNow
      });

      expect(resultNull.state).toBe('DATA_UNAVAILABLE');
      expect(resultNull.reason).toContain('Stablecoin price data is unavailable');

      const resultZero = evaluatePortfolioStrategy({
        strategy: mvpStrategy,
        stockBalance: validStockBalance,
        stableBalance: validStableBalance,
        stockPrice: standardStockPrice,
        stablePrice: { tokenPrice: 0, timestamp: defaultPriceNow },
        marketState: 'MARKET_OPEN',
        currentTimestamp: defaultPriceNow
      });

      expect(resultZero.state).toBe('DATA_UNAVAILABLE');
      expect(resultZero.reason).toContain('invalid or non-positive');
    });
  });

  describe('7. Stale / Invalid Data', () => {
    const validStockBalance: AssetBalanceInput = {
      symbol: 'NVDAB',
      address: mvpStrategy.stockAddress,
      amountRaw: 30000000000000000000n,
      decimals: 18,
      amountFormatted: 30
    };

    const validStableBalance: AssetBalanceInput = {
      symbol: 'USDC',
      address: mvpStrategy.stableAddress,
      amountRaw: 4000000000000000000000n,
      decimals: 18,
      amountFormatted: 4000
    };

    it('returns DATA_UNAVAILABLE when price quote age exceeds maxStalenessSeconds', () => {
      const oldTimestamp = defaultPriceNow - (901 * 1000); // 901 seconds ago (limit: 900)
      const staleStockPrice: AssetPriceInput = {
        tokenPrice: 200,
        timestamp: oldTimestamp
      };

      const result = evaluatePortfolioStrategy({
        strategy: mvpStrategy,
        stockBalance: validStockBalance,
        stableBalance: validStableBalance,
        stockPrice: staleStockPrice,
        stablePrice: standardStablePrice,
        marketState: 'MARKET_OPEN',
        currentTimestamp: defaultPriceNow,
        maxStalenessSeconds: 900
      });

      expect(result.state).toBe('DATA_UNAVAILABLE');
      expect(result.reason).toContain('Stock price quote is stale');
    });

    it('returns DATA_UNAVAILABLE when marketState is REFERENCE_STALE', () => {
      const result = evaluatePortfolioStrategy({
        strategy: mvpStrategy,
        stockBalance: validStockBalance,
        stableBalance: validStableBalance,
        stockPrice: standardStockPrice,
        stablePrice: standardStablePrice,
        marketState: 'REFERENCE_STALE',
        currentTimestamp: defaultPriceNow
      });

      expect(result.state).toBe('DATA_UNAVAILABLE');
      expect(result.reason).toContain('REFERENCE_STALE');
    });

    it('returns DATA_UNAVAILABLE when balance verification status indicates MISMATCH', () => {
      const mismatchStockBalance: AssetBalanceInput = {
        ...validStockBalance,
        verificationStatus: 'MISMATCH'
      };

      const result = evaluatePortfolioStrategy({
        strategy: mvpStrategy,
        stockBalance: mismatchStockBalance,
        stableBalance: validStableBalance,
        stockPrice: standardStockPrice,
        stablePrice: standardStablePrice,
        marketState: 'MARKET_OPEN',
        currentTimestamp: defaultPriceNow
      });

      expect(result.state).toBe('DATA_UNAVAILABLE');
      expect(result.reason).toContain('MISMATCH');
    });

    it('returns DATA_UNAVAILABLE when wallet balances are null', () => {
      const result = evaluatePortfolioStrategy({
        strategy: mvpStrategy,
        stockBalance: null,
        stableBalance: validStableBalance,
        stockPrice: standardStockPrice,
        stablePrice: standardStablePrice,
        marketState: 'MARKET_OPEN',
        currentTimestamp: defaultPriceNow
      });

      expect(result.state).toBe('DATA_UNAVAILABLE');
      expect(result.reason).toContain('Wallet balance data is missing');
    });
  });

  describe('8. Market Closed', () => {
    it('returns MARKET_CLOSED when market is closed and strategy disallows closed trading', () => {
      // Overweight portfolio (70% stock vs 60% target) that would normally rebalance
      const stockBalance: AssetBalanceInput = {
        symbol: 'NVDAB',
        address: mvpStrategy.stockAddress,
        amountRaw: 35000000000000000000n,
        decimals: 18,
        amountFormatted: 35
      };

      const stableBalance: AssetBalanceInput = {
        symbol: 'USDC',
        address: mvpStrategy.stableAddress,
        amountRaw: 3000000000000000000000n,
        decimals: 18,
        amountFormatted: 3000
      };

      const result = evaluatePortfolioStrategy({
        strategy: { ...mvpStrategy, allowClosedMarketRebalance: false },
        stockBalance,
        stableBalance,
        stockPrice: standardStockPrice,
        stablePrice: standardStablePrice,
        marketState: 'MARKET_CLOSED',
        currentTimestamp: defaultPriceNow
      });

      expect(result.state).toBe('MARKET_CLOSED');
      expect(result.proposal).toBeNull();
      expect(result.reason).toContain('Underlying equity market is closed');
    });

    it('allows rebalancing with tighter closed-market slippage if allowClosedMarketRebalance is true', () => {
      const stockBalance: AssetBalanceInput = {
        symbol: 'NVDAB',
        address: mvpStrategy.stockAddress,
        amountRaw: 35000000000000000000n,
        decimals: 18,
        amountFormatted: 35
      };

      const stableBalance: AssetBalanceInput = {
        symbol: 'USDC',
        address: mvpStrategy.stableAddress,
        amountRaw: 3000000000000000000000n,
        decimals: 18,
        amountFormatted: 3000
      };

      const result = evaluatePortfolioStrategy({
        strategy: { ...mvpStrategy, allowClosedMarketRebalance: true },
        stockBalance,
        stableBalance,
        stockPrice: standardStockPrice,
        stablePrice: standardStablePrice,
        marketState: 'MARKET_CLOSED',
        currentTimestamp: defaultPriceNow,
        maxSlippageClosedBps: 25
      });

      expect(result.state).toBe('REBALANCE_REQUIRED');
      expect(result.proposal?.slippageLimitBps).toBe(25); // Tighter slippage policy applied
    });
  });

  describe('9. Excessive Token/Reference Spread', () => {
    it('returns RISK_BLOCKED when BUY_STOCK is required and token price trades at excessive premium', () => {
      // Underweight stock (50% vs 60% target) -> would buy stock
      const stockBalance: AssetBalanceInput = {
        symbol: 'NVDAB',
        address: mvpStrategy.stockAddress,
        amountRaw: 25000000000000000000n,
        decimals: 18,
        amountFormatted: 25
      };

      const stableBalance: AssetBalanceInput = {
        symbol: 'USDC',
        address: mvpStrategy.stableAddress,
        amountRaw: 5000000000000000000000n,
        decimals: 18,
        amountFormatted: 5000
      };

      // On-chain token is $208.00 vs US Reference price $200.00 -> +4.00% spread (400 bps)
      // Strategy maxSpreadBps = 200 bps (2.0%) -> BREACH!
      const highSpreadStockPrice: AssetPriceInput = {
        tokenPrice: 208.0,
        referencePrice: 200.0,
        spread: 0.04, // 4.0%
        timestamp: defaultPriceNow
      };

      const result = evaluatePortfolioStrategy({
        strategy: { ...mvpStrategy, maxSpreadBps: 200 },
        stockBalance,
        stableBalance,
        stockPrice: highSpreadStockPrice,
        stablePrice: standardStablePrice,
        marketState: 'MARKET_OPEN',
        currentTimestamp: defaultPriceNow
      });

      expect(result.state).toBe('RISK_BLOCKED');
      expect(result.spreadRisk?.isExcessive).toBe(true);
      expect(result.spreadRisk?.spreadBps).toBe(400);
      expect(result.proposal).toBeNull();
      expect(result.reason).toContain('exceeds maximum allowed spread');
    });

    it('permits BUY_STOCK when spread is within acceptable boundaries', () => {
      const stockBalance: AssetBalanceInput = {
        symbol: 'NVDAB',
        address: mvpStrategy.stockAddress,
        amountRaw: 25000000000000000000n,
        decimals: 18,
        amountFormatted: 25
      };

      const stableBalance: AssetBalanceInput = {
        symbol: 'USDC',
        address: mvpStrategy.stableAddress,
        amountRaw: 5000000000000000000000n,
        decimals: 18,
        amountFormatted: 5000
      };

      // Spread is +0.0778% (78 bps) <= 200 bps
      const lowSpreadStockPrice: AssetPriceInput = {
        tokenPrice: 200.1556,
        referencePrice: 200.0,
        spread: 0.000778,
        timestamp: defaultPriceNow
      };

      const result = evaluatePortfolioStrategy({
        strategy: { ...mvpStrategy, maxSpreadBps: 200 },
        stockBalance,
        stableBalance,
        stockPrice: lowSpreadStockPrice,
        stablePrice: standardStablePrice,
        marketState: 'MARKET_OPEN',
        currentTimestamp: defaultPriceNow
      });

      expect(result.state).toBe('REBALANCE_REQUIRED');
      expect(result.spreadRisk?.isExcessive).toBe(false);
      expect(result.proposal?.action).toBe('BUY_STOCK');
    });

    it('does not block SELL_STOCK when token price trades at a premium', () => {
      // Overweight stock (70% vs 60%) -> action is SELL_STOCK
      // Selling at a premium is favorable to the portfolio, not blocked by buy-spread guard
      const stockBalance: AssetBalanceInput = {
        symbol: 'NVDAB',
        address: mvpStrategy.stockAddress,
        amountRaw: 35000000000000000000n,
        decimals: 18,
        amountFormatted: 35
      };

      const stableBalance: AssetBalanceInput = {
        symbol: 'USDC',
        address: mvpStrategy.stableAddress,
        amountRaw: 3000000000000000000000n,
        decimals: 18,
        amountFormatted: 3000
      };

      const highSpreadStockPrice: AssetPriceInput = {
        tokenPrice: 208.0,
        referencePrice: 200.0,
        spread: 0.04, // 4.0%
        timestamp: defaultPriceNow
      };

      const result = evaluatePortfolioStrategy({
        strategy: { ...mvpStrategy, maxSpreadBps: 200 },
        stockBalance,
        stableBalance,
        stockPrice: highSpreadStockPrice,
        stablePrice: standardStablePrice,
        marketState: 'MARKET_OPEN',
        currentTimestamp: defaultPriceNow
      });

      expect(result.state).toBe('REBALANCE_REQUIRED');
      expect(result.proposal?.action).toBe('SELL_STOCK');
    });
  });

  describe('10. Circuit Breaker & Capped Trade Sizes', () => {
    it('caps proposed trade at maxSingleTradeUsd when delta exceeds circuit breaker limit', () => {
      // Total portfolio = $50,000. 10% stock ($5,000), 90% stable ($45,000).
      // Target: 60% stock ($30,000). Delta = $25,000.
      // Strategy maxSingleTradeUsd = $5,000.
      const stockBalance: AssetBalanceInput = {
        symbol: 'NVDAB',
        address: mvpStrategy.stockAddress,
        amountRaw: 25000000000000000000n, // 25 * $200 = $5,000
        decimals: 18,
        amountFormatted: 25
      };

      const stableBalance: AssetBalanceInput = {
        symbol: 'USDC',
        address: mvpStrategy.stableAddress,
        amountRaw: 45000000000000000000000n, // 45,000 * $1 = $45,000
        decimals: 18,
        amountFormatted: 45000
      };

      const result = evaluatePortfolioStrategy({
        strategy: { ...mvpStrategy, maxSingleTradeUsd: 5000 },
        stockBalance,
        stableBalance,
        stockPrice: standardStockPrice,
        stablePrice: standardStablePrice,
        marketState: 'MARKET_OPEN',
        currentTimestamp: defaultPriceNow
      });

      expect(result.state).toBe('REBALANCE_REQUIRED');
      expect(result.proposal?.tradeAmountUsd).toBe(5000); // Strictly capped
    });
  });

  describe('11. Integration Helpers & OO DeterministicPortfolioEngine', () => {
    it('extractBalancesFromVerifiedList matches real VerifiedTokenBalance contracts', () => {
      const verifiedList: VerifiedTokenBalance[] = [
        {
          binanceChainId: '56',
          tokenContractAddress: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
          symbol: 'NVDAB',
          decimals: 18,
          binanceRawBalance: null,
          binanceFormattedBalance: null,
          rpcRawBalance: 30000000000000000000n,
          rpcFormattedBalance: '30',
          verifiedRawBalance: 30000000000000000000n,
          verifiedFormattedBalance: '30',
          verificationStatus: 'VERIFIED',
          checkedAt: defaultPriceNow
        },
        {
          binanceChainId: '56',
          tokenContractAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
          symbol: 'USDC',
          decimals: 18,
          binanceRawBalance: null,
          binanceFormattedBalance: null,
          rpcRawBalance: 4000000000000000000000n,
          rpcFormattedBalance: '4000',
          verifiedRawBalance: 4000000000000000000000n,
          verifiedFormattedBalance: '4000',
          verificationStatus: 'VERIFIED',
          checkedAt: defaultPriceNow
        }
      ];

      const { stockBalance, stableBalance } = extractBalancesFromVerifiedList(
        verifiedList,
        mvpStrategy.stockAddress,
        mvpStrategy.stableAddress
      );

      expect(stockBalance?.symbol).toBe('NVDAB');
      expect(stockBalance?.verifiedRawBalance).toBe(30000000000000000000n);
      expect(stableBalance?.symbol).toBe('USDC');
      expect(stableBalance?.verifiedRawBalance).toBe(4000000000000000000000n);

      const engine = new DeterministicPortfolioEngine(mvpStrategy);
      const evalResult = engine.evaluate({
        stockBalance,
        stableBalance,
        stockPrice: standardStockPrice,
        stablePrice: standardStablePrice,
        marketState: 'MARKET_OPEN',
        currentTimestamp: defaultPriceNow
      });

      expect(evalResult.state).toBe('NO_ACTION');
      expect(evalResult.snapshot?.totalValueUsd).toBe(10000);
    });

    it('extractBalancesFromVerifiedList handles empty or null input gracefully', () => {
      const res = extractBalancesFromVerifiedList(null, mvpStrategy.stockAddress, mvpStrategy.stableAddress);
      expect(res.stockBalance).toBeNull();
      expect(res.stableBalance).toBeNull();
    });
  });
});
