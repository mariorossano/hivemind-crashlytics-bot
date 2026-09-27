# Alert sources: design and deferred official integration

## Current implementation

The bot polls read-only Crashlytics issue reports and forwards Firebase-owned
issue signals as `new`, `repetitive`, `regressed` and `early`. Those labels are
metadata from Firebase, not locally invented urgency levels.

**Local trend/impact detection is planned, not implemented. Official Firebase
Alerts are also deferred.** This checkout has no alert receiver, manual alert
import command, cloud deployment, or usable alert-source selector. In particular,
the native issue signals do not mean that Firebase Trending or Velocity alerts
are being received. Count-change notifications are not trend detection either.

The first implementation is intended to calculate alerts in the bot from
read-only reports. They must be visibly labeled **Bot-calculated**, not
**Firebase official**. No brain/model will be responsible for calculating them.

## Why calculate locally first?

Users should be able to install the bot with report-read access without
deploying a separate cloud receiver or setting up alert delivery infrastructure
in their Firebase project. Provider API access, permission requirements and
quotas still apply; the bot does not bypass them.

Local observations are not equivalent to Firebase's official alerting service.
They can differ in windows, coverage, thresholds, freshness and classification.
Documentation and messages must explain that difference instead of suggesting
that locally generated `trending` or high-impact labels reproduce Firebase's
own Trending or Velocity decisions.

Official alert support remains a future optional integration. The issue draft
below is local documentation only: no repository issue has been opened yet.

## Local detection requirements — implementation pending

- Use deterministic bot code with documented, configurable thresholds. Separate
  high absolute impact from growth: a frequently occurring crash is not
  necessarily growing. Do not invent Firebase-owned native classifications.
- Define comparable observation windows, filters and the version scope before
  calculating a trend. Subtracting successive overlapping rolling-window totals
  does not reliably yield new events; late data and expired events affect them.
- Report absolute event and affected-user counts for their stated windows.
  Never sum distinct-user totals across issues or windows as if they were
  disjoint; never claim a percentage of all active users without a matching
  denominator. Unknown user counts remain unknown, not zero.
- Expose insufficient history, incomplete pagination, stale data and source
  errors. Failure or absence from a filtered report is not recovery. No alert
  decision may advance from a partial/failed read.
- Define quiet initial baselines, durable detection state, cooldown/rearm rules
  and idempotent delivery. Restarts or retries must not replay the same alert;
  sustained incidents must not notify on every poll. Scope changes require an
  explicit state transition, not reuse of incompatible history.
- Include producer, classification, algorithm version, observation windows,
  counts and the threshold evidence in each alert. Treat diagnostic text and
  provider fields as untrusted data, never as agent instructions.
- Keep the destination explicitly bound to a configured subscription. Analysis,
  investigation-channel creation and any fix are separate channel/Human
  authorizations, not privileges granted by a crash notification.

The sampling design, threshold defaults and detection-state schema still need
implementation and regression tests. No numerical defaults are promised here.

## One alert source setting — future contract

Expose a single **Alert source** choice in the bot's project settings:

- **Bot-calculated**: only the deterministic local detector produces alerts.
- **Firebase official**: only the authenticated official integration produces
  alerts, after it has been configured and verified.

These modes must be mutually exclusive, not independent toggles. The setting
applies to all subscriptions in that project's bot profile. A shared profile
must not silently make a different choice for another project.

Switching must require a stopped monitor and a deliberate configuration change.
Fence the old source/generation and settle or explicitly cancel its pending
alerts before activating the new source. Do not relabel or replay old alerts.
Previously submitted messages cannot be recalled; report that boundary clearly.
Keep history and deduplication records with their original source. Late inbound
events or in-flight local computations from an old generation must not create
new deliveries after the switch.

Official-source configuration failures must stay visible. Do not silently fall
back to local calculations when official delivery is unavailable. Likewise, do
not accept official alert ingress in local mode. Ordinary report observations
and native issue-signal metadata may remain available as such, but must not act
as a second alert producer or trigger duplicate investigation workflows.

Until official support exists, do not show it as an available working option.

## Future repository issue draft — not yet filed

**Title:** Add authenticated Firebase Alerts with an exclusive alert-source setting

**Problem:** The planned low-setup local detector will not produce official
Firebase Trending or Velocity alerts. Users who need Firebase's own decisions
should be able to opt into an official integration without running both alert
producers for the same project.

**Scope:** Design an optional, authenticated delivery path for official alerts;
document its cloud setup, permissions, ownership and cost requirements. Choose
the transport in that issue rather than deploying cloud resources implicitly.
Schema validation and project/app matching alone are not sender authentication.

Acceptance criteria:

- [ ] Preserve the no-extra-cloud-setup local mode and document both sources'
      provenance, behavior, limitations and operational requirements.
- [ ] Implement the single project-profile Alert source setting and validate
      configuration before activation; official mode is unavailable until ready.
- [ ] Authenticate the sender and validate app/project binding, payload sizes
      and supported event contracts. Publish to explicit configured destinations
      only, respecting Hivemind bot permissions and private-channel boundaries.
- [ ] Record durable source-scoped receipts and outbox entries atomically;
      handle duplicate, delayed, out-of-order and conflicting events safely.
- [ ] Enforce mutual exclusion at production, ingestion and delivery, including
      source changes with queued work, in-flight operations and process restarts.
- [ ] Make disconnected/stale official delivery observable without silently
      enabling local calculations. Expose only redacted operational diagnostics.
- [ ] Test both modes and switching: pending/backed-off/blocked messages,
      cancellation, late arrival, duplicate delivery, lost acknowledgements,
      wrong app/project and unauthorized requests. Never automatically retry a
      denied write or revive cancelled events.
- [ ] Verify against supported official contracts and an explicitly authorized
      isolated cloud setup before claiming official end-to-end coverage.

Neither implementation authorizes a brain to modify code, publish a fix or
change external systems. A channel may permit autonomous analysis; fixes still
require the Human approval specified by that channel's workflow.
