/**
 * StockPilot — Deterministic Strategy & Risk Engine
 * Pure calculation functions with zero side effects.
 */

import {
  MarketState,
  StrategyConfig,
  PortfolioBalance,
  PortfolioSnapshot,
  DriftAnalysis,
  RebalanceProposal
} from '../types/index.js';

export interface MarketStateParams {
  referenceTimestamp: number;
  currentTimestamp: number;
  maxStalenessSeconds: number;
  forceState?: MarketState; // For testing deterministic overrides
}

/**
 * Evaluates the market state:
 * - REFERENCE_STALE: Reference price age exceeds max allowable staleness.
 * - MARKET_OPEN: Data is fresh AND regular US equity market is active (09:30 - 16:00 ET, Mon-Fri).
 * - MARKET_CLOSED: Data is fresh BUT regular US equity market is closed.
 */
export function evaluateMarketState(params: MarketStateParams): MarketState {
  if (params.forceState) {
    return params.forceState;
  }

  const ageSeconds = Math.max(0, Math.floor((params.currentTimestamp - params.referenceTimestamp) / 1000));
  if (ageSeconds > params.maxStalenessSeconds) {
    return 'REFERENCE_STALE';
  }

  // Convert current timestamp to US Eastern Time (ET)
  const date = new Date(params.currentTimestamp);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric'
  });

  const parts = formatter.formatToParts(date);
  let weekday = '';
  let hour = 0;
  let minute = 0;

  for (const part of parts) {
    if (part.type === 'weekday') weekday = part.value;
    if (part.type === 'hour') hour = parseInt(part.value, 10);
    if (part.type === 'minute') minute = parseInt(part.value, 10);
  }

  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  if (isWeekend) {
    return 'MARKET_CLOSED';
  }

  const currentMinutes = hour * 60 + minute;
  const marketOpenMinutes = 9 * 60 + 30; // 09:30 ET
  const marketCloseMinutes = 16 * 60;    // 16:00 ET

  if (currentMinutes >= marketOpenMinutes && currentMinutes < marketCloseMinutes) {
    return 'MARKET_OPEN';
  }

  return 'MARKET_CLOSED';
}

/**
 * Calculates deterministic portfolio allocation and weight in basis points (100 bps = 1%).
 */
export function calculatePortfolioSnapshot(
  stock: PortfolioBalance,
  stable: PortfolioBalance,
  quoteTimestamp: number,
  currentTimestamp: number
): PortfolioSnapshot {
  const stockVal = stock.amountFormatted * stock.priceUsd;
  const stableVal = stable.amountFormatted * stable.priceUsd;
  const totalVal = stockVal + stableVal;

  const stockWithVal: PortfolioBalance = { ...stock, valueUsd: stockVal };
  const stableWithVal: PortfolioBalance = { ...stable, valueUsd: stableVal };

  let currentStockWeightBps = 0;
  let currentStableWeightBps = 0;

  if (totalVal > 0) {
    currentStockWeightBps = Math.round((stockVal / totalVal) * 10000);
    currentStableWeightBps = 10000 - currentStockWeightBps;
  }

  const ageSeconds = Math.max(0, Math.floor((currentTimestamp - quoteTimestamp) / 1000));

  return {
    timestamp: currentTimestamp,
    stock: stockWithVal,
    stable: stableWithVal,
    totalValueUsd: totalVal,
    currentStockWeightBps,
    currentStableWeightBps,
    quoteTimestamp,
    quoteAgeSeconds: ageSeconds
  };
}

/**
 * Calculates allocation drift against strategy target in basis points.
 */
export function calculateDrift(
  currentStockWeightBps: number,
  strategy: StrategyConfig
): DriftAnalysis {
  const driftBps = Math.abs(currentStockWeightBps - strategy.targetStockWeightBps);
  const exceedsThreshold = driftBps >= strategy.driftThresholdBps;

  let driftDirection: 'OVERWEIGHT_STOCK' | 'UNDERWEIGHT_STOCK' | 'BALANCED' = 'BALANCED';
  if (currentStockWeightBps > strategy.targetStockWeightBps) {
    driftDirection = 'OVERWEIGHT_STOCK';
  } else if (currentStockWeightBps < strategy.targetStockWeightBps) {
    driftDirection = 'UNDERWEIGHT_STOCK';
  }

  return {
    currentStockWeightBps,
    targetStockWeightBps: strategy.targetStockWeightBps,
    driftBps,
    driftThresholdBps: strategy.driftThresholdBps,
    exceedsThreshold,
    driftDirection
  };
}

