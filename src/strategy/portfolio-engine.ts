/**
 * StockPilot — Real Deterministic Portfolio Strategy Engine
 *
 * Implements the deterministic evaluation layer for tokenized equity strategies:
 * - Operates strictly on live or verified data: asset resolution, RWA spot & reference prices,
 *   market session status, and verified wallet balances.
 * - Zero Mock Policy: Never fabricates missing balances or prices, never simulates portfolio
 *   valuations, and never invents arbitrary allocations.
 * - Supports MVP 60/40 allocation (NVDAB / USDC) with configurable drift threshold (default 5.0% = 500 bps).
 * - Produces explicit, typed decision states:
 *   - NO_ACTION: Portfolio within acceptable drift threshold.
 *   - REBALANCE_REQUIRED: Portfolio drifted beyond threshold, verified risk checks pass.
 *   - INSUFFICIENT_PORTFOLIO_DATA: Both balances are zero or total portfolio valuation <= 0.
 *   - MARKET_CLOSED: Underlying equity session closed and closed-market trading disabled.
 *   - DATA_UNAVAILABLE: Missing, invalid, or stale price or balance telemetry.
 *   - RISK_BLOCKED: Proposed trade blocked by risk boundaries (e.g. excessive token/reference spread).
 */

import {
  StrategyConfig,
  StrategyDecisionState,
  StrategyEvaluationResult,
  PortfolioSnapshot,
  PortfolioBalance,
  DriftAnalysis,
  SpreadRiskAnalysis,
  RebalanceProposal,
  MarketState,
  DEFAULT_MVP_STRATEGY_CONFIG
} from '../types/index.js';
import {
  BalanceVerificationStatus,
  VerifiedTokenBalance,
  formatUnits
} from '../binance/wallet-balance-client.js';
import {
  DEFAULT_SAFETY_POLICY_SLIPPAGE_OPEN_BPS,
  DEFAULT_SAFETY_POLICY_SLIPPAGE_CLOSED_BPS
} from './risk-engine.js';

export interface AssetBalanceInput {
  symbol: string;
  address?: string;
  tokenContractAddress?: string;
  amountRaw?: bigint | null;
  decimals: number;
  amountFormatted?: number | null;
  verificationStatus?: BalanceVerificationStatus;
  verifiedRawBalance?: bigint | null;
  rpcRawBalance?: bigint | null;
  binanceRawBalance?: bigint | null;
}

export interface AssetPriceInput {
  tokenPrice: number;
  priceUsd?: number; // Optional alias for stablecoins
  referencePrice?: number | null;
  spread?: number | null;
  timestamp?: number;
  tokenPriceUpdatedAt?: number | null;
}

export interface StrategyEvaluationInput {
  strategy?: StrategyConfig;
  stockBalance: AssetBalanceInput | null;
  stableBalance: AssetBalanceInput | null;
  stockPrice: AssetPriceInput | null;
  stablePrice: AssetPriceInput | null;
  marketState?: MarketState | null;
  currentTimestamp?: number;
  maxStalenessSeconds?: number;
  maxSlippageOpenBps?: number;
  maxSlippageClosedBps?: number;
}

/**
 * Extracts stock and stablecoin balance inputs from a list of VerifiedTokenBalance objects.
 */
export function extractBalancesFromVerifiedList(
  balances: VerifiedTokenBalance[] | null | undefined,
  stockAddress: string,
  stableAddress: string
): { stockBalance: AssetBalanceInput | null; stableBalance: AssetBalanceInput | null } {
  if (!balances || balances.length === 0) {
    return { stockBalance: null, stableBalance: null };
  }

  const stockTarget = stockAddress.trim().toLowerCase();
  const stableTarget = stableAddress.trim().toLowerCase();

  const stockMatch = balances.find(b => b.tokenContractAddress.toLowerCase() === stockTarget) ?? null;
  const stableMatch = balances.find(b => b.tokenContractAddress.toLowerCase() === stableTarget) ?? null;

  return {
    stockBalance: stockMatch,
    stableBalance: stableMatch
  };
}

/**
 * Deterministically evaluates a portfolio strategy given live or verified market and wallet telemetry.
 * Completely pure calculation with zero network or state side effects.
 */
