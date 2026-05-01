# Loki

> Schema-agnostic, plug-in transaction tracking and bookkeeping library — Prisma for money-movement records.

You declare your transaction shapes, actors, accounts, and rules in a TypeScript schema, and Loki gives you a typed runtime that handles the bookkeeping correctly by construction: idempotency, audit logging, state-transition guards, double-entry invariants, capability gating, multi-tenancy, reconciliation, tamper detection, and adapter-mediated PSP integration.

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
