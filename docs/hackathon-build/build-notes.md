# StockPilot — Technical Build Notes

> **BNB Hack: Tokenized Stocks Edition**  
> Technical decisions, documentation audit results, and zero-mock implementation guidelines.

---

## 1. Verified Binance Web3 API Findings

Following official documentation research on `https://web3.binance.com/build`:

1. **Authentication Requirements**:
   - `X-OC-APIKEY`: Web3 API Key.
   - `X-OC-TIMESTAMP`: Current UTC ISO 8601 string with milliseconds. Must fall within ±5,000 ms.
   - `X-OC-SIGN`: Base64-encoded HMAC-SHA256 (or Ed25519) signature.
2. **Supported Token Discovery**:
   - `GET /api/v1/dex/market/token/search`
   - `POST /api/v1/dex/market/token/basic-info`
3. **Real-Time Price Feeds**:
   - `POST /api/v1/dex/market/price` (batch query up to 100 assets).
4. **Wallet Balances**:
   - `POST /api/v1/dex/balance/token-balances-by-address`
   - `GET /api/v1/dex/balance/all-token-balances-by-address`
   - Direct BSC RPC `eth_call` (`balanceOf`) for redundant on-chain verification.
5. **DEX Aggregator Quotes**:
   - `GET /api/v1/dex/aggregator/quote`
   - Returns `executionMode`: `"SWAP"` (regular DeFi tokens) or `"RFQ"` (tokenized stocks & RWAs).
6. **Execution Pipeline for Tokenized Equities**:
   - Step 1: `GET /api/v1/dex/aggregator/swap` returns `rfq.typedDataToSign` (EIP-712).
   - Step 2: Must be signed by the user's wallet within **30 seconds** (`40401 QUOTE_EXPIRED` if late).
   - Step 3: `POST /api/v1/dex/aggregator/order/submit` with idempotency UUID.
   - Step 4: `GET /api/v1/dex/aggregator/order/{orderId}` to poll settlement status.
7. **Rate Limits**:
   - Returns HTTP 429 with error code `42900`.
   - Client must respect `Retry-After` header. Agentic wallet limits observed at 30 calls/hr.
8. **Transaction Simulation**:
   - `POST /api/v1/transaction/simulate` available for testing execution gas and pre-validating transactions.

---

## 2. Verified Tokenized Stock Assets on BSC Mainnet

- **bNVDA (Backed NVIDIA)**:
  - Contract: `0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495`
  - Decimals: `18`
  - Underlying: NVIDIA Corp (1:1 collateralized tracker certificate issued by Backed Finance).
  - Trading Mode: Subject to RFQ market hours (`40369` error if market closed).
- **USDC (Counter-Asset)**:
  - Contract: `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`
  - Decimals: `18`
- **USDY (Ondo US Dollar Yield - Alternative RWA)**:
  - Contract: `0x608593d17A2decBbc4399e4185bE4922F97eD32E`
  - Decimals: `18`

---

## 3. Market State & Slippage Architectural Decoupling

### 3.1 Pluggable Market State Provider
- Traditional US market hours (09:30–16:00 ET, Mon–Fri) cannot be assumed as authoritative exchange status for all tokenized products without an explicit calendar feed.
- Binance Web3 API does not expose a standalone `GET /market-hours` endpoint, but emits errors `40369` (BStock) and `40367` (Ondo) when orders are submitted out-of-session.
- **Architectural Decision**: Created `IMarketStateProvider` adapter interface. The application uses a configurable calendar adapter by default and is ready to ingest live calendar APIs or react directly to Binance API session halt responses.

### 3.2 Slippage & Risk Bounds as StockPilot Safety Policies
- Slippage limits (e.g. 50 bps during normal hours, 25 bps during closed hours) are **StockPilot application safety policies** configured by the operator/user to protect against price impact, rather than intrinsic exchange rules.

---

## 4. Independent Verification Boundary (GenLayer)

- GenLayer verification adapter remains an independent verification gate.
- It verifies evidence packets:
  - Calculated drift vs user strategy threshold
  - Trade amount vs maximum circuit breaker cap
  - Quote timestamp vs max allowable staleness
  - Market regime status
- **Zero Mock Rule**: StockPilot never fabricates a verification consensus response. If GenLayer endpoint is unconfigured or unavailable, the system reports `"Verification unavailable"` and halts closed.
