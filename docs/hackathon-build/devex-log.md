# Developer Experience (DevEx) Log

> **BNB Hack: Tokenized Stocks Edition** (Sep 16 – Oct 11, 2026)  
> Project: **StockPilot**  
> *Tracked integration efforts, Binance Web3 API interactions, observations, and recommendations.*

---

## Log Template

Every real Binance integration attempt must record:
* **Date / Time (UTC)**
* **Endpoint / Module**
* **Purpose**
* **Request Type (REST / WebSocket / SDK / RPC)**
* **Result (Success / Failure / Inconclusive)**
* **Latency (ms, when measurable)**
* **Errors & Raw Responses**
* **Documentation Location**
* **Confusing Behavior / Gotchas**
* **Resolution**
* **Improvement Suggestion for Binance DevEx**

---

## Log Entries

### Entry #001: Initial Architecture & API Discovery
- **Date / Time**: 2026-09-25 07:15:00 UTC
- **Endpoint / Module**: Binance Web3 API / Agentic Wallet & Spot Market Data Modules
- **Purpose**: Map required capabilities for StockPilot portfolio polling (tokenized stock balances on BSC, spot quote reference, transaction simulation).
- **Request Type**: Architecture & documentation mapping
- **Result**: Complete
- **Latency**: N/A
- **Errors**: N/A
- **Documentation Location**: `https://web3.binance.com/build`
- **Confusing Behavior**: Multiple API surfaces exist across Binance Web3 services:
  1. Binance Web3 Wallet (MPC / Agentic Wallet APIs for signing/dispatch).
  2. Binance Web3 API / DEX aggregator endpoints (quote, swap routes on BSC).
  3. BNB Agent Studio endpoints for agentic tools.
- **Resolution**: Strict adapter pattern (`BinanceWeb3Client` interface) isolating market data fetching, quote fetching, and wallet submission.
- **Improvement Suggestion**: Provide a unified OpenAPI spec / TypeScript SDK specifically bundling tokenized stock metadata for BSC-native bStocks/Ondo/xStocks.

---

### Entry #002: Official Authentication & Security Header Audit
- **Date / Time**: 2026-09-25 07:30:00 UTC
- **Endpoint / Module**: Binance Web3 API Gateway (`https://web3.binance.com`)
- **Purpose**: Document exact cryptographic header and signing requirements for authenticated endpoints.
- **Request Type**: Documentation Verification
- **Result**: Verified against official specification
- **Latency**: N/A
- **Errors**: `40102 Signature error` (when signature mismatched), `40100 Unauthorized` (missing API key).
- **Documentation Location**: `https://web3.binance.com/en/dev-docs/`
- **Confusing Behavior**: Unlike standard Binance CEX API which uses `X-MBX-APIKEY` and query signature `&signature=...`, Binance Web3 API requires:
  - `X-OC-APIKEY`: Web3 API Key
  - `X-OC-TIMESTAMP`: Current UTC ISO 8601 string with milliseconds (e.g. `2026-05-11T10:08:57.715Z`)
  - `X-OC-SIGN`: Base64-encoded HMAC-SHA256 or Ed25519 signature covering the concatenated payload and timestamp
  - `recv_window`: ±5,000 ms strict window.
- **Resolution**: Implemented signing specification in `docs/hackathon-build/binance-integration-spec.md`. Client will construct exact `X-OC-*` headers.
- **Improvement Suggestion**: Provide official TypeScript request-signing middleware in npm `@binance/web3-sdk` to eliminate signature formatting mismatches.

---

