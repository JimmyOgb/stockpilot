# Binance Web3 API Integration Specification

> **Document Status**: Official Documentation & Skills Hub Alignment  
> **Target Network**: BNB Smart Chain (BSC Mainnet — Chain ID: 56)  
> **Hackathon**: BNB Hack: Tokenized Stocks Edition (Sep 16 – Oct 11, 2026)  
> **Core Asset**: `bNVDA` (Backed NVIDIA — `0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495`) & `USDC` (`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`)  
> **Zero Mock Compliance**: Verified against official documentation and installed Binance skills (`binance-tokenized-securities-info`, `binance-agentic-wallet`).  

---

## 1. Global Authentication & Security Requirements

All requests to private/signed endpoints on the Binance Web3 API require cryptographic request signing:

* **Official Portal**: `https://web3.binance.com/en/dev-docs/introduction` & `https://web3.binance.com/en/dev-docs/authentication`
* **Base URL**: `https://web3.binance.com/build` (All API requests are served from `/build/api/v1/...`)
* **Headers**:
  * `X-OC-APIKEY`: Web3 API Key issued via Binance Web3 developer portal.
  * `X-OC-TIMESTAMP`: Current UTC timestamp in ISO 8601 format with milliseconds (e.g. `2026-05-11T10:08:57.715Z`).
  * `X-OC-SIGN`: Base64-encoded cryptographic signature (HMAC-SHA256) computed over the exact `preHash` string.
  * `X-OC-RECV-WINDOW`: Optional allowed time deviation in ms (default `5000`, max `60000`).
  * `Content-Type`: `application/json`
* **Common Authentication Errors**:
  * `40102 Signature error`: Signature mismatch. **#1 Cause in documentation**: omitting `/build` prefix from the signed `requestPath`.
  * `40100 Unauthorized`: Missing or invalid API key.
  * `42900 Request rate limit exceeded`: Rate limit exceeded.

### 1.1 Official Pre-Hash Signature Specification

$$\text{preHash} = \text{timestamp} + \text{method} + \text{requestPath} + \text{body}$$

| Component | Rule | Example |
|---|---|---|
| `timestamp` | Exact ISO 8601 UTC string from `X-OC-TIMESTAMP` header | `2026-05-11T10:08:57.715Z` |
| `method` | HTTP method in **UPPERCASE** | `GET` or `POST` |
| `requestPath` | Full path **including `/build` base prefix** + raw query string | `/build/api/v1/dex/market/token/search?chainId=56&keyword=bNVDA` |
| `body` | Raw JSON body string for POST/PUT; **empty string `""` for GET/HEAD** | `[{"chainId":"56","contractAddress":"..."}]` |

