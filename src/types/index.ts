/**
 * StockPilot Core Domain Types
 * BNB Hack: Tokenized Stocks Edition
 */

export type MarketState = 'MARKET_OPEN' | 'MARKET_CLOSED' | 'REFERENCE_STALE';

export type RwaIssuerPlatform = 'bStocks' | 'Ondo' | 'xStocks';

export interface RwaAssetDescriptor {
  underlyingTicker: string;          // e.g. "NVDA"
  issuerPlatform: RwaIssuerPlatform; // e.g. "bStocks"
  tokenSymbol: string;               // e.g. "NVDAB"
  tokenContractAddress: string;      // e.g. "0x02fca66c1d1afb4e2a7884261eb00f63598a7436"
  binanceChainId: string;            // e.g. "56"
  decimals: number;                  // 18
  platformId?: number;
}

export interface StrategyConfig {
  id: string;
  name: string;
  userPrompt: string;
  stockSymbol: string;
  stockAddress: string;
  underlyingTicker?: string;
  issuerPlatform?: RwaIssuerPlatform;
  stableSymbol: string;
  stableAddress: string;
  targetStockWeightBps: number;  // 100 bps = 1.0% (e.g. 6000 bps = 60.0%)
  targetStableWeightBps: number; // e.g. 4000 bps = 40.0%
  driftThresholdBps: number;     // e.g. 500 bps = 5.0%
  maxSingleTradeUsd: number;
  maxSpreadBps?: number;         // e.g. 200 bps = 2.0% max premium over reference price
  allowClosedMarketRebalance?: boolean;
}

export const DEFAULT_MVP_STRATEGY_CONFIG: StrategyConfig = {
  id: 'strat-nvda-usdc-60-40',
  name: 'bStocks NVDAB / USDC 60-40 Core',
  userPrompt: 'Keep 60% tokenized NVIDIA (NVDAB) and 40% USDC. Rebalance when stock allocation drifts more than 5%.',
  stockSymbol: 'NVDAB',
  stockAddress: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
  underlyingTicker: 'NVDA',
  issuerPlatform: 'bStocks',
  stableSymbol: 'USDC',
  stableAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  targetStockWeightBps: 6000, // 60.0%
  targetStableWeightBps: 4000, // 40.0%
  driftThresholdBps: 500,     // 5.0%
  maxSingleTradeUsd: 5000,    // $5,000 circuit breaker
  maxSpreadBps: 200,          // 2.0% max spread
  allowClosedMarketRebalance: false
};

export type StrategyDecisionState =
  | 'NO_ACTION'
  | 'REBALANCE_REQUIRED'
  | 'INSUFFICIENT_PORTFOLIO_DATA'
  | 'MARKET_CLOSED'
  | 'DATA_UNAVAILABLE'
  | 'RISK_BLOCKED';

export interface SpreadRiskAnalysis {
  tokenPrice: number;
  referencePrice: number | null;
  spread: number | null;
  spreadBps: number | null;
  maxSpreadBps: number;
  isExcessive: boolean;
}

export interface StrategyEvaluationResult {
  state: StrategyDecisionState;
  strategyId: string;
  evaluatedAt: number;
  snapshot: PortfolioSnapshot | null;
  drift: DriftAnalysis | null;
  spreadRisk: SpreadRiskAnalysis | null;
  proposal: RebalanceProposal | null;
  reason: string;
}

export interface PortfolioBalance {
  symbol: string;
  address: string;
  amountRaw: bigint;
  decimals: number;
  amountFormatted: number;
  priceUsd: number;
  valueUsd: number;
}

export interface PortfolioSnapshot {
  timestamp: number;
  stock: PortfolioBalance;
  stable: PortfolioBalance;
  totalValueUsd: number;
  currentStockWeightBps: number;
  currentStableWeightBps: number;
  quoteTimestamp: number;
  quoteAgeSeconds: number;
}

export interface DriftAnalysis {
  currentStockWeightBps: number;
  targetStockWeightBps: number;
  driftBps: number;
  driftThresholdBps: number;
  exceedsThreshold: boolean;
  driftDirection: 'OVERWEIGHT_STOCK' | 'UNDERWEIGHT_STOCK' | 'BALANCED';
}

export type RebalanceAction = 'BUY_STOCK' | 'SELL_STOCK' | 'NONE';

export interface RebalanceProposal {
  action: RebalanceAction;
  sourceAsset: string;
  targetAsset: string;
  tradeAmountUsd: number;
  approxTokenAmount: number;
  slippageLimitBps: number;
  marketState: MarketState;
  reason: string;
  generatedAt: number;
}

export interface VerificationEvidence {
  strategyId: string;
  targetStockWeightBps: number;
  currentStockWeightBps: number;
  driftBps: number;
  marketState: MarketState;
  quoteAgeSeconds: number;
  proposal: RebalanceProposal;
  timestamp: number;
}

export type VerificationStatus = 'ALLOW' | 'REJECT' | 'HALT';

export interface VerificationResult {
  status: VerificationStatus;
  evidenceHash: string;
  reason: string;
  verifiedAt: number;
}

export type ExecutionState = 'PENDING' | 'EXECUTED' | 'FAILED' | 'BLOCKED_FAIL_CLOSED';

export interface ExecutionReceipt {
  executionId: string;
  strategyId: string;
  state: ExecutionState;
  txHash?: string;
  rebalanceProposal: RebalanceProposal;
  verificationResult: VerificationResult;
  executedAt: number;
  errorMessage?: string;
}

export interface SystemHealthStatus {
  status: 'HEALTHY' | 'DEGRADED' | 'HALTED';
  network: string;
  chainId: number;
  marketState: MarketState;
  quoteFreshness: {
    lastTimestamp: number;
    ageSeconds: number;
    maxAllowedAgeSeconds: number;
    isFresh: boolean;
  };
  components: {
    binanceApiClient: 'CONNECTED' | 'DISCONNECTED' | 'UNCONFIGURED';
    genLayerVerifier: 'AVAILABLE' | 'UNAVAILABLE' | 'UNCONFIGURED';
    executionWallet: 'READY' | 'UNCONFIGURED';
  };
}
