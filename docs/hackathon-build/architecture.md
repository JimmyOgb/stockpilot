# StockPilot Architecture Specification

> **BNB Hack: Tokenized Stocks Edition** (Sep 16 – Oct 11, 2026)  
> **System**: StockPilot Autonomous BSC Portfolio Rebalancer  
> **Core Asset**: `NVDA` Tokenized Equity — Backed NVIDIA (`NVDAB` — `0x02fca66c1d1afb4e2a7884261eb00f63598a7436`) & `USDC` (`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`). *Note: Initial spec address `0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495` is [STALE / INVALIDATED BY LIVE BINANCE REGISTRY].*  
> **Data Integrity**: Strict Zero-Mock Policy  

---

## 1. System Overview

StockPilot is an autonomous BSC agent that lets users define tokenized-stock allocation strategies in plain English, continuously monitors their on-chain portfolio, verifies proposed rebalances against deterministic risk parameters and an independent verification gate, validates transaction viability via preflight simulation, and safely executes spot rebalancing via the Binance Web3 API and Binance Agentic Wallet.

---

## 2. Updated End-to-End Decision Pipeline

The StockPilot architecture enforces strict separation of responsibilities across each layer of the pipeline:

$$\begin{aligned}
\text{USER STRATEGY} &\longrightarrow \text{STRATEGY PARSER} \\
&\longrightarrow \text{REAL RWA DATA} \\
&\longrightarrow \text{REAL MARKET DATA} \\
&\longrightarrow \text{REAL WALLET STATE} \\
&\longrightarrow \text{DETERMINISTIC STRATEGY / RISK ENGINE} \\
&\longrightarrow \text{PROPOSED ACTION} \\
&\longrightarrow \text{GENLAYER INDEPENDENT VERIFICATION} \\
&\longrightarrow \text{BINANCE TRANSACTION SIMULATION} \\
&\longrightarrow \text{EXPLICIT EXECUTION AUTHORIZATION} \\
&\longrightarrow \text{BINANCE TRADING / AGENTIC WALLET} \\
&\longrightarrow \text{BSC MAINNET} \\
&\longrightarrow \text{REAL RECEIPT / STATUS} \\
&\longrightarrow \text{AUDIT HISTORY}
\end{aligned}$$

```mermaid
flowchart TD
    User([User Strategy Prompt e.g. 60% bNVDA / 40% USDC]) --> Parser[Strategy Parser]
    Parser --> StrategyConfig[Target Allocations & Risk Thresholds]

    subgraph LiveTelemetry [1. Real Telemetry & RWA Feeds - Binance Web3 API]
        RWA[Authoritative RWA Data API\n- On-Chain Price & Reference Price\n- Market Status: open/closed/paused/halted\n- Attestation & Metadata]
        Market[Market API\n- Spot Prices & Candlesticks]
        Wallet[Wallet API / BSC RPC\n- Real Token Balances: bNVDA & USDC]
    end

    StrategyConfig --> RiskEngine
    RWA --> RiskEngine
    Market --> RiskEngine
    Wallet --> RiskEngine

    subgraph DeterministicEngine [2. Deterministic Strategy & Risk Engine]
        RiskEngine[StockPilot Risk Engine\n- Portfolio Valuation & Drift Math\n- Spread Intelligence: onchain vs reference\n- Fail-Closed: Stale / Paused / Halted]
        RiskEngine --> DriftEval{Drift > Threshold & Risk Checks Pass?}
        DriftEval -->|No| NoAction[Log No-Op & Update Audit History]
        DriftEval -->|Yes| ProposeAction[Generate Proposed Spot Rebalance]
    end

    subgraph VerificationLayer [3. Independent Verification Layer - GenLayer]
        ProposeAction --> EvidencePacket[Compile Signed Evidence Packet\n- Target weights, drift bps, quote freshness\n- Market state & spread premium]
        EvidencePacket --> GenLayerGate[GenLayer Intelligent Contract\n- Deterministic Multi-Validator Consensus\n- NEVER executes trades]
        GenLayerGate --> VerifyDecision{Decision == ALLOW?}
        VerifyDecision -->|REJECT / UNKNOWN| AbortVerify[Fail Closed: Abort Rebalance]
    end

    subgraph SimulationLayer [4. Transaction Simulation Service - Binance Web3]
        VerifyDecision -->|ALLOW| SimulateTx[Binance Transaction Simulation API\nPOST /api/v1/transaction/simulate\n- Preflight state override & gas estimation]
        SimulateTx --> SimResult{Simulation Success?}
        SimResult -->|FAIL / REVERT| AbortSim[Fail Closed: Simulation Failed - Abort]
    end

    subgraph ExecutionLayer [5. Execution Authorization & Dispatch]
        SimResult -->|PASS| AuthCheck[Explicit Execution Authorization\n- Verify User Daily Limits & Policy via Agentic Wallet]
        AuthCheck --> Dispatch[Binance Trading API / Agentic Wallet\n- RFQ / Swap Execution\n- EIP-712 Typed Data Signing]
        Dispatch --> BSC[(BSC Mainnet Settlement)]
        BSC --> Receipt[Real Onchain Tx Receipt & Status]
    end

    Receipt --> Audit[(Immutable Audit History Store)]
    NoAction --> Audit
    AbortVerify --> Audit
    AbortSim --> Audit
    Audit -.-> UI[Zero-Mock Web Dashboard]
```

