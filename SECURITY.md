# Security & data-handling guidance

Loki is a money-movement library. Several regulatory frameworks (PCI DSS for cardholder data, GDPR for EU personal data, regional finance regulators for payout flows) impose constraints that interact awkwardly with an append-only audit log. This document is the authoritative guidance — read it before storing anything sensitive.

## TL;DR

- **Never put a card PAN, CVV, or unsalted SSN in a Loki payload.** Use a token from your PSP / vault.
- **GDPR right-to-erasure on append-only history is hard.** Use payload encryption + crypto-shredding. See ["GDPR right-to-erasure"](#gdpr-right-to-erasure-crypto-shredding) below.
- **Default to encryption at rest** (`payloadCrypto`) for any tenant subject to PCI / GDPR / HIPAA.
- **Treat `txn_transitions.payload` as the only mutable-but-auditable surface.** Every other column is part of the integrity guarantee.

---

## What Loki stores per transition

| column | content | sensitivity |
|---|---|---|
| `txn_records` | id, type, state, version, participants (actor refs) | low — refs only |
| `txn_transitions` | id, by, from/to state, **payload**, hashes | depends on payload |
| `postings` | account_id, amount, direction | low — money math |
| `outbox` | event name, **payload** | depends on payload |
| `txn_anomalies` | check_name, **expected**, **observed** | depends on what triggered |
| `accounts` | actor ref, name, balance | low |

`payload` and the anomaly diagnostic columns are the only places where the application's free-form data ends up. Everything else is engine-defined and contains no caller-supplied content.

## What NEVER goes in a payload

| ❌ never | ✅ instead |
|---|---|
| Card PAN / CVV / track data | a tokenized reference (Stripe `pm_...`, your vault's id) |
| Bank account number | last 4 digits + a vault token, no full account number |
| Unsalted national ID, passport, SSN | a hashed identifier or your own opaque key |
| Plaintext password / API secret | nothing — these never belong in a transaction record |
| Free-text customer chat / email body | a reference to wherever your messaging stack stores it |

The constraint isn't that Loki can't hold these — it's that putting them in an append-only audit log with reconciliation hash chains makes them very hard to remove, and PCI / GDPR explicitly require removal in some cases.

---

## PCI DSS

Loki is not, by itself, in PCI scope. It becomes in-scope **only** if your payloads include cardholder data. The recommended posture:

1. Tokenize at the network edge — your PSP returns a token (`pm_xxx`, `tok_xxx`); your application never holds raw card data.
2. Loki's payload stores the token and a last-4 indicator. Both are non-sensitive under PCI.
3. The PCI scope stays inside the PSP and the (tiny) tokenization boundary. Loki is out-of-scope.

If you must store cardholder data in a payload (e.g. a regulated B2B PSP processor), enable `payloadCrypto` with an HSM-backed encrypt/decrypt and ensure your KMS access logs are audited. The hash chain is computed over plaintext, so a key rotation **does not** invalidate historical hashes — see the encryption section in `docs.md`.

---

## GDPR right-to-erasure (crypto-shredding)

Append-only history is fundamentally at odds with "delete all my data on request." There are three viable patterns; pick one and document it in your privacy policy.

### Pattern A — separate the personal data

The cleanest approach. Loki holds a stable opaque identifier (your customer's internal id), and the personal-data-bearing fields (name, email, address) live in a separate `customers` table outside Loki.

- **Erasure.** DELETE / anonymize the row in `customers`. Loki's records still reference the opaque id — they're now references to "deleted customer 12345" rather than to "Jane Doe."
- **Cost.** Higher boundary discipline — consumer code has to JOIN to `customers` to render a name.
- **Recommended for.** Most consumer-facing products.

### Pattern B — crypto-shredding via per-customer key

If you want personal data inside the Loki payload, encrypt every customer's payloads under a per-customer key. Erasure = destroy the key.

- Keys live in your KMS, indexed by customer id.
- `payloadCrypto.encrypt` / `decrypt` route through the right key based on the payload's customer reference (e.g. `payload.customerId`).
- DELETE the customer's key in the KMS. Their old payloads become unreadable and are effectively deleted.
- The hash chain is computed over plaintext, so the chain integrity is preserved — but reconciliation **cannot decrypt the dead payload to verify the hash**, and a `hash_chain_break` anomaly will fire.
- Mitigate by either: tagging shredded transitions in `txn_anomalies` so the reconciler skips them, or by maintaining a "shredded" set in your KMS that the reconciler consults.
- **Recommended for.** Tenant-scoped financial workloads where personal data is integral to the audit trail.

### Pattern C — pseudonymization at write time

Hash personal-data fields with a per-customer salt and store only the hash. Erasure = destroy the salt.

- Doesn't help if the field has low entropy (a hashed email is trivially attacked with a rainbow table).
- Useful for transaction-level analytics where you need to count distinct customers without identifying them.
- **Recommended for.** Internal analytics, almost never the primary erasure mechanism.

### Right-to-access (Article 15)

Use `engine.forTenant(tenantId).queries.actor(customer).trails(...)` to dump every record the customer touched. The shape is JSON-friendly and matches the structure of an Article 15 export.

---

## Tenant isolation

Loki uses Postgres row-level security to scope every per-tenant query by `loki.tenant_id`. The runtime user MUST NOT have `BYPASSRLS`. To verify:

```sql
SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('loki_app', 'loki_admin');
```

Both should return `rolbypassrls = false`. If `loki_admin` has it set, change it — even admin operations should respect RLS unless they go through `connection.asAdmin(...)`.

The reconciler runs as `loki_admin` (no tenant GUC), so cross-tenant integrity scans require admin role privileges. This is intentional — operators should not be able to run a reconciler pass and incidentally see another tenant's data unless they explicitly assume the admin role.

---

## Secrets & credentials

- `DATABASE_URL` belongs in your secret manager, not your env file in source control.
- `payloadCrypto` and HMAC keys (`@loki/hmac` / `signOutboxPayload`) belong in a KMS, not the runtime env. Pass them at boot via your secret manager → in-memory delivery, never written to disk.
- Loki itself never logs the connection string or payload contents at any level. If you wrap the engine in custom logging, **explicitly redact** payloads — your hooks see plaintext.

---

## Reporting a vulnerability

If you find a security issue in Loki, please email **security@<your-org>.example** rather than opening a public issue. We aim to acknowledge within one business day and ship a fix within two weeks for confirmed issues. Please include:

- Affected version / commit.
- Reproduction steps (a failing test is ideal).
- Impact assessment if you have one.

The package is small and the threat model is clear; we don't expect a long backlog.