Implemented in [`src/binance/request-signer.ts`](file:///C:/Users/NO%20GO%20NO/StockPilot/src/binance/request-signer.ts) and verified via 19 unit tests in [`tests/binance-request-signer.test.ts`](file:///C:/Users/NO%20GO%20NO/StockPilot/tests/binance-request-signer.test.ts).

---

## 2. Priority API Specifications

### Priority 1: RWA Data API (Authoritative Tokenized-Equity Source)

The RWA Data API is the primary authority for tokenized equity information on BSC.

#### 2.1.1 RWA Token Search & Discovery
* **Endpoint**: `GET /api/v1/dex/market/rwa/search`
* **Gateway Path**: `/build/api/v1/dex/market/rwa/search`
* **Authentication**: Signed (`X-OC-APIKEY`, `X-OC-TIMESTAMP`, `X-OC-SIGN`)
* **Parameters**: `keyword=bNVDA&chainId=56`
* **Response Fields**:
  - `data[].chainId`: string (`"56"`)
  - `data[].contractAddress`: string (e.g. `0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495`)
  - `data[].symbol`: string (`"bNVDA"`)
  - `data[].name`: string (`"Backed NVIDIA"`)
  - `data[].decimals`: number (`18`)
  - `data[].underlyingTicker`: string (`"NVDA"`)
  - `data[].platformId`: number (`3` = bStock)
* **Status**: Implemented in [`src/binance/rwa-client.ts`](file:///C:/Users/NO%20GO%20NO/StockPilot/src/binance/rwa-client.ts) (`searchRwaToken`). Fails closed to `UNAVAILABLE` when token is not found.

#### 2.1.2 Dual-Price Discovery & Spread Intelligence
* **Endpoint**: `GET /api/v1/dex/market/rwa/price`
* **Gateway Path**: `/build/api/v1/dex/market/rwa/price`
* **Authentication**: Signed (`X-OC-APIKEY`, `X-OC-TIMESTAMP`, `X-OC-SIGN`)
* **Parameters**: `contractAddress=0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495&chainId=56`
* **Response Fields**:
  - `data[].onChainPrice`: Real-time spot price on BSC.
  - `data[].referencePrice`: Real-time underlying traditional equity reference price.
  - `data[].updatedAt`: Timestamp of the price observation.
* **Deterministic Spread Calculation**:
  $$\text{spread} = \frac{\text{onChainPrice} - \text{referencePrice}}{\text{referencePrice}}$$
* **Zero-Mock Rules**:
  - Evaluated **only** when both `onChainPrice` and `referencePrice` parse to positive finite numbers (`> 0`).
  - If either price is absent, non-positive, or invalid, `spread` returns `null` and the UI renders `—`.
* **Status**: Implemented in [`src/binance/rwa-client.ts`](file:///C:/Users/NO%20GO%20NO/StockPilot/src/binance/rwa-client.ts) (`getRwaPriceAndSpread`).

#### 2.1.3 Authoritative Market Status & Underlying Market Data
* **Authoritative Developer REST Endpoint**: `GET /api/v1/dex/market/rwa/underlying-market-data`
* **Gateway Path**: `/build/api/v1/dex/market/rwa/underlying-market-data`
* **Authentication**: Signed (`X-OC-APIKEY`, `X-OC-TIMESTAMP`, `X-OC-SIGN`)
* **Parameters**: `contractAddress=0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495&chainId=56`
* **Response Fields**:
  - `data.marketStatus`: string (e.g. `'regular'`, `'open'`, `'closed'`, `'pause'`, `'halted'`)
  - `data.openState`: boolean (`true` / `false`)
  - `data.reasonCode`: string (e.g. `'TRADING'`, `'MARKET_CLOSED'`, `'ASSET_PAUSED'`, `'HALTED'`)
  - `data.reasonMsg`: string (e.g. `'Paused for session transition'`)
  - `data.nextOpenTime`: number (ms epoch)
  - `data.nextCloseTime`: number (ms epoch)
* **Deterministic Internal Status Mapping**:
  - `OPEN`: Active session (`'open'`, `'regular'`, `'premarket'`, `'postmarket'`, `'overnight'`, or `openState=true` with `TRADING`).
  - `CLOSED`: Outside trading session (`'closed'`, `openState=false`, `MARKET_CLOSED`).
  - `PAUSED`: Temporary pause or corporate action halt (`'pause'`, `'ASSET_PAUSED'`, `'MARKET_PAUSED'`).
  - `HALTED`: Volatility circuit breaker or exchange halt (`'halt'`, `'HALTED'`).
  - `UNAVAILABLE`: Unpopulated or empty status envelope.
  - `UNKNOWN`: Unrecognized or custom status string.
* **Provider Integration**: `BinanceRwaMarketStateProvider` implements `IMarketStateProvider`, resolving `MARKET_OPEN`, `MARKET_CLOSED`, or `REFERENCE_STALE` when telemetry freshness exceeds `maxStalenessSeconds`.
* **Note on Public BAPI Endpoints**: The endpoints `/market/status/ai` and `/asset/market/status/ai` on `www.binance.com/bapi` are internal to the AI skill wrapper; the core authenticated backend client queries the verified developer REST endpoint `/api/v1/dex/market/rwa/underlying-market-data`.

---

### Priority 2: Market API (Crypto & Supporting Feeds)

* **Endpoint**: `POST /api/v1/dex/market/price`
* **Purpose**: Batch spot prices for counter-assets (`USDC`) and gas token (`BNB`).
* **Request Schema**:
  ```json
  [
    { "chainId": "56", "contractAddress": "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" },
    { "chainId": "56", "contractAddress": "0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495" }
  ]
  ```
* **Status**: Implemented in [`src/binance/market-data-client.ts`](file:///C:/Users/NO%20GO%20NO/StockPilot/src/binance/market-data-client.ts) (`getPrices`).

---

### Priority 3: Wallet API & Direct BSC RPC (Real Balances)

* **Primary Endpoint**: `POST /api/v1/dex/balance/token-balances-by-address`
* **Request Schema**:
  ```json
  {
    "address": "0xUserWalletAddress...",
    "chainId": "56",
    "excludeRiskToken": "0"
  }
  ```
* **Redundant Fallback**: Direct BSC RPC `eth_call` invoking standard ERC-20 `balanceOf(address)` for `bNVDA` and `USDC`.
* **Zero-Mock Requirement**: No fabricated balances. Displays `"No wallet connected"` or `"—"` if unconfigured.

---

### Priority 4: Trading API (Spot Quotes & RFQ Execution)

* **Quote Endpoint**: `GET /api/v1/dex/aggregator/quote`
* **Parameters**:
  * `chainId`: `56`
  * `fromTokenAddress`: Input token (e.g. USDC `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`)
  * `toTokenAddress`: Output token (e.g. bNVDA `0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495`)
  * `amount`: Raw integer amount in base units
  * `userWalletAddress`: Signer address
  * `slippageTolerance`: e.g. `50` (0.50%)
* **Execution Modes**:
  * `RFQ`: Used for tokenized equities (`bNVDA`). Generates `typedDataToSign` (EIP-712).
  * `SWAP`: Standard AMM swap for general tokens.
* **RFQ Order Submission**: `POST /api/v1/dex/aggregator/order/submit` with idempotency UUID.
* **Order Tracking**: `GET /api/v1/dex/aggregator/order/{orderId}`.

---

### Priority 5: Transaction Simulation API (Preflight Gate)

* **Endpoint**: `POST /api/v1/transaction/simulate` (or `baw preflight`)
* **Role**: Evaluates the transaction before requesting wallet signature.
* **Enforced Flow**:
  $$\text{PROPOSE} \longrightarrow \text{VERIFY} \longrightarrow \text{SIMULATE} \longrightarrow \text{EXECUTE}$$
* **Fail-Closed Condition**: If simulation detects a contract revert, insufficient token balance, or out-of-gas condition, execution halts immediately.

---

### Priority 6: Agentic Wallet & Skills Hub (`baw` CLI & Skills)

The official skills installed under `.agents/skills/` are:
1. `binance-tokenized-securities-info`: RWA token discovery, attestation queries, corporate actions, live session status.
2. `binance-agentic-wallet`: Policy boundary enforcement (daily spending limits, whitelist of approved contracts), EIP-712 typed-data signing for RFQ orders, preflight gas checks.

**Division of Responsibility**:
- **Direct REST API**: Core backend polling (balances, prices, drift math, evidence compilation).
- **Agentic Wallet Skills**: User policy guardrails, explicit signing authorization, and market status verification.

---

### Priority 7: BNB Agent Studio (Autonomous Agent Layer)

StockPilot integrates with BNB Agent Studio to operate as an autonomous rebalancing service:
- Registers periodic rebalance evaluation triggers.
- Publishes auditable rebalance event logs.
- Enables autonomous execution within user-defined Agentic Wallet spending limits.

---

### Priority 8: GenLayer Independent Verification Gate

- Evaluates signed evidence packets (drift calculations, quote freshness, RWA market status, spread premium).
- Consensus result (`ALLOW` or `REJECT`) must be cryptographically affirmed before simulation or execution proceeds.
- **GenLayer never executes trades**.

---

## 3. Supported Asset Directory on BSC Mainnet

| Asset | Contract Address | Decimals | Issuer / Model | Notes |
|---|---|---|---|---|
| **bNVDA** | `0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495` | 18 | Backed Finance | 1:1 backed collateralized tracker. Primary MVP asset. |
| **USDC** | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | 18 | Binance-Peg USDC | High liquidity settlement asset. |
| **USDY** | `0x608593d17A2decBbc4399e4185bE4922F97eD32E` | 18 | Ondo Finance | Secondary tokenized yield instrument. |
