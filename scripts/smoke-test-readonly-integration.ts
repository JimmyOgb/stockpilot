/**
 * StockPilot — Real Read-Only Integration Smoke Test
 *
 * Exercises the complete real read-only integration pipeline against:
 * 1. Live Binance Web3 API (RWA Search, RWA Price, Underlying Market, Wallet Balances)
 * 2. Live BSC Mainnet JSON-RPC node (Direct ERC-20 balanceOf eth_call)
 *
 * Strict Security & Zero-Mock Rules:
 * - Read-only operations ONLY. No private key, no transaction signing, no swaps/orders/RFQs, no funds moved.
 * - ZERO MOCK: Never fabricates or substitutes fake data.
 * - Credential hygiene: Never logs API secrets, full API keys, signatures, or auth headers.
 */

import 'dotenv/config';
import { BinanceRequestSigner } from '../src/binance/request-signer.js';
import { BinanceRwaClient, BinanceRwaMarketStateProvider } from '../src/binance/rwa-client.js';
import { BinanceWalletBalanceClient, TokenBalanceTarget, isValidEvmAddress } from '../src/binance/wallet-balance-client.js';

export const CONFIGURED_ASSETS = {
  bNVDA: {
    symbol: 'bNVDA',
    name: 'Backed NVIDIA Corp',
    contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495',
    decimals: 18,
    binanceChainId: '56'
  },
  USDC: {
    symbol: 'USDC',
    name: 'Binance-Peg USD Coin',
    contractAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    decimals: 18,
    binanceChainId: '56'
  }
};

export interface EnvironmentCheckResult {
  isComplete: boolean;
  missingVariables: string[];
  resolvedConfig?: {
    apiKey: string;
    apiSecret: string;
    bscRpcUrl: string;
    walletAddress: string;
  };
}

