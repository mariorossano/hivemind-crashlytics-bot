# hivemind-crashlytics

A read-only Firebase Crashlytics bot for Hivemind. It polls app issue reports,
deduplicates changes and posts observations with optional stack attachments to
existing channels selected by Human. It does not use a model or change Firebase.

Requires Hivemind's composable **Bot** contract (`hivemind-bot.json`, publish/tools
capabilities and project-specific settings). Do not install against an older
core that lacks that contract. Install from this repository; see the
verification and release checklist below.

## Quick start

This walkthrough uses Hivemind's UI and a brain to connect one Firebase app to
one channel. The monitor itself does not use an AI model.

**Before you begin:** Node.js >=22.13, npm and Git;
a running Hivemind with the composable Bots API; a Hivemind project
and brain; and a Firebase account with read access to the app. Run the terminal
commands on the computer running Hivemind, not just on a computer viewing its UI.

### 1. Download and install

```sh
git clone https://github.com/mariorossano/hivemind-crashlytics-bot.git
cd hivemind-crashlytics-bot
npm ci
```

No separate build is needed. Keep this directory: Hivemind will run the bot from
here. The npm package is not published to a registry.

### 2. Check your Firebase login

If the intended account is not already logged into Firebase CLI, run from the
checkout:

```sh
node node_modules/firebase-tools/lib/bin/firebase.js login
```

Signing into Firebase in your browser is not the same as signing into its CLI.
Use an account that can read the app; do not paste passwords or tokens into
Hivemind. No Cloud Functions, Pub/Sub or BigQuery setup is required.

### 3. Register the bot with Hivemind

From the same checkout, replace `/absolute/hivemind-home` with the **home directory
of your running Hivemind instance**, not the bot checkout or its future profile:

```sh
hivemind bots add "$PWD/hivemind-bot.json" --home /absolute/hivemind-home
```

If `hivemind` is not on your PATH, replace it with
`node /absolute/hivemind/bin/hivemind.mjs` from your Hivemind installation.
Registration only adds the package to the catalog. It does not read crashes or
start a monitor.

### 4. Configure and connect in the UI

In your Hivemind project, open **Project settings → Bots… → Add bot**, choose
**Crashlytics** under **Service**, then **Configure**. Use **Refresh** if the newly
registered service is not listed.

- Leave **Firebase account email** empty to use the CLI's default login, or enter
  the email of the specific account already logged into that CLI.
- For a first test, keep the defaults: 300-second polling, 90-second timeout,
  7-day lookback, `OPEN` issues and `FATAL` errors (crashes). Leave version names
  empty to include all versions. These filters do not include every error type
  or closed issue; they can be changed deliberately.
- Check **Enable service for this project after saving**, then **Save locally**.
- Keep the bot name **Crashlytics** and press **Create and connect bot**.

Keep **Publish** and **Tools** enabled; **Receive** is not needed. Configuration
and connection do not read Firebase or start monitoring. **Do not press Start
monitor yet.**

### 5. Copy the app's Crashlytics URL

In Firebase Console, select your Firebase project, open **Crashlytics**, select
the app and stay on the page listing its issues. **Copy that page's URL from the
browser address bar**, not the link to an individual issue. An example is:

```text
https://console.firebase.google.com/project/example-prod/crashlytics/app/ios:com.example.app/issues?state=open&time=7d&types=crash
```

The URL identifies the Firebase project and app; it is **not** a password or
token. Its supported filters can override the corresponding bot defaults.
**Do not paste it into Service settings or Firebase account email.** Give it
to the brain in the single message below.

### 6. Ask the brain to finish setup and start — one message

After the bot is connected, you do not need to create the channel, invite its
members or press Start manually. Send this to your brain in the intended
Hivemind project. Replace `@YOUR_BRAIN` with an actual mention of your brain and
`FIREBASE_APP_URL` with the URL you copied:

