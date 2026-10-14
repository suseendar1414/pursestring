# Security policy

PurseString sits in front of payment credentials, so we take security reports seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's [private vulnerability reporting](https://github.com/suseendar1414/pursestring/security/advisories/new) instead. Include what you found, how to reproduce it, and the impact you expect. We aim to acknowledge reports within 3 working days and will credit you in the advisory unless you'd rather we didn't.

## Supported versions

Only the latest release receives security fixes while the project is pre-1.0.

## Design commitments

- No telemetry. The only outbound calls go to the payment rail and webhooks you configure.
- Card numbers and CVVs are returned to the agent in the tool result and never written to `state.json` or `decisions.jsonl`.
- State and log files are created with `0600` permissions.
- Deny rules (hard cap, blocklist, currency) can't be overridden by a human approval.
- HTTP mode supports bearer tokens for agents (`PURSESTRING_TOKEN`) and for approvals (`PURSESTRING_ADMIN_TOKEN`) and binds to `127.0.0.1` by default.

## Known limitations

- The agent receives the card number, so a compromised agent can misuse an issued card up to its cap and merchant lock. Keep `auto_approve.max_amount` low.
- `vendor_domain` is declared by the agent. Merchant enforcement depends on the rail's merchant lock.
- Slack/Discord messages are notifications only; approvals happen through the CLI or the authenticated HTTP API.
