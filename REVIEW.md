# Crashlytics bot review — 2026-09-26

Scope: source/runtime, protocol, subprocess lifecycle, source filtering and
pagination, identity isolation, durable outbox, stack cache/attachments,
dependency and package hygiene. All changes and tests were made in an isolated
review checkout. No live profile, monitor, provider or channel was changed.

## Fixed findings

| Severity | Finding                                                                                                                            | Correction and coverage                                                                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | Unfollow during an upload could still send a message; an in-flight failure could resurrect a cancelled event.                      | Recheck enabled/pending state before each new send; update delivery outcomes only while pending. Three race regressions failed before the fix and pass afterward. Already submitted messages cannot be recalled. |
| Medium   | A permanent delivery error blocked all subsequent events with no supported recovery.                                               | Explicit stopped-profile `retry` via CLI/native tool; retain IDs/receipts and ordering; never retry denials automatically or revive cancelled work.                                                              |
| Medium   | More than 200 queued events behind a blocked/backed-off subscription could prevent delivery to other healthy destinations forever. | Exclude ineligible chains before applying the batch limit; retain per-subscription ordering and index the eligibility query. Regression demonstrates both blocked and backoff cases.                             |
| Medium   | Firebase's inherited token could override an explicitly selected account; an unusable login could fall back to ADC.                | Reject conflicting credentials, disable fallback for explicit accounts and verify the authenticated identity. Mocked auth-contract and endpoint-allowlist tests.                                                 |
| Medium   | Fixed `.next` JSON file names followed pre-existing symlinks, while empty/concurrently created profiles could be overwritten.      | Unique exclusive temporary files, shared atomic writer, exclusive initial creation and rejection of invalid existing profiles. Regression verifies the unrelated file remains unchanged.                         |
| Medium   | Flags valid for a different CLI command were silently ignored, including privacy-relevant stack options.                           | Command-specific allowlists and strict positional arguments.                                                                                                                                                     |
| Medium   | Reader output was trusted without a snapshot schema; malformed JSON errors could echo input.                                       | Validate snapshots before transaction; bounded UTF-8 stdin assembly with redacted parse errors. Tests ensure no partial fingerprint advancement.                                                                 |
| Medium   | Several individually valid stack files could exhaust memory before the bundle size limit was checked.                              | Check aggregate size before reading files; verify cached file type/size before reading; retain explicit failure rather than truncate diagnostics.                                                                |
| Low      | Corrupt cache retry metadata could permanently prevent sample recovery.                                                            | Validate retry metadata and sample/time coherence; treat invalid cached state as a miss.                                                                                                                         |
| Low      | Native status omitted stack warnings and usage that operator status displayed.                                                     | Include bounded, paginated diagnostic previews without credentials. Verified through a real core.                                                                                                                |
| Low      | Bounded foreground runs with no enabled sources never finished.                                                                    | Exit when no sources remain and clear running intent on normal completion.                                                                                                                                       |

Cleanup: consistent formatting, formatter checks, removal of copied Slack/GitLab
test scaffolding, shared input/writer helpers, current English documentation,
private-data ignore patterns and reproducible integration/package smoke scripts.
The runtime remains an external bot with no dependency on a sibling checkout.

## Verification

- Baseline: 67 tests passed; the optional core integration test was skipped.
- After fixes: 91 tests passed on Node 24.17 and 91 on Node 22.18, with the core
  test enabled and **no skips**; TypeScript passed. The minimum declared Node
  22.13 version itself was not tested.
- Real-core integration used the composable-Bot PR checkout at `b9aaf80` (same
  Bot implementation as the integrated develop, which additionally has the Grok
  catalog changes). Temporary core/database/channel only; Firebase data invented.
- Verified native configure/connect/follow/status/retry/start/stop, real HTTP
  upload and message delivery, deduplication, downloaded attachment content and
  denial of file access outside the private channel.
- Fault tests cover startup delay/death, lost parent IPC, pending stop, locks,
  reader timeout/cancellation/output limits, lost delivery acknowledgement,
  report pagination/scope failures and stack privacy filtering.