> @YOUR_BRAIN Set up Crashlytics monitoring in this Hivemind project for:
> FIREBASE_APP_URL
>
> Create a private channel named `crashes`, or reuse it if it already exists and
> is private. Add me, yourself and the existing connected Crashlytics bot.
> Use the native bot tools to follow that app in this channel with initial mode
> `snapshot`, then start the monitor. I authorize these setup and monitoring
> actions, including importing matching existing issues and representative stacks.
> Do not create a second bot or initialize another profile.
>
> Verify the saved app URL, destination channel, first successful Firebase read
> and delivery of observations. Report any errors; do not claim success merely
> because the process started. If no issues match, confirm a successful empty read.
> Send me the channel link and the result. Monitoring does not authorize analysis,
> code changes or fixes.
>
> If the channel name belongs to a public channel, the source is ambiguous, or
> setup would require stopping an active monitor or starting unrelated sources,
> ask me before doing that.

Choose any suitable channel name; a private channel is useful because stacks
can contain application data. To receive **future changes only**, replace
`snapshot` with `baseline` and ask to omit the existing-issue import.
Its first successful read is intentionally quiet.

The brain performs the requested channel creation/invitations using Hivemind's
channel tools, discovers Crashlytics with `bot_tools`, and calls native `follow`
with the app URL and channel ID. **Native `follow` configures only; `start` is the
separate tool call that begins reads and posts.** Both are authorized by this
single message. The bot never creates channels itself, and inviting it alone
does not choose an app.

If the brain lacks the instructions, provide the installed
[BOT-TOOLS.md](BOT-TOOLS.md); do not let it guess commands or report success
without tool results. Native client permission prompts may still need your
approval; a chat instruction does not disable those checks.

### Check or stop later

Use **Bots → Crashlytics → Check status**, or ask the brain to inspect subscription
and delivery-error details. A running process alone is not proof of a successful
Firebase read or message delivery. No messages can be normal with `baseline`
or no matching issues.

Ask the brain to stop, or use **Stop monitor**. One monitor serves all subscriptions
in the project's profile; stopping it affects them all. Closing the browser or
disabling service availability does not stop a running monitor.

### Ask for the most frequent crash

After connecting the bot, ask your brain in the relevant channel:

> Which crash happened most in the last seven days? Give me its occurrence count,
> impacted users and Firebase link.

The brain uses the read-only native `top_issues` function for a **fresh Firebase
query**, not a comparison of old chat messages. It takes the app overview `url`
(from the request or the relevant subscription), optional `lookbackDays` (1–89,
overrides URL time), and `limit` (1–10, default 1). If multiple apps are possible,
the brain must clarify which one. No new channel, subscription or monitor restart
is needed, and the query also works while monitoring is stopped.

Results include the UTC interval, fetch time, effective state/type/version and
minimum-count filters, occurrence counts, nullable impacted-user counts and
Firebase links. `types=crash` selects fatal crashes; other types include nonfatal
errors/ANRs. The ranking covers only the stated filters. All report pages must
succeed before sorting; ties use issue ID order, and `moreWithSameCount` reports
ties omitted by the requested limit. Empty results mean no matching issues.
Unknown user counts are not zero; long titles/subtitles are marked as truncated.

This function performs metadata reads only: no stack downloads, messages, cache
updates, configuration or delivery changes. Its reader timeout is the lower of
the configured timeout and 20 seconds. The reader also stops if its native caller
dies earlier (for example, after a queued call exhausts its deadline). Errors and incomplete reports do not fall
back to cached/chat counts. Firebase's reporting delay may still apply. This is
an occurrence ranking, not an official Trending/Velocity alert.

Native query receipts use `ok: true` for a ranking or `ok: false` with an
`error.code` and safe `error.message`; failures never include partial results.
Codes distinguish invalid arguments/URLs, required login, denied access, rate
limits, provider failures, incomplete/invalid reports, oversized results,
timeouts, busy/changed profiles and unexpected query failures. Raw provider
bodies, exception text, stderr, paths and credentials are not returned. Query
errors are inline receipts, not monitor errors in `status`. An outer Hivemind
deadline can still end the call before a receipt is returned.

## Project-specific Hivemind settings

The package manifest declares `settings.schema.json`. Hivemind uses that schema to render **Project settings → Bots…**, with a separate profile and availability setting per project. Install the package once; registration alone does not enable it. For an existing configured profile, use `hivemind bots bind hivemind-crashlytics --project PROJECT_SLUG --config-home /existing/profile --home /hive` after registration. This preserves bots, subscriptions, cache and outbox in place.

