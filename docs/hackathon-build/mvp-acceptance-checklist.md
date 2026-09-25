# StockPilot — MVP Acceptance Checklist

> **Hackathon**: BNB Hack: Tokenized Stocks Edition  
> **Status Tracker**: Acceptance Criteria & Sign-off (Zero Mock Audit Completed)

---

## 1. Core Feature Checklist

- [ ] **1. Strategy Creation**
  - [x] Natural language strategy parsing (e.g., "Keep 60% tokenized NVIDIA and 40% USDC with 5% drift").
  - [x] Structured parameters: `targetStockWeightBps`, `targetStableWeightBps`, `driftThresholdBps`.
  - [x] Strict validation: Target weights must sum to exactly 100% (10,000 bps).

  - [x] Verified BSC contract address identified via live Binance RWA registry: **NVDAB (bStocks)** (`0x02fca66c1d1afb4e2a7884261eb00f63598a7436`). *Note: Address `0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495` is [STALE / INVALIDATED BY LIVE BINANCE REGISTRY].*
  - [x] Verified token decimals: `18`.
  - [x] Secondary candidate documented: Ondo NVIDIA (`NVDAon` — `0xa9ee28c80f960b889dfbd1902055218cba016f75`).

- [ ] **3. USDC / Stablecoin Counter-Asset**
  - [x] Verified BSC USDC contract mapped: `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` (18 decimals).
  - [x] Dual-asset valuation (Stock + USDC = Total Portfolio Value).

- [x] **4. Portfolio Allocation Calculation**
  - [x] Deterministic calculation of current USD value of stock holdings.
  - [x] Deterministic calculation of current USD value of stablecoin holdings.
  - [x] Exact basis point calculation of actual portfolio weights.
  - [x] Fails closed to `INSUFFICIENT_PORTFOLIO_DATA` when balances are genuinely zero (never invents a 60/40 allocation).

- [x] **5. Drift Threshold Monitoring**
  - [x] Deterministic drift math: $|\text{Actual Weight} - \text{Target Weight}|$.
  - [x] Strict threshold trigger: No trade proposed if drift < threshold (`NO_ACTION`).
  - [x] Threshold boundary precision (500 bps triggers, 499 bps holds `NO_ACTION`).

- [x] **6. Market-State Indicator & Pluggable Provider**
  - [x] Pluggable `IMarketStateProvider` architecture decoupled from hardcoded logic.
  - [x] Visible UI badge with 3 explicit states:
    - 🟢 `MARKET_OPEN`: Normal execution bounds.
    - 🟡 `MARKET_CLOSED`: Tokenized stock trades on-chain; tighter execution bounds.
    - 🔴 `REFERENCE_STALE`: Stale oracle/quote; trade execution unconditionally blocked.
  - [x] Slippage bounds documented as StockPilot application safety policies (not market constants).

- [x] **7. Proposed Rebalance Generation**
  - [x] Deterministic delta calculation and trade sizing in `src/strategy/portfolio-engine.ts`.
  - [x] Trade direction: `BUY_STOCK` or `SELL_STOCK`.
  - [x] Max single-rebalance cap circuit breaker ($5,000 USD default).
  - [x] Real token-vs-reference price spread risk check (`RISK_BLOCKED` when spread exceeds `maxSpreadBps`).
  - [x] 6 typed decision states: `NO_ACTION`, `REBALANCE_REQUIRED`, `INSUFFICIENT_PORTFOLIO_DATA`, `MARKET_CLOSED`, `DATA_UNAVAILABLE`, `RISK_BLOCKED`.

- [x] **8. Verification Gate (GenLayer Adapter)**
  - [x] Verification adapter maintained as independent verification boundary (`src/verification/genlayer-adapter.ts`).
  - [x] GenLayer Intelligent Contract (`contracts/rebalance_verifier.py`) pinned to latest runner with custom comparator (no `strict_eq` on LLM).
  - [x] Canonical evidence packet structured (`CanonicalEvidencePayload` with sorted-key deterministic SHA-256 hash).
  - [x] Execution blocked unless verification returns `ALLOW` (`VERIFIED`).
  - [x] Zero mock policy: No fabricated verification consensus responses in production runtime.
  - [x] 19 dedicated unit tests in `tests/genlayer-adapter.test.ts` covering BUY, SELL, NO_ACTION, math mismatches, wrong directions, excessive spread, market closed, circuit breakers, stale quotes, zero balances, malformed responses, consensus timeouts, and tampered hashes.

