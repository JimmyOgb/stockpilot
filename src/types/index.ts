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

export interface GenLayerVerificationInput {
  strategy: StrategyConfig;
  balances: {
    stock: {
      symbol: string;
      contractAddress: string;
      rawAmount: string;
      formattedAmount: number;
      verificationStatus: string;
    };
    stable: {
      symbol: string;
      contractAddress: string;
      rawAmount: string;
      formattedAmount: number;
      verificationStatus: string;
    };
  };
  marketData: {
    stockTokenPrice: number;
    stockReferencePrice: number | null;
    spread: number | null;
    spreadBps: number | null;
    quoteTimestamp: number;
    quoteAgeSeconds: number;
  };
  marketStatus: {
    state: MarketState;
    rawStatus?: string;
    openState?: boolean;
    updatedAt?: number;
  };
  snapshot: PortfolioSnapshot | null;
  proposal: RebalanceProposal;
  riskChecks: {
    maxSpreadBps: number;
    maxSingleTradeUsd: number;
    isSpreadExcessive: boolean;
    isCircuitBreakerTripped: boolean;
  };
  timestamp: number;
  proposalId?: string;
}

export interface CanonicalEvidencePayload {
  version: '1.0.0';
  proposalId: string;
  strategyId: string;
  targetStockWeightBps: number;
  targetStableWeightBps: number;
  driftThresholdBps: number;
  maxSingleTradeUsd: number;
  maxSpreadBps: number;
  stockSymbol: string;
  stockContractAddress: string;
  stableSymbol: string;
  stableContractAddress: string;
  stockBalanceRaw: string;
  stockBalanceFormatted: number;
  stableBalanceRaw: string;
  stableBalanceFormatted: number;
  stockTokenPrice: number;
  stockReferencePrice: number | null;
  spread: number | null;
  spreadBps: number | null;
  marketState: MarketState;
  quoteTimestamp: number;
  quoteAgeSeconds: number;
  currentStockWeightBps: number;
  currentStableWeightBps: number;
  totalValueUsd: number;
  calculatedDriftBps: number;
  proposedAction: RebalanceAction;
  proposedTradeAmountUsd: number;
  proposedApproxTokenAmount: number;
  proposedSlippageLimitBps: number;
  sourceAsset: string;
  targetAsset: string;
  evidenceTimestamp: number;
}

export interface GenLayerRuleChecks {
  payload_valid: boolean;
  math_consistent: boolean;
  direction_consistent: boolean;
  spread_permitted: boolean;
  circuit_breaker_passed: boolean;
  market_state_permitted: boolean;
  non_zero_portfolio: boolean;
  freshness_passed?: boolean;
}

export interface GenLayerContractResponse {
  status: 'ALLOW' | 'REJECT';
  reason: string;
  evidence_hash: string;
  proposal_id: string;
  checks: GenLayerRuleChecks;
}

export type VerificationStatus = 'ALLOW' | 'REJECT' | 'HALT';
export type VerificationDecision = 'VERIFIED' | 'NOT_VERIFIED';

export interface VerificationResult {
  status: VerificationStatus;
  decision: VerificationDecision;
  evidenceHash: string;
  reason: string;
  verifiedAt: number;
  proposalId?: string;
  checks?: GenLayerRuleChecks;
}

export interface GenLayerVerificationAuditRecord {
  auditId: string;
  proposalId: string;
  strategyId: string;
  evidenceHash: string;
  canonicalPayload: CanonicalEvidencePayload;
  status: VerificationStatus;
  decision: VerificationDecision;
  reason: string;
  verifiedAt: number;
  contractAddress: string;
  rpcUrl: string;
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

// ============================================================================
// Binance Transaction Preflight / Simulation Types
// ============================================================================

export type SimulationStatus =
  | 'SUCCESS'
  | 'REVERT'
  | 'SIMULATION_ERROR'
  | 'UNVERIFIED_PROPOSAL'
  | 'NO_ACTION_PROPOSAL'
  | 'HASH_MISMATCH'
  | 'ID_MISMATCH'
  | 'MARKET_CLOSED'
  | 'STALE_QUOTE'
  | 'SPREAD_RISK_BREACH'
  | 'CIRCUIT_BREAKER_BREACH'
  | 'INVALID_WALLET'
  | 'INVALID_TRADE_AMOUNT'
  | 'MISSING_FEE_DATA'
  | 'INSUFFICIENT_FUNDS'
  | 'RISK_BLOCKED'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR';

export type SimulationDecision = 'SIMULATED_OK' | 'SIMULATION_FAILED';

export interface BinanceSimulationRequest {
  binanceChainId: string;
  fromAddress: string;
  toAddress: string;
  calldata?: string;
  value?: string;
  gasLimit?: string;
  gasPrice?: string;
}

export interface SimulationPreflightInput {
  verificationResult: VerificationResult;
  canonicalPayload: CanonicalEvidencePayload;
  walletAddress: string;
  maxAllowedQuoteAgeSeconds?: number;
  customTx?: Partial<BinanceSimulationRequest>;
}

export interface BinanceSimulationResult {
  decision: SimulationDecision;
  status: SimulationStatus;
  simulationHash: string;
  proposalId: string;
  evidenceHash: string;
  gasUsed: bigint | null;
  gasLimit: bigint | null;
  gasPriceGwei: number | null;
  estimatedFeeBnb: number | null;
  estimatedFeeUsd: number | null;
  revertReason: string | null;
  rawResponse: Record<string, unknown> | null;
  simulatedAt: number;
  reason: string;
}

export interface BinanceSimulationAuditRecord {
  auditId: string;
  proposalId: string;
  evidenceHash: string;
  simulationHash: string;
  decision: SimulationDecision;
  status: SimulationStatus;
  gasUsed: string | null;
  gasPriceGwei: number | null;
  estimatedFeeBnb: string | null;
  simulatedAt: number;
  reason: string;
}