- Local tarball installed offline with production dependencies only; CLI and
  native protocol smoke passed. The final package contains 24 allowlisted files.
- Review of tracked/untracked source files found no real credentials or private
  machine/project references. The credential-pattern hits were deliberately
  invalid `user:secret@host` URLs in rejection tests, not real credentials.
  The sole existing commit uses the author's GitHub noreply address. This is
  evidence from this snapshot, not a guarantee for future commits or artifacts.

## Native classifications — local follow-up

Implemented Firebase-owned issue-signal mappings (`new`, `repetitive`,
`regressed`, `early`). No locally calculated trend/priority or model call.
Existing report fingerprints remain unchanged. Tests cover combined mappings,
future/unknown signals, unchanged deduplication and absence of count-derived
Firebase Trending/Velocity labels.

An experimental official-alert parser/manual importer was previously tested
with 101 tests on Node 24.17 and 22.18. **That implementation was removed before
publication after the scope changed**: official Firebase Alerts are deferred,
not merely waiting for a transport to be configured. Its old test count is not
the current checkout's result. No live alert integration was ever configured.

The CLI rejects `import-alert` before accessing a profile/provider. The reader
has no alert-specific app-resolution action, and status no longer advertises
manual alert ingress. Report issue-signal mappings remain supported.

README, bot instructions and [ALERTS.md](ALERTS.md) distinguish working report
labels from planned local alerts and deferred official alerts. The future
single project-profile source selector must make producers mutually exclusive,
including pending work and restarts. No selector or local detector is claimed
to be implemented. The official integration issue is a draft, not a filed issue.

Post-removal verification: TypeScript and **94/94 tests passed on both Node
24.17 and 22.18, with zero skips**, including the isolated real-core test.
Formatting and diff checks passed. The offline production-package smoke passed
with **26 allowlisted files**, including the alerting design/issue draft and
excluding the removed importer. It also verifies that CLI help does not
advertise alert import. No commits, push, cloud changes or live restarts.

## Publication privacy and history review

The post-cleanup review inspected **45 current source/document/test files** and
all **32 file blobs in the existing one-commit history**, including commit
metadata. Pattern matches were reviewed without printing possible secret
values. No real provider token, private key, private machine/project reference
or personal email other than the intended GitHub noreply attribution was found.
The matches were intentionally invalid credential-bearing URLs in rejection
tests and public package-maintainer contact metadata from the npm lockfile.
All lockfile download URLs use the public npm registry. This bounded scan and
manual inspection are not a guarantee that all sensitive data is absent.

The targeted code re-review covered account isolation, authenticated endpoint
restrictions, project binding, route/credential boundaries, private artifacts,
outbox cancellation/retry, CLI input and the removed alert-import path. It found
no additional actionable defect within that scope. The 94-test dual-runtime
suite and production-package smoke described above passed.

Use a new parentless initial commit containing only the reviewed source tree
for publication. Keep old refs, bundles, worktree snapshots, runtime profiles
and local diagnostics private; do not push all branches/tags. Recheck the exact
publication commit and package after any subsequent change. This review does
not authorize a push or claim that the remaining release gates are closed.

## Publication regression follow-up

- The offline package smoke used an unlocked consumer install, so newer cached
  registry metadata could select tarballs not populated by `npm ci`. It now
  extracts the real package, installs from the unchanged checkout lockfile with
  `npm ci --offline --omit=dev --ignore-scripts`, and verifies installed package
  versions, origins and integrity against that lockfile. This covers packed
  source with locked dependencies, not every possible consumer dependency tree.
- Settings accepted two distinct issue states even though a source URL can
  represent only one or all states. Validation now rejects pairs before profile
  creation or overwrite. Settings guidance documents the constraint. Three
  regression tests failed before the fix and pass after it, covering configuration,
  CLI error receipts, all state subsets, duplicates and URL round trips.

Current verification: **97/97 tests on Node 24.17 and 22.18**, no skips, including
the isolated real-core test. TypeScript and formatting checks passed. The locked
production-package smoke passed on both runtimes with **26 allowlisted files**;
it also checks that the packed CLI rejects invalid state settings. Dependency
versions and the checkout lockfile are unchanged. No real Firebase calls,
publication or live monitor changes were made for these regressions.

