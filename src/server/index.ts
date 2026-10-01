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
  PortfolioBalance,
  VerificationResult
} from '../types/index.js';
import {
  buildCanonicalEvidencePayload,
  computeEvidenceHash,
  validateEvidencePayload,
  GenLayerVerificationAdapter
} from '../verification/genlayer-adapter.js';
import {
  isValidEvmAddress,
  encodeErc20BalanceOfCalldata,
  formatUnits,
  BinanceWalletBalanceClient
} from '../binance/wallet-balance-client.js';
import { BinanceRequestSigner } from '../binance/request-signer.js';
import { BinanceRwaClient } from '../binance/rwa-client.js';
import { WalletPortfolioResponse, ConnectedTokenBalance } from '../types/index.js';

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
app.get(['/api/market/telemetry', '/market/telemetry'], async (req: Request, res: Response) => {
  const now = Date.now();
  let livePrice: { tokenPrice: number; referencePrice: number; spread: number | null; tokenPriceUpdatedAt: number } | null = null;
  let liveMarket: { status: string } | null = null;
  try {
    const apiKey = process.env.BINANCE_WEB3_API_KEY;
    const apiSecret = process.env.BINANCE_WEB3_API_SECRET;
    if (apiKey && apiSecret) {
      const rwa = new BinanceRwaClient({ signer: new BinanceRequestSigner({ apiKey, apiSecret }), baseUrl: process.env.BINANCE_WEB3_API_BASE_URL });
      const address = process.env.TOKENIZED_STOCK_ADDRESS || '0x02fca66c1d1afb4e2a7884261eb00f63598a7436';
      const [price, market] = await Promise.all([
        rwa.getRwaPriceAndSpread({ tokenContractAddresses: address, binanceChainId: '56' }),
        rwa.getUnderlyingMarketStatus({ tokenContractAddress: address, binanceChainId: '56' })
      ]);
      livePrice = price.status === 'LIVE' ? price.data?.[0] ?? null : null;
      liveMarket = market.status === 'LIVE' && market.data ? market.data : null;
      if (livePrice) lastReferenceQuoteTimestamp = livePrice.tokenPriceUpdatedAt;
    }
  } catch {
    livePrice = null;
    liveMarket = null;
  }
  const quoteTimestamp = livePrice?.tokenPriceUpdatedAt ?? lastReferenceQuoteTimestamp;
  const quoteAgeSeconds = Math.max(0, Math.floor((now - quoteTimestamp) / 1000));
  const isFresh = Boolean(livePrice && quoteAgeSeconds <= maxStalenessSeconds);

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
      lastTimestamp: quoteTimestamp,
      ageSeconds: quoteAgeSeconds,
      maxAllowedAgeSeconds: maxStalenessSeconds,
      isFresh,
      tokenPrice: livePrice?.tokenPrice ?? null,
      referencePrice: livePrice?.referencePrice ?? null,
      spread: livePrice?.spread ?? null,
      marketStatus: liveMarket?.status ?? 'UNAVAILABLE'
    },
    policies: {
      maxSpreadBps: 200,
      openSlippageBps: parseInt(process.env.MAX_SLIPPAGE_BPS || '50', 10),
      closedSlippageBps: parseInt(process.env.MAX_SLIPPAGE_CLOSED_BPS || '25', 10),
      maxSingleTradeUsd: parseInt(process.env.MAX_SINGLE_REBALANCE_USD || '5000', 10),
      tinyExecutionCapUsd: 25
    },
    liveTelemetryStatus: livePrice && liveMarket ? 'CONNECTED' : 'UNAVAILABLE'
  });
});

/**
 * Deterministic Verification Inspector Endpoint
 * POST /api/verification/inspect
 * Computes canonical evidence payload and deterministic SHA-256 hash
 */
