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
* **Endpoint**: `GET /api/v1/dex/market/rwa/search` or `GET /api/v1/dex/market/token/search`
* **Parameters**: `keyword=bNVDA&chainId=56`
* **Returns**: Contract address, issuer details, token decimals (`18`), backing certificate information.

#### 2.1.2 Dual-Price Discovery & Spread Intelligence
* **Endpoint**: `GET /api/v1/dex/market/rwa/price` & `GET /api/v1/dex/market/rwa/underlying-market-data`
* **Fields Returned**:
  * `onchainPrice`: Real-time spot price on BSC.
  * `referencePrice`: Real-time underlying traditional equity reference price.
  * `sharesMultiplier`: Number of token units per underlying share (e.g. `1.0`).
* **Spread Formula**:
  $$\text{spread} = \frac{\text{onchainPrice} - \text{referencePrice}}{\text{referencePrice}}$$
* **Zero-Mock Rendering**: Displayed and evaluated **only** when both prices are valid live numbers; otherwise displays `—`.

#### 2.1.3 Authoritative Market Status & Session Schedule
Authoritative market status is fetched directly from Binance DeFI / RWA status endpoints (as documented in `binance-tokenized-securities-info`):
* **Endpoint**:
  `GET https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/asset/market/status/ai?chainId=56&contractAddress=0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495`
* **Overall Market Status**:
  `GET https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/market/status/ai`
* **Status Classification**:
  * `marketStatus`:
    - `regular`: Active US market trading hours.
    - `premarket` / `postmarket` / `overnight`: Extended trading sessions.
    - `closed`: Session closed.
    - `pause` / `halt`: Trading halted due to corporate action or circuit breaker.
  * `reasonCode`:
    - `TRADING`: Normal operations.
    - `MARKET_CLOSED`: Outside trading session.
    - `ASSET_PAUSED`: Halted by issuer/exchange.
* **Strict Rule**: Never infer market status from static calendars when authoritative status is available.

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
