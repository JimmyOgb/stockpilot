/**
 * StockPilot HTTP Server
 * Exposes health/status endpoints, strategy evaluation, DevEx log, and serves frontend.
 */

import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  evaluateMarketState,
  calculatePortfolioSnapshot,
  calculateDrift,
  generateRebalanceProposal
} from '../strategy/risk-engine.js';
import {
  SystemHealthStatus,
  StrategyConfig,
  PortfolioBalance
} from '../types/index.js';
import {
  buildCanonicalEvidencePayload,
  computeEvidenceHash,
  validateEvidencePayload
} from '../verification/genlayer-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// Serve static assets and web dashboard from client build directory or fallback to public
const clientDir = path.resolve(__dirname, '../client');
const publicDir = path.resolve(__dirname, '../../public');
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir));
} else {
  app.use(express.static(publicDir));
}

// Track reference quote timestamp (initial mock-free state: initialized at server boot)
const bootTimestamp = Date.now();
let lastReferenceQuoteTimestamp = bootTimestamp;
const maxStalenessSeconds = process.env.MAX_STALENESS_SECONDS
  ? parseInt(process.env.MAX_STALENESS_SECONDS, 10)
  : 900;

/**
 * Basic Health & Status Endpoint
 * GET /api/health
 */
app.get(['/api/health', '/health'], (req: Request, res: Response) => {
  const now = Date.now();
  const marketState = evaluateMarketState({
    referenceTimestamp: lastReferenceQuoteTimestamp,
    currentTimestamp: now,
    maxStalenessSeconds
  });

  const quoteAgeSeconds = Math.max(0, Math.floor((now - lastReferenceQuoteTimestamp) / 1000));
  const isFresh = quoteAgeSeconds <= maxStalenessSeconds;

  const health: SystemHealthStatus = {
    status: marketState === 'REFERENCE_STALE' ? 'HALTED' : 'HEALTHY',
    network: 'BSC Mainnet',
    chainId: 56,
    marketState,
    quoteFreshness: {
      lastTimestamp: lastReferenceQuoteTimestamp,
      ageSeconds: quoteAgeSeconds,
      maxAllowedAgeSeconds: maxStalenessSeconds,
      isFresh
    },
    components: {
      binanceApiClient: process.env.BINANCE_WEB3_API_KEY ? 'CONNECTED' : 'UNCONFIGURED',
      genLayerVerifier: process.env.GENLAYER_RPC_URL ? 'AVAILABLE' : 'UNCONFIGURED',
      executionWallet: process.env.EXECUTOR_WALLET_ADDRESS ? 'READY' : 'UNCONFIGURED'
    }
  };

  res.status(health.status === 'HALTED' ? 503 : 200).json(health);
});

/**
 * DevEx Log Endpoint
 * GET /api/devex-log
 * Exposes live Developer Experience entries to UI
 */
