# StockPilot — Technical Build Notes

> **BNB Hack: Tokenized Stocks Edition**  
> Technical decisions, environment requirements, and implementation guidelines.

---

## 1. Runtime Environment & Tooling

- **Runtime**: Node.js v24+ (verified on host environment)
- **Language**: TypeScript 5.x (strict mode enabled)
- **Package Manager**: `npm`
- **Testing Framework**: Vitest or Node Test Runner with TypeScript support
- **HTTP Server**: Express / Native HTTP module with JSON REST endpoints
- **Version Control**: Git

---

## 2. Tokenized Stock Identification on BSC Mainnet

StockPilot focuses on top tokenized stock assets on BSC. Target candidates:
1. **bStocks** (e.g. bNVDA, bAAPL, bTSLA on BNB Smart Chain)
2. **Ondo Finance** (e.g. USDY / short-term US Treasury / institutional tokens bridged or issued on BSC)
3. **xStocks** (Tokenized equity instruments compliant with BSC standards)
4. **Stablecoin counter-asset**: **USDC** on BSC (`0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` or native standard).

---

## 3. Deterministic Risk Calculations

All rebalancing math must be deterministic and verifiable without floating-point inaccuracies:
- Token amounts represented using high-precision integer arithmetic (basis points for percentages: `100% = 10,000 bps`, `5% = 500 bps`).
- Prices represented in fixed decimal format (USD price scaled to 6 or 18 decimals).
- Drift calculation:
  $$\text{Current Stock Weight (bps)} = \frac{\text{Value}_{\text{Stock}}}{\text{Value}_{\text{Total}}} \times 10,000$$
  $$\text{Drift (bps)} = |\text{Current Stock Weight} - \text{Target Stock Weight}|$$
- If $\text{Drift} \ge \text{Drift Threshold (bps)}$, trigger rebalance generation.

---

## 4. Market State Determination Engine

Reference market hours for US equities (NYSE/NASDAQ):
- Regular Trading Hours: Monday – Friday 09:30 – 16:00 US Eastern Time (excluding US holidays).
- State evaluation logic:
  1. Check timestamp of last reference price update:
     - If $(\text{currentTime} - \text{lastUpdate}) > \text{MAX\_STALENESS\_SECONDS}$ (e.g. 900s / 15m), state = `REFERENCE_STALE`.
  2. If data is fresh:
     - If current UTC time corresponds to US market open hours, state = `MARKET_OPEN`.
     - Else, state = `MARKET_CLOSED`.

---

## 5. Fail-Closed Error Hierarchy

| Failure Condition | Action Taken | Audit Log Status | UI Display |
|---|---|---|---|
| Price quote unavailable or timed out | Reject rebalance | `FAILED_QUOTE_FETCH` | Red banner: "Market quote unavailable. Execution paused." |
| Price quote stale (> max allowed age) | Reject rebalance | `REFERENCE_STALE` | Amber banner: "Market data stale. Trading halted." |
| Wallet balance read error | Reject rebalance | `FAILED_BALANCE_READ` | Red banner: "Wallet balance sync failed." |
| Verification rejected by GenLayer | Abort execution | `VERIFICATION_REJECTED` | Red badge: "Verification gate rejected proposed action." |
| Slippage exceeds safety tolerance | Abort swap | `SLIPPAGE_EXCEEDED` | Warning: "Excessive slippage detected. Swap blocked." |
| Insufficient BNB for BSC gas | Abort swap | `INSUFFICIENT_GAS` | Warning: "Insufficient BNB for network transaction fee." |

---

## 6. Binance Web3 Integration Strategy

To fulfill hackathon requirements meaningfully:
1. **Balance & Asset Ingestion**: Poll BSC tokenized stock holdings and stablecoin balances via Binance Web3 API / RPC provider.
2. **Quote & Swap Routing**: Query Binance Web3 swap / DEX aggregator API for spot routing on BSC.
3. **Transaction Dispatch**: Prepare and sign spot swaps via Binance Web3 Wallet / Agentic Wallet signing interfaces.
4. **DevEx Documentation**: Every integration step logged continuously in `docs/hackathon-build/devex-log.md`.