## Settings admission race — 2026-09-27

Commands loaded settings before acquiring the setup lock. A configuration save
could complete in between, allowing a subsequent poll to use old options such
as `autoStacks: true` after the operator had saved `false`.

CLI run/poll/follow/start/retry and native connect/follow/start/retry now compare
normalized settings while holding setup, before operational effects. Managed
startup checks while its parent owns setup. A changed, missing or invalid
configuration rejects admission, releases acquired locks and does not retry
automatically. Existing running intent, subscriptions, credentials and outbox
remain untouched by the rejected admission. Status, stop and unfollow are not
subject to this guard. Explicit on-demand inspect remains independent of the
monitor's automatic-stack setting.

Ten deterministic command-race tests failed before the fix and pass after it.
Four additional regressions cover normalized defaults/origins, missing or
malformed configuration with redacted errors, and recovery operations. Fresh
run/poll invocations verify that both the reader's configuration and stack
prefetch flag use the new disabled value.

Verification: **111/111 tests on Node 24.17 and 22.18**, no skips, including the
isolated real-core test; TypeScript, formatting and diff checks passed. The
locked offline production-package smoke passed on both runtimes with 26
allowlisted files. The privacy scan now covers 46 current files and found only
the same synthetic rejection URLs and public npm contact metadata described
above. No real Firebase calls or live profile changes were made.

## First-initialization race — 2026-09-27

A further review found that the constructor could read settings before a
concurrent configuration save, then write the first retained database identity
from the old settings. Admission rejected that command, but every subsequent
invocation also failed because the saved identity no longer matched the file.

First initialization now acquires setup before reading configuration or creating
the state database. An existing identity is checked with a read-only probe;
initialized profiles keep their lock-free constructor so a managed-start child
does not contend with its parent, and status/stop remain usable. Failed
construction closes its database and releases setup.

Two deterministic interleavings failed before the fix and pass afterward. Two
additional regressions cover configuration/schema failures (including an empty
state database) and construction while the startup parent owns setup. The
existing startup suite also covers cancellation and readiness handshakes.

Verification: **115/115 tests on Node 24.17 and 22.18**, no skips, including the
isolated real-core test; TypeScript passed. No dependency, live profile, monitor
or provider changes were made.

## Enrichment timeout isolation — 2026-09-27

A complete issue report could be discarded when subsequent stack discovery
exhausted the reader deadline. Discovery continued for every issue even after
the sample budget had run out. The synthetic reproduction used 36 issues,
200 ms per variant report and a five-second deadline: repeated reads queued
nothing with stacks enabled, while metadata-only queued all 36 immediately.

The initial fix emitted a complete validated metadata checkpoint before enrichment.
A typed owned-child timeout could recover only that checkpoint, with an explicit
incomplete-stack warning. Cancellation, invalid/partial metadata, process errors,
provider errors and additional ambiguous output remain failures. Checkpoint
content is private on the error object and is not printed by ordinary logging.
That protocol initially allowed two bounded 16 MiB records; the follow-up below
adds bounded completed-sample checkpoints without increasing the overall cap.

Enrichment admits no requests after its soft deadline, stops new discovery when
the sample budget is exhausted, and records a per-source issue cursor before
each discovery request. Later issues therefore get a turn after both graceful
deferral and hard-timeout/restart. The cursor never claims completed coverage;
all issue metadata stays in the report and existing fingerprints are unchanged.

Three regressions were RED before the fix. Additional tests cover malformed
checkpoints, cancellation, redaction, report failure before checkpoint emission,
pagination deadlines and corrupt scheduling state. A real-child synthetic test
forces two timeouts: all 36 issues queue once, the next poll is deduplicated,
and a later successful poll adds one stack observation for the next issue.
Post-fix review also caught timeout fallback masking an additional error record
or output overflow during child shutdown. Both cases were reproduced RED and
fixed with separate regressions: ambiguous or discarded output cannot recover
a checkpoint.

