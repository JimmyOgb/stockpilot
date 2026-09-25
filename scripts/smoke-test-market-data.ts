/**
 * StockPilot — Live Binance Web3 Market Data Smoke Test
 *
 * Manual verification script for testing real read-only connectivity against:
 * 1. GET /api/v1/dex/market/token/search
 * 2. POST /api/v1/dex/market/price
 *
 * Zero-mock rule: Requires authentic BINANCE_WEB3_API_KEY and BINANCE_WEB3_API_SECRET.
 * If credentials are not present, stops with a clear message without using mock data.
 * NEVER prints API secrets or credentials.
 */

import 'dotenv/config';
import { BinanceRequestSigner } from '../src/binance/request-signer.js';
import { BinanceMarketDataClient } from '../src/binance/market-data-client.js';

async function runMarketDataSmokeTest(): Promise<void> {
  console.log('===============================================================');
  console.log('StockPilot — Binance Web3 Market Data Smoke Test (Read-Only)');
  console.log('===============================================================');

  const apiKey = process.env.BINANCE_WEB3_API_KEY;
  const apiSecret = process.env.BINANCE_WEB3_API_SECRET;

  if (!apiKey || !apiSecret || apiKey.trim().length === 0 || apiSecret.trim().length === 0) {
    console.log('[SMOKE TEST PAUSED] No Binance Web3 API credentials found in environment.');
    console.log('Please set BINANCE_WEB3_API_KEY and BINANCE_WEB3_API_SECRET in your .env file.');
    console.log('Zero Mock Rule Enforced: No fallback or fake market data will be produced.');
    process.exit(0);
  }

  // Safe credential summary (never logs secret)
  const maskedKey = `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
  console.log(`[INFO] Authenticating using API Key: ${maskedKey}`);
  console.log('[INFO] Target Network: BNB Smart Chain (BSC Mainnet / Chain ID: 56)');
  console.log('[INFO] Target Token: bNVDA (0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495)');
  console.log('---------------------------------------------------------------');

  const signer = new BinanceRequestSigner({
    apiKey: apiKey.trim(),
    apiSecret: apiSecret.trim()
  });

  const client = new BinanceMarketDataClient({
    signer,
    baseUrl: process.env.BINANCE_WEB3_API_BASE_URL || 'https://web3.binance.com'
  });

  // Step 1: Token Search
  console.log('\n[STEP 1] Executing token search for bNVDA...');
  const searchStartTime = Date.now();
  const searchResult = await client.searchToken({
    keyword: 'bNVDA',
    chainId: 56
  });
  const searchLatency = Date.now() - searchStartTime;

  console.log(`[RESULT] Token Search Status: ${searchResult.status} (${searchLatency}ms)`);
  if (searchResult.status === 'LIVE' && searchResult.data) {
    console.log(`[SUCCESS] Found ${searchResult.data.length} matching token(s):`);
    for (const t of searchResult.data) {
      console.log(`  - Symbol: ${t.symbol} | Name: ${t.name} | Decimals: ${t.decimals}`);
      console.log(`    Address: ${t.contractAddress} | Chain ID: ${t.chainId}`);
    }
  } else {
    console.log(`[INFO] Search outcome: ${searchResult.status}`);
    if (searchResult.error) {
      console.log(`  Error: [${searchResult.error.code ?? 'N/A'}] ${searchResult.error.message}`);
    }
  }

  // Step 2: Spot Price Query
  console.log('\n[STEP 2] Querying live spot price for bNVDA...');
  const priceStartTime = Date.now();
  const priceResult = await client.getPrices([
    {
      chainId: 56,
      contractAddress: '0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495'
    }
  ]);
  const priceLatency = Date.now() - priceStartTime;

  console.log(`[RESULT] Price Query Status: ${priceResult.status} (${priceLatency}ms)`);
  if (priceResult.status === 'LIVE' && priceResult.data) {
    for (const p of priceResult.data) {
      console.log(`  - Token: ${p.contractAddress}`);
      console.log(`    Live Price: $${p.priceUsd.toFixed(2)} USD`);
      console.log(`    Updated At: ${new Date(p.updatedAt).toISOString()}`);
    }
  } else {
    console.log(`[INFO] Price outcome: ${priceResult.status}`);
    if (priceResult.error) {
      console.log(`  Error: [${priceResult.error.code ?? 'N/A'}] ${priceResult.error.message}`);
    }
  }

  console.log('\n===============================================================');
  console.log('Smoke test complete. Zero Mock Policy strictly maintained.');
  console.log('===============================================================');
}

runMarketDataSmokeTest().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[SMOKE TEST ERROR] ${msg}`);
  process.exit(1);
});