The local `configure --home PROFILE` protocol receives stdin JSON `{config, projectId}` and returns `{configured:true, projectId, monitorRunning}`. It validates and saves settings without provider calls, bot creation, model calls or starting a monitor. Error receipts use `{configured:false,error}` and a nonzero exit. It binds the profile in `hivemind-project.json`; follow then rejects destination channels belonging to another project. Unchanged running profiles can be bound, but changed settings require a stopped monitor. Retained source identities cannot silently be changed. Credentials stay with the provider CLI; do not put them in the settings form.

Monitoring commands and native connect recheck their loaded settings under the profile's setup lock before proceeding. If another configuration save completed before admission, the command fails with `Profile settings changed; run the command again`, without starting a read, sending messages or retrying automatically. Invoke it again to load the saved settings. Status, stop and unfollow remain available; this check does not cancel an already admitted operation.

The first runtime initialization also holds setup while loading settings and recording the retained profile identity. A concurrent settings save cannot leave the configuration and database bound to different identities. Already initialized profiles do not need this constructor lock, so status/stop and the managed-start child remain available during startup.

Hivemind substitutes the project profile into the brain's `{{command}}` instructions. Availability affects new/resumed launch prompts, not active processes or existing brain sessions. Disabling/unregistering is not `stop`; stop the monitor separately. Private profile data is retained when a Hivemind project is deleted.

Independent configurable Hivemind bot. A non-model **Crashlytics** bot follows Firebase app issue reports and delivers changed observations to **any Human-selected existing channel**, public or private, including channels shared with GitLab. No channel is created or reserved by this bot. Apps and channels are selected per `follow`, not hardcoded in the package.

## Operator CLI reference

