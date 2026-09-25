# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }

import genlayer as gl
from genlayer import *
import json

ERROR_EXPECTED  = "[EXPECTED]"
ERROR_EXTERNAL  = "[EXTERNAL]"
ERROR_TRANSIENT = "[TRANSIENT]"
ERROR_LLM       = "[LLM_ERROR]"

class RebalanceVerifier:
    owner: Address
    verification_count: u256

    def __init__(self):
        self.owner = gl.message.sender_account
        self.verification_count = 0

    @gl.public.view
    def get_verification_count(self) -> int:
        return int(self.verification_count)

    @gl.public.write
    def verify_proposal(self, payload_json: str) -> dict:
        def leader_fn() -> dict:
            try:
                payload = json.loads(payload_json)
            except Exception as e:
                return {
                    "status": "REJECT",
                    "reason": f"Malformed JSON payload: {str(e)}",
                    "evidence_hash": "",
                    "proposal_id": "",
                    "checks": {
                        "payload_valid": False,
                        "math_consistent": False,
                        "direction_consistent": False,
                        "spread_permitted": False,
                        "circuit_breaker_passed": False,
                        "market_state_permitted": False,
                        "non_zero_portfolio": False,
                    }
                }

            # 1. Extract required fields
            proposal_id = str(payload.get("proposalId", ""))
            target_stock_weight = int(payload.get("targetStockWeightBps", 0))
            stock_balance_raw = int(payload.get("stockBalanceRaw", "0"))
            stable_balance_raw = int(payload.get("stableBalanceRaw", "0"))
            stock_balance_fmt = float(payload.get("stockBalanceFormatted", 0.0))
            stable_balance_fmt = float(payload.get("stableBalanceFormatted", 0.0))
            stock_token_price = float(payload.get("stockTokenPrice", 0.0))
            spread_bps = payload.get("spreadBps")
            if spread_bps is not None:
                spread_bps = int(spread_bps)
            market_state = str(payload.get("marketState", ""))
            current_stock_weight = int(payload.get("currentStockWeightBps", 0))
            drift_bps = int(payload.get("calculatedDriftBps", 0))
            drift_threshold = int(payload.get("driftThresholdBps", 500))
            proposed_action = str(payload.get("proposedAction", ""))
            proposed_trade_usd = float(payload.get("proposedTradeAmountUsd", 0.0))
            max_single_trade_usd = float(payload.get("maxSingleTradeUsd", 5000.0))
            max_spread_bps = int(payload.get("maxSpreadBps", 200))
            quote_age_seconds = int(payload.get("quoteAgeSeconds", 0))
            evidence_hash = str(payload.get("evidenceHash", ""))

            # 2. Check for empty/zero portfolio (Zero Mock Policy enforcement)
            if stock_balance_raw == 0 and stable_balance_raw == 0:
                return {
                    "status": "REJECT",
                    "reason": "Both stock and stablecoin balances are zero. Proposal cannot be verified.",
                    "evidence_hash": evidence_hash,
                    "proposal_id": proposal_id,
                    "checks": {
                        "payload_valid": True,
                        "math_consistent": False,
                        "direction_consistent": False,
                        "spread_permitted": False,
                        "circuit_breaker_passed": False,
                        "market_state_permitted": False,
                        "non_zero_portfolio": False,
                    }
                }

            # 3. Check market state
            if market_state != "MARKET_OPEN":
                return {
                    "status": "REJECT",
                    "reason": f"Market state {market_state} does not permit trading.",
                    "evidence_hash": evidence_hash,
                    "proposal_id": proposal_id,
                    "checks": {
                        "payload_valid": True,
                        "math_consistent": True,
                        "direction_consistent": True,
                        "spread_permitted": True,
                        "circuit_breaker_passed": True,
                        "market_state_permitted": False,
                        "non_zero_portfolio": True,
                    }
                }

            # 4. Check quote freshness
            if quote_age_seconds > 900:
                return {
                    "status": "REJECT",
                    "reason": f"Quote age {quote_age_seconds}s exceeds max allowable 900s.",
                    "evidence_hash": evidence_hash,
                    "proposal_id": proposal_id,
                    "checks": {
                        "payload_valid": True,
                        "math_consistent": True,
                        "direction_consistent": True,
                        "spread_permitted": True,
                        "circuit_breaker_passed": True,
                        "market_state_permitted": True,
                        "freshness_passed": False,
                        "non_zero_portfolio": True,
                    }
                }

            # 5. Math reconciliation
            stock_val = stock_balance_fmt * stock_token_price
            stable_val = stable_balance_fmt * 1.0  # USDC pegged at $1.0
            computed_total = stock_val + stable_val

            if computed_total <= 0:
                return {
                    "status": "REJECT",
                    "reason": "Computed total portfolio value is zero or negative.",
                    "evidence_hash": evidence_hash,
                    "proposal_id": proposal_id,
                    "checks": {
                        "payload_valid": True,
                        "math_consistent": False,
                        "direction_consistent": False,
                        "spread_permitted": False,
                        "circuit_breaker_passed": False,
                        "market_state_permitted": True,
                        "non_zero_portfolio": False,
                    }
                }

            computed_stock_weight = int(round((stock_val / computed_total) * 10000))
            computed_drift = abs(computed_stock_weight - target_stock_weight)

            # Tolerance for rounding: allow 2 bps difference
            if abs(computed_stock_weight - current_stock_weight) > 2 or abs(computed_drift - drift_bps) > 2:
                return {
                    "status": "REJECT",
                    "reason": f"Math mismatch: computed weight {computed_stock_weight} vs reported {current_stock_weight}, drift {computed_drift} vs reported {drift_bps}.",
                    "evidence_hash": evidence_hash,
                    "proposal_id": proposal_id,
                    "checks": {
                        "payload_valid": True,
                        "math_consistent": False,
                        "direction_consistent": False,
                        "spread_permitted": False,
                        "circuit_breaker_passed": False,
                        "market_state_permitted": True,
                        "non_zero_portfolio": True,
                    }
                }

            # 6. Drift threshold vs proposed action
            if computed_drift < drift_threshold:
                if proposed_action != "NONE":
                    return {
                        "status": "REJECT",
                        "reason": f"Drift {computed_drift} bps is below threshold {drift_threshold} bps, but proposed action is {proposed_action}.",
                        "evidence_hash": evidence_hash,
                        "proposal_id": proposal_id,
                        "checks": {
                            "payload_valid": True,
                            "math_consistent": True,
                            "direction_consistent": False,
                            "spread_permitted": True,
                            "circuit_breaker_passed": True,
                            "market_state_permitted": True,
                            "non_zero_portfolio": True,
                        }
                    }
                else:
                    return {
                        "status": "ALLOW",
                        "reason": "NO_ACTION verified: drift is within tolerance.",
                        "evidence_hash": evidence_hash,
                        "proposal_id": proposal_id,
                        "checks": {
                            "payload_valid": True,
                            "math_consistent": True,
                            "direction_consistent": True,
                            "spread_permitted": True,
                            "circuit_breaker_passed": True,
                            "market_state_permitted": True,
                            "non_zero_portfolio": True,
                        }
                    }

            # 7. Direction consistency
            expected_direction = "SELL_STOCK" if computed_stock_weight > target_stock_weight else "BUY_STOCK"
            if proposed_action != expected_direction:
                return {
                    "status": "REJECT",
                    "reason": f"Direction mismatch: portfolio requires {expected_direction} but proposal specifies {proposed_action}.",
                    "evidence_hash": evidence_hash,
                    "proposal_id": proposal_id,
                    "checks": {
                        "payload_valid": True,
                        "math_consistent": True,
                        "direction_consistent": False,
                        "spread_permitted": True,
                        "circuit_breaker_passed": True,
                        "market_state_permitted": True,
                        "non_zero_portfolio": True,
                    }
                }

            # 8. Spread boundary check
            if proposed_action == "BUY_STOCK" and spread_bps is not None and spread_bps > max_spread_bps:
                return {
                    "status": "REJECT",
                    "reason": f"Spread {spread_bps} bps exceeds maximum allowable spread {max_spread_bps} bps for BUY_STOCK.",
                    "evidence_hash": evidence_hash,
                    "proposal_id": proposal_id,
                    "checks": {
                        "payload_valid": True,
                        "math_consistent": True,
                        "direction_consistent": True,
                        "spread_permitted": False,
                        "circuit_breaker_passed": True,
                        "market_state_permitted": True,
                        "non_zero_portfolio": True,
                    }
                }

            # 9. Circuit breaker check
            if proposed_trade_usd > max_single_trade_usd:
                return {
                    "status": "REJECT",
                    "reason": f"Trade amount ${proposed_trade_usd:.2f} exceeds circuit breaker limit ${max_single_trade_usd:.2f}.",
                    "evidence_hash": evidence_hash,
                    "proposal_id": proposal_id,
                    "checks": {
                        "payload_valid": True,
                        "math_consistent": True,
                        "direction_consistent": True,
                        "spread_permitted": True,
                        "circuit_breaker_passed": False,
                        "market_state_permitted": True,
                        "non_zero_portfolio": True,
                    }
                }

            # 10. LLM structured risk evaluation (agentic verification)
            prompt = (
                f"You are an independent DeFi risk auditor for an autonomous portfolio agent on BSC.\n"
                f"Evaluate this proposed rebalance:\n"
                f"- Strategy: Target Stock {target_stock_weight / 100}%, Actual Stock {computed_stock_weight / 100}%\n"
                f"- Proposed Action: {proposed_action} of ${proposed_trade_usd:.2f} USD\n"
                f"- Market Status: {market_state}\n"
                f"- On-Chain Spread: {spread_bps} bps (limit: {max_spread_bps} bps)\n"
                f"Confirm whether the proposal is consistent with safe portfolio management.\n"
                f"Return JSON: {{\"approved\": true, \"risk_score\": 0, \"assessment\": \"brief explanation\"}}"
            )
            llm_res = gl.nondet.exec_prompt(prompt, response_format="json")

            is_approved = True
            if isinstance(llm_res, dict):
                is_approved = bool(llm_res.get("approved", True))

            if not is_approved:
                assessment_text = str(llm_res.get("assessment", "High risk")) if isinstance(llm_res, dict) else "High risk"
                return {
                    "status": "REJECT",
                    "reason": f"LLM risk auditor rejected proposal: {assessment_text}",
                    "evidence_hash": evidence_hash,
                    "proposal_id": proposal_id,
                    "checks": {
                        "payload_valid": True,
                        "math_consistent": True,
                        "direction_consistent": True,
                        "spread_permitted": True,
                        "circuit_breaker_passed": True,
                        "market_state_permitted": True,
                        "non_zero_portfolio": True,
                    }
                }

            return {
                "status": "ALLOW",
                "reason": "Proposal successfully verified against all deterministic risk and allocation rules.",
                "evidence_hash": evidence_hash,
                "proposal_id": proposal_id,
                "checks": {
                    "payload_valid": True,
                    "math_consistent": True,
                    "direction_consistent": True,
                    "spread_permitted": True,
                    "circuit_breaker_passed": True,
                    "market_state_permitted": True,
                    "non_zero_portfolio": True,
                }
            }

        def validator_fn(leaders_res: gl.vm.Result) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return False
            leader_data = leaders_res.calldata
            if not isinstance(leader_data, dict):
                return False
            validator_data = leader_fn()
            # Custom comparator: must agree on status and evidence_hash (NOT strict_eq on LLM assessment text)
            if leader_data.get("status") != validator_data.get("status"):
                return False
            if leader_data.get("evidence_hash") != validator_data.get("evidence_hash"):
                return False
            return True

        verdict = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)
        if isinstance(verdict, dict) and verdict.get("status") == "ALLOW":
            self.verification_count += u256(1)
        return verdict
