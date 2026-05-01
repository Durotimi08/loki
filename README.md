# Loki

> Schema-agnostic, plug-in transaction tracking and bookkeeping library — Prisma for money-movement records.

You declare your transaction shapes, actors, accounts, and rules in a TypeScript schema, and Loki gives you a typed runtime that handles the bookkeeping correctly by construction: idempotency, audit logging, state-transition guards, double-entry invariants, capability gating, multi-tenancy, reconciliation, tamper detection, and adapter-mediated PSP integration.

## Status

Pre-alpha — building toward M1 of the [§18 roadmap](./project.md#18-roadmap). Public APIs will change.

| Milestone | Status |
|-----------|--------|
| Decisions locked | ✅ |
| Monorepo + tooling | ✅ |
| M1 — Schema DSL + types + validation | 🚧 in progress |
| M1 — Engine, idempotency, runtime client | ⏳ |
| M2+ | ⏳ |

## Repo layout

```
packages/
  core/           @loki/core         — schema DSL, engine, reconciler
  client/         @loki/client       — codegen target for the typed runtime client
  cli/            @loki/cli          — `loki migrate`, `loki reconcile`, `loki schema *`
  adapter-sdk/    @loki/adapter-sdk  — defineAdapter() for first- and third-party PSPs
  adapter-mocked/ @loki/adapter-mocked — deterministic in-memory PSP for tests
```

Reference schemas (`@loki/schemas-*`) and first-party adapters (`@loki/adapter-stripe`, etc.) land in M12–M13.

## Develop

```sh
pnpm install
pnpm tests
pnpm typecheck
pnpm lint
```

## License

Apache-2.0.