app.post(['/api/verification/inspect', '/verification/inspect'], async (req: Request, res: Response) => {
  const { strategy, walletAddress, transactionId } = req.body;
  if (!strategy || typeof walletAddress !== 'string' || !isValidEvmAddress(walletAddress)) {
    res.status(400).json({ error: 'A valid walletAddress and strategy are required. Evidence must be loaded from live sources.' });
    return;
  }
  const apiKey = process.env.BINANCE_WEB3_API_KEY;
  const apiSecret = process.env.BINANCE_WEB3_API_SECRET;
  if (!apiKey || !apiSecret) {
    res.status(503).json({ success: false, inspectStatus: 'UNAVAILABLE', error: 'Live Binance credentials are unavailable; verification is blocked.' });
    return;
  }

  try {
    const stockAddress = strategy.stockAddress || process.env.TOKENIZED_STOCK_ADDRESS || '0x02fca66c1d1afb4e2a7884261eb00f63598a7436';
    const stableAddress = strategy.stableAddress || process.env.STABLECOIN_ADDRESS || '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
    const signer = new BinanceRequestSigner({ apiKey, apiSecret });
    const walletClient = new BinanceWalletBalanceClient({ signer, bscRpcUrl: process.env.BSC_RPC_URL });
    const rwaClient = new BinanceRwaClient({ signer, baseUrl: process.env.BINANCE_WEB3_API_BASE_URL });
    const [walletResult, priceResult, marketResult] = await Promise.all([
      walletClient.getVerifiedWalletBalances({ walletAddress, tokens: [
        { tokenContractAddress: stockAddress, symbol: strategy.stockSymbol, decimals: 18, binanceChainId: '56' },
        { tokenContractAddress: stableAddress, symbol: strategy.stableSymbol, decimals: 18, binanceChainId: '56' }
      ] }),
      rwaClient.getRwaPriceAndSpread({ tokenContractAddresses: stockAddress, binanceChainId: '56' }),
      rwaClient.getUnderlyingMarketStatus({ tokenContractAddress: stockAddress, binanceChainId: '56' })
    ]);
    const stockLive = walletResult.balances.find((balance) => balance.tokenContractAddress.toLowerCase() === stockAddress.toLowerCase());
    const stableLive = walletResult.balances.find((balance) => balance.tokenContractAddress.toLowerCase() === stableAddress.toLowerCase());
    const priceLive = priceResult.status === 'LIVE' ? priceResult.data?.[0] : null;
    const marketLive = marketResult.status === 'LIVE' ? marketResult.data : null;
    if (!stockLive || !stableLive || !priceLive || !marketLive || walletResult.overallStatus !== 'VERIFIED' || stockLive.verificationStatus !== 'VERIFIED' || stableLive.verificationStatus !== 'VERIFIED') {
      res.status(503).json({ success: false, inspectStatus: 'UNAVAILABLE', error: 'Live balance, price, or market evidence is unavailable or failed independent verification.' });
      return;
    }
    const now = Date.now();
    const quoteTimestamp = priceLive.tokenPriceUpdatedAt;
    const quoteAgeSeconds = Math.max(0, Math.floor((now - quoteTimestamp) / 1000));
    const marketState = marketLive.status === 'OPEN' ? 'MARKET_OPEN' : marketLive.status === 'CLOSED' || marketLive.status === 'PAUSED' || marketLive.status === 'HALTED' ? 'MARKET_CLOSED' : 'REFERENCE_STALE';
    const stockBalance: PortfolioBalance = { symbol: strategy.stockSymbol, address: stockAddress, amountRaw: stockLive.verifiedRawBalance!, decimals: 18, amountFormatted: Number(stockLive.verifiedFormattedBalance), priceUsd: priceLive.tokenPrice, valueUsd: Number(stockLive.verifiedFormattedBalance) * priceLive.tokenPrice };
    const stableBalance: PortfolioBalance = { symbol: strategy.stableSymbol, address: stableAddress, amountRaw: stableLive.verifiedRawBalance!, decimals: 18, amountFormatted: Number(stableLive.verifiedFormattedBalance), priceUsd: 1, valueUsd: Number(stableLive.verifiedFormattedBalance) };
    const portfolioSnapshot = calculatePortfolioSnapshot(stockBalance, stableBalance, quoteTimestamp, now);
    const proposal = generateRebalanceProposal({ snapshot: portfolioSnapshot, strategy, marketState, maxSlippageOpenBps: parseInt(process.env.MAX_SLIPPAGE_BPS || '50', 10), maxSlippageClosedBps: parseInt(process.env.MAX_SLIPPAGE_CLOSED_BPS || '25', 10) });
    const verificationInput = {
      strategy,
      balances: { stock: { symbol: strategy.stockSymbol, contractAddress: stockAddress, rawAmount: stockLive.verifiedRawBalance!.toString(), formattedAmount: Number(stockLive.verifiedFormattedBalance), verificationStatus: stockLive.verificationStatus }, stable: { symbol: strategy.stableSymbol, contractAddress: stableAddress, rawAmount: stableLive.verifiedRawBalance!.toString(), formattedAmount: Number(stableLive.verifiedFormattedBalance), verificationStatus: stableLive.verificationStatus } },
      marketData: { stockTokenPrice: priceLive.tokenPrice, stockReferencePrice: priceLive.referencePrice, spread: priceLive.spread, spreadBps: Math.round((priceLive.tokenPrice - priceLive.referencePrice) / priceLive.referencePrice * 10000), quoteTimestamp, quoteAgeSeconds },
      marketStatus: { state: marketState, rawStatus: marketLive.rawMarketStatus, openState: marketLive.openState, updatedAt: marketLive.updatedAt }, snapshot: portfolioSnapshot, proposal,
      riskChecks: { maxSpreadBps: strategy.maxSpreadBps ?? 200, maxSingleTradeUsd: strategy.maxSingleTradeUsd, isSpreadExcessive: false, isCircuitBreakerTripped: proposal.tradeAmountUsd > strategy.maxSingleTradeUsd }, timestamp: now
    } as const;
    const canonicalPayload = buildCanonicalEvidencePayload(verificationInput);
    const evidenceHash = computeEvidenceHash(canonicalPayload);
    const validation = validateEvidencePayload(canonicalPayload);
    const verifier = new GenLayerVerificationAdapter();
    let verificationResult: VerificationResult = validation.valid
      ? await verifier.verifyProposal(verificationInput, { transactionId: typeof transactionId === 'string' ? transactionId : undefined })
      : { status: 'REJECT', decision: 'NOT_VERIFIED', inspectStatus: 'EVIDENCE_INVALID', evidenceHash, proposalId: canonicalPayload.proposalId, reason: validation.reason || 'Live evidence validation failed.', verifiedAt: now };
    if (verificationResult.evidenceHash !== evidenceHash) {
      verificationResult = { ...verificationResult, status: 'REJECT', decision: 'NOT_VERIFIED', inspectStatus: 'PAYLOAD_HASH_MISMATCH', reason: 'Server evidence hash does not match the GenLayer verdict hash.' };
    }
    res.json({
      success: verificationResult.decision === 'VERIFIED' && verificationResult.status === 'ALLOW',
      inspectStatus: verificationResult.inspectStatus,
      transactionId: verificationResult.transactionId,
      protocolStatus: verificationResult.protocolStatus,
      canonicalPayload,
      evidenceHash,
      validation,
      verificationResult,
      simulationEligible: verificationResult.decision === 'VERIFIED' && verificationResult.status === 'ALLOW',
      executionEligible: false
    });
  } catch {
    res.status(503).json({ success: false, inspectStatus: 'UNAVAILABLE', error: 'Live evidence acquisition failed; verification is blocked.' });
  }
});

