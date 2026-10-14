# 📌 Product Vision: AI Agent Spending Governance Platform

## Executive Summary

- **The Core Thesis:** Cards are the easy part. Existing fintech issuers (Ramp, Stripe, Lithic) give agents spend limits, but they don't evaluate intent, prevent duplicate-charge loops, or log decision reasoning.
- **The Solution:** An open-source, rail-agnostic governance server (built on MCP) that sits between AI agents and financial rails. It enforces intent-based policy rules, handles idempotency, provides human-in-the-loop (HITL) gates, and logs an auditable "black box" reasoning tree before executing any financial action.

## ⚙️ 1. Architecture & Universal Adapter Pattern

PurseString acts as the central control plane between any AI agent framework (Claude, Cursor, LangChain, CrewAI) and any financial rail (BaaS, corporate banks, or crypto).

```
┌─────────────────────────────────────────────────────────────┐
│                       AI AGENT LAYER                        │
│             (Claude Desktop, Cursor, CrewAI, etc.)          │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│          PURSESTRING: SPENDING GOVERNANCE SERVER (MCP)       │
│ ─────────────────────────────────────────────────────────── │
│  1. Intent Verification (Goal + Alternatives Evaluated)     │
│  2. Idempotency Lock Engine (Prevents double-charges)       │
│  3. Reversibility & Policy Engine (Auto vs. HITL)           │
│  4. Reasoning Tree Auditor ("Black Box" Logger)             │
└──────────────────────────────┬──────────────────────────────┘
                               │ (Approved / Tokenized Request)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 UNIVERSAL PAYMENT ADAPTER                   │
├───────────────┬───────────────────┬─────────────────────────┤
│ BaaS / Issuers│ Enterprise Banks  │ Micro / Web3 Rails      │
│ (Lithic,      │ (Amex, JPMorgan,  │ (USDC, x402, Solana,    │
│ Stripe)       │ ACH/SEPA)         │ Lightning)              │
└───────────────┴───────────────────┴─────────────────────────┘
```

## 💡 2. The Three Core Problems We Solve

### Problem 1: "Cards Are Easy, Governance Is Broken"

- **Standard card failure:** A card capped at $50 allows an agent to sign up for a $15/month recurring SaaS trial that auto-renews forever and goes unnoticed.
- **Our solution:** Force structured intent context before executing a tool call.

```json
{
  "task_goal": "Parse invoice PDF for task #102",
  "cost": 15.00,
  "is_recurring": true,
  "alternatives_attempted": ["PyPDF2 (Failed OCR)"],
  "vendor_domain": "pdfocr.io"
}
```

### Problem 2: The Agent "Double-Charge" Loop (Idempotency)

- **Standard failure:** When a web page hangs during checkout, the agent assumes the purchase failed, calls the card tool a second time, and double-charges the company.
- **Our solution:** Deterministic idempotency keys. The server hashes:

$$\text{Key} = \text{SHA256}(\text{agent\_id} + \text{task\_id} + \text{vendor} + \text{amount})$$

If the agent calls the payment tool again with identical intent within a 30-minute window, the server returns the cached virtual card details without generating a second transaction.

### Problem 3: Missing Reversibility-Based Human-in-the-Loop (HITL)

- **Standard failure:** Hard dollar limits fail because cost alone does not equal risk.
- **Our solution:** Smart approval routing based on reversibility and constraints:
  - **Auto-approve:** non-recurring, single-use, bounded card under $20 on an allowlisted domain.
  - **Pause execution & intercept (Slack / Discord notification):**
    - any transaction flagged `is_recurring: true`
    - spends over a defined threshold (e.g. $50)
    - merchants outside the pre-approved domain allowlist

## 🚀 3. Go-To-Market & Business Model (Open Core)

### Open-Source Community Core (Apache 2.0): this repository

- **Distribution:** npm package (`npx pursestring`), later PyPI.
- **Features:** self-hosted local MCP server, YAML policy config (`policies.yaml`), local JSON decision logging, and sandbox adapters for card issuers (Lithic / Stripe Issuing).
- **Why open source?** Enterprise security teams will never pass financial credentials through a closed-source black-box proxy. Open source builds code trust and enables local VPC deployment.

### Enterprise Cloud Platform (paid SaaS, planned)

- **Target customer:** engineering leads, CTOs and finance teams running agents in production.
- **Monetization features:**
  1. **Audit dashboard:** web UI displaying the visual decision trees and reasoning behind every charge.
  2. **1-click Slack / Teams approvals:** interactive human approval workflow buttons.
  3. **Role-based access control (RBAC):** spend policies per department, project, or agent squad.
  4. **Multi-rail enterprise connections:** direct plugins for Amex, corporate bank ACH/wires, and ERP purchase-order generation.

## 🛠️ 4. MVP Action Plan: status

| # | Step | Status |
|---|---|---|
| 1 | **Repository setup:** public GitHub repo for the MCP server (TypeScript) | ✅ Done |
| 2 | **Core MCP tool schema:** `submit_purchase_intent`, `request_ephemeral_card`, `check_policy_compliance` (plus `get_intent_status` for the HITL pause) | ✅ Done |
| 3 | **Sandbox rails:** adapter backend for the Lithic sandbox (mock rail by default); Stripe Issuing test mode | ✅ Lithic · 🔜 Stripe ([#1](https://github.com/suseendar1414/pursestring/issues/1)) |
| 4 | **Slack interceptor:** async execution pause that pings a Slack webhook when `is_recurring: true`, limits are breached, or the vendor isn't allowlisted | ✅ Done (Discord too) · 🔜 one-click buttons ([#5](https://github.com/suseendar1414/pursestring/issues/5)) |

See [how-it-works.md](how-it-works.md) for how each of these is implemented.
