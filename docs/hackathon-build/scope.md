# StockPilot — Scope & Product Specification

> **Event**: BNB Hack: Tokenized Stocks Edition (Sep 16 – Oct 11, 2026)  
> **Target Network**: BNB Smart Chain (BSC) Mainnet  
> **Asset Focus**: Tokenized Stocks (bStocks / Ondo / xStocks) & USDC Stablecoin  

---

## 1. Product Vision

**StockPilot** is an autonomous BSC agent that lets users define tokenized-stock allocation strategies in plain English (e.g., *"Keep 60% tokenized NVIDIA and 40% USDC. Rebalance when the stock allocation drifts more than 5%"*), continuously monitors the user's BSC portfolio, verifies proposed rebalances against deterministic risk and strategy rules, passes evidence through an independent verification gate, and executes spot rebalancing via the Binance Web3 API / Binance Web3 Wallet.

---

## 2. Hackathon Requirements & Constraints

1. **Asset Core**: Centered on tokenized stocks (bStocks / Ondo / xStocks) on BSC.
2. **Network**: Deployed and operating on **BSC mainnet**.
3. **Transaction Type**: **Spot transactions only** (absolutely no perpetuals, leverage, or derivatives).
4. **Binance Integrations**:
   - Meaningful use of **Binance Web3 API** (portfolio balances, spot routing, reference pricing).
   - Use of **Binance Web3 Wallet / Agentic Wallet** for secure transaction dispatch.
   - Use of **BNB Agent Studio** where appropriate for agent workflow triggers.
5. **GenLayer Independent Verification Gate**:
   - GenLayer acts as an **independent verification layer** evaluating proposed actions against verifiable evidence before execution.
   - GenLayer **never executes trades**; it only issues deterministic verification decisions (ALLOW / REJECT / HALT).
   - If verification fails or evidence is incomplete, execution halts.
6. **Market-State Intelligence**:
   - `MARKET_OPEN`: Underlying traditional equities market is open; normal rebalancing execution rules apply.
   - `MARKET_CLOSED`: Underlying market is closed; tokenized stock can trade on-chain, but underlying reference may be stale; tighter slippage and drift thresholds apply.
   - `REFERENCE_STALE`: Underlying reference data or on-chain oracle is stale (> threshold); **trade must fail closed**.
7. **Quality & Authenticity**:
   - No fake or simulated transactions passed off as real mainnet transactions.
   - No fake market data.
   - No fake verification results.
   - Auditable state machine with fail-closed behavior.

---

## 3. MVP Scope (Strictly Scoped)

To ensure completion before the hackathon submission deadline, the MVP includes:

| Component | MVP In-Scope | Out-of-Scope (Future / Post-Hackathon) |
|---|---|---|
| **Strategy Creation** | Plain-English parsing + structured target allocations (e.g. 60% bNVDA / 40% USDC, 5% drift) | Multi-asset baskets (>2 assets), complex conditional triggers |
| **Asset Support** | 1 Tokenized Stock (e.g. bNVDA or Ondo US equity token) + USDC on BSC | Multi-chain stocks, synthetic derivatives, illiquid small-caps |
| **Portfolio Math** | Exact deterministic spot valuation, weight calculation, drift detection | Yield farming, staking, lending integrations |
| **Market States** | Tri-state indicator (`MARKET_OPEN`, `MARKET_CLOSED`, `REFERENCE_STALE`) | Complex order book depth modeling, news sentiment |
| **Rebalance Proposal** | Deterministic trade generator specifying exact delta (Buy/Sell asset, target token, slippage cap) | TWAP/VWAP execution slicing |
| **Verification Gate** | Evidence packet creation & verification check (strategy, drift, size, staleness, limits) | Complex multi-validator multi-round games |
| **Execution** | Spot swap invocation via Binance Web3 API / Wallet adapter | Perpetual swaps, margin borrowing, stop-loss orders |
| **Auditability** | Full JSON audit logs with state transitions (PENDING → VERIFIED → EXECUTED / FAILED) | Social feeds, public leaderboards |

---

## 4. Fail-Closed Principles

StockPilot adheres to strict fail-closed rules:
- **Missing or stale price data**: Rebalance aborted; status set to `REFERENCE_STALE`.
- **Drift below threshold**: No action proposed; reason logged clearly.
- **Verification failure**: If verification adapter rejects the proposal or times out, trade is halted immediately.
- **Excessive slippage or market closed constraints**: Rebalance size or slippage bounds exceeded results in immediate rejection.
- **Secret integrity**: No keys or credentials exposed to client or browser.