---

## 3. Core Architectural Modules & Responsibilities

### 3.1 RWA Data API (Authoritative Tokenized-Equity Source)
The RWA Data API is the primary authority for tokenized equities (`bNVDA`, Ondo assets):
- **Token Discovery & Metadata**: Contract address, issuer backing (Backed Finance), decimals (`18`), and backing ratio (`sharesMultiplier`).
- **Dual-Price Discovery**:
  - `onchainPrice`: Real-time spot price of tokenized equity on BSC.
  - `referencePrice`: Real-time underlying traditional equity reference price.
- **Authoritative Market Status**: Must never be inferred from static calendars. The system explicitly distinguishes and handles:
  - 🟢 `MARKET_OPEN` / `premarket` / `regular` / `postmarket` / `overnight`
  - 🟡 `MARKET_CLOSED`
  - 🟠 `PAUSED`
  - 🔴 `HALTED`
  - ⚪ `UNAVAILABLE`
  - ❓ `UNKNOWN`
- **Next Open/Close Time**: Authoritative timestamps provided by Binance Web3 / DeFI endpoints (`/market/status/ai` and `/asset/market/status/ai`).

### 3.2 Market API (Crypto & Supporting Feeds)
- Real-time spot pricing for counter-assets (`USDC`) and native gas (`BNB`).
- Candlesticks and volume metrics for secondary liquidity analysis.
- Fails closed if data timestamps exceed `MAX_STALENESS_SECONDS` (default: 60s).

### 3.3 Wallet API & BSC RPC Fallback (Real Portfolio State)
- Queries token balances via `POST /api/v1/dex/balance/token-balances-by-address`.
- Incorporates direct BSC JSON-RPC (`eth_call` for ERC-20 `balanceOf`) as an authoritative, zero-mock fallback to guarantee uncompromised state verification.

### 3.4 On-Chain vs. Reference Price Intelligence (StockPilot Differentiator)
When the RWA Data API provides both `onchainPrice` and `referencePrice`, StockPilot calculates the real-time spread deterministically:

$$\text{spread} = \frac{\text{onchainPrice} - \text{referencePrice}}{\text{referencePrice}}$$

- **Zero-Mock Rendering**: Calculated and displayed **only** when both feeds are valid and live. If either is missing, stale, or unavailable, the UI and API explicitly return `—`.
- **Strategy Condition Integration**: The deterministic risk engine evaluates user-defined spread constraints (e.g., *"Do not buy if tokenized price is > 2.0% above traditional reference"*), preventing toxic arbitrage or paying excessive illiquidity premiums.

