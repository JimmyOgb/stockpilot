# GenLayer steward remediation

## Finding

The submitted UI path stopped at local evidence inspection. It could display a locally valid payload as verified, bypassed the Intelligent Contract for `NONE`, accepted non-finalized results, defaulted missing checks to `true`, and the contract permissively accepted malformed LLM output. The server also accepted client-provided balances and prices as evidence.

## Corrected path

Live Binance balance telemetry (Binance/RPC reconciliation) and authenticated Binance RWA price/underlying-market telemetry feed the deterministic strategy engine. The application POST `/api/verification/inspect` accepts only a strategy and wallet address, reacquires those live inputs server-side, builds the canonical evidence packet, then invokes:

`RebalanceVerifier.verify_proposal(payload_json, submitted_evidence_hash)`

The adapter requires `finalized: true` and `consensus_status: FINALIZED`, matching `proposal_id`, a non-empty reason, the submitted/recomputed hash, and every required safety check. Only `ALLOW + VERIFIED` can be passed to `BinanceSimulationClient.simulatePreflight`; execution remains behind the existing simulation, Agentic Wallet policy, tiny-cap, explicit-approval, and live-execution gates.

## Canonical evidence and hash

`buildCanonicalEvidencePayload` in `src/verification/genlayer-adapter.ts` deterministically serializes strategy limits, token and contract identities, reconciled raw/formatted balances and statuses, token/reference prices, recomputed spread, market state, quote timestamp and recomputed age, portfolio values, allocation/drift, direction, trade amount, slippage, and proposal identity. `computeEvidenceHash` sorts keys and hashes the JSON with SHA-256 (`0x` + 64 lowercase hex characters).

The exact JSON payload and independently computed hash are sent to the contract. After the response, the server/adapter compares the locally recomputed hash with the contract `evidence_hash`; mismatch is `NOT_VERIFIED` and cannot reach simulation or execution.

## Evidence verification and fail-closed states

Balance evidence must be `VERIFIED` after the existing Binance + BSC reconciliation. Price/reference values must be positive and the spread is recomputed as `(tokenPrice - referencePrice) / referencePrice`; reported spread values are not authoritative. Market state must be the normalized `MARKET_OPEN` value. Freshness is recomputed from the quote timestamp and remains limited to 900 seconds. Drift, direction, trade amount, spread, market state, allocation, and circuit-breaker checks are mandatory.

`PENDING`, `NO_MAJORITY`, `REJECT`, malformed output, missing checks, hash/ID mismatch, timeout, RPC error, unavailable evidence, stale data, and ambiguous market state all produce `NOT_VERIFIED`, `ALLOW=false`, and block simulation and execution.

The contract validates the LLM response as exactly `{approved: boolean, risk_score: finite number, assessment: string}` and uses the existing custom comparator, never `strict_eq` for LLM output.

## Repository paths

- `contracts/rebalance_verifier.py` — consensus-backed write method and strict schema/evidence checks.
- `src/verification/genlayer-adapter.ts` — canonical payload, SHA-256, contract invocation, finalized response validation.
- `src/server/index.ts` — submitted application path connected to the adapter.
- `src/binance/simulation-client.ts` — simulation gate.
- `src/execution/agentic-execution-adapter.ts` — final wallet policy and approval gates.
- `tests/steward-remediation.integration.test.ts` — application workflow tests.

## Reproducible tests

```powershell
npm test
npm run build
genvm-lint check contracts/rebalance_verifier.py --json
```

The integration tests use deterministic doubles only at the external GenLayer/Binance boundary. They are not live consensus results. A live GenLayer smoke test requires configured RPC and deployed contract credentials; this repository change does not claim a successful live consensus or trade.

## Deployment configuration status

The current contract is pinned for StudioNet with `# v0.2.16` and
`py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6`. The
authoritative StudioNet deployment is:

- Contract: `RebalanceVerifier`
- Network: GenLayer StudioNet, chain ID `61999`
- Address: `0xC013CE8fb3697FF7a14DCd5D3a4fEb5d9dbc405C`
- Deployment transaction: `0xc4a6c4d024ecd5c556e6ac472e9509aadbcb1a8650fa52655b32533635871efe`
- Deployment status: `FINALIZED`, `MAJORITY_AGREE`, execution `SUCCESS`
- Verified schema: `verify_proposal(payload_json: string, submitted_evidence_hash: string) -> dict`

The public `GENLAYER_VERIFIER_CONTRACT` and `GENLAYER_RPC_URL` configuration
now point to this deployment. The application still requires Binance
credentials for live evidence and fails closed when they are unavailable.
The deployment result is not a verification consensus result and no trade is
claimed.

## Release record

- GitHub remediation commit: `6b97656` (`fix: connect app verification to GenLayer consensus`).
- Deployment-only Vercel commit: `02f2c6f` (`chore: exclude local artifacts from Vercel upload`).
- Vercel production deployment: `dpl_7ZFwEtf9BLLawchhp7GY6L93Bm9t`.
- Production aliases: `https://stockpilot-eight-sepia.vercel.app` and `https://stockpilot-jamism123.vercel.app`.
- Deployment status: Ready.
- Live verification status: GenLayer address is configured; live verification remains fail-closed until Binance credentials are available.
- Final hash-gated commit: `9eebec8` (`fix: enforce server verdict hash equality`).
- Final deployment: `dpl_4P8hCe47NaRX9tJ7bgcgWLfKC9ps` (Ready; aliases unchanged).
- Corrected StudioNet deployment: `0xc4a6c4d024ecd5c556e6ac472e9509aadbcb1a8650fa52655b32533635871efe` -> `0xC013CE8fb3697FF7a14DCd5D3a4fEb5d9dbc405C`.
- Current production configuration commit: `05dc1a26de2b5fd603737b313e4ae1cfaf5053b6` (`docs: record verified GenLayer production configuration`).
- Current Vercel production deployment: `dpl_8a6EtGYMxY26EpPdZr74MLX1Gjiq` (Ready), deployed URL `https://stockpilot-egt6b64nm-jamism123.vercel.app`, with the production aliases above.
- Production smoke checks: `/api/health` and `/api/market/telemetry` returned HTTP 200; invalid strategy and verification requests returned HTTP 400. Live verification remains blocked safely because the required Binance credentials are not configured.