The [Quick start](#quick-start) above is the UI-and-brain installation path.
The commands below are an alternative operator workflow, not additional setup
steps. After UI setup, preserve the project's profile path shown under Service
settings with `--home`; do not initialize a second unrelated default profile.
Unlike native `follow`, CLI `follow` starts monitoring unless `--no-start` is set.

    hivemind-crashlytics init --hive-url http://127.0.0.1:7420 --account you@example.com --interval 300
    hivemind-crashlytics follow 'https://console.firebase.google.com/project/example-prod/crashlytics/app/ios:com.example.app/issues?state=open&time=7d&types=crash' --channel CHANNEL_ID
    hivemind-crashlytics status
    hivemind-crashlytics unfollow --id SUBSCRIPTION_ID
    hivemind-crashlytics stop
    hivemind-crashlytics start

From this checkout use `node bin/hivemind-crashlytics.mjs` in place of the command. Every command accepts `--home /absolute/private/profile`. Default profile: `$XDG_CONFIG_HOME/hivemind-crashlytics` or `~/.config/hivemind-crashlytics`. Profiles hold config, private bot credentials, state/outbox, locks and logs; never commit them.

`follow` provisions/reuses one bot per Hivemind project and starts one durable monitor per profile. Several apps may share a channel; the same app may be sent to several channels, with same-cycle reads shared. Repeat follow is idempotent. No per-crash bot or process. Existing GitLab monitors and brains are not restarted.

Initial mode is `snapshot` (matching existing issues are imported, one observation each). Use `--initial baseline` for a quiet first read and future observed changes only. `--no-start` configures the link without a source read and requires the monitor stopped. `poll --id ID` performs one read while stopped; `run --max-polls N` stops after N source-read attempts (not a wall-clock deadline), or immediately when no sources remain enabled. Source failures do not advance the snapshot. Registration/status do not read Firebase. Closing the browser does not stop a detached monitor. Options are command-specific: misplaced options are rejected instead of silently ignored.

### Settings

| Setting / init flag                            | Default                      | Meaning                                                                      |
| ---------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| `account` / `--account`                        | Firebase CLI default account | Existing Firebase login email, not a token                                   |
| `intervalSeconds` / `--interval`               | 300                          | Delay after each completed source read                                       |
| `lookbackDays` / `--lookback-days`             | 7                            | Rolling observed window, 1–89 days                                           |
| `errorTypes` / `--types`                       | FATAL                        | Comma-separated FATAL, NON_FATAL, ANR                                        |
| `states` / `--states`                          | OPEN                         | One of OPEN/CLOSED/MUTED, or all three; empty means all. Pairs are rejected. |
| `versions` / `--versions`                      | All                          | Exact Firebase display names, e.g. `1.2 (42)`; comma-separated               |
| `minEvents` / `--min-events`                   | 1                            | Minimum events in the selected window                                        |
| `minUsers` / `--min-users`                     | 0                            | Minimum affected users; unknown never means zero                             |
| `notifyCounts` / `--notify-counts`             | false                        | Include count changes in notifications; can be noisy                         |
| `pageSize` / `--page-size`                     | 100                          | Report groups per page                                                       |
| `maxPages` / `--max-pages`                     | 20                           | Full-pagination safety bound, not silent top-N truncation                    |
| `timeoutSeconds` / `--timeout`                 | 90                           | Whole reader timeout                                                         |
| `autoStacks` / `--no-auto-stacks`              | true                         | Cache/attach one representative stack per observed variant                   |
| `maxSamplesPerPoll` / `--max-samples-per-poll` | 20                           | Maximum new variant-sample attempts per poll; remaining work continues later |

App overview URL filters `state`, `time=7d` and `types=crash` override corresponding profile defaults and are retained in the canonical subscription URL. `tag=all` is supported; sort is presentation-only. Unsupported filters, repeated filter keys and individual issue URLs are rejected. Browser `/u/0/` is not an authentication account. Android package overview URLs also use the same configurable reader; only iOS has been exercised live for this prototype.

`init` does not connect and does not overwrite an existing profile. Stop before editing `config.json`. Timing/page-limit changes are applied on restart. For a different account, versions, thresholds or notification semantics, use a new private profile so old fingerprints cannot silently be reused. To change URL filters, unfollow the previous subscription and follow the new URL explicitly; the reader does not infer source changes.

## Firebase access and data

The package pins `firebase-tools` **15.31.0** and reuses its normal account/credential refresh. It does not modify or depend on a globally installed Firebase executable, invoke Claude, or extract secrets from an application repository. If login is needed, from this checkout run:

    node node_modules/firebase-tools/lib/bin/firebase.js login

Use the account that can read the selected project. Existing Google ADC may also work, subject to project/API permissions; user-login auth is the path exercised locally. No service account, new cloud app, IAM change or BigQuery export is created automatically. Tokens remain with Firebase/Google, never in bot messages or bot config. Normal OAuth refresh may update Firebase's existing token cache.

With an explicit `account`, authentication must use that exact existing login:
there is no fallback to ADC. A simultaneous `FIREBASE_TOKEN` is rejected because
Firebase CLI gives it precedence over selected accounts. Resolve the conflicting
configuration before retrying; the bot does not clear or change your credentials.

Implementation uses the public Firebase Management and Crashlytics REST APIs with **GET only**: resolve the exact registered app from its project+bundle/package; fetch all pages of `topIssues` with a fixed interval and filters per poll. Credential refresh is handled by the pinned CLI, not by handwritten token storage. The small auth adapter imports internal CLI modules: upgrading that dependency requires compatibility testing. There is no stable-contract claim for internal modules or the v1alpha Crashlytics API.

The report MCP currently does not expose a page-token input. Direct paginated GETs avoid claiming coverage from only a top-N MCP report. No report or stack trace is requested through a model. With autoStacks enabled the CLI also reads `topVariants` and `events` to cache one representative per variant. It uses an explicit Event readMask and local field allowlist, excluding user/session/installation IDs, custom keys, logs and breadcrumbs. Exception/stack text may itself contain sensitive application data: this is data minimization, not guaranteed anonymization.

## Stack attachments and extra investigation

For each issue selected for enrichment, the bot discovers the complete paginated variant report (not the Issue object's top-12 subset). A successful representative is cached across restarts and rolling-window changes, scoped by project/app/issue/variant and configured versions. It is not downloaded for each occurrence. Newly obtained variants are usually bundled into one TXT on a short notification; if their combined size exceeds 32 MiB, they are split into numbered notifications, each with one bounded TXT. No variant is truncated or dropped to make the bundle fit. Unchanged samples are not attached again on later issue changes. More than four variants are supported by grouping them into TXT files. Each TXT includes all reported threads/exception/error frames, variant IDs and event time/version. It is a representative, not necessarily the most recent event. A baseline-only first read remains quiet.

For a new `--initial baseline` subscription, complete variant inventories are recorded separately from sample downloads. Existing variants stay quiet even if their stacks arrive on later polls or after restart. If initial discovery is deferred, the first complete inventory of that unchanged issue becomes its quiet baseline. This is conservative: variants appearing before that inventory is available cannot be distinguished from initially existing ones. A real issue-metadata change ends pending baseline suppression immediately; new issues and variants appearing after the established inventory notify normally. No missing stack is marked as downloaded merely because its variant is in the baseline.

Sample failures do not hide issue metadata or claim complete coverage. `status` warnings show failed discovery, missing samples, retry backoff and the per-poll download budget; remaining work resumes later. Sample errors back off up to one hour. Successful cached samples survive whole-reader timeout/retry. Text artifacts are capped at 32 MiB each; exceeding that limit is an explicit error, never silent truncation. Artifacts/cache contain diagnostic data and stay in the private profile until deliberately removed; there is no automatic retention/cleanup yet.

Automatic enrichment stops admitting requests before the whole-reader deadline and stops discovering new issues after the sample budget is used. Private scheduling cursors rotate both the starting issue and its variants across polls, scoped to source/app/issue and configured versions. They are advanced before requests and survive restarts, including a hard timeout: a persistently slow variant cannot continually prevent later variants of the same issue being attempted. Deferred issues remain in the complete metadata report; cursors are not proof of stack coverage.

Before enrichment, the reader emits an in-memory checkpoint only after the entire issue report has passed validation. Complete paginated variant inventories then emit ID-only checkpoints, followed by completed-stack checkpoints containing their issue/variant and cached-file descriptor, never stack contents. If the owned reader then times out, the bot retains the complete issue metadata, known inventories and completed stacks, with an incomplete-coverage warning. One persistently slow issue therefore cannot withhold healthy stacks completed before it. Checkpoints must belong to an issue in that report; unknown/duplicate identities, reordered inventories and samples outside a known inventory are rejected. The bot does not recover partial reports or frames, cancelled reads, process/provider errors, or additional ambiguous output. If an error occurs before a valid checkpoint, the read still fails. Internal records are limited to 16 MiB each and output to 32 MiB combined; checkpoint data is not included in error logs. No timeout setting is silently increased.

On macOS/Linux, each reader owns a separate process group. Timeout, cancellation or output overflow first requests termination, escalating after one second if needed. If the reader exits first, remaining members of that same group are force-terminated before the error is returned; an unsuccessful reader exit also cleans up its group. Closing the reader alone is not treated as proof that its helpers stopped. This does not discover or terminate unrelated processes, or helpers that explicitly detach into a different group. Windows retains direct-child termination rather than a process-group guarantee.

Reader exit and pipe closure are tracked separately. An unsuccessful exit observed before the deadline remains a process error even if a helper holds its output pipes open. A successful exit whose pipes do not close by the deadline also fails without checkpoint recovery. Only a deadline reached while the reader is still running permits timeout recovery; a subsequent shutdown exit does not replace that timeout or an earlier cancellation.

    hivemind-crashlytics inspect 'https://console.firebase.google.com/project/example-prod/crashlytics/app/ios:com.example.app/issues/ISSUE_ID?time=7d' --variant VARIANT_ID --samples 3
    hivemind-crashlytics inspect 'https://console.firebase.google.com/project/example-prod/crashlytics/app/ios:com.example.app/issues/ISSUE_ID' --lookback-days 30

`inspect` saves local TXT files and returns only paths/metadata. It does not post, create a bot, touch subscriptions or start a monitor. Without --variant it discovers all variants in that window; --samples (1–10) is per variant. It reuses valid cached requests (including the automatic one-sample representative when still inside the requested window); --refresh explicitly fetches again. Fewer samples than requested are reported, not fabricated. Exact configured version filters remain in force. Canonical bundle/package issue URLs emitted by this bot are supported, not Firebase app-ID deep links.

Hivemind wait delivers attachment metadata, not contents. The brain can fetch_file only when useful, and can use the generic attach tool to share an additional locally downloaded file in the intended channel/thread. Downloading and attaching involve no model call; model consumption occurs when an agent processes notifications or reads diagnostics.

Durable event-file receipts reuse the same attachment ID on message retry/restart. Split notifications have distinct durable event IDs and are queued atomically with their deduplication state. A quiet baseline does not queue any part. The same file sent to another channel gets another attachment ID. A lost upload response can leave an unused file record before retry (the server has no upload idempotency key); message delivery remains deduplicated. No Hivemind core change is required for stack attachments.

References: [events list and readMask](https://firebase.google.com/docs/reference/crashlytics/rest/v1alpha/projects.apps.events/list), [Firebase Crashlytics schemas](https://github.com/firebase/firebase-tools/blob/master/src/crashlytics/types.ts).

References: [Crashlytics reports GET](https://firebase.google.com/docs/reference/crashlytics/rest/v1alpha/projects.apps.reports/get), [report schema](https://firebase.google.com/docs/reference/crashlytics/rest/v1alpha/projects.apps.reports), [official Firebase CLI](https://github.com/firebase/firebase-tools).

## Notifications and limitations

### Alert strategy: bot-calculated first, official Firebase alerts later

**Current checkout:** report polling and Firebase issue-signal labels work;
local trend/impact detection is planned, not yet implemented. There is no
official Firebase Alerts receiver or manual alert-import command.

The first alerting implementation will calculate trends and impact in the bot
using read-only Crashlytics reports. These will be **bot-calculated alerts, not
official Firebase Trending or Velocity alerts**, and may differ from Firebase's
classifications and timing. Calculation belongs in deterministic bot code, not
in a brain or a channel prompt.

This keeps installation accessible: it reuses report-read access without asking
users to deploy Cloud Functions, configure Pub/Sub or provision cloud resources
just for this integration. Official Firebase Alerts are a future optional
integration, not a prerequisite. Normal report API access/quotas still apply.

When official support is available, **one Alert source setting** in the bot's
project settings will choose **Bot-calculated** or **Firebase official**.
They must be mutually exclusive: never two alert producers, duplicate incident
messages, or a silent fallback from official alerts to local estimates.
The selector is not implemented or advertised as usable yet.

See [the alerting design and future repository issue draft](ALERTS.md) for
provenance, switching behavior, limitations and acceptance criteria.

### Native classifications

Report observations start with `Native classifications:`. These are combinable
characteristics assigned by Firebase, not a severity score:

| Native issue signal | Classification | Meaning                                                       |
| ------------------- | -------------- | ------------------------------------------------------------- |
| `SIGNAL_FRESH`      | `new`          | Newly detected by Firebase, not merely first seen by this bot |
| `SIGNAL_REPETITIVE` | `repetitive`   | Repeated impact on some users; not necessarily many users     |
| `SIGNAL_REGRESSED`  | `regressed`    | Previously closed issue detected again                        |
| `SIGNAL_EARLY`      | `early`        | Early in the app session, not necessarily exactly at startup  |

No signals means `none reported`, not healthy. Unknown signals are retained raw
with a status warning. Counts never invent these Firebase-owned classifications. Existing report
fingerprints are unchanged: this display improvement does not replay old issues
or rewrite messages. The header appears on subsequent observations.

Official Trending and Velocity are Firebase Alerts, not these report signals.
They are deferred to the future integration described in [ALERTS.md](ALERTS.md).
Keeping native issue labels does not mean the bot receives official alerts.

Official contract: [issue signals](https://firebase.google.com/docs/reference/crashlytics/rest/v1alpha/projects.apps.issues).

Channel contracts may authorize a coordinator to react to these labels. The bot
never creates investigation channels, assigns workers or approves fixes. Public
channels require addressing/subscriptions to wake the coordinator; invitation
alone is not a wake rule.

By default issue title/subtitle, state, first/latest seen version and Crashlytics signals determine a change. Counts and moving timestamps do not; count notifications are opt-in. Counts are for the whole rolling interval, not increments since the previous poll. Changes are observed reports, not an exhaustive real-time alert feed; collection/processing delays, retention, filters and an outage longer than the window can hide events. Never call an issue newly created just because this monitor first observed it.

An open-only report cannot establish that a missing issue was closed. No deletion/resolution is inferred from absence, and no regressions are invented from count movement. `SIGNAL_REGRESSED` is forwarded only when Firebase reports it. Filtering changes what is visible. Late data is picked up while inside the rolling window; increase that window explicitly if needed.

A complete validated snapshot updates durable fingerprints/outbox atomically. Failed/incomplete/duplicate pages never advance state; repeated identical reads stay silent. Same event IDs survive retries, preventing duplicate Hivemind delivery after lost acknowledgment. Errors/backoff and blocked deliveries are exposed in `status`. No automatic mute, close, comment, repair, merge, push or publication to Firebase/GitLab occurs.

### Recovering blocked deliveries

HTTP 4xx responses (except 408/429) block that subscription's queue instead of
repeatedly attempting denied writes. Reconnecting or starting does not clear
the block. After resolving the cause and explicitly authorizing another attempt:

    hivemind-crashlytics stop
    hivemind-crashlytics status
    hivemind-crashlytics retry --id SUBSCRIPTION_ID
    hivemind-crashlytics start

Wait for `monitorRunning: false` before `retry`. It only requeues blocked events
for the selected enabled subscription, preserving event IDs and upload receipts;
it does not send or start monitoring. Cancelled events are never revived.
`unfollow` cancels queued work and prevents a new send after an in-flight upload
finishes. A message already submitted to Hivemind may still finish; stopping is
not a recall of previously submitted messages. Stack bundles are checked against
the 32 MiB attachment limit before loading their constituent files into memory.

## Register with Hivemind

    hivemind bots add /absolute/hivemind-crashlytics/hivemind-bot.json --home /absolute/hive-profile

Registration is local only: no bot/channel/read/monitor is started. Configure/enable the bot for a project in Project settings → Bots, or bind its existing profile. New/resumed brain launch prompts then include `BOT-TOOLS.md` with that project's profile. Existing brains are not silently updated: give them the installed instructions or use a refreshed launch prompt. Human can then ask, in whichever channel they choose, “Follow the crashes from this Firebase app here: URL”. The brain resolves that channel and invokes `follow`.

No import or runtime dependency on Hivemind or sibling bot repositories. Uses the existing generic bot API: snapshot, create/invite bot, idempotent bot message delivery. Public/private channel mail behavior remains Hivemind's normal behavior; private members receive observations, public channels retain mention-based delivery. The bot does not invite brains or modify directives.

## Verification / publication

Run from the checkout after `npm ci`:

```sh
npm run check
npm run format:check
HIVEMIND_TEST_SOURCE=/absolute/installed/hivemind-checkout npm run test:integration
npm run test:package
npm audit --omit=dev
```

The unit/fault-injection suite uses invented diagnostics and mocked Firebase
transport, never real credentials or Firebase requests. The optional core test in
`npm test` skips unless `HIVEMIND_TEST_SOURCE` is set. **`test:integration` fails
without it**, so a release check cannot silently skip the real-core integration.
Install that core's dependencies first. Integration creates a temporary core,
project, bot and private channel; verifies upload/delivery/deduplication and file
access isolation; starts/stops only its own empty monitor; then removes fixtures.

`test:package` checks a strict file allowlist, packs locally and extracts only the
tarball into a temporary directory (requires `tar`). It copies the checkout's
lockfile into that test directory, runs `npm ci --offline --omit=dev` and checks
that the installed dependencies match the lockfile before testing the CLI and
native protocol. Run `npm ci` first to populate npm's cache. This verifies the
packed source against the locked production dependencies, not an unlocked
consumer install. It never publishes or updates dependency versions. Profiles,
credentials, logs and local diagnostics are not shipped.

Release gates still requiring a decision or further verification:

- Run an authorized smoke test with a real Firebase account/app after the auth
  dependency change, separately from these simulated tests. Include Android if
  claiming live verification for both platforms. No such access is performed by
  the automated checks.
- Repeat the history/content privacy review before each release. Runtime
  profiles, credentials and real crash diagnostics must remain outside Git.
- `private: true` continues to prevent npm publication; install from Git instead.

See [REVIEW.md](REVIEW.md) for this review's findings and verification scope.

## License

Licensed under the [Apache License 2.0](LICENSE), the same license used by
[Hivemind](https://github.com/maxcorrads/hivemind). See [NOTICE](NOTICE) for attribution.