Verification: **124/124 tests on Node 24.17 and 22.18**, zero skips, including
isolated real-core integration; TypeScript passed. Final code review found no
additional actionable findings. Package smoke passed on both versions with
27 allowlisted files. The 49-file content scan found only previously reviewed
synthetic credential URLs and public npm metadata; it is not an absolute
no-leak guarantee. Dependencies and lockfile are unchanged. No live profile,
monitor or provider was used or modified.

## Follow-up: persistent timeouts and oversized bundles — 2026-09-27

Two further synthetic reproductions exposed independent gaps. A persistently
stalled variant request discarded stacks already obtained earlier in every
read: three timeouts/restarts retained metadata, but queued zero attachments
despite a healthy cached stack. Separately, two individually valid 17 MiB stack
files exceeded the combined attachment limit and rolled back the whole report,
including unrelated issue metadata, on every poll.

Completed samples now emit bounded descriptor-only checkpoints after cache
validation/write. On a real owned-reader timeout, only complete records for
known report issues and unique variants may supplement the metadata checkpoint.
Partial frames, errors, extra finals, overflow and cancellation still fail closed.
The total reader-output cap remains 32 MiB and each JSON record is at most
16 MiB. Recovered samples use the existing artifact validation and per-channel
deduplication; no cross-read cache inventory is trusted as report coverage.

Large sets of fresh samples are partitioned by actual byte size, including
separators, into bounded TXT attachments. Each part is a numbered notification
with a distinct durable revision/event ID. All parts and sample-deduplication
state commit atomically. Quiet baseline, rollback for corrupt/missing artifacts,
restart and lost-acknowledgement behavior remain intact.

Both reproductions were RED before the fixes and pass afterward. New tests also
cover checkpoint identity/framing, exact size boundaries, baseline, rollback
after a later bad part, and replay without duplicate upload/message delivery.
Verification: **129/129 tests on Node 24.17 and 22.18**, zero skips, including
isolated real-core integration; TypeScript and formatting passed. Final review
found no additional actionable findings. Offline package smoke passed on both
versions with 27 allowlisted files. The 49-file content scan found only the
previously reviewed synthetic URLs/public npm metadata, not new sensitive data;
this is not an absolute no-leak guarantee. No dependencies, live profiles,
monitors or provider services were modified.

## Follow-up: deferred baseline and intra-issue fairness — 2026-09-27

Two further P2 reproductions were RED before these fixes. With a one-sample
budget and two unchanged existing issues, a quiet baseline emitted the second
issue when its sample arrived on the next poll. Separately, a hard timeout on
the first variant repeatedly prevented the second variant of that same issue
being attempted, even across restarts.

Complete paginated variant inventories now have validated ID-only checkpoints,
separate from downloaded-sample descriptors. Per-subscription baseline state
records those IDs without claiming any sample was obtained. Their delayed stacks
remain quiet across restart. If initial discovery is unavailable, the first
complete inventory of an unchanged initial issue becomes its baseline; variants
appearing during that unknown interval cannot reliably be distinguished from
initially existing ones. A real metadata change ends pending suppression.
New issues and variants appearing after the established inventory still notify.
Inventory, sample deduplication and queued events commit or roll back together.

A separate private variant cursor is scoped by source/app/issue/versions and
advanced before each uncached sample request. Hard-killing a slow request thus
leaves a starting point for later variants on the next poll. Corrupt or obsolete
cursors recover safely, and scheduling state never implies completed coverage.

Nine new regressions cover the two real-child reproductions, deferred versus
immediate baseline inventory, restart and channel isolation, new variants/issues,
metadata changes, empty inventories, transactional rollback, checkpoint framing
and cancellation, incomplete pagination, and corrupt/version-scoped cursors.
Both reproductions are now GREEN. **138/138 tests passed on Node 24.17 and 22.18**,
zero skips, including the isolated real-core integration. TypeScript passed.
Post-fix code review found no additional actionable findings. Formatting and
diff checks passed; offline package smoke passed on both versions with 27
allowlisted files. The 49-file scan found only the previously verified synthetic
credential URLs and public npm metadata, not new sensitive data; this remains
a bounded review, not an absolute no-leak guarantee. Dependencies and lockfile
are unchanged. No Firebase services, live monitor or retained live profile was
used or modified.

