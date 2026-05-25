# Sync Audit — Data flow integrity from Supabase ↔ local SQLite ↔ memory cache

> Last updated: 2026-05-25. Companion to ARCHITECTURE.md §3–5. Read that first
> if you haven't — this doc focuses specifically on the four data-flow
> directions and what we guarantee about each.

The goal of this audit is to lock down the invariants that protect against
silent data loss and cross-tenant leakage. There are **four directions** data
can flow between the three persistence layers, and each has different failure
modes. The matrix below names every transformation we apply, where it lives,
and what would break if it stopped working.

---

## The three layers

| Layer | What | Read by | Written by |
|---|---|---|---|
| **Supabase** (`public.*`) | Authoritative server-side store. Postgres with RLS policies that scope every row to `organization_id`. | `SyncPuller`, `storageService.fetchAllPagesFromSupabase`, `InitialSync` | `SyncWorker.pushBatch`, `storageService.saveData` (direct online path) |
| **Local SQLite** (`mdxera.db`) | Durable mirror on disk. Owned by Tauri plugin-sql. Schema lives in `src/core/db/migrations/`. | `hydrateMemoryCacheFromSqlite`, `storageService.getData` (offline fallback), `App.tsx` GL/configuration lookups | `SyncPuller.upsertLocalRow`, `storageService.persistLocalRowToSqlite`, `InitialSync.bulkInsertAdapted` |
| **Memory cache** (`memoryCache: Record<string, any[]>`) | Hot in-memory cache the legacy app reads from. Module-scoped in `services/storageService.ts`. | Every React component via `storage.fetchX()` / `storage.getData()` | `storage.saveData()`, `hydrateMemoryCacheFromSqlite` |

---

## The four directions

### Direction 1 — **Pull**: Supabase → Local SQLite

**Trigger:** `SyncPuller.pullDeltaFromSupabase` (every 30s when online), `InitialSync.runForegroundSync` (first-time setup), `InitialSync.startBackgroundSync` (transactional history).

**Pipeline:**
```
supabase.from(table).select('*').eq('organization_id', orgId).gt(deltaCol, since)
  → mirrorOwnerIdColumns(table, row)         ← NEW: copies created_by_id into user_id
  → adaptRowForSqlite(table, row)            ← drops unknown columns, JSON-encodes nested values,
                                               bool→0/1, fills NOT NULL defaults
  → conflictResolver.resolveConflict()       ← last-write-wins on updated_at; local 'pending' wins
  → db.upsert(table, adapted)                ← INSERT OR REPLACE
```

**Guarantees:**
- ✅ `organization_id` filter is mandatory — no cross-tenant data ever enters local SQLite.
- ✅ Unknown columns dropped silently (column drift is non-fatal — handled by migrations 9–12).
- ✅ Pending local rows aren't overwritten by remote (`_sync_status = 'pending'` guard in `SyncPuller`).
- ✅ `created_by_id` from Supabase mirrors into local `user_id` for owner-tracked tables (legacy reads still work).

**Failure modes addressed:**
| Symptom | Fix | Location |
|---|---|---|
| Local row missing columns the production web app shows (e.g. `customer_group`, `area`, `district`) | Migrations 10, 11, 12 add the columns; `_sync_meta` is cleared to force a re-pull. | `src/core/db/migrations/010_party_master_columns.ts`, `011_master_schema_completeness.ts`, `012_created_by_id_remaining.ts` |
| Local SQLite table doesn't exist yet | `adaptRowForSqlite` returns null → SyncPuller skips silently. | `src/core/sync/columnFilter.ts:84` |
| Server lacks a table (e.g. `customer_price_list` on older Supabases) | `_permanentlyMissingTables` set added; skipped for the session, no repeated 404s. | `src/core/sync/SyncPuller.ts:53` |
| Pulled rows lose `created_by_id` because local schema lacks the column → legacy `user_id` reads return NULL | `mirrorOwnerIdColumns` copies `created_by_id → user_id` before adapting. | `src/core/sync/SyncPuller.ts:23` |

---

### Direction 2 — **Hydrate**: Local SQLite → Memory cache

