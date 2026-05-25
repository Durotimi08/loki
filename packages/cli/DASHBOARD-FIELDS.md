# Dashboard fields reference

Every value the Loki dashboard renders, what it means, and where it comes from.
Pages map 1:1 to the nav. All counts/timestamps reflect what's in the ledger
**now** — no caching, no aggregation tables. Pages with a `● live` badge open
an SSE stream and update without a reload.

**Pagination model.** Every list page (Transactions, Actors per-type, Anomalies,
Outbox, Scheduler, Holds, Disputes, plus the per-actor Recent transactions
table) loads the first 50–100 rows and appends more via a **Load more**
button. Cursors are HMAC-signed and route-scoped (a cursor for one route
can't be replayed on another). The row counter under each table shows how
many are currently loaded.

**Money formatting.** Loki stores amounts as integer minor units (cents,
kobo, etc.) — every example schema and the engine's API contract expect
this. The dashboard divides by 100 for display by default, so `9_235_000`
displays as `92,350.00`, with thousands separators and a currency symbol
where known (`$`, `€`, `£`, `₦`, `KSh `, `GH₵`, `R`); unknown currencies
render as `CCY 92,350.00`. If your application stores whole units instead
of minor units, inject a per-currency scale override before `app.js` loads:
```html
<script>window.__LOKI_CURRENCY_SCALE = { USD: 0, NGN: 0 }</script>
```
Negative balances are expected on credit-side accounts (liabilities, fee
sinks, processor "source" accounts that money flows *out* of). Rather than
show a bare minus sign — which reads as a bug — account balances render as
absolute values with a direction indicator:
- **`↑ 16,550.00 held`** (green) — money currently sitting on this account.
- **`↓ 807,435.00 outflow`** (red) — money cumulatively flowed *out* through this account (its sign is recorded as negative in the DB; the dashboard shows the magnitude + direction tag).
- **`0.00`** (muted) — neutral.

The underlying integer is unchanged — the dashboard's job is presentation,
not normalization. If you need the raw signed value, read the API response
(`/api/v1/tenants/:tid/actors/:type/:id` exposes `accounts[].balance` as a
string with sign preserved).

---

## Page chrome (every page)

### Topbar

| Element | Meaning |
|---|---|
| **Loki** (brand) | Click to return to Overview. |
| **Nav links** | Static list of all pages. The current page is marked `aria-current="page"`. |
| **Tenant** dropdown | The tenant whose data every API call is scoped to. List comes from `GET /api/v1/tenants`. Selection is persisted in `localStorage` (`loki:tenant`). Switching the tenant re-renders the current page. |

### Footbar

| Element | Meaning |
|---|---|
| **core `<v>`** | Version of `@loki/core` baked into this build. |
| **cli `<v>`** | Version of `@loki/cli` baked into this build. |
| **schema `<8-hex>`** | First 8 chars of the schema fingerprint (a hash over the static schema definition). Two dashboards with the same hash see the same actors / transaction types / states. |
| **build `<hash>`** | Either `git:<short-sha>` (resolved from the working tree at boot) or `dev` if not in a git repo. Overridable via `LOKI_DASHBOARD_BUILD_HASH`. |
| **health: `<status>` • primary `<up\|down>` • replica `<up\|down>`** | Result of `GET /api/v1/health`, polled every 15s. `primary` is the main pool; `replica` is only shown if a read replica is configured. "Degraded" means one probe failed. |

---

## Overview (`/`)

`GET /api/v1/tenants/:tid/summary`

A grid of counters plus a per-schema-version breakdown of how the tenant's
data is partitioned across schema migrations.

### Counter cards

| Card | Source | Meaning |
|---|---|---|
| **Records** | `count(txn_records)` for this tenant | Total transactions ever opened. Includes every state (live, terminal, compromised). |
| **Transitions** | `count(txn_transitions)` | Total state transitions ever written. One per row in the audit chain. Always ≥ Records (at minimum each record has a `_init`). |
| **Accounts** | `count(accounts)` | Distinct account rows. One per `(owner_actor_type, owner_actor_id, name, currency)`. |
| **Compromised** | `count(txn_records where compromised = true)` | Records flagged by the reconciler as failing integrity checks (hash chain break, posting drift, etc.). Red when > 0. Investigate immediately — these are quarantined from further transitions. |
| **Open anomalies** | `count(txn_anomalies where resolved_at is null)` | Reconciler-detected issues that haven't been resolved. Yellow when > 0. Drill into the **Anomalies** page. |
| **Outbox pending** | rows with `delivered_at IS NULL AND failed_at IS NULL AND attempts = 0` | Events never attempted. Should drain quickly if a delivery worker is running. |
| **Outbox in-flight** | rows with `delivered_at IS NULL AND failed_at IS NULL AND attempts > 0` | Events that have been picked up at least once but not yet succeeded or terminally failed. A rising number indicates retries in progress. |
| **Outbox terminal** | rows with `delivered_at IS NOT NULL OR failed_at IS NOT NULL` | Events that finished (delivered or gave up). |
| **Scheduled** | `count(txn_scheduled where status = 'pending')` | Future transitions queued for the scheduler. |
| **Scheduled due** | `count(txn_scheduled where status = 'pending' AND run_at <= now())` | Scheduled rows whose fire time has passed but the scheduler hasn't moved them out of `pending`. Yellow when > 0 — likely a stuck or slow scheduler worker. |

### Schema versions table

Per-version row count showing how migrations have re-shaped the tenant's data.

| Column | Meaning |
|---|---|
| **Version** | The `schema_version` integer stamped on `txn_records` / `txn_transitions` at write time. |
| **Records** | How many records were written under that version. |
| **Transitions** | How many transitions were written under that version. |

A spread across many versions means migrations have happened. Old versions
shrinking over time is normal if records have been archived; never-shrinking
old versions are fine — Loki doesn't rewrite history.

---

## Schema (`/schema`)

`GET /api/v1/schema`

The compile-time definition the server boots with. Not a runtime count — same
output regardless of tenant data.

| Section | Column | Meaning |
|---|---|---|
| **Header** | `Schema · <tenant>` and `version <n>` | The active tenant id + the schema's declared `version` field. |
| **Actors** | **Type** | An `actor` declared in the schema (e.g. `user`, `merchant`). Actors own accounts. |
| | **Accounts** | All accounts an actor of this type implicitly has, formatted `name:currency` (e.g. `wallet:USD · escrow:USD`). |
| **Transaction types** | **Type** | One transaction kind declared in the schema (e.g. `payment`). |
| | **Initial** | The state every new record of this type starts in. |
| | **States** | Reachable states (initial first). Read it as a state machine alphabet. |
| | **Terminal** | States that allow no further transitions. Once a record is in a terminal state, it's frozen. |
| | **Transitions** | All transition names declared on this type, joined by ` · `. |

---

## Flows (`/flows`)

`GET /api/v1/tenants/:tid/flows`

How instances of each transaction type are distributed across states **right now**.

| Column | Meaning |
|---|---|
| **Type** | Transaction type. Click to open the per-flow detail page. |
| **Total instances** | Records of this type for this tenant (matches Overview's Records broken down by type). |
| **By state** | Live count per state, e.g. `pending: 12 · captured: 340 · refunded: 2`. Adds up to **Total instances**. |

### Flow detail (`/flow/:txnType`)

`GET /api/v1/tenants/:tid/flows/:txnType` plus the SSE stream
`/api/v1/tenants/:tid/stream/flows/:txnType` for live count ticking.

**State machine SVG** — circular layout, one node per state.
- Initial state: distinguished node style.
- Terminal states: filled (vs. open-stroke for active states).
- Number under each node = current instance count in that state. **Updates live** as transitions fire.
- Edges drawn between states; thickness scaled to the number of times that transition fired in the recent window; the heaviest half are highlighted in the accent colour.
- Hover an edge: tooltip shows the transition name, count, and last fire time.

**Transitions table** below the diagram:

| Column | Meaning |
|---|---|
| **Name** | Transition name as declared in the schema. |
| **From** | Source state(s). When a transition has multiple legal sources, they're joined with ` | `. |
| **To** | Destination state. |
| **By** | Actor types allowed to trigger this transition. `—` if any actor may trigger it. |
| **Count** | How many times this transition has fired in the dashboard's window. |
| **Last fire** | Timestamp of the most recent fire (local time). |

---

## Transactions (`/transactions`)

`GET /api/v1/tenants/:tid/transactions` with SSE `/stream/transitions` for the live badge.

The list of recent transaction records (across all types).

| Column | Meaning |
|---|---|
| **ID** | First 8 chars of the record's UUID. Clickable — opens the detail page. |
| **Type** | Transaction type (matches Flows page). |
| **State** | Current state. Green pill normally; red pill if the record is compromised. |
| **Updated** | `updated_at` from `txn_records` — when the last transition was applied. |
| **Compromised** | Red `compromised` pill if `compromised = true`, else blank. See Anomalies for *why*. |

**`● live`** badge ticks each time a new transition lands anywhere. Use the
`refresh` link to redraw the table with the freshest rows; live updates only
change the count, not the table content.

### Transaction detail (`/transactions/:id`)

`GET /api/v1/tenants/:tid/transactions/:id` + `/trace`.

| Card | Meaning |
|---|---|
| **State** | Current state. Red if compromised. |
| **Version** | Optimistic-concurrency version (`txn_records.version`). Increments by 1 per applied transition. |
| **Schema version** | The schema migration generation under which the record was written. |

**Trace table** — every transition in chronological order:

| Column | Meaning |
|---|---|
| **Name** | Transition name (or `_init` for the synthetic genesis transition). |
| **From → To** | State move. From may be `—` for `_init`. |
| **Actor** | `type:id` of who/what fired it. |
| **When** | `occurred_at` timestamp. |
| **Hash** | First 12 chars of the hash-chain `row_hash`. Each row's hash incorporates the previous one — tampering breaks the chain and the reconciler flags the record compromised. |

---

## Actors (`/actors`, `/actors/:type`, `/actors/:type/:id`)

Three drill-down pages. Actor cells in other pages (e.g. the transaction trace's
**Actor** column) link straight to `/actors/:type/:id`.

### Categories index (`/actors`)

`GET /api/v1/tenants/:tid/actors`

| Column | Meaning |
|---|---|
| **Type** | An actor type declared in the schema (e.g. `customer`, `rider`). Click to list ids of this type. |
| **With accounts** | Distinct `owner_actor_id` count on the `accounts` table — every actor of this type that has *ever* had an account on this tenant. Grows monotonically with sign-ups; not a measure of activity. |
| **Active (7d)** | Distinct `actor_id` count on `txn_transitions` whose `occurred_at` is within the last 7 days. The honest "how many of these actors actually did something this week" number. |
| **Accounts owned** | The accounts every actor of this type implicitly has, formatted `name:currency`. |

### Per-type list (`/actors/:type`)

`GET /api/v1/tenants/:tid/actors/:type?limit=100[&cursor=…]`

Flat list of actor IDs. Cursor-paginated — the **Load more** button at the
bottom fetches the next page (HMAC-signed cursor, server-side keyset
ordering on the id). The page-counter shows how many rows are currently
loaded.

### Actor detail (`/actors/:type/:id`)

Multiple endpoints feed this page:

| Endpoint | Used for |
|---|---|
| `GET /api/v1/tenants/:tid/actors/:type/:id` | Account list + balances. |
| `GET /api/v1/tenants/:tid/actors/:type/:id/summary?since=…[&until=…]` | The Activity panel cards (transitions / credited / debited). |
| `GET /api/v1/tenants/:tid/actors/:type/:id/transactions?limit=50[&cursor=…]` | Cursor-paginated Recent transactions table. |

#### Activity panel (with range picker)

The time window is selectable: **1 hour / 24 hours / 7 days / 30 days /
90 days / All time**, plus **Custom…** which reveals two
`datetime-local` inputs. Selection is persisted in `localStorage`
(`loki:actor-range`) so it sticks across navigations.

Two complementary perspectives:

**Headline cards — account perspective ("what happened to this actor's books"):**

| Card | Meaning |
|---|---|
| **Transitions on books · `<range>`** | Number of distinct transitions whose postings landed on accounts this actor owns, regardless of who fired them. This is the right metric for an accounting-style view — when a rider confirms a delivery, the firing actor is Driver but the transition still debits Company.escrow and credits Company.revenue, so it appears on Company's "on books" count. |
| **Credited to books · `<range>`** | Sum of credit-direction postings on this actor's accounts. |
| **Debited from books · `<range>`** | Sum of debit-direction postings on this actor's accounts. |

**Sub-line — initiated perspective ("what this actor itself did"):**

A single muted line below the cards: `Initiated by this actor: N
transitions · credited X · debited Y`. Use this for actor-action
accountability (e.g. "how many confirms did this driver tap?", "how many
admin overrides did the platform fire?"). It will often be smaller than
the headline cards because most transitions affecting an actor's books
are fired by other actors (Drivers fire confirms, Processors fire
webhook credits, Sweepers fire expirations, etc.).

#### Accounts table

| Column | Meaning |
|---|---|
| **Name** / **Currency** | As declared on the schema for this actor type. |
| **Balance** | Live balance (sum of postings) in major units with the currency symbol where known (`$`, `€`, `£`, `₦`, `KSh `, `GH₵`, `R`); other currencies render as `CCY 1,234.00`. |

#### Recent transactions

Cursor-paginated. **Important caveat:** the list shows every record where
this actor either (a) created the record, (b) fired a transition on it, or
(c) is named in the record's `participants` JSON. If a payment was
processed by gateway A but actor B (e.g. another processor, or the
platform) is also a named participant, it will appear under B's page too.
This is intentional — it surfaces every relationship — but can surprise
when actor types you think of as "primary" overlap.

---

## Anomalies (`/anomalies`)

`GET /api/v1/tenants/:tid/anomalies?unresolved=true` plus SSE `/stream/anomalies`.

Open (unresolved) anomalies — reconciler findings that need human attention.

| Column | Meaning |
|---|---|
| **Detected** | `detected_at` — when the reconciler found it. |
| **Check** | Which integrity check fired: `transitions` (chain break), `drift` (balance ≠ Σpostings), `state` (state mismatch with hash), or `keys` (key lifecycle violation). |
| **Severity** | `warn` (grey), `error` (yellow), or `critical` (red). |
| **Txn** | First 8 chars of the txn UUID this anomaly is attached to (if any — drift can be account-only, in which case `—`). |

**`● live`** ticks for each new anomaly emitted by the stream.

---

## Outbox (`/outbox`)

`GET /api/v1/tenants/:tid/outbox`

Domain events queued for downstream delivery (webhooks, message queues, etc.).

| Column | Meaning |
|---|---|
| **ID** | First 8 chars of the outbox row UUID. |
| **Event** | The event name written by the originating transition. |
| **Status** | Derived from columns, not stored directly: |
| | `pending` — `delivered_at NULL`, `failed_at NULL`, `attempts = 0` (untouched). |
| | `in_flight` — `delivered_at NULL`, `failed_at NULL`, `attempts > 0` (being retried). |
| | `terminal` — `delivered_at NOT NULL` (delivered) **or** `failed_at NOT NULL` (gave up). Note: the dashboard collapses success and terminal-failure into one bucket here; check the row's `last_error` to distinguish. |
| **Attempts** | Number of delivery attempts so far. |
| **Next attempt** | `next_attempt_at` — when a worker may pick the row up again (or when it last did, for terminal rows). |

---

## Scheduler (`/scheduled`)

`GET /api/v1/tenants/:tid/scheduled`

Future transitions queued to fire at a specific time.

| Column | Meaning |
|---|---|
| **ID** | First 8 chars of the scheduled-row UUID. |
| **Name** | The transition name that will fire when the time arrives. |
| **Run at** | `run_at` — when the scheduler should fire this. Past = overdue. |
| **Status** | `pending` (waiting to fire), `completed` (fired successfully), `cancelled` (cancelled before firing), or `failed` (firing raised an error — see `last_error` server-side). |
| **Attempts** | How many times the scheduler has tried to fire this row. > 1 means retries. |

---

## Holds (`/holds`)

`GET /api/v1/tenants/:tid/holds`

Funds reserved against an account but not yet captured (think: pre-auth on a card).

| Column | Meaning |
|---|---|
| **ID** | First 8 chars of the hold UUID. |
| **Amount** | Amount held, in minor units, right-aligned. |
| **Status** | `placed` (active, funds reserved), `released` (returned to caller), `expired` (timed out without capture), or `captured` (consumed by a follow-up transition). |
| **Placed** | When the hold was created. |
| **Released** | When the hold left `placed` (or `—` if still placed). |

---

## Disputes (`/disputes`)

`GET /api/v1/tenants/:tid/disputes`

Chargebacks / disputes opened on transactions.

| Column | Meaning |
|---|---|
| **ID** | First 8 chars of the dispute UUID. |
| **Status** | `open` (yellow), `resolved_customer` (refunded to customer), `resolved_merchant` (merchant kept the funds), or `expired` (deadline passed without resolution). |
| **Opened** | When the dispute row was created. |
| **Reason** | Free-form reason string supplied at open time, or `—`. |

---

## Reconciler (`/reconciler`)

`GET /api/v1/tenants/:tid/reconciler/state` + `/runs`, with SSE `/stream/reconciler` updating watermarks live.

The reconciler runs the four integrity checks listed below and remembers
how far each one has scanned via a watermark (a ULID transition id).

### Watermarks table

| Column | Meaning |
|---|---|
| **Check** | One of: |
| | `transitions` — hash-chain integrity (each row's `prev_hash` matches the previous row's `row_hash`). |
| | `drift` — for each account, `balance` equals the sum of its postings. |
| | `state` — `txn_records.state` is consistent with the latest transition. |
| | `keys` — txn-key lifecycle (no fabricated keys, expired keys flipped). |
| **Watermark** | The highest transition ULID this check has examined. New transitions written after this point haven't been seen yet. `—` if the check hasn't run. |
| **Last sweep** | `updated_at` on the watermark row — when the reconciler last advanced this watermark. |
| **Full sweep** | Reserved column — not tracked on the storage layer today, so always `—`. |

### Recent runs table

Dashboard-triggered reconciler runs only (background runs aren't in this list).

| Column | Meaning |
|---|---|
| **Run** | Run id. |
| **Started** | When the run began. |
| **Duration** | Wall-clock duration of the run. |
| **Anomalies** | Number of anomalies recorded during this run. |
| **Status** | `ok` (green) — completed cleanly; anything else (red) — failed mid-sweep. |

---

## FX (`/fx`)

`GET /api/v1/tenants/:tid/fx?base=<CCY>&quote=<CCY>&limit=200`

The currency time series for a chosen base→quote pair. Currencies are pulled
from the schema's declared account currencies (the only ones the server will
accept).

### Controls

| Control | Meaning |
|---|---|
| **Base** | The "1 unit of which currency" side. |
| **Quote** | The currency it's expressed in. |
| **Load** | Fetch the series. The pair is persisted in `localStorage` (`loki:fx`) so the page comes back where you left it. |

Picking the same currency on both sides shows a "pick two different
currencies" notice; nothing is fetched.

### Series table

| Column | Meaning |
|---|---|
| **Fixed at** | `fixed_at` — the moment the rate applies to (typically when the source published it). |
| **Rate** | The actual decimal rate (up to 18 fractional digits). |
| **Source** | A string identifier of who published this rate (e.g. `openexchange`, `manual`). |
| **Expires** | When the rate stops being valid (`—` if open-ended). |
| **Published** | `created_at` — when the row was written to Loki. Usually equal-or-after **Fixed at**. |

---

## Live updates (where the `● live` badge appears)

| Page | Stream endpoint | Event |
|---|---|---|
| Flow detail | `/api/v1/tenants/:tid/stream/flows/:txnType` | `flow-counts` — updates per-state instance counts inside the SVG. |
| Transactions | `/api/v1/tenants/:tid/stream/transitions` | `transition` — ticks the badge counter. |
| Anomalies | `/api/v1/tenants/:tid/stream/anomalies` | `anomaly` — ticks the badge counter. |
| Reconciler | `/api/v1/tenants/:tid/stream/reconciler` | `reconciler-state` — replaces the watermarks table with the latest snapshot. |

All other pages are poll-on-load. Use the **refresh** link (Transactions, Anomalies) or reload to re-fetch.