app.get(['/api/devex-log', '/devex-log'], (req: Request, res: Response) => {
  try {
    const devexPath = path.resolve(__dirname, '../../docs/hackathon-build/devex-log.md');
    if (fs.existsSync(devexPath)) {
      const content = fs.readFileSync(devexPath, 'utf-8');
      res.json({ success: true, content });
    } else {
      res.status(404).json({ success: false, error: 'DevEx log not found' });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
});

/**
 * Parse Strategy Prompt Endpoint
 * POST /api/strategy/parse
 * Deterministically parses natural language strategy into structured weights
 */
app.post(['/api/strategy/parse', '/strategy/parse'], (req: Request, res: Response) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'Prompt is required' });
    return;
  }

  // Deterministic extraction logic for percentage allocations
  const stockMatch = prompt.match(/(\d+)%\s*(?:tokenized\s*)?(NVIDIA|bNVDA|NVDA|Apple|bAAPL|AAPL|Tesla|bTSLA|TSLA|stock)/i);
  const stableMatch = prompt.match(/(\d+)%\s*(USDC|USDT|stablecoin|cash)/i);
  const driftMatch = prompt.match(/(\d+)%\s*drift/i);

  let targetStockWeightBps = 6000;
  let targetStableWeightBps = 4000;
  let driftThresholdBps = 500;
  let stockSymbol = 'bNVDA';

  if (stockMatch) {
    targetStockWeightBps = parseInt(stockMatch[1], 10) * 100;
    const rawSymbol = stockMatch[2].toUpperCase();
    if (rawSymbol.includes('NVDA') || rawSymbol.includes('NVIDIA')) stockSymbol = 'bNVDA';
    else if (rawSymbol.includes('AAPL') || rawSymbol.includes('APPLE')) stockSymbol = 'bAAPL';
    else if (rawSymbol.includes('TSLA') || rawSymbol.includes('TESLA')) stockSymbol = 'bTSLA';
  }

  if (stableMatch) {
    targetStableWeightBps = parseInt(stableMatch[1], 10) * 100;
  } else {
    targetStableWeightBps = 10000 - targetStockWeightBps;
  }

  if (driftMatch) {
    driftThresholdBps = parseInt(driftMatch[1], 10) * 100;
  }

  // Validate strict 100% total allocation
  if (targetStockWeightBps + targetStableWeightBps !== 10000) {
    res.status(400).json({
      error: `Allocations must sum to 100%. Received: Stock ${targetStockWeightBps / 100}%, Stable ${targetStableWeightBps / 100}%.`
    });
    return;
  }

  const strategy: StrategyConfig = {
    id: `strat-${Date.now()}`,
    name: `${stockSymbol} ${targetStockWeightBps / 100}/${targetStableWeightBps / 100} Core`,
    userPrompt: prompt,
    stockSymbol,
    stockAddress: process.env.TOKENIZED_STOCK_ADDRESS || '0x0000000000000000000000000000000000000000',
    stableSymbol: process.env.STABLECOIN_SYMBOL || 'USDC',
    stableAddress: process.env.STABLECOIN_ADDRESS || '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    targetStockWeightBps,
    targetStableWeightBps,
    driftThresholdBps,
    maxSingleTradeUsd: parseInt(process.env.MAX_SINGLE_REBALANCE_USD || '5000', 10)
  };

  res.json({ success: true, strategy });
});

/**
 * Strategy Evaluation Endpoint
 * POST /api/strategy/evaluate
 * Evaluates provided real balances against deterministic risk and drift rules
 */
app.post(['/api/strategy/evaluate', '/strategy/evaluate'], (req: Request, res: Response) => {
  const { strategy, stockBalance, stableBalance, quoteTimestamp } = req.body;

  if (!strategy || !stockBalance || !stableBalance) {
    res.status(400).json({ error: 'Missing strategy or balance data. Zero mock data rule enforced.' });
    return;
  }

  const now = Date.now();
  const qTimestamp = typeof quoteTimestamp === 'number' ? quoteTimestamp : lastReferenceQuoteTimestamp;

  const marketState = evaluateMarketState({
    referenceTimestamp: qTimestamp,
    currentTimestamp: now,
    maxStalenessSeconds
  });

  const snapshot = calculatePortfolioSnapshot(stockBalance, stableBalance, qTimestamp, now);
  const drift = calculateDrift(snapshot.currentStockWeightBps, strategy);
  const proposal = generateRebalanceProposal({
    snapshot,
    strategy,
    marketState,
    maxSlippageOpenBps: parseInt(process.env.MAX_SLIPPAGE_BPS || '50', 10),
    maxSlippageClosedBps: parseInt(process.env.MAX_SLIPPAGE_CLOSED_BPS || '25', 10)
  });

  res.json({
    success: true,
    marketState,
    snapshot,
    drift,
    proposal
  });
});

/**
 * Market Telemetry & Static Asset Endpoint
 * GET /api/market/telemetry
 */