**Trigger:** `hydrateMemoryCacheFromSqlite(orgId)` runs on every boot (fire-and-forget) and after the foreground InitialSync completes.

**Pipeline:**
```
db.select('SELECT * FROM ${table} WHERE organization_id = ?', [orgId])
  → decodeSqliteRow(row)                     ← parses SQLITE_JSON_COLUMNS + auto-detects JSON-looking
                                               strings; bool restoration
  → toCamel(row)                             ← snake_case → camelCase for the legacy app
  → memoryCache[STORE_KEY].push(decoded)
  → memoryCacheOrgScope[STORE_KEY] = orgId   ← guards against cross-org reads
```

**Guarantees:**
- ✅ `memoryCacheOrgScope` tracks which org's data the cache holds. If the user switches orgs, the cache is invalidated, not leaked.
- ✅ All JSON columns are parsed back into native objects/arrays before legacy components read them.
- ✅ `_sync_status`, `_local_only`, and other underscore-prefixed columns are excluded from what the legacy app sees.

**Failure modes addressed:**
| Symptom | Fix | Location |
|---|---|---|
| `configurations.masterShortcuts.map is not a function` blank screen | Auto-detect of `[`/`{`-prefixed strings + explicit `SQLITE_JSON_COLUMNS` list | `services/storageService.ts:73` |
| 15s hydration timeout during InitialSync writes | Fire-and-forget, no timeout; emits `mdxera:hydrate-complete` when done | `services/storageService.ts` `hydrateMemoryCacheFromSqlite` |
| Stale memoryCache survives org switch | `memoryCacheOrgScope[storeKey] !== user.organization_id` check on every read | `services/storageService.ts` `getData` |

---

### Direction 3 — **Online push**: memory cache → Supabase (direct)

**Trigger:** `storageService.saveData(table, payload, user)` when `navigator.onLine === true` and the user is connected.

**Pipeline:**
```
saveData()
  → enforce organization_id              ← line 893: dbPayload.organization_id = user.organization_id
  → enforce user_id (if owner-tracked)   ← line 896-898: from currentUser
  → getSupabasePayload(table, payload)   ← per-table picker, ownership mapping, UUID guard,
                                            sourcePurchaseOrderId→reference_doc_number, etc.
  → toSnake(remotePayload)               ← camelCase → snake_case
  → pushWithDriftLearning(table, snake, supabase.insert/upsert)
                                          ← strips columns previously confirmed missing on this org's
                                            Supabase; learns + retries on PGRST204
  → fromSupabase(result)                  ← server response normalised back to camelCase + created_by_id→user_id
  → persistLocalRowToSqlite(synced)       ← mirror back into local SQLite
```

