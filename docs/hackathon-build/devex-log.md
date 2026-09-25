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
- **Result**: In Progress / Scoping
- **Latency**: N/A
- **Errors**: N/A
- **Documentation Location**: Official Binance Web3 Developer Portal & BNB Chain documentation for tokenized stock contracts (bStocks / Ondo / xStocks).
- **Confusing Behavior**: Multiple API surfaces exist across Binance Web3 services:
  1. Binance Web3 Wallet (MPC / Agentic Wallet APIs for signing/dispatch).
  2. Binance Web3 API / DEX aggregator endpoints (quote, swap routes on BSC).
  3. BNB Agent Studio endpoints for agentic tools.
  Need to clearly delineate between direct BSC on-chain reads vs Binance Web3 gateway quote APIs to maintain zero-fake-data and fail-closed guarantees.
- **Resolution**: Strict adapter pattern (`BinanceWeb3Client` interface) isolating market data fetching, quote fetching, and wallet submission. All calls will be timed and logged with exact HTTP/RPC traces.
- **Improvement Suggestion**: Provide a unified OpenAPI spec / TypeScript SDK specifically bundling tokenized stock metadata (underlying market hours, trading hours, corporate action flags) for BSC-native bStocks/Ondo/xStocks.

---

*(Additional entries will be recorded during each live endpoint integration attempt)*