## Follow-up: interrupted reader process-group cleanup — 2026-09-27

A P2 lifecycle reproduction showed that a reader could exit on SIGTERM while
its helper ignored SIGTERM and remained alive. The reader's close handler then
cancelled the scheduled SIGKILL, leaving the helper orphaned after both timeout
and cancellation. The same gap affected stdout/stderr overflow. Post-fix review
also reproduced a helper surviving an unsuccessful reader exit without a prior
timeout.

On a failed or interrupted reader close, the runner now signals only that
reader's owned process group with SIGKILL before clearing the grace timer and
returning the error. A still-running reader retains the existing one-second
escalation. Timeout checkpoint contents/type, overflow precedence, cancellation,
successful responses and native permissions are unchanged. No process discovery,
unrelated-process signalling, automatic retry or timeout increase was added.

Six POSIX regressions cover timeout, cancellation, stdout/stderr overflow, a
stubborn group leader and an unsuccessful leader exit. Five failed before their
correction and now pass; the stubborn-leader case verifies the existing timer
path. Every scenario checks that its helper stops and a separate control process
survives. Test cleanup also owns and removes only its synthetic processes.
**144/144 tests passed on Node 24.17 and 22.18 on macOS**, zero skips, including
isolated real-core integration. TypeScript passed. The process-group tests skip
Windows, where termination still targets the direct child; explicitly detached
helpers in a different group are outside this guarantee. Final code review
found no further actionable findings in this fix. No live monitor, profile,
provider service or agent runner was changed.

Formatting/diff checks and offline package smoke passed on both Node versions
(27 allowlisted package files). The 49-file privacy scan found only the already
reviewed synthetic credential URLs and public npm metadata, not new sensitive
data; it is not an absolute no-leak guarantee. Dependencies and lockfile are
unchanged.

## Follow-up: reader exit cannot become a recoverable timeout — 2026-09-27

A P2 reproduction exited a synthetic reader with code 7 before the deadline
while its helper retained stdout/stderr. Waiting only for `close` let the
deadline misclassify the failure as `ReaderTimeoutError`; the provider returned
the metadata checkpoint as a successful read. The same gap affected a reader
terminated by a signal, and a reader that exited successfully after emitting
only a checkpoint while its helper held the pipes open.

The runner now observes `exit` separately. An unsuccessful exit records its
error and cleans up the owned group immediately, preserving an already-recorded
timeout or cancellation. The deadline still bounds pipe draining after a clean
exit, but that condition is a non-recoverable output-close error rather than a
reader timeout. Output overflow keeps precedence; no timeout increase, retry,
process discovery or unrelated-process termination was added.

Five POSIX real-child regressions exercise the actual provider recovery path:
nonzero exit, signal exit, successful exit with open pipes, actual deadline
followed by nonzero shutdown, and cancellation. The first three were RED before
the correction; all five now pass. Each verifies helper cleanup and survival of
an unrelated control process. Windows skips these group tests and retains the
documented direct-child limitation.

**149/149 tests passed on Node 24.17 and 22.18 on macOS**, zero skips, including
the isolated real-core integration. TypeScript, formatting and diff checks
passed. Offline package smoke passed on both versions with 27 allowlisted
files. The 49-file privacy scan found only the already-reviewed synthetic
credential URLs and public npm metadata, not new sensitive data; it is not an
absolute no-leak guarantee. Dependencies and lockfile are unchanged. Post-fix
review found no additional actionable findings in this change. No live monitor,
retained live profile, provider service or agent runner was used or changed.

## Remaining release gates

No real Firebase/ADC login or live Android/iOS smoke was run in this
review. These live checks and the license/public-release decision remain
outstanding; automated test results do not imply production readiness.

On 2026-09-27, the owner authorized a single-commit private GitHub repository
at `mariorossano/hivemind-crashlytics-bot` for manual first-install testing.
The prepared source tree was rechecked against the tested snapshot; only the
README installation instructions and this publication note changed. Private
publication does not authorize public visibility, npm publication, registration
in a live Hivemind instance or starting a monitor.