export function evaluatePortfolioStrategy(input: StrategyEvaluationInput): StrategyEvaluationResult {
  const strategy = input.strategy ?? DEFAULT_MVP_STRATEGY_CONFIG;
  const now = input.currentTimestamp ?? Date.now();
  const maxStaleness = input.maxStalenessSeconds ?? 900; // 15 minutes default staleness
  const marketState = input.marketState ?? 'MARKET_OPEN';

  // 1. Fail closed on stale reference or oracle failure
  if (marketState === 'REFERENCE_STALE') {
    return {
      state: 'DATA_UNAVAILABLE',
      strategyId: strategy.id,
      evaluatedAt: now,
      snapshot: null,
      drift: null,
      spreadRisk: null,
      proposal: null,
      reason: 'Execution blocked: Reference price or oracle telemetry is stale (REFERENCE_STALE).'
    };
  }

  // 2. Market closed check (fail closed if strategy disallows closed-market rebalancing)
  if (marketState === 'MARKET_CLOSED' && !strategy.allowClosedMarketRebalance) {
    return {
      state: 'MARKET_CLOSED',
      strategyId: strategy.id,
      evaluatedAt: now,
      snapshot: null,
      drift: null,
      spreadRisk: null,
      proposal: null,
      reason: 'Underlying equity market is closed. Rebalancing is paused until market session opens.'
    };
  }

  // 3. Stock Price Validation
  if (!input.stockPrice) {
    return {
      state: 'DATA_UNAVAILABLE',
      strategyId: strategy.id,
      evaluatedAt: now,
      snapshot: null,
      drift: null,
      spreadRisk: null,
      proposal: null,
      reason: 'Stock token price data is unavailable.'
    };
  }

  const stockTokenPrice = input.stockPrice.tokenPrice;
  if (typeof stockTokenPrice !== 'number' || !Number.isFinite(stockTokenPrice) || stockTokenPrice <= 0) {
    return {
      state: 'DATA_UNAVAILABLE',
      strategyId: strategy.id,
      evaluatedAt: now,
      snapshot: null,
      drift: null,
      spreadRisk: null,
      proposal: null,
      reason: `Stock token price is invalid or non-positive: ${stockTokenPrice}.`
    };
  }

  // Stock price staleness check
  const stockPriceTs = input.stockPrice.timestamp ?? input.stockPrice.tokenPriceUpdatedAt;
  if (typeof stockPriceTs === 'number' && stockPriceTs > 0) {
    const quoteAge = Math.max(0, Math.floor((now - stockPriceTs) / 1000));
    if (quoteAge > maxStaleness) {
      return {
        state: 'DATA_UNAVAILABLE',
        strategyId: strategy.id,
        evaluatedAt: now,
        snapshot: null,
        drift: null,
        spreadRisk: null,
        proposal: null,
        reason: `Stock price quote is stale (${quoteAge}s old, max allowable: ${maxStaleness}s).`
      };
    }
  }

  // 4. Stablecoin Price Validation
  if (!input.stablePrice) {
    return {
      state: 'DATA_UNAVAILABLE',
      strategyId: strategy.id,
      evaluatedAt: now,
      snapshot: null,
      drift: null,
      spreadRisk: null,
      proposal: null,
      reason: 'Stablecoin price data is unavailable.'
    };
  }

  const stablePriceUsd = input.stablePrice.priceUsd ?? input.stablePrice.tokenPrice;
  if (typeof stablePriceUsd !== 'number' || !Number.isFinite(stablePriceUsd) || stablePriceUsd <= 0) {
    return {
      state: 'DATA_UNAVAILABLE',
      strategyId: strategy.id,
      evaluatedAt: now,
      snapshot: null,
      drift: null,
      spreadRisk: null,
      proposal: null,
      reason: `Stablecoin price is invalid or non-positive: ${stablePriceUsd}.`
    };
  }

  // 5. Wallet Balances Validation
  if (!input.stockBalance || !input.stableBalance) {
    return {
      state: 'DATA_UNAVAILABLE',
      strategyId: strategy.id,
      evaluatedAt: now,
      snapshot: null,
      drift: null,
      spreadRisk: null,
      proposal: null,
      reason: 'Wallet balance data is missing or incomplete for required portfolio assets.'
    };
  }

  // Check verification failure states
  const invalidStatuses: BalanceVerificationStatus[] = ['INVALID_WALLET', 'MISMATCH', 'INVALID_RESPONSE', 'BOTH_UNAVAILABLE'];
  if (input.stockBalance.verificationStatus && invalidStatuses.includes(input.stockBalance.verificationStatus)) {
    return {
      state: 'DATA_UNAVAILABLE',
      strategyId: strategy.id,
      evaluatedAt: now,
      snapshot: null,
      drift: null,
      spreadRisk: null,
      proposal: null,
      reason: `Stock balance verification failed with status: ${input.stockBalance.verificationStatus}.`
    };
  }

  if (input.stableBalance.verificationStatus && invalidStatuses.includes(input.stableBalance.verificationStatus)) {
    return {
      state: 'DATA_UNAVAILABLE',
      strategyId: strategy.id,
      evaluatedAt: now,
      snapshot: null,
      drift: null,
      spreadRisk: null,
      proposal: null,
      reason: `Stablecoin balance verification failed with status: ${input.stableBalance.verificationStatus}.`
    };
  }

  // Extract raw and formatted balances
  const stockRaw = input.stockBalance.verifiedRawBalance ?? input.stockBalance.rpcRawBalance ?? input.stockBalance.amountRaw;
  const stableRaw = input.stableBalance.verifiedRawBalance ?? input.stableBalance.rpcRawBalance ?? input.stableBalance.amountRaw;

  if (stockRaw === null || stockRaw === undefined) {
    return {
      state: 'DATA_UNAVAILABLE',
      strategyId: strategy.id,
      evaluatedAt: now,
      snapshot: null,
      drift: null,
      spreadRisk: null,
      proposal: null,
      reason: 'Stock raw integer balance is missing.'
    };
  }

  if (stableRaw === null || stableRaw === undefined) {
    return {
      state: 'DATA_UNAVAILABLE',
      strategyId: strategy.id,
      evaluatedAt: now,
      snapshot: null,
      drift: null,
      spreadRisk: null,
      proposal: null,
      reason: 'Stablecoin raw integer balance is missing.'
    };
  }

  // 6. Zero/Empty Portfolio Guard (Zero Mock enforcement)
  // If both wallet balances are genuinely zero, fail closed to INSUFFICIENT_PORTFOLIO_DATA rather than inventing an allocation
  if (stockRaw === 0n && stableRaw === 0n) {
    return {
      state: 'INSUFFICIENT_PORTFOLIO_DATA',
      strategyId: strategy.id,
      evaluatedAt: now,
      snapshot: null,
      drift: null,
      spreadRisk: null,
      proposal: null,
      reason: 'Both wallet balances are zero (0 tokens). Insufficient portfolio data to calculate allocation drift or execute rebalancing.'
    };
  }

  // Format token amounts preserving decimals
  const stockFormatted = input.stockBalance.amountFormatted !== undefined && input.stockBalance.amountFormatted !== null
    ? input.stockBalance.amountFormatted
    : Number(formatUnits(stockRaw, input.stockBalance.decimals));

  const stableFormatted = input.stableBalance.amountFormatted !== undefined && input.stableBalance.amountFormatted !== null
    ? input.stableBalance.amountFormatted
    : Number(formatUnits(stableRaw, input.stableBalance.decimals));

  // 7. Calculate Portfolio Values & Weights
  const stockValUsd = stockFormatted * stockTokenPrice;
  const stableValUsd = stableFormatted * stablePriceUsd;
  const totalValUsd = stockValUsd + stableValUsd;

  if (totalValUsd <= 0 || !Number.isFinite(totalValUsd)) {
    return {
      state: 'INSUFFICIENT_PORTFOLIO_DATA',
      strategyId: strategy.id,
      evaluatedAt: now,
      snapshot: null,
      drift: null,
      spreadRisk: null,
      proposal: null,
      reason: 'Total portfolio valuation is non-positive. Insufficient portfolio data to calculate allocation.'
    };
  }

  const currentStockWeightBps = Math.round((stockValUsd / totalValUsd) * 10000);
  const currentStableWeightBps = 10000 - currentStockWeightBps;

  const quoteTs = stockPriceTs ?? now;
  const quoteAgeSeconds = Math.max(0, Math.floor((now - quoteTs) / 1000));

  const stockBalanceObj: PortfolioBalance = {
    symbol: strategy.stockSymbol,
    address: strategy.stockAddress,
    amountRaw: stockRaw,
    decimals: input.stockBalance.decimals,
    amountFormatted: stockFormatted,
    priceUsd: stockTokenPrice,
    valueUsd: stockValUsd
  };

  const stableBalanceObj: PortfolioBalance = {
    symbol: strategy.stableSymbol,
    address: strategy.stableAddress,
    amountRaw: stableRaw,
    decimals: input.stableBalance.decimals,
    amountFormatted: stableFormatted,
    priceUsd: stablePriceUsd,
    valueUsd: stableValUsd
  };

  const snapshot: PortfolioSnapshot = {
    timestamp: now,
    stock: stockBalanceObj,
    stable: stableBalanceObj,
    totalValueUsd: totalValUsd,
    currentStockWeightBps,
    currentStableWeightBps,
    quoteTimestamp: quoteTs,
    quoteAgeSeconds
  };

  // 8. Deterministic Drift Calculation
  const driftBps = Math.abs(currentStockWeightBps - strategy.targetStockWeightBps);
  const driftThresholdBps = strategy.driftThresholdBps ?? 500;
  const exceedsThreshold = driftBps >= driftThresholdBps;

  let driftDirection: 'OVERWEIGHT_STOCK' | 'UNDERWEIGHT_STOCK' | 'BALANCED' = 'BALANCED';
  if (currentStockWeightBps > strategy.targetStockWeightBps) {
    driftDirection = 'OVERWEIGHT_STOCK';
  } else if (currentStockWeightBps < strategy.targetStockWeightBps) {
    driftDirection = 'UNDERWEIGHT_STOCK';
  }

  const driftAnalysis: DriftAnalysis = {
    currentStockWeightBps,
    targetStockWeightBps: strategy.targetStockWeightBps,
    driftBps,
    driftThresholdBps,
    exceedsThreshold,
    driftDirection
  };

  // 9. Deterministic Spread Intelligence & Risk Evaluation
  let spread: number | null = null;
  if (input.stockPrice.spread !== undefined && input.stockPrice.spread !== null) {
    spread = input.stockPrice.spread;
  } else if (
    input.stockPrice.referencePrice !== undefined &&
    input.stockPrice.referencePrice !== null &&
    input.stockPrice.referencePrice > 0
  ) {
    spread = (stockTokenPrice - input.stockPrice.referencePrice) / input.stockPrice.referencePrice;
  }

  const spreadBps = spread !== null ? Math.round(spread * 10000) : null;
  const maxSpreadBps = strategy.maxSpreadBps ?? 200; // 2.0% default max spread premium

  // Spread risk blocks BUY_STOCK when tokenized price trades at an excessive premium above reference
  let isExcessiveSpread = false;
  if (driftDirection === 'UNDERWEIGHT_STOCK' && spreadBps !== null && spreadBps > maxSpreadBps) {
    isExcessiveSpread = true;
  }

  const spreadRisk: SpreadRiskAnalysis = {
    tokenPrice: stockTokenPrice,
    referencePrice: input.stockPrice.referencePrice ?? null,
    spread,
    spreadBps,
    maxSpreadBps,
    isExcessive: isExcessiveSpread
  };

  // If spread is excessive when attempting to buy stock, trip RISK_BLOCKED circuit breaker
  if (isExcessiveSpread) {
    const spreadPctStr = spread !== null ? (spread * 100).toFixed(2) : 'N/A';
    const maxSpreadPctStr = (maxSpreadBps / 100).toFixed(2);
    return {
      state: 'RISK_BLOCKED',
      strategyId: strategy.id,
      evaluatedAt: now,
      snapshot,
      drift: driftAnalysis,
      spreadRisk,
      proposal: null,
      reason: `Execution blocked: Token/reference spread (${spreadPctStr}% / ${spreadBps} bps) exceeds maximum allowed spread (${maxSpreadPctStr}% / ${maxSpreadBps} bps) for purchasing ${strategy.stockSymbol}.`
    };
  }

  // 10. Drift Tolerance Decision
  if (!exceedsThreshold) {
    const stockPctStr = (currentStockWeightBps / 100).toFixed(2);
    const targetPctStr = (strategy.targetStockWeightBps / 100).toFixed(2);
    const proposal: RebalanceProposal = {
      action: 'NONE',
      sourceAsset: '',
      targetAsset: '',
      tradeAmountUsd: 0,
      approxTokenAmount: 0,
      slippageLimitBps: 0,
      marketState,
      reason: `Portfolio is within drift tolerance (drift: ${driftBps} bps, threshold: ${driftThresholdBps} bps). Current allocation: ${stockPctStr}% (target: ${targetPctStr}%).`,
      generatedAt: now
    };

    return {
      state: 'NO_ACTION',
      strategyId: strategy.id,
      evaluatedAt: now,
      snapshot,
      drift: driftAnalysis,
      spreadRisk,
      proposal,
      reason: proposal.reason
    };
  }

  // 11. Rebalance Proposal Construction
  const targetStockValueUsd = (strategy.targetStockWeightBps / 10000) * totalValUsd;
  const deltaUsd = Math.abs(stockValUsd - targetStockValueUsd);
  const tradeAmountUsd = strategy.maxSingleTradeUsd > 0
    ? Math.min(deltaUsd, strategy.maxSingleTradeUsd)
    : deltaUsd;

  const approxTokenAmount = stockTokenPrice > 0 ? tradeAmountUsd / stockTokenPrice : 0;
  const slippageLimitBps = marketState === 'MARKET_OPEN'
    ? (input.maxSlippageOpenBps ?? DEFAULT_SAFETY_POLICY_SLIPPAGE_OPEN_BPS)
    : (input.maxSlippageClosedBps ?? DEFAULT_SAFETY_POLICY_SLIPPAGE_CLOSED_BPS);

  let proposal: RebalanceProposal;

  if (driftDirection === 'OVERWEIGHT_STOCK') {
    proposal = {
      action: 'SELL_STOCK',
      sourceAsset: strategy.stockSymbol,
      targetAsset: strategy.stableSymbol,
      tradeAmountUsd,
      approxTokenAmount,
      slippageLimitBps,
      marketState,
      reason: `Stock is overweight by ${driftBps} bps (${(currentStockWeightBps / 100).toFixed(2)}% vs target ${(strategy.targetStockWeightBps / 100).toFixed(2)}%). Proposing spot sell of $${tradeAmountUsd.toFixed(2)} USD of ${strategy.stockSymbol}.`,
      generatedAt: now
    };
  } else {
    proposal = {
      action: 'BUY_STOCK',
      sourceAsset: strategy.stableSymbol,
      targetAsset: strategy.stockSymbol,
      tradeAmountUsd,
      approxTokenAmount,
      slippageLimitBps,
      marketState,
      reason: `Stock is underweight by ${driftBps} bps (${(currentStockWeightBps / 100).toFixed(2)}% vs target ${(strategy.targetStockWeightBps / 100).toFixed(2)}%). Proposing spot buy of $${tradeAmountUsd.toFixed(2)} USD of ${strategy.stockSymbol}.`,
      generatedAt: now
    };
  }

  return {
    state: 'REBALANCE_REQUIRED',
    strategyId: strategy.id,
    evaluatedAt: now,
    snapshot,
    drift: driftAnalysis,
    spreadRisk,
    proposal,
    reason: proposal.reason
  };
}

/**
 * DeterministicPortfolioEngine
 * Provides an object-oriented interface for strategy evaluation.
 */
export class DeterministicPortfolioEngine {
  constructor(private readonly defaultStrategy: StrategyConfig = DEFAULT_MVP_STRATEGY_CONFIG) {}

  public evaluate(input: StrategyEvaluationInput): StrategyEvaluationResult {
    const mergedInput: StrategyEvaluationInput = {
      ...input,
      strategy: input.strategy ?? this.defaultStrategy
    };
    return evaluatePortfolioStrategy(mergedInput);
  }
}
