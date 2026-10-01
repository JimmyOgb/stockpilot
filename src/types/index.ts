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
  stockBalanceVerificationStatus: string;
  stableBalanceVerificationStatus: string;
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
  freshness_passed: boolean;
  balance_verified: boolean;
  price_verified: boolean;
  spread_verified: boolean;
  market_state_verified: boolean;
  allocation_drift_valid: boolean;
  trade_direction_valid: boolean;
  trade_amount_valid: boolean;
  risk_limits_passed: boolean;
}

export interface GenLayerContractResponse {
  status: 'ALLOW' | 'REJECT';
  finalized?: boolean;
  consensus_status?: string;
  reason: string;
  evidence_hash: string;
  proposal_id: string;
  checks: GenLayerRuleChecks;
}

export type VerificationStatus = 'ALLOW' | 'REJECT' | 'HALT';
export type VerificationDecision = 'VERIFIED' | 'NOT_VERIFIED';

export type VerificationInspectStatus =
  | 'SUBMISSION_FAILED'
  | 'CONSENSUS_PENDING'
  | 'CONSENSUS_ACCEPTED_NOT_FINAL'
  | 'CONSENSUS_FINALIZED'
  | 'CONSENSUS_FINALIZED_EXECUTION_FAILED'
  | 'NO_MAJORITY'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'EVIDENCE_INVALID'
  | 'VERIFIED'
  | 'UNAVAILABLE';

export interface VerificationResult {
  status: VerificationStatus;
  decision: VerificationDecision;
  evidenceHash: string;
  reason: string;
  verifiedAt: number;
  proposalId?: string;
  checks?: GenLayerRuleChecks;
  transactionId?: string;
  protocolStatus?: string;
  inspectStatus?: VerificationInspectStatus;
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
  transactionId?: string;
  protocolStatus?: string;
  inspectStatus?: VerificationInspectStatus;
}

export type ExecutionState =
  | 'EXECUTION_BLOCKED'
  | 'APPROVAL_REQUIRED'
  | 'EXECUTION_SUBMITTED'
  | 'EXECUTION_PENDING'
  | 'EXECUTION_CONFIRMED'
  | 'EXECUTION_FAILED'
  | 'EXECUTION_UNKNOWN';

export type ExecutionBlockReason =
  | 'EXECUTION_BLOCKED_INSUFFICIENT_LIVE_BALANCE'
  | 'EXECUTION_BLOCKED_UNVERIFIED_PROPOSAL'
  | 'EXECUTION_BLOCKED_SIMULATION_FAILED'
  | 'EXECUTION_BLOCKED_HASH_MISMATCH'
  | 'EXECUTION_BLOCKED_ID_MISMATCH'
  | 'EXECUTION_BLOCKED_MARKET_CLOSED'
  | 'EXECUTION_BLOCKED_STALE_QUOTE'
  | 'EXECUTION_BLOCKED_SPREAD_EXCESSIVE'
  | 'EXECUTION_BLOCKED_CIRCUIT_BREAKER'
  | 'EXECUTION_BLOCKED_EXCEEDS_TINY_CAP'
  | 'EXECUTION_BLOCKED_INVALID_WALLET'
  | 'EXECUTION_BLOCKED_INVALID_ASSET'
  | 'EXECUTION_BLOCKED_WALLET_LOCKED'
  | 'EXECUTION_BLOCKED_WALLET_DISCONNECTED'
  | 'EXECUTION_BLOCKED_WALLET_POLICY_REJECT'
  | 'EXECUTION_BLOCKED_USER_APPROVAL_DENIED'
  | 'EXECUTION_BLOCKED_DUPLICATE_EXECUTION'
  | 'EXECUTION_BLOCKED_LIVE_EXECUTION_DISABLED'
  | 'EXECUTION_BLOCKED_FAIL_CLOSED';

export interface BscTransactionReceipt {
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  from: string;
  to: string;
  status: '0x1' | '0x0' | number;
  gasUsed: string;
  cumulativeGasUsed: string;
  effectiveGasPrice?: string;
}

export interface ExecutionAuditRecord {
  auditId: string;
  proposalId: string;
  strategyId: string;
  verificationHash: string;
  simulationHash: string;
  walletAddress: string;
  tokenContract: string;
  direction: RebalanceAction;
  requestedAmount: number;
  actualExecutedAmount: number | null;
  executionOrderId: string | null;
  txHash: string | null;
  submissionTimestamp: number | null;
  confirmationTimestamp: number | null;
  finalExecutionStatus: ExecutionState;
  failureReason: string | null;
  idempotencyKey: string;
  isDryRun: boolean;
  blockReason?: ExecutionBlockReason | string | null;
}