### 3.5 Real Deterministic Strategy & Risk Engine (`src/strategy/portfolio-engine.ts` & `risk-engine.ts`)
- Pure mathematical calculation of portfolio weights, drift basis points, and rebalance amounts based strictly on verified live data.
- **Zero Mock Policy**:
  - Never fabricates missing balance or price data.
  - Returns `INSUFFICIENT_PORTFOLIO_DATA` when balances are genuinely zero or total portfolio valuation is zero (never invents a fake 60/40 allocation).
  - Evaluates live on-chain vs. reference price spread and enforces risk boundaries.
- **Six Explicit Decision States**:
  1. `NO_ACTION`: Portfolio allocation drift is strictly within the tolerance threshold (default: 500 bps / 5.0%).
  2. `REBALANCE_REQUIRED`: Allocation drift exceeds threshold and all verified risk checks pass. Proposes deterministic `BUY_STOCK` or `SELL_STOCK`.
  3. `INSUFFICIENT_PORTFOLIO_DATA`: Both asset balances are zero or total portfolio valuation is $\le 0$. No fake portfolio weights generated.
  4. `MARKET_CLOSED`: Underlying equity session is closed and strategy policy disallows closed-market rebalancing.
  5. `DATA_UNAVAILABLE`: Missing, invalid, or stale price quotes or balance telemetry; or reference data stale (`REFERENCE_STALE`).
  6. `RISK_BLOCKED`: Proposed rebalance blocked by risk boundaries (e.g., token/reference price spread exceeds `maxSpreadBps`).
- **Configurable Safety Boundaries**:
  - Max trade size per rebalance (`maxSingleTradeUsd`, e.g. $5,000 USD circuit breaker).
  - Max slippage tolerance: 50 bps in open session, 25 bps in closed/overnight session.
  - Max spread premium threshold (`maxSpreadBps`, default: 200 bps / 2.0%).
  - Minimum drift activation threshold (`driftThresholdBps`, default: 500 bps / 5.0%).
- **Standard MVP Configuration (`DEFAULT_MVP_STRATEGY_CONFIG`)**:
  - Target: 60% NVDAB (`0x02fca66c1d1afb4e2a7884261eb00f63598a7436`) / 40% USDC (`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`).
  - Drift threshold: 500 bps (5.0%). Circuit breaker: $5,000 USD. Max spread: 200 bps (2.0%). Fail-closed when market closed.

### 3.6 Independent Verification Layer (GenLayer — `contracts/rebalance_verifier.py` & `src/verification/genlayer-adapter.ts`)
- Evaluates proposed rebalances as an external, independent validator consensus gate.
- **Strict Boundary**: GenLayer **never executes trades, holds private keys, signs transactions, or submits orders**.
- **Canonical Evidence Payload (`CanonicalEvidencePayload`)**:
  - Deterministic serialization with alphabetically sorted keys and SHA-256 evidence hashing.
  - Contains strategy configuration, verified wallet balance evidence, live NVDAB token and reference prices, deterministic spread, market session status, snapshot weights, proposal delta, and risk checks.
- **Independent Verification Invariants**:
  1. Proposal mathematically matches supplied portfolio balance valuations.
  2. Drift calculation is independently reconciled ($|\text{Weight} - \text{Target}|$).
  3. Proposed trade direction is consistent with drift (`BUY_STOCK` when underweight, `SELL_STOCK` when overweight, `NONE` when within threshold).
  4. Trade amount does not exceed circuit breaker (`maxSingleTradeUsd`).
  5. Market session permits proposed action (blocks trades when `MARKET_CLOSED` or `REFERENCE_STALE`).
  6. Real token/reference spread does not violate configured risk boundary (`maxSpreadBps` on `BUY_STOCK`).
  7. Zero/empty portfolio balances (`0 tokens`) are **never converted into synthetic weights** (strictly rejected).
  8. Stale quotes ($> 900\text{s}$) or tampered evidence hashes are unconditionally rejected.
