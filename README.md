# StockPilot

> **Autonomous Tokenized-Stock Portfolio Automation for BNB Chain**  
> Real market telemetry, deterministic risk engine, independent GenLayer verification, preflight simulation, Agentic Wallet policy boundaries, and explicit human authorization.

[![Live Demo](https://img.shields.io/badge/Live%20Demo-Vercel-black?style=for-the-badge&logo=vercel)](https://stockpilot-eight-sepia.vercel.app)
[![GitHub](https://img.shields.io/badge/GitHub-Repository-181717?style=for-the-badge&logo=github)](https://github.com/JimmyOgb/stockpilot)
[![BNB Chain](https://img.shields.io/badge/Network-BNB%20Chain%20%2356-F0B90B?style=for-the-badge&logo=binance)](https://bscscan.com)
[![Tests](https://img.shields.io/badge/Vitest-232%2F232%20Passing-brightgreen?style=for-the-badge&logo=vitest)](https://github.com/JimmyOgb/stockpilot)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

---

## Executive Summary

**StockPilot** is an autonomous tokenized-stock portfolio agent for **BNB Chain (BSC Mainnet)** that combines real Binance Web3 market and wallet infrastructure, deterministic portfolio strategy, independent GenLayer consensus verification, transaction simulation, Agentic Wallet policy controls, explicit human approval, and on-chain execution confirmation.

Most agentic DeFi projects connect an LLM directly to a private key or rely on synthetic market data. In volatile tokenized equity markets, unconstrained probabilistic models cause catastrophic misallocations. StockPilot decouples intelligence from execution through **seven strict fail-closed gates**: financial intent is parsed deterministically, verified by independent multi-validator consensus, simulated against live orderbooks, bounded by wallet policy, authorized by a human operator, and confirmed on-chain.

* **Live Production URL**: [https://stockpilot-eight-sepia.vercel.app](https://stockpilot-eight-sepia.vercel.app)
* **GitHub Repository**: [https://github.com/JimmyOgb/stockpilot](https://github.com/JimmyOgb/stockpilot)
* **Hackathon Track**: BNB Hack: Tokenized Stocks Edition

---

## The Problem

Automating tokenized US equities on BNB Chain introduces unique institutional challenges that generic DeFi trading bots cannot address:

1. **Market Hours & Oracle Staleness**: US equities trade during market hours, while crypto markets run 24/7. When stock markets close, on-chain tokenized equities (such as bStocks or Ondo) trade with wider spreads. If oracle feeds go stale, naive rebalancing algorithms execute into unrepresentative prices.
2. **LLM Hallucination Risk**: Giving an AI prompt direct trading authority or unconstrained signing keys risks unhedged rebalancing, prompt injection, and catastrophic capital loss.
3. **Execution Blindness**: Autonomous agents frequently submit transactions without preflight gas telemetry, KYC/KYT checks, or transaction revert simulations.
4. **Synthetic Data Prevalence**: Many hackathon prototypes inject fake mock balances and synthetic quotes, masking real-world execution failure modes.

---

## The Solution

StockPilot enforces a **Zero-Mock, Fail-Closed Pipeline** where every proposed rebalance traverses a sequential verification chain:

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                           STOCKPILOT EXECUTION FLOW                            │
└────────────────────────────────────────────────────────────────────────────────┘

  [ 01 REAL BINANCE DATA ]
         │  Live RWA registry search, token & reference prices, BSC RPC telemetry
         ▼
  [ 02 DETERMINISTIC STRATEGY ]
         │  Mathematical drift: |Current Stock % - Target Stock %| vs Threshold
         ▼
  [ 03 GENLAYER VERIFICATION ]
         │  Independent Intelligent Contract consensus; 7 invariant checks
         ▼
  [ 04 BINANCE PREFLIGHT SIMULATION ]
         │  Pre-transaction revert checks, gas telemetry, simulation audit hash
         ▼
  [ 05 AGENTIC WALLET POLICY ]
         │  Daily quota limits, token allowlist, tx-lock, $25 Tiny Live Cap
         ▼
  [ 06 EXPLICIT USER APPROVAL ]
         │  Interactive human-in-the-loop authorization boundary
         ▼
  [ 07 BSC SPOT EXECUTION ]
         │  Strict spot swap on BSC Mainnet (zero derivatives, perps, or margin)
         ▼
  [ 08 ORDER STATUS & ON-CHAIN RECEIPT ]
         │  JSON-RPC eth_getTransactionReceipt polling to terminal confirmation
         ▼
  [ 09 IMMUTABLE AUDIT RECORD ]
            Cryptographic SHA-256 evidence trail and idempotency tracking
```

---

## Why StockPilot Is Different

StockPilot maintains a strict separation of architectural responsibilities:

| Subsystem | Architectural Role | What It Does NOT Do |
| :--- | :--- | :--- |
| **Binance Web3** | Market data, RWA registry, quote freshness, preflight simulation, Agentic Wallet infrastructure | Does not determine strategy allocations or override safety gates |
| **Deterministic Engine** | Strategy math, drift calculation, circuit breakers, allocation sizing | Does not execute trades or hold signing keys |
| **GenLayer** | Independent multi-validator consensus verification (`contracts/rebalance_verifier.py`) | **Does NOT sign transactions, hold user funds, execute trades, or act as the wallet** |
| **Agentic Wallet** | Policy boundary, daily quota, token allowlist, transaction execution guard | Does not execute without explicit human approval |
| **BNB Chain (BSC)** | Final on-chain settlement and receipt confirmation | Does not accept unverified or simulated transactions |

---

## Core MVP Strategy

The production MVP strategy enforces a deterministic core rebalancing mandate on BSC Mainnet:

* **Target Equity Allocation**: **60.0% NVDAB** (6,000 bps)
* **Target Stablecoin Allocation**: **40.0% USDC** (4,000 bps)
* **Drift Threshold**: **5.0%** (500 bps). No action is taken if $|\text{Actual Weight} - \text{Target Weight}| < 500\text{ bps}$.
* **Strategy Circuit Breaker**: **$5,000 USD** maximum single-trade cap.
* **Tiny Live Safety Cap**: **$25.00 USD** maximum for early live tests.
* **Execution Boundary**: **Strictly Spot Only** on BSC Mainnet. Perpetuals, margin, and leverage are rejected at the type level.
* **Fail-Closed Portfolio Data**: When verified on-chain balances are zero or unavailable, StockPilot fails closed to `INSUFFICIENT_PORTFOLIO_DATA`. It never invents a synthetic 60/40 allocation.

---

## Real Binance Web3 Integrations

StockPilot integrates directly with official Binance Web3 infrastructure documented in [`docs/hackathon-build/binance-integration-spec.md`](docs/hackathon-build/binance-integration-spec.md):

### 1. Verified RWA Contract Resolution
StockPilot queries the live Binance Web3 RWA registry dynamically by underlying ticker (`NVDA`). It discovers verified contract addresses, filters by chain ID `56` (BSC Mainnet), and strictly rejects invalidated stale contracts:
* **Verified Primary Token**: **NVDAB (bStocks)** — [`0x02fca66c1d1afb4e2a7884261eb00f63598a7436`](https://bscscan.com/token/0x02fca66c1d1afb4e2a7884261eb00f63598a7436) (18 decimals)
* **Verified Secondary Token**: **NVDAon (Ondo)** — [`0xa9ee28c80f960b889dfbd1902055218cba016f75`](https://bscscan.com/token/0xa9ee28c80f960b889dfbd1902055218cba016f75)
* **Verified Counter-Asset**: **Binance-Peg USDC** — [`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`](https://bscscan.com/token/0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d) (18 decimals)
* **Rejected Invalid Spec Address**: `0xA34C5e0AbE843E10461E2C9586Ea03E55Dbcc495` (*invalidated by live Binance registry*).

### 2. Live Pricing & Market Session Bounds
* **Session State Detection**: Real-time evaluation into `MARKET_OPEN`, `MARKET_CLOSED`, or `REFERENCE_STALE`.
* **Slippage Bounds**: Enforces a 50 bps (0.5%) maximum slippage policy during open market hours, tightening to 25 bps (0.25%) when the stock market is closed.
* **Spread Risk Guard**: Validates on-chain token price against underlying reference equity price. Fails closed with `RISK_BLOCKED` if spread exceeds 200 bps (2.0%).

### 3. Preflight Transaction Simulation (`BinanceSimulationClient`)
Before any order reaches the execution adapter, StockPilot dispatches a simulation request to `POST /build/api/v1/dex/pre-transaction/simulate` and queries gas telemetry from `GET /build/api/v1/dex/pre-transaction/gas-price`. The transaction is evaluated for gas adequacy, KYT compliance, and on-chain revert risks, producing a cryptographic simulation audit hash.

### 4. Binance Agentic Wallet Integration (`AgenticExecutionAdapter`)
Interfaces with the official Binance Agentic Wallet (`baw`) CLI:
* Queries wallet connection state (`baw wallet status`)
* Verifies transaction lock status (`baw wallet tx-lock`)
* Inspects daily spending limits and quotas (`baw wallet settings`)
* Enforces token allowlists and evaluates risky token approvals (`baw approvals list`)

---

## Independent GenLayer Verification

To eliminate single-agent failure modes, every rebalance proposal must pass independent consensus verification executed by GenLayer Intelligent Contracts:

1. **Canonical Evidence Payload (`CanonicalEvidencePayload`)**: Strategy weights, current balances, reference quotes, market session, trade deltas, and risk limits are formatted into a deterministic schema with alphabetically sorted keys.
2. **Cryptographic Evidence Identity**: A deterministic SHA-256 digest is generated (`0x...`). Any mutation in inputs invalidates downstream gates.
3. **Independent Intelligent Contract**: [`contracts/rebalance_verifier.py`](contracts/rebalance_verifier.py) runs on GenLayer validator nodes, evaluating seven strict invariants:
   - `payload_valid`: Schema matches v1.0.0.
   - `math_consistent`: Target weights sum to 10,000 bps; proposed trade matches portfolio delta.
   - `direction_consistent`: Buy when underweight stock; Sell when overweight stock.
   - `spread_permitted`: Token vs reference spread $\le$ 200 bps.
   - `circuit_breaker_passed`: Proposed trade amount $\le$ $5,000 USD.
   - `market_state_permitted`: Slippage tightened during closed sessions; blocked when reference quote is stale.
   - `non_zero_portfolio`: Fails closed immediately if balances are zero.
4. **Custom Comparator**: Verification parser uses defensive fuzzy equivalence rather than `strict_eq` on LLM outputs, preventing consensus fragility.
5. **Honest Deployment State**: In test environments where validator consensus returned `NO_MAJORITY`, StockPilot's fail-closed boundary correctly blocked downstream execution rather than fabricating an artificial approval.

---

## Execution Safety & Seven Execution States

StockPilot enforces fourteen pre-execution validation gates and tracks seven explicit lifecycle states:

```
                        [ Proposed Rebalance ]
                                  │
                       All Gates Pass & Verified?
                                 ╱ ╲
                               NO   YES
                              ╱       ╲
                             ▼         ▼
                    EXECUTION_BLOCKED  APPROVAL_REQUIRED
                                            │
                                  User Grants Approval?
                                           ╱ ╲
                                         NO   YES
                                        ╱       ╲
                                       ▼         ▼
                    EXECUTION_BLOCKED  EXECUTION_SUBMITTED
                                            │
                                            ▼
                                   EXECUTION_PENDING
                                            │
                                  BSC On-Chain Receipt
                                           ╱ ╲
                                      FAIL    SUCCESS
                                      ╱         ╲
                                     ▼           ▼
                             EXECUTION_FAILED  EXECUTION_CONFIRMED
                                     │
                             Network Ambiguity?
                                     │
                                     ▼
                             EXECUTION_UNKNOWN
```

### Seven Explicit Execution States
1. `EXECUTION_BLOCKED`: Failed one or more preflight gates (stale quote, spread breach, unverified proposal, simulation failure, insufficient live balance).
2. `APPROVAL_REQUIRED`: Fully verified proposal awaiting explicit human authorization.
3. `EXECUTION_SUBMITTED`: Dispatched to Binance Agentic Wallet.
4. `EXECUTION_PENDING`: Transaction submitted to BSC Mainnet; awaiting block inclusion.
5. `EXECUTION_CONFIRMED`: Verified on-chain transaction receipt (`status: '0x1'`) retrieved from BSC JSON-RPC node.
6. `EXECUTION_FAILED`: Terminal transaction failure or on-chain revert (`status: '0x0'`).
7. `EXECUTION_UNKNOWN`: **Ambiguous network timeout or lost response. In strict adherence to fail-closed principles, ambiguous responses are NEVER converted to success.**

---

## Zero-Mock Policy

StockPilot enforces a **Zero-Mock Policy**:

* **Zero Fake Balances**: We never render synthetic account balances.
* **Zero Fake Prices**: If external Binance API credentials are unconfigured, pricing displays `UNAVAILABLE`.
* **Zero Fabricated Transactions**: Trades are never simulated as live successes.
* **Zero Private Key Storage**: StockPilot never stores private keys in application source code.
* **Real-World Limitation**: In the integration smoke test, the live wallet had 0 NVDAB and 0 USDC. StockPilot correctly halted with `EXECUTION_BLOCKED_INSUFFICIENT_LIVE_BALANCE`. This proves the fail-closed safety boundary functions as designed.

---

## Cinematic Landing & Institutional Command Center

The frontend provides a dual-layer experience:

1. **Scroll-Tied Cinematic Hero**:
   - WebCodecs and MP4Box-driven decoded canvas rendering (1920×1080) with smooth HTML5 fallback.
   - Frame-bank LRU cache (24 frames) with exponential lerp scroll scrubbing ($\tau = 8$).
   - 500vh sticky viewport with three sequential scenes:
     - **Scene 1**: Stacked dark navy editorial typography (`AUTONOMOUS INTELLIGENCE FOR TOKENIZED MARKETS`) with circular scroll cue.
     - **Scene 2**: Progressive scroll reveal of strategy principles and four-step informational sequence.
     - **Scene 3**: High-contrast white typography and `LAUNCH STOCKPILOT` action button.
   - Respects `prefers-reduced-motion` with direct seeking fallbacks.

2. **Institutional Command Center Dashboard**:
   - Prominent **Execution Pipeline Architecture** visualization (all 7 gates).
   - Real-time Global Ticker bar with BSC Mainnet Chain #56 status, market session, and quote age.
   - **Portfolio Console**: Verified token contract metadata, BSCScan links, and real balance tracking.
   - **Strategy Parser**: Deterministic natural language intent parser (`POST /api/strategy/parse`) and drift engine.
   - **Market Telemetry**: bStocks vs Ondo token registry comparison and spread monitoring.
   - **Verification Inspector**: Canonical evidence payload JSON viewer and 7 invariant checks.
   - **Execution Console**: Agentic Wallet controls, $25.00 Tiny Live Cap indicator, and interactive **User Approval Boundary** with `[AUTHORIZE REBALANCE]` and `[REJECT / HALT]` actions.

---

## Repository Architecture

```
StockPilot/
├── api/                                # Vercel serverless function entrypoints
│   └── index.ts                        # Serverless handler exporting Express app
├── contracts/                          # GenLayer Intelligent Contracts
│   └── rebalance_verifier.py           # Multi-validator consensus verification contract
├── docs/
│   └── hackathon-build/                # Canonical hackathon documentation
│       ├── architecture.md             # Complete system architecture specification
│       ├── binance-integration-spec.md # Binance Web3 API & Agentic Wallet spec
│       ├── build-notes.md              # Milestones, token addresses, and API findings
│       ├── devex-log.md                # Official Developer Experience Log (Entries #001-#010)
│       ├── mvp-acceptance-checklist.md # Zero-mock audit sign-off & acceptance criteria
│       └── scope.md                    # MVP boundaries & security constraints
├── public/                             # Static assets
├── scripts/                            # Read-only integration smoke tests
│   ├── smoke-test-market-data.ts       # Binance market telemetry smoke test
│   ├── smoke-test-readonly-integration.ts # Full read-only pipeline smoke test
│   └── smoke-test-simulation.ts        # Binance transaction preflight simulation test
├── src/
│   ├── agent/                          # Agent orchestration layer
│   │   └── orchestrator.ts             # Pipeline coordinator
│   ├── binance/                        # Binance Web3 integration clients
│   │   ├── asset-resolver.ts           # Dynamic RWA token contract resolver
│   │   ├── client.ts                   # Binance Web3 API client interface
│   │   ├── market-data-client.ts       # Quotes, tickers, and 24hr stats
│   │   ├── request-signer.ts           # HMAC-SHA256 authenticated request signer
│   │   ├── rwa-client.ts               # Binance RWA search, metadata, and market state
│   │   ├── simulation-client.ts        # Pre-transaction simulation & gas telemetry
│   │   └── wallet-balance-client.ts    # BSC RPC verified token balances
│   ├── components/                     # Frontend UI components
│   │   ├── CinematicHero.tsx           # 500vh scroll-tied WebCodecs cinematic hero
│   │   ├── CommandCenter.tsx           # Institutional Command Center dashboard
│   │   ├── MobileMenu.tsx              # Fullscreen editorial navigation drawer
│   │   ├── Navbar.tsx                  # Sticky editorial navigation bar with adaptive palette
│   │   └── StatusModal.tsx             # System telemetry & gate inspection modal
│   ├── execution/                      # Binance Agentic Wallet execution adapter
│   │   ├── adapter.ts                  # Execution adapter interface
│   │   ├── agentic-execution-adapter.ts # 14-gate live execution adapter with user approval
│   │   └── binance-agentic-wallet-client.ts # Agentic Wallet CLI client
│   ├── hooks/                          # Custom React hooks
│   │   └── useVideoScrub.ts            # High-performance WebCodecs video scrubbing hook
│   ├── server/                         # Express API server
│   │   └── index.ts                    # Backend API endpoints & static serving
│   ├── storage/                        # Audit log storage
│   │   └── audit-log.ts                # Immutable audit log store
│   ├── strategy/                       # Deterministic strategy & risk engines
│   │   ├── portfolio-engine.ts         # Portfolio allocation & delta calculations
│   │   └── risk-engine.ts              # Drift math & deterministic rules
│   ├── types/                          # Core TypeScript domain types
│   │   ├── index.ts                    # Complete domain data models
│   │   └── video.ts                    # Video scrubbing & frame bank types
│   └── verification/                   # GenLayer independent verification adapter
│       ├── adapter.ts                  # Verification adapter interface
│       └── genlayer-adapter.ts         # Canonical payload builder & consensus parser
├── tests/                              # Comprehensive unit & integration tests
│   ├── agentic-execution-adapter.test.ts # 30 tests: execution gates, dry run, approval
│   ├── binance-agentic-wallet-client.test.ts # 11 tests: Agentic Wallet CLI commands
│   ├── binance-asset-resolver.test.ts  # 12 tests: dynamic RWA registry discovery
│   ├── binance-market-data-client.test.ts # 13 tests: market data & credential hygiene
│   ├── binance-request-signer.test.ts  # 19 tests: HMAC-SHA256 signature verification
│   ├── binance-rwa-client.test.ts      # 26 tests: RWA registry, quotes, market status
│   ├── binance-simulation-client.test.ts # 25 tests: pre-transaction simulation gates
│   ├── binance-wallet-balance-client.test.ts # 20 tests: BSC RPC balance verification
│   ├── frontend-cinematic.test.ts      # 8 tests: opacity formulas, LRU constants, palette
│   ├── portfolio-engine.test.ts        # 22 tests: drift math, delta sizing, circuit breakers
│   └── strategy.test.ts                # 14 tests: deterministic risk engine
├── index.html                          # Single-page application entrypoint
├── package.json                        # Scripts & dependencies
├── tailwind.config.js                  # Tailwind styling configuration
├── tsconfig.json                       # TypeScript compiler configuration
├── vercel.json                         # Vercel production deployment configuration
└── vite.config.ts                      # Vite build configuration
```

---

## Test Verification & Quality Gates

StockPilot passes all test suites and compiler verification gates:

```
Test Files  12 passed (12)
     Tests  219 passed (219)
  Start at  11:08:53
  Duration  7.54s
```

* **Deterministic Strategy & Drift Engine**: 36 tests ([`tests/portfolio-engine.test.ts`](tests/portfolio-engine.test.ts), [`tests/strategy.test.ts`](tests/strategy.test.ts))
* **GenLayer Independent Verification**: 19 tests ([`tests/genlayer-adapter.test.ts`](tests/genlayer-adapter.test.ts))
* **Binance Simulation Client**: 25 tests ([`tests/binance-simulation-client.test.ts`](tests/binance-simulation-client.test.ts))
* **Binance Market Data, RWA & Wallet Clients**: 90 tests ([`tests/binance-rwa-client.test.ts`](tests/binance-rwa-client.test.ts), [`tests/binance-asset-resolver.test.ts`](tests/binance-asset-resolver.test.ts), etc.)
* **Binance Agentic Wallet & Execution Adapter**: 41 tests ([`tests/agentic-execution-adapter.test.ts`](tests/agentic-execution-adapter.test.ts), [`tests/binance-agentic-wallet-client.test.ts`](tests/binance-agentic-wallet-client.test.ts))
* **Cinematic Frontend Opacities & Scrubbing Constants**: 8 tests ([`tests/frontend-cinematic.test.ts`](tests/frontend-cinematic.test.ts))
* **TypeScript Clean**: `npx tsc --noEmit` exits with code 0 across the entire repository.
* **Production Build Clean**: `npm run build:all` (`tsc && vite build`) compiles with code 0.

---

## Local Setup & Development

### Prerequisites
* **Node.js**: v20.x or v22.x+ (tested on Node v24.15)
* **npm**: v10.x+
* **Git**

### Installation
```bash
# 1. Clone repository
git clone https://github.com/JimmyOgb/stockpilot.git
cd stockpilot

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your BSC RPC and optional Binance Web3 credentials
```

### Running the Application
```bash
# Start frontend dev server with hot reload
npm run dev:ui

# Start backend Express server with TypeScript watch
npm run dev

# Run complete test suite (219 tests)
npm test

# Run full production build
npm run build:all

# Run read-only integration smoke test against BSC Mainnet
npm run test:smoke
```

---

## Environment Variables

All variables are strictly categorized. **Never commit actual secret values to version control.**

| Variable Name | Scope | Sensitivity | Description |
| :--- | :--- | :--- | :--- |
| `PORT` | Server | Public | Port for standalone Express server (default `3000`) |
| `NODE_ENV` | Server / Build | Public | Node environment (`development` / `production`) |
| `BSC_RPC_URL` | Server / Telemetry | Public | BSC Mainnet JSON-RPC endpoint (e.g. `https://bsc-dataseed.binance.org/`) |
| `BSC_CHAIN_ID` | Server / Telemetry | Public | BSC Chain ID (default `56`) |
| `TOKENIZED_STOCK_SYMBOL` | Strategy | Public | Tokenized equity symbol (`NVDAB`) |
| `TOKENIZED_STOCK_ADDRESS` | Strategy | Public | Verified token contract address (`0x02fca66c1d1afb4e2a7884261eb00f63598a7436`) |
| `STABLECOIN_SYMBOL` | Strategy | Public | Counter-asset symbol (`USDC`) |
| `STABLECOIN_ADDRESS` | Strategy | Public | Verified USDC contract address (`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`) |
| `MAX_STALENESS_SECONDS` | Risk Engine | Public | Max age of quote before `REFERENCE_STALE` halt (default `900`) |
| `MAX_SLIPPAGE_BPS` | Risk Engine | Public | Open session slippage tolerance in basis points (default `50`) |
| `MAX_SLIPPAGE_CLOSED_BPS` | Risk Engine | Public | Closed session slippage tolerance in basis points (default `25`) |
| `MAX_SINGLE_REBALANCE_USD` | Circuit Breaker | Public | Maximum single-trade dollar cap (default `5000`) |
| `BINANCE_WEB3_API_KEY` | Server | **Secret** | Binance Web3 API Key for live RWA queries |
| `BINANCE_WEB3_API_SECRET` | Server | **Secret** | Binance Web3 HMAC-SHA256 API Secret |
| `EXECUTOR_WALLET_ADDRESS` | Server | **Restricted** | Wallet address for Agentic Wallet interaction |
| `GENLAYER_RPC_URL` | Verifier | Public | GenLayer validator RPC endpoint (`https://rpc.genlayer.com`) |
| `GENLAYER_VERIFIER_CONTRACT` | Verifier | Public | GenLayer intelligent contract address (`0x4858...`) |

---

## BNB Hackathon Alignment

StockPilot directly addresses the core themes of the **BNB Hack: Tokenized Stocks Edition**:

1. **Tokenized Stocks on BNB Chain**: Integrates live tokenized NVIDIA equities on BSC Mainnet (`NVDAB` from bStocks and `NVDAon` from Ondo).
2. **Binance Web3 Infrastructure**: Implements dynamic RWA token registry resolution, market quote validation, preflight transaction simulation, and Agentic Wallet CLI integration.
3. **Real Execution Boundaries**: Enforces strict spot-only swap semantics on BSC Mainnet, rejects perpetuals/margin, and applies a $25.00 Tiny Live Cap with on-chain receipt confirmation.
4. **Developer Experience (DevEx)**: Ten detailed technical entries documented in [`docs/hackathon-build/devex-log.md`](docs/hackathon-build/devex-log.md), auditing endpoint schemas, signature headers, and fail-closed edge cases.
5. **Production Product UX**: A high-end institutional terminal combining WebCodecs scroll-tied background storytelling with real-data command center controls.

---

## Developer Experience Highlights

The complete integration journey is preserved in [`docs/hackathon-build/devex-log.md`](docs/hackathon-build/devex-log.md). Key findings include:

* **Entry #001**: API signature headers require exact casing: `X-OC-APIKEY`, `X-OC-TIMESTAMP`, `X-OC-SIGN`, `X-OC-RECV-WINDOW`.
* **Entry #002**: Identified live contract address discrepancy: `NVDAB` (`0x02fc...7436`) is active on BSC Mainnet, while initial hackathon spec address `0xA34C...495` was invalidated by the live registry.
* **Entry #004**: BSC USDC uses 18 decimals (`0x8AC7...580d`), differing from Ethereum's 6 decimals.
* **Entry #006**: Pinned GenLayer intelligent contract runner hash and avoided `strict_eq` comparisons on LLM verification consensus.
* **Entry #008**: Pre-transaction simulation endpoint `POST /build/api/v1/dex/pre-transaction/simulate` requires signed payloads matching live execution paths.

---

## Demo Walkthrough for Judges

1. **Open Production Terminal**: Navigate to [https://stockpilot-eight-sepia.vercel.app](https://stockpilot-eight-sepia.vercel.app).
2. **Cinematic Hero**: Scroll through the opening WebCodecs video viewport. Observe dark navy editorial typography, sequential scene transitions, and circular scroll cues.
3. **Launch Terminal**: Click `LAUNCH STOCKPILOT` in Scene 3 to scroll directly into the Command Center.
4. **Inspect Telemetry**: Click `STATUS` in the navigation bar to inspect operational health, market session state, quote age, and component readiness.
5. **Examine Portfolio Gate**: Navigate to `01 PORTFOLIO`. Observe verified contract addresses (`0x02fc...7436` and `0x8AC7...580d`). Note that with a zero-balance wallet, StockPilot fails closed to `INSUFFICIENT LIVE DATA` rather than inventing synthetic assets.
6. **Parse Intent**: Under `02 STRATEGY`, test the natural language intent parser with `"Keep 60% tokenized NVIDIA (NVDAB) and 40% USDC with 5% drift"`. Click `PARSE INTENT` to observe structured basis points.
7. **Evaluate Drift**: Click `RUN DETERMINISTIC DRIFT MATH`. Toggle between Live Zero-Balance mode and Sample Portfolio mode to observe mathematical drift calculations and delta trade sizing.
8. **Inspect GenLayer Verification**: Open `04 VERIFICATION` to review the canonical evidence schema, cryptographic SHA-256 evidence hash, and seven independent invariant checks.
9. **Observe Human Approval Boundary**: Under `05 EXECUTION`, review the structured `UserApprovalRequest`. Click `[AUTHORIZE REBALANCE]` to simulate authorized dry-run execution, or `[REJECT / HALT]` to observe fail-closed termination.
10. **Confirm Execution Safety**: Note the active $25.00 Tiny Live Cap and strict spot-only constraint protecting user capital.

---

## Security Invariants

* **Zero Private Key Exposure**: StockPilot does not store or process private keys in client code or frontend bundles. Signing is delegated to the official Binance Agentic Wallet.
* **Fail-Closed by Design**: Any unexpected error, stale quote ($> 900\text{s}$), spread breach ($> 200\text{ bps}$), verification dispute, or simulation failure unconditionally halts execution.
* **Replay Protection**: Every proposed trade generates a unique SHA-256 idempotency key, preventing duplicate transactions.
* **Zero-Address Rejection**: Any input referencing the zero address (`0x000...000`) is rejected at initialization.
* **Secret-Safe Logging**: All error handlers and client wrappers sanitize sensitive query strings and credentials before writing to audit logs.

---

## License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.