export interface RebalanceProposalParams {
  snapshot: PortfolioSnapshot;
  strategy: StrategyConfig;
  marketState: MarketState;
  maxSlippageOpenBps?: number;
  maxSlippageClosedBps?: number;
}

/**
 * Generates deterministic spot rebalancing proposal.
 * Fails closed if market state is REFERENCE_STALE.
 */
export function generateRebalanceProposal(params: RebalanceProposalParams): RebalanceProposal {
  const { snapshot, strategy, marketState } = params;
  const now = snapshot.timestamp;

  // Fail closed check: REFERENCE_STALE strictly blocks rebalancing
  if (marketState === 'REFERENCE_STALE') {
    return {
      action: 'NONE',
      sourceAsset: '',
      targetAsset: '',
      tradeAmountUsd: 0,
      approxTokenAmount: 0,
      slippageLimitBps: 0,
      marketState,
      reason: 'Execution blocked: Reference price data is stale or oracle is unavailable (REFERENCE_STALE).',
      generatedAt: now
    };
  }

  const drift = calculateDrift(snapshot.currentStockWeightBps, strategy);

  if (!drift.exceedsThreshold) {
    return {
      action: 'NONE',
      sourceAsset: '',
      targetAsset: '',
      tradeAmountUsd: 0,
      approxTokenAmount: 0,
      slippageLimitBps: 0,
      marketState,
      reason: `Portfolio is within drift tolerance (drift: ${drift.driftBps} bps, threshold: ${strategy.driftThresholdBps} bps).`,
      generatedAt: now
    };
  }

  // Determine slippage limit based on market state
  const slippageLimitBps = marketState === 'MARKET_OPEN'
    ? (params.maxSlippageOpenBps ?? 50)
    : (params.maxSlippageClosedBps ?? 25);

  // Target stock value in USD
  const targetStockValueUsd = (strategy.targetStockWeightBps / 10000) * snapshot.totalValueUsd;
  const currentStockValueUsd = snapshot.stock.valueUsd;
  const deltaUsd = Math.abs(currentStockValueUsd - targetStockValueUsd);

  // Apply maximum trade size circuit breaker
  const tradeAmountUsd = Math.min(deltaUsd, strategy.maxSingleTradeUsd);

  if (drift.driftDirection === 'OVERWEIGHT_STOCK') {
    // Need to sell stock to acquire stablecoin
    const approxStockTokens = snapshot.stock.priceUsd > 0
      ? tradeAmountUsd / snapshot.stock.priceUsd
      : 0;

    return {
      action: 'SELL_STOCK',
      sourceAsset: strategy.stockSymbol,
      targetAsset: strategy.stableSymbol,
      tradeAmountUsd,
      approxTokenAmount: approxStockTokens,
      slippageLimitBps,
      marketState,
      reason: `Stock is overweight by ${drift.driftBps} bps. Proposing spot sell of ${tradeAmountUsd.toFixed(2)} USD of ${strategy.stockSymbol}.`,
      generatedAt: now
    };
  } else {
    // Underweight stock: Need to sell stablecoin to buy stock
    const approxStockTokens = snapshot.stock.priceUsd > 0
      ? tradeAmountUsd / snapshot.stock.priceUsd
      : 0;

    return {
      action: 'BUY_STOCK',
      sourceAsset: strategy.stableSymbol,
      targetAsset: strategy.stockSymbol,
      tradeAmountUsd,
      approxTokenAmount: approxStockTokens,
      slippageLimitBps,
      marketState,
      reason: `Stock is underweight by ${drift.driftBps} bps. Proposing spot buy of ${tradeAmountUsd.toFixed(2)} USD of ${strategy.stockSymbol}.`,
      generatedAt: now
    };
  }
}