export interface ExecutionReceipt {
  executionId: string;
  proposalId: string;
  strategyId: string;
  state: ExecutionState;
  idempotencyKey: string;
  orderId?: string | null;
  txHash?: string | null;
  actualExecutedAmount?: number | null;
  requestedAmount: number;
  direction: RebalanceAction;
  tokenContract: string;
  walletAddress: string;
  verificationHash: string;
  simulationHash: string;
  submissionTimestamp?: number | null;
  confirmationTimestamp?: number | null;
  blockReason?: ExecutionBlockReason | string | null;
  failureReason?: string | null;
  isDryRun: boolean;
  bscReceipt?: BscTransactionReceipt | null;
  executedAt: number;
  errorMessage?: string;
  rebalanceProposal?: RebalanceProposal;
  verificationResult?: VerificationResult;
}

export interface AgenticWalletSettings {
  dailyLimit: number;
  quotaUsed: number;
  quotaLeft: number;
  tradeAllTokens: boolean;
  abnormalTxnHandling: 'AutoReject' | 'NeedConfirmation' | string;
  allowedTokens?: string[];
  sessionExpireTime?: string;
  devMode?: {
    enabled: boolean;
    dailyLimit?: number;
    expiresAt?: number | null;
  };
}

export interface AgenticWalletStatus {
  status: 'CONNECTED' | 'UNCONNECTED' | 'CREATING';
}

export interface AgenticWalletTxLock {
  status: 'UNLOCKED' | 'LOCKED';
}

export interface AgenticWalletBalanceItem {
  symbol: string;
  address: string;
  binanceChainId: string;
  balance: string;
  price?: string;
  value?: string;
}

export interface AgenticWalletApprovalItem {
  tokenSymbol: string;
  tokenContract: string;
  tokenDecimals?: number;
  spender: string;
  spenderName?: string | null;
  amount: string;
  riskyLevel: string;
  riskyMsg?: string | null;
  binanceChainId: string;
  type: string;
}

export interface AgenticMarketOrderQuoteParams {
  fromTokenQty: number | string;
  fromToken: string;
  toToken: string;
  binanceChainId: string;
  slippage?: string;
}

export interface AgenticMarketOrderQuote {
  fromCoinSymbol: string;
  fromCoinAmount: string;
  toCoinSymbol: string;
  toCoinAmount: string;
  slippage: number | string;
}

export interface AgenticMarketOrderSwapParams {
  fromTokenQty: number | string;
  fromToken: string;
  toToken: string;
  binanceChainId: string;
  slippage?: string;
  mev?: boolean | string;
  gasLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface AgenticMarketOrderSwapResult {
  orderId: string;
}

export interface AgenticMarketOrderDetail {
  orderId: string;
  chain?: string;
  fromToken?: string;
  fromTokenName?: string;
  fromTokenQty?: string;
  toToken?: string;
  toTokenName?: string;
  toTokenQty?: string;
  status: 'PENDING' | 'FINISHED' | 'FAILED' | string;
  slippage?: string;
  txHash?: string | null;
  bookTime?: string;
  updatedTime?: string;
  failReason?: string | null;
}

export interface UserApprovalRequest {
  proposalId: string;
  strategyId: string;
  action: RebalanceAction;
  sourceAsset: string;
  targetAsset: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  tradeAmountUsd: number;
  approxTokenAmount: number;
  slippageLimitBps: number;
  marketPrice: number;
  referencePrice: number | null;
  spreadBps: number | null;
  evidenceHash: string;
  simulationHash: string;
  estimatedFeeBnb: number | null;
  walletAddress: string;
  idempotencyKey: string;
  isTinyLiveCapEnforced: boolean;
  requestedAt: number;
}

export interface UserApprovalDecision {
  approved: boolean;
  approvedBy: string;
  approvedAt: number;
  notes?: string;
}

export interface ExecutionPreflightInput {
  strategy: StrategyConfig;
  canonicalPayload: CanonicalEvidencePayload;
  verificationResult: VerificationResult;
  simulationResult: BinanceSimulationResult;
  walletAddress: string;
  userApproval?: UserApprovalDecision;
  options?: {
    isDryRun?: boolean;
    maxAllowedQuoteAgeSeconds?: number;
    tinyExecutionCapUsd?: number;
    slippage?: string;
  };
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

export * from './wallet.js';
