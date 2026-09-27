# Security and publication checklist

This is a local read-only Firebase monitor, not a public webhook server. Its
Hivemind connection accepts only explicit numeric loopback HTTP origins. UI
session cookies and bot credentials are kept separate; bot-token denials do not
bootstrap a Human session. Redirects are rejected on both provider and Hive calls.

Official Firebase Alerts are deferred; the experimental manual import path has
been removed from this checkout. No webhook, Pub/Sub consumer, cloud resources
or IAM changes are installed. Future support must authenticate the event source:
schema validation and app/project matching alone are not authentication. Local
bot-calculated alerts must never be presented as Firebase-issued events, and
the two alert producers must be mutually exclusive. Neither source grants
authority to agents. See [ALERTS.md](ALERTS.md) for the planned boundaries.

## Private data

- Keep runtime profiles outside the source checkout. They contain bot credentials,
  outbox messages, cached diagnostics and local logs. Profile directories use
  mode 0700 and sensitive files 0600. Filesystem permissions are not encryption.
- Firebase login/refresh is delegated to the pinned Firebase CLI. Explicit account
  selection fails closed instead of falling back to another account, an inherited
  legacy token, or ADC. Default credentials remain supported when no account is
  selected.
- Provider event fields are allowlisted. User/session/installation IDs, custom
  keys, breadcrumbs and logs are excluded. Stack and exception strings can still
  contain sensitive application data. Only follow channels approved for it.
- The npm package uses an explicit file allowlist. Before publishing, review the
  staged changes, **Git history**, package contents and dependency audit. An
  allowlist or regex secret scan is not a guarantee that content is anonymized.
- `retry` is an explicit, stopped-profile operation after the cause is resolved
  and retry authorized. It never overrides Hivemind capabilities or token policy.

## Verification boundaries

Automated auth tests verify the imported CLI contract with mocked login/token
functions and a replaced fetch transport. They do not prove a real account's
permissions, OAuth refresh or current Firebase availability. Run an explicitly
authorized read-only smoke test against the intended app before production
rollout. Never include real crash samples or credentials in public test fixtures.

This project uses the [Apache License 2.0](LICENSE). Do not publish credentials,
private crash content or full local logs in an issue.
