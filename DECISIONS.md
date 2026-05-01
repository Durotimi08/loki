# Loki — Locked Decisions

These resolve §19 of `project.md` so M1 can land without backtracking. Each decision lists the chosen option and the reason it was preferred.

| § | Decision | Choice | Why |
|---|----------|--------|-----|
| DSL surface | File vs in-code | **In-code TS builders** (`defineTransaction(...)` etc., assembled with `defineSchema(...)`) | Full TS inference end-to-end; no parser to maintain; codegen reads the TS module directly. Drizzle proved the model. |
| Storage | Postgres only or pluggable | **Postgres-only for v1** | The spec explicitly relies on Postgres-specific primitives (RLS, `FOR UPDATE SKIP LOCKED`, partial indexes, declarative partitioning). A storage abstraction would dilute correctness for hypothetical future stores. |
| Type generation | Codegen / runtime / TS plugin | **Codegen** into `@loki/client` (consumer-side) | Mirrors Prisma. Compile-time safety with zero runtime overhead. The TS schema feeds inference directly during authoring; codegen produces the typed client surface. |
| Currency precision | float / integer / library | **Integer minor units as `bigint`** | Matches the spec's explicit ban on floats. |
| Soft deletes | yes / no | **No** | Append-only is the package's defining invariant. |
| Hash function | SHA-256 / BLAKE3 / pluggable | **SHA-256 default, swappable via `Hasher` interface** | SHA-256 has the widest auditor familiarity. BLAKE3 is selectable when reconciliation is the bottleneck. |
| Reconciler placement | in-process worker / external CLI | **Both** — in-process worker shipped with `@loki/core`; `loki reconcile` CLI for external schedulers | Most consumers want the in-process path; ops teams that prefer Kubernetes CronJobs get the CLI. |
| Default tenancy mode | RLS / schema / DB | **Row-level (RLS)** | Most flexible default; the migrations generate RLS policies on every table. Schema-per-tenant and DB-per-tenant remain configurable. |
| Hook execution pool | shared / isolated | **Per-event isolated promise pools with bounded concurrency** | Slow handlers can't starve other events; a runaway PagerDuty hook never delays the outbox worker. |
| Adapter packaging | same repo / separate repos | **Same monorepo, separate packages, independent versions via Changesets** | Lets first-party adapters track core but ship on their own cadence. |
| Validator runtime | Zod / Valibot / native | **Standard Schema (`@standard-schema/spec`)** for payload validators | Zero hard dependency on a single validator. Consumers bring Zod, Valibot, ArkType, whatever validates. |
| Name | Ledger / Loki / TBD | **Loki** (working title; up for revision) | Matches the working directory; differentiates from "Hyperledger" / "QuickBooks ledger". |

## Toolchain

- **Package manager:** pnpm 10 with workspaces.
- **TypeScript:** 5.6+, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. ESM-first, dual ESM/CJS via `tsup`.
- **Lint/format:** Biome.
- **Tests:** Vitest. Unit tests inline; integration tests use Testcontainers (Postgres) once the engine lands in M1.5+.
- **Versioning:** Changesets.
- **Node engines:** `>=20`.

## Public surface (M1)

```ts
import {
  defineTenant,
  defineActor,
  defineTransaction,
  defineSchema,
} from '@loki/core'
```

Engine, client codegen, RLS migrations, reconciler, hooks, adapters, and reference schemas land in subsequent batches per the §18 milestone plan.
