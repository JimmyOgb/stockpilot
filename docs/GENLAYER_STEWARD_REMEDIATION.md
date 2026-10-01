# GenLayer Steward Remediation & Real Consensus Verification

## Steward Issues Addressed

The steward raised two critical issues regarding GenLayer verification:
1. **Real Consensus-Backed Write:** The previous application called `verify_proposal` through `gen_call` and treated self-reported finality fields returned by the contract itself as proof of finalization.
2. **Contract-Level Payload Hashing:** The previous contract validated only the submitted hash's hex format and echoed it without independently calculating `SHA-256(payload_json)`.

Both issues have been remediated in full.

---

## 1. Real Consensus-Backed Write Flow

- **Authoritative Write Flow:** The production verification path no longer treats `gen_call` / `simulateWriteContract` execution as proof of finalization. `simulateProposal` is restricted exclusively to simulation / dry-run inspection and explicitly outputs `decision: 'NOT_VERIFIED'`.
- **Protocol Transaction Submission:** `submitVerificationProposal` invokes `client.writeContract({ address, functionName: 'verify_proposal', args: [canonicalJson, evidenceHash] })`, obtaining an authoritative GenLayer transaction ID (`0x...`).
- **Independent Protocol Transaction Query:** The adapter polls `client.getTransaction({ hash: txId })` until reaching protocol finality or timeout.
- **Protocol Lifecycle Enforcement (Rule A–J):**
  - **Rule A:** Real protocol transaction ID must exist.
  - **Rule B:** Transaction status must be protocol `FINALIZED` (status code `7` or `statusName: 'FINALIZED'`) and achieve consensus `MAJORITY_AGREE` (result code `6`). `PENDING`, `ACCEPTED`, `NO_MAJORITY`, or non-final states are rejected fail-closed.
  - **Rule C:** Protocol transaction execution result must be `SUCCESS` (or `FINISHED_WITH_RETURN`). Failed execution rejects with `CONSENSUS_FINALIZED_EXECUTION_FAILED`.
  - **Rule D:** Finalized transaction recipient (`to_address` / `recipient`) must strictly match the configured `GENLAYER_VERIFIER_CONTRACT`.
  - **Rule E:** Finalized transaction calldata must target `verify_proposal`.
  - **Rule F:** Calldata payload must match the proposal under verification.
  - **Rule G & H:** Contract independently computes `SHA-256(payload_json)` and the computed hash must match the expected canonical hash.
  - **Rule I:** Returned verification decision must be `ALLOW`.
  - **Rule J:** All 16 fine-grained safety and risk checks must evaluate to `true`.
- **Self-Reported Finality Rejected:** All logic trusting contract-returned `finalized: true` or `consensus_status: FINALIZED` has been removed. Contract return values represent execution output; only the GenLayer protocol transaction status/receipt constitutes authoritative consensus evidence.

---

## 2. Independent Contract-Level Payload Hashing

In [`contracts/rebalance_verifier.py`](file:///C:/Users/NO%20GO%20NO/StockPilot/contracts/rebalance_verifier.py):
- The contract imports `hashlib` and computes `contract_computed_hash = "0x" + hashlib.sha256(payload_json.encode('utf-8')).hexdigest().lower()`.
- It validates the format of `submitted_evidence_hash` (must be `0x` followed by 64 hex characters).
- It strictly enforces `contract_computed_hash == submitted_evidence_hash.lower()`.
- If the hashes differ:
  - Fails closed immediately (`ALLOW = False`, `checks['payload_valid'] = False`).
  - Sets `evidence_hash = ""` (refuses to echo or store an unverified hash).
  - Returns descriptive rejection reason.
  - Does NOT store the proposal as verified.

---

## 3. Identical Deterministic Canonicalization

Canonical JSON serialization is deterministic and identical across:
1. **TypeScript Server & Adapter:** [`canonicalizeJson()`](file:///C:/Users/NO%20GO%20NO/StockPilot/src/verification/genlayer-adapter.ts) recursively sorts object keys and formats with `JSON.stringify` without whitespace.
2. **Intelligent Contract:** `contracts/rebalance_verifier.py` verifies the exact canonical UTF-8 JSON.
3. **Tests:** [`tests/steward-remediation.integration.test.ts`](file:///C:/Users/NO%20GO%20NO/StockPilot/tests/steward-remediation.integration.test.ts) proves identical hashes across key insertion permutations and verifies that tampering with any field alters the SHA-256 hash.

---

## 4. Evidence Binding

All critical portfolio and risk evidence fields are bound into the canonical payload:
- Reconciled wallet/balance evidence (amounts, decimals, verification status).
- Token price, reference price, and computed spread.
- Market state (`MARKET_OPEN`).
- Quote timestamp and freshness age.
- Current vs target allocation and drift.
- Proposed action, assets, trade amount in USD, and token amount.
- Risk limits (max spread, single-trade limit, circuit breakers).

---

## 5. Distinct Verification Inspect Statuses

The `/api/verification/inspect` endpoint returns one of 10 explicit inspect statuses:
1. `SUBMISSION_FAILED` — Missing transaction ID or RPC submission failure.
2. `CONSENSUS_PENDING` — Transaction submitted but awaiting validator consensus.
3. `CONSENSUS_ACCEPTED_NOT_FINAL` — Transaction accepted into mempool/block but not yet consensus finalized.
4. `CONSENSUS_FINALIZED` — Consensus reached, but contract rejected the proposal (e.g. risk check failed).
5. `CONSENSUS_FINALIZED_EXECUTION_FAILED` — Consensus reached but contract execution threw an error or targeted wrong recipient/method.
6. `NO_MAJORITY` — Validators failed to reach majority consensus.
7. `PAYLOAD_HASH_MISMATCH` — Contract-computed hash did not match submitted evidence hash, or calldata did not match proposal.
8. `EVIDENCE_INVALID` — Evidence failed pre-verification gates (e.g. stale quote, zero portfolio, balance mismatch).
9. `VERIFIED` — All protocol rules A–J passed; consensus finalized with `ALLOW` and all 16 checks passed.
10. `UNAVAILABLE` — Binance live telemetry or market data is unavailable (fail-closed before writing).

---

## 6. Deployed Contract on StudioNet

- **Contract Name:** `RebalanceVerifier`
- **Network:** GenLayer StudioNet (Chain ID `61999`)
- **RPC Endpoint:** `https://studio.genlayer.com/api`
- **Contract Address:** `0x801A94870ecADe3Aedd0f8D070498Ad954b63841`
- **Deployment Transaction ID:** `0x0db43276874b9ceec0cbdd5ce3ade548c00ed790bb9c7f8b2f6276e4ba539207`
- **Deployment Status:** `FINALIZED`, `MAJORITY_AGREE`, execution `SUCCESS`
- **Verified Schema:** `verify_proposal(payload_json: string, submitted_evidence_hash: string) -> dict`
- **Live Real Write Execution:**
  - **Transaction ID:** `0xbefcbfeec4f3302a6004a2d59bab49f6190f9c869f3f690d10956026763d4ea6`
  - **Protocol Consensus:** `FINALIZED` (status: `7`), `MAJORITY_AGREE` (result: `6`), execution: `SUCCESS`.
  - **Independent Hash:** Contract independently verified matching `evidence_hash`, returned `status: 'ALLOW'`, all 16 safety checks `true`.

---

## 7. Strict Binance Boundary

- **Binance files changed:** `NONE`
- **Binance credentials / endpoints / signing changed:** `NONE`
- **Binance environment variables changed:** `NONE`
- All changes are strictly confined to the GenLayer contract, verification adapter, inspection endpoint, and remediation test suites.
