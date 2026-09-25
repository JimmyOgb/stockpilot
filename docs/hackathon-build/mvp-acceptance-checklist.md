# StockPilot — MVP Acceptance Checklist

> **Hackathon**: BNB Hack: Tokenized Stocks Edition  
> **Status Tracker**: Acceptance Criteria & Sign-off

---

## 1. Core Feature Checklist

- [ ] **1. Strategy Creation**
  - [ ] Natural language strategy input (e.g., "Keep 60% tokenized NVIDIA and 40% USDC with 5% drift").
  - [ ] Parsing into structured parameters: `targetStockWeightBps`, `targetStableWeightBps`, `driftThresholdBps`.
  - [ ] Validation: Target weights must sum to exactly 100% (10,000 bps).

- [ ] **2. Single Supported Tokenized Stock Asset**
  - [ ] Focus on a verified BSC tokenized stock asset (e.g. bNVDA / bAAPL / Ondo USDY / equity token).
  - [ ] Token contract address, symbol, and decimals configured deterministically.

- [ ] **3. USDC / Stablecoin Counter-Asset**
  - [ ] BSC USDC contract mapped and monitored.
  - [ ] Dual-asset valuation (Stock + USDC = Total Portfolio Value).

- [ ] **4. Portfolio Allocation Calculation**
  - [ ] Deterministic calculation of current USD value of stock holdings.
  - [ ] Deterministic calculation of current USD value of stablecoin holdings.
  - [ ] Exact basis point calculation of actual portfolio weights.

- [ ] **5. Drift Threshold Monitoring**
  - [ ] Calculation of drift: $|\text{Actual Weight} - \text{Target Weight}|$.
  - [ ] Strict threshold trigger: No trade proposed if drift < threshold.

- [ ] **6. Market-State Indicator**
  - [ ] Indicator visible in UI with 3 explicit states:
    - 🟢 `MARKET_OPEN`: Normal execution bounds.
    - 🟡 `MARKET_CLOSED`: Tokenized stock trades on-chain; tighter execution bounds.
    - 🔴 `REFERENCE_STALE`: Stale oracle/quote; trade execution unconditionally blocked.
  - [ ] System handles state transitions deterministically based on timestamp and market schedules.

- [ ] **7. Proposed Rebalance Generation**
  - [ ] Calculates exact token delta required to restore portfolio to target weights.
  - [ ] Sets trade direction: `BUY_STOCK` (selling USDC) or `SELL_STOCK` (buying USDC).
  - [ ] Enforces maximum single-rebalance cap and slippage tolerance.

- [ ] **8. Verification Gate (GenLayer Adapter)**
  - [ ] Generates verifiable evidence packet (strategy, portfolio snapshot, drift, proposed trade, market state, quote timestamp).
  - [ ] Evaluates deterministic rules via verification adapter.
  - [ ] Execution proceeds ONLY when verification result is strictly `ALLOW`.
  - [ ] Does not execute trades inside the verifier (separation of concerns).

- [ ] **9. Binance Web3 API Integration**
  - [ ] Balance retrieval on BSC via Binance Web3 API / agentic wallet interface.
  - [ ] Spot quote & routing query via Binance Web3 API.
  - [ ] Real requests logged in DevEx log with timestamps, latencies, and responses.

- [ ] **10. Spot Transaction Execution**
  - [ ] Execution adapter submits signed spot swap to BSC mainnet.
  - [ ] Spot-only validation (rejection of leverage / perps).
  - [ ] Captures transaction hash and confirms on BSC explorer.

- [ ] **11. Execution & Audit History**
  - [ ] Comprehensive event log storing every evaluation and transaction attempt.
  - [ ] Explicit states: `PENDING`, `VERIFIED`, `EXECUTED`, `FAILED`, `HALTED_STALE`.
  - [ ] Auditable explanation provided for every action taken or skipped.

- [ ] **12. Clear Fail-Closed Behavior**
  - [ ] Blocks trades when price feeds exceed staleness threshold.
  - [ ] Blocks trades when Binance Web3 API returns errors.
  - [ ] Blocks trades when verification fails or returns unknown status.
  - [ ] Never fabricates mock data as live mainnet data.

---

## 2. Hackathon Deliverables Checklist

- [ ] Public GitHub repository created.
- [ ] Comprehensive `README.md` with architecture, setup, and run instructions.
- [ ] `docs/hackathon-build/scope.md` detailing constraints and MVP boundary.
- [ ] `docs/hackathon-build/build-notes.md` detailing engineering decisions.
- [ ] `docs/hackathon-build/devex-log.md` with real Binance integration entries.
- [ ] Unit tests for deterministic strategy and risk calculations passing.
- [ ] Working health / status endpoint (`/api/health`).
- [ ] Demo video (<= 4 minutes) scripted and recorded.
