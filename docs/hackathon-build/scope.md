# StockPilot — Scope & Product Specification

> **Event**: BNB Hack: Tokenized Stocks Edition (Sep 16 – Oct 11, 2026)  
> **Target Network**: BNB Smart Chain (BSC) Mainnet (Chain ID: 56)  
> **Core Asset**: `bNVDA` (Backed NVIDIA) & `USDC` on BSC  
> **Transaction Mode**: Spot Only (Zero Perpetuals, Zero Leverage)  
> **Data Policy**: Strict Zero Mock (No Fake Prices, No Fake Transactions)  

---

## 1. Product Vision

**StockPilot** is an autonomous BSC agent that lets users define tokenized-stock allocation strategies in plain English (e.g., *"Keep 60% bNVDA and 40% USDC. Rebalance when bNVDA allocation drifts more than 5%, but do not buy if the tokenized price is more than 2% above the reference price"*), continuously monitors real BSC portfolio holdings, calculates on-chain vs. reference price spread intelligence, verifies proposed rebalances against deterministic risk boundaries and an independent verification gate, validates transaction viability via preflight simulation, and safely dispatches spot execution via Binance Web3 API and the Binance Agentic Wallet.

---

## 2. Mandatory Track Requirements & Alignment

1. **Asset Core (Mandatory)**: Centered on **bNVDA / bStocks** on BSC Mainnet (`0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495`, 18 decimals), paired with `USDC` (`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`, 18 decimals).
2. **Network**: Fully operational on **BSC Mainnet** (Chain ID: 56).
3. **Transaction Mode**: **Spot transactions only** (RFQ or Dex Aggregator swap). Absolutely zero perpetuals, zero leverage, and zero margin borrowing.
4. **Authoritative RWA Data API**:
   - The authoritative source for tokenized equities.
   - Distinctly identifies real market status:
     - `market open`
     - `market closed`
     - `paused`
     - `halted`
     - `unavailable`
     - `unknown`
   - Market status must **never be inferred** from static trading calendars when Binance provides authoritative market status feeds.
5. **On-Chain vs. Reference Price Intelligence**:
   - Computes deterministic spread: $\text{spread} = \frac{\text{onchainPrice} - \text{referencePrice}}{\text{referencePrice}}$
   - Only calculated when both live prices are available; otherwise explicitly displays `—`.
   - Exposed as an actionable risk condition (e.g., max allowable spread premium before buying).
6. **Execution Safety Pipeline**:
   - Enforces the strict sequential lifecycle:
     $$\text{PROPOSE} \longrightarrow \text{VERIFY} \longrightarrow \text{SIMULATE} \longrightarrow \text{EXECUTE}$$
   - **Preflight Simulation**: A failed or reverting transaction simulation terminates execution immediately.
7. **Independent Verification Layer (GenLayer)**:
   - External verification gate validating cryptographic evidence packets.
   - **Never executes trades**. Returns verifiable `ALLOW` or `REJECT`.
8. **Agentic Wallet & Wallet Skills**:
   - Clear division between programmatic REST API calls (telemetry, drift) and Agentic Wallet skills (`baw` / `binance-tokenized-securities-info` for policy enforcement and EIP-712 signing).
9. **BNB Agent Studio**:
   - Persistent autonomous agent runtime evaluating rebalancing loops.
10. **Zero-Mock Requirement**:
    - Absolutely no simulated financial data, fake stock prices, fabricated balances, or dummy transaction hashes. If unconfigured or disconnected, explicit states (`Awaiting API Configuration`, `No wallet connected`, `—`) are rendered.

---

## 3. Module Prioritization & Scope Boundaries

| Priority | Module | Responsibility in StockPilot | Status |
|---|---|---|---|
| **P1** | **RWA Data API** | Authoritative token discovery, dual-price feeds, real market status (`open`, `closed`, `paused`, `halted`), next open time. | Primary Focus |
| **P2** | **Market Data API** | Spot prices for counter-assets (`USDC`), candlesticks, secondary signals. | Core Client Built |
| **P3** | **Wallet API & RPC** | Real BSC token balances for `bNVDA` and `USDC` with redundant direct RPC validation. | In Progress |
| **P4** | **Trading API** | Real spot RFQ quotes, approval checks, and swap execution payloads. | Next Phase |
| **P5** | **Transaction Simulation** | Preflight transaction simulation (`/api/v1/transaction/simulate` / `baw preflight`). Revert prevention. | Safety Gate |
| **P6** | **Agentic Wallet Skills** | User spending limits, approved token policies, EIP-712 signing for RFQ orders. | Skills Installed |
| **P7** | **BNB Agent Studio** | Persistent autonomous agent scheduling and portfolio alert listener. | Agent Layer |
| **P8** | **GenLayer Gate** | Independent multi-validator evidence verification. | Verification Adapter |
| *Out-of-Scope* | *DeFi API & b402* | Staking, lending, and HTTP 402 paywalls are excluded for MVP simplicity. | Deprioritized |

---

## 4. Fail-Closed Principles

StockPilot adheres strictly to fail-closed operations:
- **Missing / Stale Telemetry**: If price, reference, or balance data exceeds staleness thresholds, rebalancing is aborted with `REFERENCE_STALE`.
- **Trading Session Inactive**: If RWA market status is `closed`, `paused`, `halted`, or `unavailable`, execution fails closed.
- **Spread Premium Breach**: If on-chain price exceeds reference price by more than the user's defined risk limit, buying is blocked.
- **Verification Failure**: If GenLayer rejects the proposal, execution aborts.
- **Simulation Failure**: If preflight simulation reverts, execution halts before wallet signing.
- **Credential Hygiene**: API secrets never reach client/browser or logs.