### Entry #003: Trading & DEX Aggregator Workflow Discovery (SWAP vs RFQ)
- **Date / Time**: 2026-09-25 07:45:00 UTC
- **Endpoint / Module**: Trading API (`/api/v1/dex/aggregator/quote`, `/swap`, `/order/submit`, `/order/{orderId}`)
- **Purpose**: Determine exact execution flow for tokenized stocks on BSC.
- **Request Type**: Specification Audit
- **Result**: Critical architectural finding verified
- **Latency**: N/A
- **Errors**: `40401 QUOTE_EXPIRED` (quote lifespan > 30s), `40462 SWAP_QUOTE_MISMATCH`, `40369 BStock market closed`, `40367 Ondo market closed`.
- **Documentation Location**: `https://web3.binance.com/build` (Trading API / DEX Aggregator)
- **Confusing Behavior**: The quote response returns an `executionMode` field:
  - Standard tokens use `executionMode: "SWAP"` (returns calldata to be broadcast directly by user wallet).
  - **Tokenized Equities (bStocks, Ondo) use `executionMode: "RFQ"` (Request for Quote)**.
  - The RFQ flow does NOT broadcast a raw swap tx to BSC immediately. Instead, `/swap` returns `rfq.typedDataToSign` (EIP-712). The user/agent signs this typed data, submits it to `/api/v1/dex/aggregator/order/submit`, and polls `/api/v1/dex/aggregator/order/{orderId}` for on-chain settlement!
  - Quotes expire strictly in **30 seconds** (`40401 QUOTE_EXPIRED`).
  - Order retries must reuse the exact same UUID to prevent double-spending or duplicate orders.
- **Resolution**: Updated architecture to explicitly handle the `RFQ` workflow for tokenized equities alongside standard `SWAP`.
- **Improvement Suggestion**: Clearly highlight the RFQ vs SWAP bifurcation in the main trading quickstart guide.

---

### Entry #004: Tokenized Stock Identification on BSC Mainnet
- **Date / Time**: 2026-09-25 08:00:00 UTC
- **Endpoint / Module**: Market Data & Asset Verification (`/api/v1/dex/market/token/search`)
- **Purpose**: Verify availability and exact contracts for bNVDA, Ondo USDY, and USDC on BSC Mainnet.
- **Request Type**: Contract verification against BscScan and Backed Finance official registries
- **Result**: Verified
- **Contract Addresses**:
  - **bNVDA (Backed NVIDIA)**: `0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495` (18 decimals)
  - **USDY (Ondo US Dollar Yield)**: `0x608593d17A2decBbc4399e4185bE4922F97eD32E` (18 decimals)
  - **USDC (Counter-asset)**: `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` (18 decimals)
- **Confusing Behavior**: Many copycat / scam tokens exist on BSC using identical symbols ("bNVDA", "WBNVDA"). Only verified contract `0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495` is legitimate Backed Finance collateral.
- **Resolution**: Strict zero-mock asset pinning. All requests and displays enforce the verified contract address.
- **Improvement Suggestion**: Add verified issuer badges directly in the token search API response.

---

### Entry #005: Market Hours & Staleness Provider Architectural Decoupling
- **Date / Time**: 2026-09-25 08:15:00 UTC
- **Endpoint / Module**: Market State Detection
- **Purpose**: Determine if Binance Web3 API offers an authoritative market calendar status endpoint.
- **Request Type**: Endpoint search & documentation audit
- **Result**: Absence of standalone `GET /market-hours` endpoint confirmed; error codes `40369` (BStock) and `40367` (Ondo) are emitted when attempting trades outside active sessions.
- **Resolution**: Re-architected `MarketState` detection from hardcoded assumptions to a pluggable `IMarketStateProvider` adapter interface. The application now uses StockPilot safety-policy configuration defaults rather than claiming hardcoded hours are authoritative exchange truth.
- **Improvement Suggestion**: Expose a dedicated `GET /api/v1/dex/market/rwa/session-status?symbol=bNVDA` endpoint returning current session state (`PRE_MARKET`, `REGULAR`, `POST_MARKET`, `CLOSED`) and next session open timestamp.

---