- **Fail-Closed Consensus Protocol**:
  - Unavailable GenLayer result $\rightarrow$ `NOT_VERIFIED` (`REJECT`).
  - RPC timeout / network error $\rightarrow$ `NOT_VERIFIED` (`REJECT`).
  - Malformed schema $\rightarrow$ `NOT_VERIFIED` (`REJECT`).
  - Validator disagreement / `NO_MAJORITY` $\rightarrow$ `NOT_VERIFIED` (`REJECT`).
  - Unconfigured contract address $\rightarrow$ `NOT_VERIFIED` (`REJECT`).
  - Only an explicitly valid proposal with unanimous consensus receives `VERIFIED` (`ALLOW`).
- **Defensive Structured Schema & Custom Comparator**:
  - Does **not** use `strict_eq` on non-deterministic LLM text outputs. Uses structured JSON schema with field-level agreement on `status` (`ALLOW`/`REJECT`), `evidence_hash`, and rule flags.
- **Immutable Audit Trail**:
  - Persists `auditId`, `proposalId`, `strategyId`, `evidenceHash`, `canonicalPayload`, `status`, `decision`, `reason`, `verifiedAt` without exposing credentials or keys.

### 3.7 Transaction Simulation Service (Binance Web3 / Preflight)
- **Hard Gate**: `PROPOSE → VERIFY → SIMULATE → EXECUTE`.
- Evaluates transaction viability via Binance Transaction Simulation API (`POST /api/v1/transaction/simulate`) or Agentic Wallet preflight before any signing request is triggered.
- Detects contract reverts, insufficient allowance, slippage breaches, and gas exhaustion.
- **A failed simulation terminates the execution flow immediately**.

### 3.8 Execution Authorization & Agentic Wallet Integration (`src/binance/`, `.agents/skills/`)
StockPilot clearly delineates responsibilities between programmatic API calls and Agentic Wallet skills:

| Capability | Module Handling | Rationale |
|---|---|---|
| **RWA Metadata & Market Status** | `binance-tokenized-securities-info` Skill & RWA Data API | Authoritative access to tokenized equity parameters, trading halt codes, and sessions. |
| **Telemetry & Drift Polling** | Binance Web3 REST API Client (`src/binance/`) | High-frequency programmatic background polling without human prompt friction. |
| **Spending Limits & Policy** | Binance Agentic Wallet (`baw`) Policy Manager | Enforces user-configured daily allowances and contract whitelists. |
| **RFQ Order Signing** | Binance Agentic Wallet (`baw sign-message`) | User or agent EIP-712 typed-data signing for zero-slippage RFQ execution. |
| **Settlement & Receipts** | Binance Trading API & BSC Mainnet | Cryptographic transaction receipt and status polling. |

### 3.9 BNB Agent Studio Integration
- StockPilot operates as an autonomous agent registered with **BNB Agent Studio**.
- Ingests scheduled cron triggers and portfolio alert events, driving the rebalancing loop autonomously rather than functioning solely as a passive web dashboard.

---

## 4. Architectural Summary

| Layer | Responsibility | Does NOT Do |
|---|---|---|
| **Strategy UI** | User plain-English strategy input, zero-mock telemetry, anime narrative | Fake prices or simulated execution |
| **StockPilot Engine** | Deterministic drift, spread intelligence, proposal construction | Claim consensus or execute without verification |
| **GenLayer Gate** | Independent cryptographic verification of proposal rules | Execute trades or hold private keys |
| **Binance Simulation** | Preflight on-chain revert and gas verification | Authorize execution on failed simulations |
| **Agentic Wallet** | Policy boundary enforcement, EIP-712 signing, spot execution | Decide whether a strategy is mathematically valid |
| **BSC Mainnet** | Final decentralized spot settlement of bNVDA and USDC | N/A |