- [x] **9. Binance Web3 API Integration (Read-Only Telemetry, Verification & Preflight Simulation)**
  - [x] Official API documentation audited (`https://web3.binance.com/build`).
  - [x] Exact endpoints documented in `docs/hackathon-build/binance-integration-spec.md`.
  - [x] Authentication headers verified (`X-OC-APIKEY`, `X-OC-TIMESTAMP`, `X-OC-SIGN`, `X-OC-RECV-WINDOW`).
  - [x] Implemented `BinanceMarketDataClient`, `BinanceRwaClient`, `BinanceWalletBalanceClient`, and `BinanceRwaAssetResolver`.
  - [x] Verified live read-only pipeline via smoke test (`npm run test:smoke`): `USER_WALLET_PORTFOLIO_VERIFIED`.
  - [x] Implemented `BinanceSimulationClient` (`src/binance/simulation-client.ts`) for preflight simulation via `POST /build/api/v1/dex/pre-transaction/simulate` and `GET /build/api/v1/dex/pre-transaction/gas-price`.
  - [x] Enforces strict sequential order: accepts only proposals with GenLayer `decision === 'VERIFIED'` and `status === 'ALLOW'`.
  - [x] Fail-closed gates: tamper hash check, proposal ID check, market closed / stale reference, stale quotes, spread risk breaches, circuit breaker limits, invalid/zero-address wallets, on-chain reverts, missing gas telemetry, and KYT blocks.
  - [x] Cryptographic SHA-256 simulation audit trail (`getAuditTrail()`).
  - [x] Zero mock policy: Read-only simulation only. Zero broadcasting, zero orders, zero signing, zero funds moved.
  - [x] 25 dedicated unit tests in `tests/binance-simulation-client.test.ts`. All 170/170 unit tests passing.

- [ ] **10. Spot Transaction Execution**
  - [x] Execution adapter interface designed for both `SWAP` and `RFQ` flows.
  - [x] Spot-only enforcement (rejection of leverage / perps).
  - [ ] Live broadcast via Binance Web3 Wallet / Agentic Wallet.

- [ ] **11. Execution & Audit History**
  - [x] Immutable audit store interface.
  - [x] Explicit states: `PENDING`, `VERIFIED`, `EXECUTED`, `FAILED`, `HALTED_STALE`.
  - [x] DevEx log endpoint (`/api/devex-log`) exposing real integration records to UI.

- [ ] **12. Clear Fail-Closed Behavior**
  - [x] Zero Mock Policy enforced: Missing data displays `"Not Connected"`, `"No live data available"`, `"Verification unavailable"`, or `"—"`.
  - [x] Blocks trades on `REFERENCE_STALE`.
  - [x] Blocks trades on verification failure or timeout.

---

## 2. Hackathon Deliverables Checklist

- [x] Clean project directory and Git repository initialized.
- [x] Comprehensive `README.md`.
- [x] `docs/hackathon-build/scope.md` detailing constraints and MVP boundaries.
- [x] `docs/hackathon-build/architecture.md` detailing decoupled architecture & RFQ flow.
- [x] `docs/hackathon-build/build-notes.md` with verified API findings.
- [x] `docs/hackathon-build/binance-integration-spec.md` with full endpoint specifications.
- [x] `docs/hackathon-build/devex-log.md` with official integration entries.
- [x] Unit tests for deterministic strategy, GenLayer verification, and Binance simulation passing (170/170 across 9 test suites).
- [x] Working health/status endpoint (`/api/health`).
- [x] Anime-inspired animated product introduction sequence and live Zero-Mock dashboard.