/**
 * Real BSC Wallet Balances Endpoint
 * GET /api/wallet/balances?address=0x...
 * POST /api/wallet/balances { address: '0x...' }
 *
 * Enforces Zero-Mock Invariant:
 * Queries real BSC on-chain balances for NVDAB and USDC.
 * Cross-verified against Binance Web3 API when credentials are present.
 */
async function handleWalletBalances(rawAddress: unknown, res: Response) {
  if (typeof rawAddress !== 'string' || !isValidEvmAddress(rawAddress)) {
    res.status(400).json({
      success: false,
      error: 'Invalid or missing BSC wallet address. Please provide a valid 20-byte EVM address.'
    });
    return;
  }

  const walletAddress = rawAddress.trim().toLowerCase();
  const bscRpcUrl = process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/';
  const stockContract = process.env.TOKENIZED_STOCK_ADDRESS || '0x02fca66c1d1afb4e2a7884261eb00f63598a7436';
  const stableContract = process.env.STABLECOIN_ADDRESS || '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';

  const tokens = [
    {
      symbol: process.env.TOKENIZED_STOCK_SYMBOL || 'NVDAB',
      name: 'Tokenized NVIDIA (bStocks)',
      contractAddress: stockContract,
      decimals: 18,
      priceUsd: 0
    },
    {
      symbol: process.env.STABLECOIN_SYMBOL || 'USDC',
      name: 'Binance-Peg USD Coin',
      contractAddress: stableContract,
      decimals: 18,
      priceUsd: 1.0
    }
  ];

  try {
    // If Binance Web3 credentials are present, use the dual-verifying client
    if (process.env.BINANCE_WEB3_API_KEY && process.env.BINANCE_WEB3_API_SECRET) {
      try {
        const signer = new BinanceRequestSigner({
          apiKey: process.env.BINANCE_WEB3_API_KEY,
          apiSecret: process.env.BINANCE_WEB3_API_SECRET
        });
        const client = new BinanceWalletBalanceClient({
          signer,
          bscRpcUrl
        });
        const result = await client.getVerifiedWalletBalances({
          walletAddress,
          tokens: tokens.map(t => ({
            binanceChainId: '56',
            tokenContractAddress: t.contractAddress,
            symbol: t.symbol,
            decimals: t.decimals
          }))
        });

        const balances: ConnectedTokenBalance[] = tokens.map(t => {
          const match = result.balances.find(b => b.tokenContractAddress.toLowerCase() === t.contractAddress.toLowerCase());
          const raw = match?.verifiedRawBalance ?? match?.rpcRawBalance ?? 0n;
          const formatted = match?.verifiedFormattedBalance ?? match?.rpcFormattedBalance ?? '0';
          const numericFormatted = parseFloat(formatted) || 0;
          return {
            symbol: t.symbol,
            name: t.name,
            contractAddress: t.contractAddress,
            decimals: t.decimals,
            rawBalance: raw.toString(),
            formattedBalance: formatted,
            priceUsd: t.priceUsd,
            valueUsd: numericFormatted * t.priceUsd,
            verificationStatus: match?.verificationStatus === 'VERIFIED' ? 'VERIFIED' : match?.verificationStatus === 'MISMATCH' ? 'MISMATCH' : 'UNAVAILABLE'
          };
        });

        const totalValueUsd = balances.reduce((sum, b) => sum + b.valueUsd, 0);
        const isZeroPortfolio = balances.every(b => b.rawBalance === '0');

        const responseData: WalletPortfolioResponse = {
          success: true,
          walletAddress,
          chainId: 56,
          network: 'BSC Mainnet',
          balances,
          totalValueUsd,
          isZeroPortfolio,
          portfolioStatus: result.overallStatus === 'VERIFIED' ? 'VERIFIED' : result.overallStatus === 'MISMATCH' ? 'MISMATCH' : 'UNAVAILABLE',
          decisionState: isZeroPortfolio ? 'INSUFFICIENT_LIVE_PORTFOLIO' : 'PORTFOLIO_READY',
          executionGate: isZeroPortfolio ? 'EXECUTION_BLOCKED' : 'READY',
          explanation: isZeroPortfolio
            ? 'No eligible NVDAB or USDC balance is currently available for execution.'
            : 'Portfolio balances successfully verified on BSC Mainnet.',
          checkedAt: result.checkedAt
        };
        res.json(responseData);
        return;
      } catch {
        // Fall through to direct BSC JSON-RPC
      }
    }

    // Direct BSC JSON-RPC eth_call (balanceOf)
    const now = Date.now();
    const balancePromises = tokens.map(async (token) => {
      const calldata = encodeErc20BalanceOfCalldata(walletAddress);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        const rpcRes = await fetch(bscRpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Math.floor(Math.random() * 1000000),
            method: 'eth_call',
            params: [{ to: token.contractAddress, data: calldata }, 'latest']
          }),
          signal: controller.signal
        });
        clearTimeout(timer);
        if (!rpcRes.ok) throw new Error(`HTTP ${rpcRes.status}`);
        const json = await rpcRes.json();
        if (json.error || !json.result || json.result === '0x') {
          return {
            symbol: token.symbol,
            name: token.name,
            contractAddress: token.contractAddress,
            decimals: token.decimals,
            rawBalance: '0',
            formattedBalance: '0',
            priceUsd: token.priceUsd,
            valueUsd: 0,
            verificationStatus: 'UNAVAILABLE' as const
          };
        }
        const raw = BigInt(json.result);
        const formatted = formatUnits(raw, token.decimals);
        const numeric = parseFloat(formatted) || 0;
        return {
          symbol: token.symbol,
          name: token.name,
          contractAddress: token.contractAddress,
          decimals: token.decimals,
          rawBalance: raw.toString(),
          formattedBalance: formatted,
          priceUsd: token.priceUsd,
          valueUsd: numeric * token.priceUsd,
          verificationStatus: 'VERIFIED' as const
        };
      } catch {
        clearTimeout(timer);
        return {
          symbol: token.symbol,
          name: token.name,
          contractAddress: token.contractAddress,
          decimals: token.decimals,
          rawBalance: '0',
          formattedBalance: '0',
          priceUsd: token.priceUsd,
          valueUsd: 0,
          verificationStatus: 'UNAVAILABLE' as const
        };
      }
    });

    const balances = await Promise.all(balancePromises);
    const totalValueUsd = balances.reduce((sum, b) => sum + b.valueUsd, 0);
    const isZeroPortfolio = balances.every(b => b.rawBalance === '0');
    const allVerified = balances.every(b => b.verificationStatus === 'VERIFIED');

    const responseData: WalletPortfolioResponse = {
      success: true,
      walletAddress,
      chainId: 56,
      network: 'BSC Mainnet',
      balances,
      totalValueUsd,
      isZeroPortfolio,
      portfolioStatus: allVerified ? 'VERIFIED' : 'UNAVAILABLE',
      decisionState: isZeroPortfolio ? 'INSUFFICIENT_LIVE_PORTFOLIO' : 'PORTFOLIO_READY',
      executionGate: isZeroPortfolio ? 'EXECUTION_BLOCKED' : 'READY',
      explanation: isZeroPortfolio
        ? 'No eligible NVDAB or USDC balance is currently available for execution.'
        : 'Portfolio balances successfully verified on BSC Mainnet.',
      checkedAt: now
    };
    res.json(responseData);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message });
  }
}

app.get(['/api/wallet/balances', '/wallet/balances'], async (req: Request, res: Response) => {
  const address = req.query.address as string;
  await handleWalletBalances(address, res);
});

app.post(['/api/wallet/balances', '/wallet/balances'], async (req: Request, res: Response) => {
  const address = (req.body?.address || req.query.address) as string;
  await handleWalletBalances(address, res);
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
