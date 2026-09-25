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
* **Official Endpoint**: `GET /api/v1/dex/market/rwa/search`
* **Gateway Path**: `/build/api/v1/dex/market/rwa/search`
* **Authentication**: Signed (`X-OC-APIKEY`, `X-OC-TIMESTAMP`, `X-OC-SIGN`)
* **Official Query Parameters**:
  - `keyword` (string, required): Asset ticker or search term (e.g. `bNVDA`).
  - `platformId` (number, optional): Platform filter (e.g. `3` for bStocks).
  - *Note*: `chainId` is NOT sent to this endpoint per official schema.
* **Documented Response Schema**:
  ```json
  {
    "code": 0,
    "msg": "success",
    "data": [
      {
        "ticker": "NVDA",
        "companyName": "NVIDIA Corp",
        "assets": [
          {
            "platformId": 3,
            "binanceChainId": "56",
            "tokenContractAddress": "0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495",
            "tokenSymbol": "bNVDA",
            "assetType": "stock"
          }
        ]
      }
    ],
    "success": true
  }
  ```
* **Status**: Implemented in [`src/binance/rwa-client.ts`](file:///C:/Users/NO%20GO%20NO/StockPilot/src/binance/rwa-client.ts) (`searchRwaToken`). Fails closed to `UNAVAILABLE` when token is not found.

#### 2.1.2 Dual-Price Discovery & Spread Intelligence
* **Official Endpoint**: `GET /api/v1/dex/market/rwa/price`
* **Gateway Path**: `/build/api/v1/dex/market/rwa/price`
* **Authentication**: Signed (`X-OC-APIKEY`, `X-OC-TIMESTAMP`, `X-OC-SIGN`)
* **Official Query Parameters**:
  - `binanceChainId` (string, required): e.g. `"56"`
  - `tokenContractAddresses` (string, required): Comma-separated token contract addresses (e.g. `"0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495"`).
* **Documented Response Schema**:
  ```json
  {
    "code": 0,
    "msg": "success",
    "data": [
      {
        "binanceChainId": "56",
        "tokenContractAddress": "0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495",
        "platformId": 3,
        "tokenPrice": "124.50",
        "referencePrice": "123.80",
        "tokenPriceUpdatedAt": 1727250000000
      }
    ],
    "success": true
  }
  ```
* **Deterministic Spread Calculation**:
  $$\text{spread} = \frac{\text{tokenPrice} - \text{referencePrice}}{\text{referencePrice}}$$
* **Zero-Mock Rules**:
  - Evaluated **only** when both `tokenPrice` and `referencePrice` parse to positive finite numbers (`> 0`).
  - If either price is absent, non-positive, or invalid, `spread` returns `null` and the UI renders `—`.
* **Status**: Implemented in [`src/binance/rwa-client.ts`](file:///C:/Users/NO%20GO%20NO/StockPilot/src/binance/rwa-client.ts) (`getRwaPriceAndSpread`).

#### 2.1.3 Authoritative Market Status & Underlying Market
* **Official Developer REST Endpoint**: `GET /api/v1/dex/market/rwa/underlying-market`
* **Gateway Path**: `/build/api/v1/dex/market/rwa/underlying-market`
* **Authentication**: Signed (`X-OC-APIKEY`, `X-OC-TIMESTAMP`, `X-OC-SIGN`)
* **Official Query Parameters**:
  - `binanceChainId` (string, required): e.g. `"56"`
  - `tokenContractAddress` (string, required): Token contract address (e.g. `"0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495"`).
* **Documented Response Schema**:
  ```json
  {
    "code": 0,
    "msg": "success",
    "data": {
      "statusInfo": {
        "openState": true,
        "marketStatus": "regular",
        "reasonCode": "TRADING",
        "reasonMsg": "Market is trading normally",
        "nextOpenTime": 1727272860000,
        "nextCloseTime": 1727292540000
      },
      "marketData": {
        "referencePrice": "123.80"
      }
    },
    "success": true
  }
  ```
* **Deterministic Internal Status Mapping**:
  - `OPEN`: Active session (`'open'`, `'regular'`, `'premarket'`, `'postmarket'`, `'overnight'`, or `openState=true` with `TRADING`).
  - `CLOSED`: Outside trading session (`'closed'`, `openState=false`, `MARKET_CLOSED`).
  - `PAUSED`: Temporary pause or corporate action halt (`'pause'`, `'ASSET_PAUSED'`, `'MARKET_PAUSED'`).
  - `HALTED`: Volatility circuit breaker or exchange halt (`'halt'`, `'HALTED'`).
  - `UNAVAILABLE`: Unpopulated or missing `statusInfo`.
  - `UNKNOWN`: Unrecognized or custom status string.
* **Provider Integration**: `BinanceRwaMarketStateProvider` implements `IMarketStateProvider`, resolving `MARKET_OPEN`, `MARKET_CLOSED`, or `REFERENCE_STALE` when telemetry freshness exceeds `maxStalenessSeconds`.
* **Important Note**: The endpoint is officially named `/underlying-market` (not `/underlying-market-data`). The endpoints `/market/status/ai` and `/asset/market/status/ai` on `www.binance.com/bapi` are internal to the AI skill wrapper; the core authenticated backend client queries the verified developer REST endpoint `/api/v1/dex/market/rwa/underlying-market`.

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

### Priority 3: Wallet API & Direct BSC RPC (Dual-Source Verified Balances)

* **Official Endpoint**: `POST /api/v1/dex/balance/token-balances-by-address`
* **Gateway Path**: `/build/api/v1/dex/balance/token-balances-by-address`
* **Authentication**: Signed (`X-OC-APIKEY`, `X-OC-TIMESTAMP`, `X-OC-SIGN`, `Content-Type: application/json`)
* **Request Schema**:
  ```json
  {
    "address": "0x1234567890123456789012345678901234567890",
    "tokenContractAddresses": [
      { "binanceChainId": "56", "tokenContractAddress": "0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495" },
      { "binanceChainId": "56", "tokenContractAddress": "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" }
    ],
    "excludeRiskToken": "0"
  }
  ```
* **Response Schema**:
  ```json
  {
    "code": 0,
    "msg": "success",
    "data": [
      {
        "binanceChainId": "56",
        "tokenAssets": [
          {
            "binanceChainId": "56",
            "tokenContractAddress": "0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495",
            "rawBalance": "25500000000000000000",
            "balance": "25.5",
            "decimals": 18
          },
          {
            "binanceChainId": "56",
            "tokenContractAddress": "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
            "rawBalance": "1000000000000000000000",
            "balance": "1000",
            "decimals": 18
          }
        ]
      }
    ],
    "success": true
  }
  ```
* **Independent Verification**: Direct BSC JSON-RPC `eth_call` invoking standard ERC-20 `balanceOf(address)`:
  * Selector: `0x70a08231` (keccak256("balanceOf(address)")[0..4])
  * Parameter: Left-padded 32-byte address (24 hex zeros + 40 hex chars = 64 hex characters)
  * Calldata format: `0x70a08231000000000000000000000000{address_without_0x}` (36 bytes / 74 characters)
* **Reconciliation Rules & Zero-Mock Verification**:
  * Precision: Exact integer comparison via `BigInt` uint256 (`binanceRawBalance === rpcRawBalance`). No floating-point rounding errors.
  * Status is marked `VERIFIED` and `verifiedRawBalance` is populated **if and only if** both sources return identical raw balances.
  * If Binance and RPC return differing amounts: `MISMATCH` with detailed `discrepancyReason`. `verifiedRawBalance` is kept `null`.
  * If Binance API fails/unreachable: `BINANCE_UNAVAILABLE` (fallback to RPC balance available for audit, but not verified).
  * If BSC RPC fails/reverts: `RPC_UNAVAILABLE` (Binance balance reported, but unverified).
  * If both fail: `BOTH_UNAVAILABLE`.
  * If invalid wallet address provided: `INVALID_WALLET` (fails closed immediately without network egress).
* **Status**: Implemented in [`src/binance/wallet-balance-client.ts`](file:///C:/Users/NO%20GO%20NO/StockPilot/src/binance/wallet-balance-client.ts) and verified via 20 unit tests in [`tests/binance-wallet-balance-client.test.ts`](file:///C:/Users/NO%20GO%20NO/StockPilot/tests/binance-wallet-balance-client.test.ts).

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