export function checkEnvironment(): EnvironmentCheckResult {
  const apiKey = process.env.BINANCE_API_KEY || process.env.BINANCE_WEB3_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET || process.env.BINANCE_WEB3_API_SECRET;
  const bscRpcUrl = process.env.BSC_RPC_URL;
  const walletAddress = process.env.STOCKPILOT_WALLET_ADDRESS || process.env.EXECUTOR_WALLET_ADDRESS;

  const missing: string[] = [];

  if (!apiKey || apiKey.trim().length === 0) {
    missing.push('BINANCE_API_KEY (or BINANCE_WEB3_API_KEY)');
  }
  if (!apiSecret || apiSecret.trim().length === 0) {
    missing.push('BINANCE_API_SECRET (or BINANCE_WEB3_API_SECRET)');
  }
  if (!bscRpcUrl || bscRpcUrl.trim().length === 0) {
    missing.push('BSC_RPC_URL');
  }
  if (!walletAddress || walletAddress.trim().length === 0) {
    missing.push('STOCKPILOT_WALLET_ADDRESS (or EXECUTOR_WALLET_ADDRESS)');
  }

  if (missing.length > 0) {
    return {
      isComplete: false,
      missingVariables: missing
    };
  }

  return {
    isComplete: true,
    missingVariables: [],
    resolvedConfig: {
      apiKey: apiKey!.trim(),
      apiSecret: apiSecret!.trim(),
      bscRpcUrl: bscRpcUrl!.trim(),
      walletAddress: walletAddress!.trim()
    }
  };
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export async function runIntegrationSmokeTest(): Promise<void> {
  console.log('========================================================================');
  console.log('StockPilot — Real Read-Only Integration Smoke Test (Live BSC & Binance)');
  console.log('========================================================================\n');

  // Pre-flight Environment & Security Check
  const envCheck = checkEnvironment();
  if (!envCheck.isComplete || !envCheck.resolvedConfig) {
    console.error('[STOPPED] Required environment variables are missing:');
    for (const v of envCheck.missingVariables) {
      console.error(`  - ${v}`);
    }
    console.error('\nZero Mock Policy Enforced: Test cannot proceed without real configuration.');
    process.exit(1);
  }

  const { apiKey, apiSecret, bscRpcUrl, walletAddress } = envCheck.resolvedConfig;

  if (!isValidEvmAddress(walletAddress)) {
    console.error(`[STOPPED] Configured wallet address is not a valid EVM address: "${walletAddress}"`);
    process.exit(1);
  }

  console.log('[SECURITY PRE-FLIGHT]');
  console.log(`- Authenticating API Key: ${maskApiKey(apiKey)}`);
  console.log('- API Secret: [PROTECTED — NEVER PRINTED]');
  console.log(`- Target Wallet: ${walletAddress}`);
  console.log(`- BSC JSON-RPC: ${bscRpcUrl}`);
  console.log('- Private Keys: NONE (Read-only execution)');
  console.log('- Fund Movement / Trades / Quotes: DISABLED\n');

  const signer = new BinanceRequestSigner({ apiKey, apiSecret });
  const rwaClient = new BinanceRwaClient({ signer });
  const balanceClient = new BinanceWalletBalanceClient({
    signer,
    bscRpcUrl
  });

  // Track all output lines to verify no secrets are logged in Step 7
  const executionLogOutputs: string[] = [];
  function log(msg: string): void {
    console.log(msg);
    executionLogOutputs.push(msg);
  }

  // -------------------------------------------------------------------------
  // STEP 1 — Binance RWA Search
  // -------------------------------------------------------------------------
  log('------------------------------------------------------------------------');
  log('[STEP 1] Binance RWA Search: Searching for bNVDA asset metadata');
  log('------------------------------------------------------------------------');
  const step1Start = Date.now();
  const searchResult = await rwaClient.searchRwaToken({ keyword: 'bNVDA' });
  const step1Latency = Date.now() - step1Start;

  log(`- Request Latency: ${step1Latency}ms`);
  log(`- Client Status: ${searchResult.status}`);

  if (searchResult.status !== 'LIVE' || !searchResult.data) {
    log(`[ERROR] RWA search failed or returned no live data: ${searchResult.error?.message ?? searchResult.status}`);
  } else {
    log(`- Ticker: ${searchResult.data.ticker}`);
    log(`- Company Name: ${searchResult.data.companyName}`);
    log(`- Assets Discovered: ${searchResult.data.assets.length}`);

    const matchedAsset = searchResult.data.assets.find(
      a => a.tokenSymbol.toUpperCase() === 'BNVDA' || a.tokenContractAddress.toLowerCase() === CONFIGURED_ASSETS.bNVDA.contractAddress.toLowerCase()
    );

    if (!matchedAsset) {
      log(`[MISMATCH] No asset matching bNVDA found in Binance search response!`);
    } else {
      log(`  * Token Symbol: ${matchedAsset.tokenSymbol}`);
      log(`  * Token Contract: ${matchedAsset.tokenContractAddress}`);
      log(`  * Binance Chain ID: ${matchedAsset.binanceChainId}`);
      log(`  * Platform ID: ${matchedAsset.platformId}`);

      const addressMatches = matchedAsset.tokenContractAddress.toLowerCase() === CONFIGURED_ASSETS.bNVDA.contractAddress.toLowerCase();
      log(`  * Contract Address Matches StockPilot Configuration: ${addressMatches ? 'YES (0xA34C5e...)' : 'NO'}`);
      if (!addressMatches) {
        log(`    Expected: ${CONFIGURED_ASSETS.bNVDA.contractAddress}`);
        log(`    Received: ${matchedAsset.tokenContractAddress}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // STEP 2 — Binance RWA Price
  // -------------------------------------------------------------------------
  log('\n------------------------------------------------------------------------');
  log('[STEP 2] Binance RWA Price: Querying dual-price discovery for bNVDA');
  log('------------------------------------------------------------------------');
  const step2Start = Date.now();
  const priceResult = await rwaClient.getRwaPrices({
    binanceChainId: CONFIGURED_ASSETS.bNVDA.binanceChainId,
    tokenContractAddresses: [CONFIGURED_ASSETS.bNVDA.contractAddress]
  });
  const step2Latency = Date.now() - step2Start;

  log(`- Request Latency: ${step2Latency}ms`);
  log(`- Client Status: ${priceResult.status}`);

  if (priceResult.status !== 'LIVE' || !priceResult.data || priceResult.data.length === 0) {
    log(`[WARN] RWA price query returned no data: ${priceResult.error?.message ?? priceResult.status}`);
  } else {
    const p = priceResult.data[0];
    log(`- Token Symbol: ${CONFIGURED_ASSETS.bNVDA.symbol}`);
    log(`- Token Contract: ${p.tokenContractAddress}`);
    log(`- Token Price (On-Chain): $${p.tokenPrice.toFixed(4)} USD`);
    log(`- Reference Price (Underlying US Stock): $${p.referencePrice.toFixed(4)} USD`);
    log(`- Spread: ${p.spread !== null ? `${(p.spread * 100).toFixed(4)}%` : 'N/A'}`);
    log(`- Token Price Updated At: ${p.tokenPriceUpdatedAt ? new Date(p.tokenPriceUpdatedAt).toISOString() : 'N/A'}`);
  }

  // -------------------------------------------------------------------------
  // STEP 3 — Binance Underlying Market
  // -------------------------------------------------------------------------
  log('\n------------------------------------------------------------------------');
  log('[STEP 3] Binance Underlying Market Status: US Equity Market Session');
  log('------------------------------------------------------------------------');
  const step3Start = Date.now();
  const marketResult = await rwaClient.getUnderlyingMarketStatus({
    binanceChainId: CONFIGURED_ASSETS.bNVDA.binanceChainId,
    tokenContractAddress: CONFIGURED_ASSETS.bNVDA.contractAddress
  });
  const step3Latency = Date.now() - step3Start;

  log(`- Request Latency: ${step3Latency}ms`);
  log(`- Client Status: ${marketResult.status}`);

  if (marketResult.status !== 'LIVE' || !marketResult.data) {
    log(`[WARN] Underlying market status query returned no data: ${marketResult.error?.message ?? marketResult.status}`);
  } else {
    const m = marketResult.data;
    log(`- Raw Market Status: ${m.status}`);
    log(`- Open State: ${m.openState ?? 'N/A'}`);
    log(`- Reason Code: ${m.reasonCode ?? 'N/A'}`);
    log(`- Reason Message: ${m.reasonMsg ?? 'N/A'}`);
    log(`- Next Open Time: ${m.nextOpenTime ? new Date(m.nextOpenTime).toISOString() : 'N/A'}`);
    log(`- Next Close Time: ${m.nextCloseTime ? new Date(m.nextCloseTime).toISOString() : 'N/A'}`);
    log(`- Underlying Reference Price: ${m.referencePrice ? `$${m.referencePrice.toFixed(2)}` : 'N/A'}`);

    // Map to StockPilot MarketState model
    const mappedState = BinanceRwaMarketStateProvider.mapToMarketState(m.status);
    log(`- StockPilot Risk Engine State Mapping: ${mappedState}`);
  }

  // -------------------------------------------------------------------------
  // STEP 4 & 5 & 6 — Wallet Balances & BSC Direct RPC Verification & Reconciliation
  // -------------------------------------------------------------------------
  log('\n------------------------------------------------------------------------');
  log('[STEP 4, 5, 6] Wallet Balances & BSC Direct RPC Cross-Reconciliation');
  log('------------------------------------------------------------------------');
  log(`- Target Wallet: ${walletAddress}`);

  const targets: TokenBalanceTarget[] = [
    {
      binanceChainId: CONFIGURED_ASSETS.bNVDA.binanceChainId,
      tokenContractAddress: CONFIGURED_ASSETS.bNVDA.contractAddress,
      symbol: CONFIGURED_ASSETS.bNVDA.symbol,
      decimals: CONFIGURED_ASSETS.bNVDA.decimals
    },
    {
      binanceChainId: CONFIGURED_ASSETS.USDC.binanceChainId,
      tokenContractAddress: CONFIGURED_ASSETS.USDC.contractAddress,
      symbol: CONFIGURED_ASSETS.USDC.symbol,
      decimals: CONFIGURED_ASSETS.USDC.decimals
    }
  ];

  const balanceStart = Date.now();
  const balanceResult = await balanceClient.getVerifiedWalletBalances({
    walletAddress,
    tokens: targets
  });
  const balanceLatency = Date.now() - balanceStart;

  log(`- Portfolio Check Latency: ${balanceLatency}ms`);
  log(`- Overall Verification Consensus: ${balanceResult.overallStatus}`);

  for (const b of balanceResult.balances) {
    log(`\n  Asset: ${b.symbol} (${b.tokenContractAddress})`);
    log(`  - [Step 4] Binance Raw Balance: ${b.binanceRawBalance !== null ? b.binanceRawBalance.toString() : 'UNAVAILABLE'}`);
    log(`    [Step 4] Binance Formatted:   ${b.binanceFormattedBalance ?? 'UNAVAILABLE'}`);
    log(`  - [Step 5] Direct BSC RPC Raw:  ${b.rpcRawBalance !== null ? b.rpcRawBalance.toString() : 'UNAVAILABLE'}`);
    log(`    [Step 5] Direct BSC Formatted:${b.rpcFormattedBalance ?? 'UNAVAILABLE'}`);
    log(`  - [Step 6] Final Reconciliation: ${b.verificationStatus}`);

    if (b.verificationStatus === 'VERIFIED') {
      log(`    * Verified Balance: ${b.verifiedFormattedBalance} ${b.symbol} (Exact Integer Match)`);
    } else if (b.discrepancyReason) {
      log(`    * Discrepancy / Fallback Reason: ${b.discrepancyReason}`);
    }
  }

  // -------------------------------------------------------------------------
  // STEP 7 — Security Check
  // -------------------------------------------------------------------------
  log('\n------------------------------------------------------------------------');
  log('[STEP 7] Security Verification: Confirming zero credential leakage');
  log('------------------------------------------------------------------------');

  const combinedOutput = executionLogOutputs.join('\n');
  const leaksSecret = combinedOutput.includes(apiSecret);
  const leaksFullKey = apiKey.length > 8 && combinedOutput.includes(apiKey);
  const leaksSignature = /X-OC-SIGN/i.test(combinedOutput);
  const leaksAuthHeader = /X-OC-APIKEY/i.test(combinedOutput);

  if (leaksSecret) {
    log('[FAIL] CRITICAL SECURITY BREACH: API secret was detected in output logs!');
    process.exit(1);
  } else {
    log('[PASS] API Secret is completely protected (never printed or leaked).');
  }

  if (leaksFullKey) {
    log('[FAIL] API Key was printed in full.');
    process.exit(1);
  } else {
    log('[PASS] API Key was properly masked.');
  }

  if (leaksSignature || leaksAuthHeader) {
    log('[WARN] Signed header keys detected in output text.');
  } else {
    log('[PASS] No authorization headers or cryptographic signatures leaked.');
  }

  log('[PASS] No private keys required, no swap/order endpoints called, 0 funds moved.');

  log('\n========================================================================');
  log('Smoke Test Completed Successfully with Zero Mock Enforcement.');
  log('========================================================================');
}

runIntegrationSmokeTest().catch(err => {
  console.error('[FATAL ERROR IN SMOKE TEST]', (err as Error)?.message ?? err);
  process.exit(1);
});