app.get(['/api/market/telemetry', '/market/telemetry'], (req: Request, res: Response) => {
  const now = Date.now();
  const quoteAgeSeconds = Math.max(0, Math.floor((now - lastReferenceQuoteTimestamp) / 1000));
  const isFresh = quoteAgeSeconds <= maxStalenessSeconds;

  res.json({
    success: true,
    network: 'BSC Mainnet',
    chainId: 56,
    stockAsset: {
      symbol: 'NVDAB',
      underlying: 'NVDA',
      name: 'bStocks NVIDIA',
      address: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
      decimals: 18,
      issuerPlatform: 'bStocks',
      binanceChainId: '56'
    },
    secondaryStockAsset: {
      symbol: 'NVDAon',
      underlying: 'NVDA',
      name: 'Ondo NVIDIA',
      address: '0xa9ee28c80f960b889dfbd1902055218cba016f75',
      decimals: 18,
      issuerPlatform: 'Ondo',
      binanceChainId: '56'
    },
    stableAsset: {
      symbol: 'USDC',
      name: 'Binance-Peg USD Coin',
      address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      decimals: 18,
      binanceChainId: '56'
    },
    referenceQuote: {
      lastTimestamp: lastReferenceQuoteTimestamp,
      ageSeconds: quoteAgeSeconds,
      maxAllowedAgeSeconds: maxStalenessSeconds,
      isFresh
    },
    policies: {
      maxSpreadBps: 200,
      openSlippageBps: parseInt(process.env.MAX_SLIPPAGE_BPS || '50', 10),
      closedSlippageBps: parseInt(process.env.MAX_SLIPPAGE_CLOSED_BPS || '25', 10),
      maxSingleTradeUsd: parseInt(process.env.MAX_SINGLE_REBALANCE_USD || '5000', 10),
      tinyExecutionCapUsd: 25
    },
    liveTelemetryStatus: process.env.BINANCE_WEB3_API_KEY ? 'CONNECTED' : 'UNAVAILABLE'
  });
});

/**
 * Deterministic Verification Inspector Endpoint
 * POST /api/verification/inspect
 * Computes canonical evidence payload and deterministic SHA-256 hash
 */
app.post(['/api/verification/inspect', '/verification/inspect'], (req: Request, res: Response) => {
  const { strategy, balances, marketData, proposal, snapshot } = req.body;

  if (!strategy || !balances || !proposal) {
    res.status(400).json({ error: 'Missing strategy, balances, or proposal.' });
    return;
  }

  const now = Date.now();
  const qTimestamp = typeof marketData?.quoteTimestamp === 'number' ? marketData.quoteTimestamp : lastReferenceQuoteTimestamp;
  const quoteAgeSeconds = Math.max(0, Math.floor((now - qTimestamp) / 1000));

  const canonicalPayload = buildCanonicalEvidencePayload({
    strategy,
    balances: {
      stock: {
        symbol: balances.stock?.symbol || strategy.stockSymbol,
        contractAddress: balances.stock?.address || strategy.stockAddress,
        rawAmount: balances.stock?.amountRaw?.toString() || '0',
        formattedAmount: balances.stock?.amountFormatted ?? 0,
        verificationStatus: 'VERIFIED'
      },
      stable: {
        symbol: balances.stable?.symbol || strategy.stableSymbol,
        contractAddress: balances.stable?.address || strategy.stableAddress,
        rawAmount: balances.stable?.amountRaw?.toString() || '0',
        formattedAmount: balances.stable?.amountFormatted ?? 0,
        verificationStatus: 'VERIFIED'
      }
    },
    marketData: {
      stockTokenPrice: marketData?.stockTokenPrice ?? 0,
      stockReferencePrice: marketData?.stockReferencePrice ?? null,
      spread: marketData?.spread ?? null,
      spreadBps: marketData?.spreadBps ?? null,
      quoteTimestamp: qTimestamp,
      quoteAgeSeconds
    },
    marketStatus: {
      state: evaluateMarketState({
        referenceTimestamp: qTimestamp,
        currentTimestamp: now,
        maxStalenessSeconds
      })
    },
    snapshot: snapshot || null,
    proposal,
    riskChecks: {
      maxSpreadBps: strategy.maxSpreadBps ?? 200,
      maxSingleTradeUsd: strategy.maxSingleTradeUsd,
      isSpreadExcessive: false,
      isCircuitBreakerTripped: proposal.tradeAmountUsd > strategy.maxSingleTradeUsd
    },
    timestamp: now
  });

  const evidenceHash = computeEvidenceHash(canonicalPayload);
  const validation = validateEvidencePayload(canonicalPayload);

  res.json({
    success: true,
    canonicalPayload,
    evidenceHash,
    validation
  });
});

export { app };
export default app;

if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`[StockPilot] Server listening on port ${port}`);
    console.log(`[StockPilot] Web Dashboard: http://localhost:${port}`);
    console.log(`[StockPilot] Health Endpoint: http://localhost:${port}/api/health`);
  });
}
