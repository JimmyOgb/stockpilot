# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

import genlayer as gl
from genlayer import *
import json
import math
import hashlib

ERROR_LLM = "[LLM_ERROR]"


class RebalanceVerifier(gl.Contract):
    owner: Address
    verification_count: u256

    def __init__(self):
        self.owner = gl.message.sender_address
        self.verification_count = 0

    @gl.public.view
    def get_verification_count(self) -> int:
        return int(self.verification_count)

    def _checks(self, **overrides) -> dict:
        checks = {
            "payload_valid": False, "math_consistent": False, "direction_consistent": False,
            "spread_permitted": False, "circuit_breaker_passed": False, "market_state_permitted": False,
            "non_zero_portfolio": False, "freshness_passed": False, "balance_verified": False,
            "price_verified": False, "spread_verified": False, "market_state_verified": False,
            "allocation_drift_valid": False, "trade_direction_valid": False, "trade_amount_valid": False,
            "risk_limits_passed": False
        }
        for key in overrides:
            if key in checks:
                checks[key] = overrides[key] is True
        return checks

    def _result(self, status: str, reason: str, evidence_hash: str, proposal_id: str, checks: dict) -> dict:
        return {
            "status": status,
            "reason": reason,
            "evidence_hash": evidence_hash,
            "proposal_id": proposal_id,
            "checks": checks
        }

    @gl.public.write
    def verify_proposal(self, payload_json: str, submitted_evidence_hash: str) -> dict:
        def leader_fn() -> dict:
            proposal_id = ""
            try:
                if isinstance(payload_json, str):
                    payload = json.loads(payload_json)
                elif isinstance(payload_json, dict):
                    payload = payload_json
                else:
                    raise ValueError("payload must be a JSON string or object")

                if not isinstance(payload, dict):
                    raise ValueError("payload must be a JSON object")

                proposal_id = str(payload.get("proposalId", ""))
                if not proposal_id:
                    raise ValueError("missing proposalId")

                if (
                    not isinstance(submitted_evidence_hash, str)
                    or len(submitted_evidence_hash) != 66
                    or not submitted_evidence_hash.startswith("0x")
                    or any(c not in "0123456789abcdefABCDEF" for c in submitted_evidence_hash[2:])
                ):
                    return self._result("REJECT", "Invalid submitted evidence hash format.", "", proposal_id, self._checks())

                # Independently calculate SHA-256 over canonical JSON representation
                canonical_str = json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
                contract_computed_hash = "0x" + hashlib.sha256(canonical_str.encode("utf-8")).hexdigest()

                if contract_computed_hash.lower() != submitted_evidence_hash.lower():
                    return self._result(
                        "REJECT",
                        f"Evidence hash mismatch: contract computed {contract_computed_hash} but received {submitted_evidence_hash}.",
                        "",
                        proposal_id,
                        self._checks()
                    )

                required = [
                    "targetStockWeightBps", "stockBalanceRaw", "stableBalanceRaw",
                    "stockBalanceFormatted", "stableBalanceFormatted",
                    "stockTokenPrice", "stockReferencePrice", "marketState",
                    "currentStockWeightBps", "calculatedDriftBps", "driftThresholdBps",
                    "proposedAction", "proposedTradeAmountUsd", "maxSingleTradeUsd",
                    "maxSpreadBps", "quoteAgeSeconds",
                    "stockBalanceVerificationStatus", "stableBalanceVerificationStatus"
                ]
                if any(key not in payload for key in required):
                    return self._result("REJECT", "Missing required payload field.", contract_computed_hash, proposal_id, self._checks())

                target = int(payload["targetStockWeightBps"])
                stock_raw, stable_raw = int(payload["stockBalanceRaw"]), int(payload["stableBalanceRaw"])
                stock_fmt, stable_fmt = float(payload["stockBalanceFormatted"]), float(payload["stableBalanceFormatted"])
                price, reference = float(payload["stockTokenPrice"]), float(payload["stockReferencePrice"])
                current, drift = int(payload["currentStockWeightBps"]), int(payload["calculatedDriftBps"])
                threshold, max_spread = int(payload["driftThresholdBps"]), int(payload["maxSpreadBps"])
                trade, max_trade = float(payload["proposedTradeAmountUsd"]), float(payload["maxSingleTradeUsd"])
                age, action, market = int(payload["quoteAgeSeconds"]), payload["proposedAction"], payload["marketState"]

                numeric_ok = all(math.isfinite(value) for value in [stock_fmt, stable_fmt, price, reference, trade, max_trade])
                price_ok = numeric_ok and price > 0 and reference > 0
                spread_bps = int(round(((price - reference) / reference) * 10000)) if price_ok else 999999
                total = stock_fmt * price + stable_fmt
                math_ok = total > 0 and math.isfinite(total)
                computed_weight = int(round((stock_fmt * price / total) * 10000)) if math_ok else -1
                computed_drift = abs(computed_weight - target) if math_ok else -1
                direction_ok = (
                    (action == "NONE" and computed_drift < threshold)
                    or (action == "SELL_STOCK" and computed_weight > target)
                    or (action == "BUY_STOCK" and computed_weight < target)
                )
                trade_ok = (action == "NONE" and trade == 0) or (action != "NONE" and trade > 0)

                checks = self._checks(
                    payload_valid=True,
                    balance_verified=(
                        payload.get("stockBalanceVerificationStatus") == "VERIFIED"
                        and payload.get("stableBalanceVerificationStatus") == "VERIFIED"
                    ),
                    non_zero_portfolio=(stock_raw != 0 or stable_raw != 0),
                    price_verified=price_ok,
                    spread_verified=price_ok,
                    freshness_passed=(age >= 0 and age <= 900),
                    market_state_verified=(market == "MARKET_OPEN"),
                    market_state_permitted=(market == "MARKET_OPEN"),
                    math_consistent=(math_ok and abs(computed_weight - current) <= 2 and abs(computed_drift - drift) <= 2),
                    allocation_drift_valid=(math_ok and abs(computed_weight - current) <= 2 and abs(computed_drift - drift) <= 2),
                    direction_consistent=direction_ok,
                    trade_direction_valid=direction_ok,
                    spread_permitted=(action != "BUY_STOCK" or spread_bps <= max_spread),
                    trade_amount_valid=trade_ok,
                    circuit_breaker_passed=(trade <= max_trade),
                    risk_limits_passed=(trade <= max_trade)
                )

                deterministic_ok = all(checks.values()) and action in ["BUY_STOCK", "SELL_STOCK", "NONE"]
                if not deterministic_ok:
                    return self._result("REJECT", "Deterministic evidence or risk check failed.", contract_computed_hash, proposal_id, checks)

                llm_res = gl.nondet.exec_prompt(
                    "Return JSON only with exactly {approved: boolean, risk_score: number, assessment: string}. Approve only this deterministic rebalance evidence.",
                    response_format="json"
                )
                if (
                    not isinstance(llm_res, dict)
                    or set(llm_res.keys()) != {"approved", "risk_score", "assessment"}
                    or type(llm_res["approved"]) is not bool
                    or type(llm_res["risk_score"]) not in [int, float]
                    or not math.isfinite(float(llm_res["risk_score"]))
                    or type(llm_res["assessment"]) is not str
                ):
                    raise ValueError("malformed LLM schema")

                if llm_res["approved"] is not True:
                    return self._result("REJECT", "LLM risk auditor rejected proposal.", contract_computed_hash, proposal_id, checks)

                return self._result("ALLOW", "Proposal verified against deterministic checks and consensus risk audit.", contract_computed_hash, proposal_id, checks)
            except Exception as error:
                return self._result(
                    "REJECT",
                    ERROR_LLM + " malformed contract input or LLM output: " + str(error),
                    "",
                    proposal_id,
                    self._checks()
                )

        def validator_fn(leaders_res: gl.vm.Result) -> bool:
            if not isinstance(leaders_res, gl.vm.Return) or not isinstance(leaders_res.calldata, dict):
                return False
            validator_data = leader_fn()
            leader_data = leaders_res.calldata
            return (
                leader_data.get("status") == validator_data.get("status")
                and leader_data.get("evidence_hash") == validator_data.get("evidence_hash")
                and leader_data.get("proposal_id") == validator_data.get("proposal_id")
                and leader_data.get("checks") == validator_data.get("checks")
            )

        verdict = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)
        if isinstance(verdict, dict) and verdict.get("status") == "ALLOW":
            self.verification_count += u256(1)
        return verdict