### Entry #006: BinanceRequestSigner Implementation & Deterministic Verification
- **Date / Time**: 2026-09-25 08:31:00 UTC
- **Endpoint / Module**: Binance Web3 Authentication Layer (`src/binance/request-signer.ts`)
- **Purpose**: Implement the client-side cryptographic request signer for authenticated endpoints (`X-OC-APIKEY`, `X-OC-TIMESTAMP`, `X-OC-SIGN`, `X-OC-NONCE`).
- **Request Type**: Local cryptographic implementation & unit test verification (zero network calls).
- **Result**: Success (19/19 tests passing).
- **Latency**: Sub-millisecond local HMAC-SHA256 generation.
- **Errors**: Handled and tested invalid credentials, missing API key/secret, malformed timestamps, and serialization edge-cases.
- **Documentation Location**: `https://web3.binance.com/build` & `https://web3.binance.com/en/dev-docs/`
- **Official Test Vector Existence**:
  - **Audit Finding**: The official Binance Web3 API documentation documents the canonical string format (`payload + timestamp`), ISO 8601 millisecond timestamp specification, and Base64-encoded HMAC-SHA256 requirement. However, the portal **does not provide a static public test vector** (i.e. specific public key, secret, and expected hash output).
  - **Resolution**: Implemented deterministic test vectors in `tests/binance-request-signer.test.ts` verifying exact mathematical equivalence against Node.js `crypto.createHmac('sha256', secret).update(canonicalPayload).digest('base64')`, ensuring 100% deterministic reproducibility.
- **Security Audit**: Verified that API secret is never stored in headers, never logged, and never included in error messages.
- **Remaining Live Verification**:
  - Live handshake with Binance Web3 gateway once official API keys are provisioned to verify that gateway clock drift is within the ±5,000 ms `recv_window`.

---

### Entry #007: BinanceMarketDataClient Implementation & Smoke Test
- **Date / Time**: 2026-09-25 08:38:00 UTC
- **Endpoint / Module**: Binance Web3 Market Data Module (`src/binance/market-data-client.ts`)
  1. `GET /api/v1/dex/market/token/search`
  2. `POST /api/v1/dex/market/price`
- **Purpose**: Implement read-only market data client for token search and real-time spot price queries with strict zero-mock runtime validation.
- **Request Type**: REST (GET with signed query params, POST with signed JSON body)
- **Result**: Success in deterministic testing (13/13 unit tests passing; 46/46 project-wide tests passing).
- **Latency**: N/A during unit testing (simulated HTTP transport injected).
- **Errors Handled**:
  - HTTP 401/403: Mapped explicitly to typed `AUTH_FAILED`.
  - HTTP 429: Mapped to typed `RATE_LIMITED`, capturing `Retry-After` header.
  - Timeout / Abort: Mapped to typed `NETWORK_ERROR`.
  - Binance API `code !== 0`: Mapped to typed `UNAVAILABLE` with exact server error code and message.
  - Malformed JSON / missing fields / invalid non-positive prices: Mapped to `INVALID_RESPONSE` (fail-closed).
- **Documentation Ambiguity Discovered**:
  - The Binance documentation specifies that the price endpoint `/api/v1/dex/market/price` returns `price` as a string (e.g. `"124.50"`). The client enforces defensive runtime parsing (`parseFloat`) and verifies finite positivity (`> 0`) rather than relying on TypeScript casting.
  - The search endpoint documentation permits searching by either symbol or contract address under the single `keyword` parameter.
- **Live Smoke Test Execution**:
  - Script created: `scripts/smoke-test-market-data.ts` (runnable via `npm run test:smoke`).
  - Execution outcome: Executed locally. In strict adherence to the Zero Mock Policy, the smoke test detected that live credentials (`BINANCE_WEB3_API_KEY` and `BINANCE_WEB3_API_SECRET`) were not yet provisioned in `.env`, printed a clear informational pause message, and exited cleanly without producing or fabricating fake market data.