**Guarantees:**
- ✅ `organization_id` is set unconditionally (won't fall through any callback chain).
- ✅ Server-managed columns (`control_gl_id`, `currentBalance`) are stripped — the auto_map trigger fills `control_gl_id` server-side.
- ✅ Schema drift (PGRST204) is learned per-org-per-column and persisted in `localStorage` with a 24h TTL revalidation.
- ✅ FK columns containing invalid UUIDs are null-ified, not silently dropped (so Supabase sees the intent).

**Failure modes addressed:**
| Symptom | Fix | Location |
|---|---|---|
| Customer push: `Control GL is auto-mapped from group and cannot be manually edited [P0001]` | `control_gl_id` is in `LOCAL_ONLY_COLUMNS.customers`/`suppliers` — let the trigger fill it | `src/core/sync/SyncWorker.ts:289-311` (canonical list also exported for online path) |
| Supplier push: `Could not find the 'brand_agencies' column [PGRST204]` | Dynamic drift cache learns the column for this Supabase deployment and strips it from future pushes | `src/core/sync/schemaDriftCache.ts` |
| Random "uuid = text" or "operator does not exist" 23xxx errors | UUID guard null-ifies invalid FK values; surfaces clear "Data Type Mismatch" error if it still fails | `services/storageService.ts:1132-1151` |

---

### Direction 4 — **Offline-queued push**: memory cache → Supabase (via `_sync_queue`)

**Trigger:** `storageService.saveData(table, payload, user)` when `!navigator.onLine` OR `isNetworkError(err)` after a failed online attempt.

**Pipeline (offline-save side):**
```
saveData()
  → enforce organization_id, user_id
  → memoryCache[STORE_KEY] = patched payload   ← instant UI update
  → persistLocalRowToSqlite(payload, 'pending') ← mirror to SQLite via columnFilter
  → enqueueForSync(table, isUpdate, payload, orgId)
      → SyncQueue.enqueue(op, table, recordId, JSON.stringify(payload), orgId)
```

**Pipeline (later, SyncWorker push):**
```
SyncWorker.processSyncQueue()
  → SyncQueue.getPending() ordered by created_at ASC
  → groupByTable() then sort by TABLE_PRIORITY (FK-safe order)
  → for each table: pushBatch(table, records)
      → JSON.parse each payload
      → normalizeForSupabase(row, table)
          ↑↑↑ this is the function our parity test pins ↑↑↑
          ├── strip BOOKKEEPING_KEYS (_sync_status, etc.)
          ├── strip LOCAL_ONLY_COLUMNS[table]
          ├── strip schemaDriftCache.getMissingColumns(table)
          ├── camelToSnake(remaining keys)
          ├── OWNER_TRACKING_TABLES → map user_id → created_by_id, drop user_id
          ├── purchases → map sourcePurchaseOrderId → reference_doc_number
          └── UUID guard on all FK columns
      → pushWithDriftLearning(table, payloads, supabase.upsert)
      → markEntityRowsSynced(table, ids)     ← flips local _sync_status to 'synced'
      → markDone() the queue rows
      → on FK violation → deferRecord() (re-queue without incrementing attempts)
      → on PGRST204 → schemaDriftCache.recordMissingColumns + retry inside pushWithDriftLearning
      → on real failure → markFailed (3 attempts then 'failed')
```

**Guarantees:**
- ✅ Same output shape as Direction 3 — **verified by `normalizeForSupabase.test.ts` (75 tests)**.
- ✅ `organization_id` survives every transformation (one test per table in the parity suite asserts this).
- ✅ FK-safe push order ensures masters land before transactions that reference them.
- ✅ Network errors auto-fall-back to the queue (no silent loss from a connection blip mid-save).
- ✅ Failed records auto-reset to 'pending' on next app start so a now-fixed schema drift gets re-attempted.
- ✅ DELETE ops queue too (since this audit) — offline deletes no longer silently lost.

**Failure modes addressed:**
| Symptom | Fix | Location |
|---|---|---|
| Offline-created bills arrive at Supabase with `created_by_id = NULL` | Ownership mapping added to `normalizeForSupabase`; one-shot backfill SQL provided | `src/core/sync/SyncWorker.ts:165-187` |
| Offline deletes silently lost on reconnect | `deleteData` now enqueues a DELETE op when offline, and falls back to the queue on network failure when online | `services/storageService.ts:1221` |
| Offline-created purchases lose their PO linkage | `sourcePurchaseOrderId → reference_doc_number` mirror added to `normalizeForSupabase` | `src/core/sync/SyncWorker.ts:194-204` |
| Same column rejected by every cycle (1-hour log spam) | `schemaDriftCache` learns + persists for 24h before re-attempting | `src/core/sync/schemaDriftCache.ts` |
| Stale 'syncing' rows from a previous crash blocked the queue | `SyncQueue.resetStuck()` flips them back to 'pending' on app start | `src/core/sync/SyncQueue.ts:79` |

---

## Organization isolation — the multi-tenant invariant

This is the single most important property. Every row in every layer carries
`organization_id`, and every read/write/policy enforces it.

| Layer | Enforcement |
|---|---|
| Supabase | Row Level Security (RLS) policies on every table. `USING (organization_id = public.get_my_org_id())`. A row can only be selected or modified if it belongs to the caller's org. |
| Local SQLite | `organization_id TEXT NOT NULL` on every table. Every `SELECT` filters on it explicitly. `_sync_queue` carries it for every queued op. |
| Memory cache | `memoryCacheOrgScope` tracks which org's data the cache holds. On org switch, the entire cache is dropped before repopulating. |

The parity test suite (`src/core/sync/__tests__/normalizeForSupabase.test.ts`)
contains a dedicated section that loops over every syncable table and asserts
that `organization_id` survives normalization. Adding a new table to
`SYNCABLE_TABLES` requires adding it to that test loop too.

---

## Schema-drift handling (both directions)

Two complementary mechanisms cover the two drift directions:

**Server-has, local-doesn't (PULL direction):** `adaptRowForSqlite` drops the
unknown column silently. We add the column to local SQLite via a migration
(`010_party_master_columns.ts`, `011_master_schema_completeness.ts`,
`012_created_by_id_remaining.ts`), then clear `_sync_meta` so the next pull
populates it for existing rows.

**Local-has, server-doesn't (PUSH direction):** `schemaDriftCache` learns from
PGRST204 errors at runtime, persists to `localStorage`, and strips the column
from every subsequent push for 24 hours. Then re-attempts — if the server has
since gained the column, the entry self-clears. If not, the strip continues
for another 24 hours.

Combined: schema migrations applied on either side propagate to the client
automatically within one sync cycle (pull) or one upsert (push), with at most
24 hours of latency for newly-added server columns to be detected.

---

## The drift cache → DevTools surface

```js
// See what columns the client has learned the server doesn't have:
console.table(window.__mdxera.snapshotSchemaDrift().suppliers)

// After upgrading your Supabase to a newer schema, force re-discovery:
await window.__mdxera.resetSchemaDriftCache()

// Auto-runs as part of:
await window.__mdxera.triggerFullResync()
```

---

## Adding a new table — checklist

1. Add the canonical Supabase schema as `supabase/<name>_schema.sql`.
2. Create a migration in `src/core/db/migrations/` that mirrors every column. Match types (text/INTEGER/REAL); store JSONB as TEXT; bool as INTEGER 0/1.
3. Add to `TABLE` and `SYNCABLE_TABLES` in `src/core/db/schema.ts`.
4. Add a `TABLE_PRIORITY` entry in `SyncWorker.ts` (FK ordering).
5. If the table is owner-tracked, add it to **all three** copies of `OWNER_TRACKING_TABLES`: storageService, SyncWorker, SyncPuller.
6. If the table has any local-only/computed fields, add them to `LOCAL_ONLY_COLUMNS` in SyncWorker.
7. If the table has JSON columns, list them in `SQLITE_JSON_COLUMNS` in storageService.
8. Add to the `allTables` loop in `normalizeForSupabase.test.ts` (the org-isolation assertion).
9. Add it to `FOREGROUND_TABLES` or `BACKGROUND_TABLES` in `InitialSync.ts`.
10. Run `npm test`. If the new table fails the org-isolation test, your migration's `organization_id` column is wrong.

---

## What still isn't covered (open items, prioritised)

1. **`bank_master` table is not in `SYNCABLE_TABLES` at all.** The payment-with-accounting flows (`recordCustomerPaymentWithAccounting`, `recordSupplierPaymentWithAccounting`) still hard-fail with "Payment posting requires online mode" because they need to look up bank GLs on Supabase directly. Adding `bank_master` to InitialSync + SYNCABLE_TABLES unblocks offline payments — biggest remaining unlock.

2. **Voucher numbering needs the Option B redesign** (see chat history for the discussion). The current dual system (legacy `currentNumber` increment + new `voucher_reservations` range allocation) produces visible inconsistencies (mixed `-2026` vs `-2026-27` FY format, Settings UI shows wrong "next number"). Design is in scope but implementation hasn't started.

3. **`customerService.ts` exports `saveCustomer` / `deleteCustomer` / `updateCustomer`** that don't enforce `organization_id`. Currently unused by the live UI (which goes through `storageService.saveData` instead), but it's a footgun if someone imports them later. Either delete the file or add an `organization_id` enforcement check.

4. **No CI test step.** The release workflow doesn't run `npm test`. Should be a one-line addition to `.github/workflows/release.yml`.

5. **`physical_inventory` uses `user_id` directly as FK** while other tables use `created_by_id`. The asymmetry is documented but it's a special case future maintainers will trip over.
