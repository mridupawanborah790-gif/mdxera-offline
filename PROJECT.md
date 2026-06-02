# MDXera ERP — Project Reference

> Single source of truth for this repo. Replaces the older split files
> (`README.md`, `ARCHITECTURE.md`, `SYNC_AUDIT.md`, `RELEASING.md`). Update
> this file when seams change, migrations land, or major features ship.

---

## Table of contents
1. [What this is, in one paragraph](#1-what-this-is-in-one-paragraph)
2. [Quick start](#2-quick-start)
3. [Top-level layout](#3-top-level-layout)
4. [The dual-persistence problem](#4-the-dual-persistence-problem)
5. [Boot sequence](#5-boot-sequence)
6. [Sync layer (technical details)](#6-sync-layer-technical-details)
7. [Sync data flows (the four directions)](#7-sync-data-flows-the-four-directions)
8. [Voucher numbering](#8-voucher-numbering)
9. [POS save flow (offline-safe)](#9-pos-save-flow-offline-safe)
10. [Auth and persistent login](#10-auth-and-persistent-login)
11. [Per-user module visibility](#11-per-user-module-visibility)
12. [Inventory ↔ Material Master reconciliation](#12-inventory--material-master-reconciliation)
13. [Reports module conventions](#13-reports-module-conventions)
13a. [AI provider (Groq via Supabase Edge Function)](#13a-ai-provider-groq-via-supabase-edge-function)
14. [Service-material handling in POS](#14-service-material-handling-in-pos)
15. [Releasing](#15-releasing)
16. [Operations runbook](#16-operations-runbook)
17. [Development conventions](#17-development-conventions)
18. [Build / environment facts](#18-build--environment-facts)
19. [Failure-mode quick reference](#19-failure-mode-quick-reference)
20. [Open work / known gaps](#20-open-work--known-gaps)

---

## 1. What this is, in one paragraph

MDXera ERP is a Tauri-based desktop pharmacy ERP that wraps a legacy
React/Supabase web app. The web app (`App.tsx`, ~3300 LOC) was a thin
online-only client; it has been retrofitted with an **offline-first sync
layer** (Tauri SQLite + a custom SyncEngine) so it works without internet.
The two halves coexist: the legacy app still drives all UI and business
logic, but reads/writes are now bridged through SQLite and a sync queue
that pushes to Supabase in the background. There are real seams in this
design — most notably **two persistence layers** (an in-memory cache the
legacy app uses, plus the new SQLite store) — and most of the work in this
codebase has been bridging them safely.

---

## 2. Quick start

**Prerequisites:** Node.js 20+, Rust toolchain (for Tauri builds).

```bash
npm install
# Optional .env.local overrides:
#   VITE_SUPABASE_URL=...           override the hard-coded Supabase project URL
#   VITE_SUPABASE_ANON_KEY=...      override the hard-coded anon key
#   VITE_AI_FUNCTION=groq_ai        (default) which Edge Function to call for AI
#   VITE_AI_MODEL=...               override the AI model (see §13a)
# AI provider key (Groq) is set in Supabase Secrets, NOT in .env.local. See §13a.

npm run dev          # browser dev mode (Tauri-only features no-op)
npm run tauri:dev    # full desktop shell
npm run build        # production web build
npm run tauri:build  # produces installers under src-tauri/target/release/bundle/
npm test             # runs the Vitest parity + unit suite
npx tsc --noEmit     # type-check only
```

The Supabase URL + anon key are hard-coded fallbacks in
`src/core/db/supabaseClient.ts` and `src/core/sync/networkMonitor.ts`;
override with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` if you point
a build at a different project. AI provider config lives in §13a.

---

## 3. Top-level layout

```
mdxera-offline/
├── index.tsx                       Vite/React entry point
├── App.tsx                         LEGACY app component (~3300 LOC) — the live root
├── services/                       LEGACY services (root, pre-refactor)
│   ├── storageService.ts           ~3800 LOC — bridge between legacy memoryCache and SQLite
│   ├── indexedDbService.ts         IndexedDB shim (DISABLED — ENABLE_INDEXED_DB = false)
│   ├── supabaseClient.ts           Singleton @supabase/supabase-js client
│   ├── companyDefaultsService.ts   ensurePostingContext / loadDefaultPostingContext
│   ├── geminiService.ts            Gemini OCR / AI helpers
│   └── supplierService.ts
├── src/
│   ├── app/                        NEW app shell (UNUSED — kept for future cutover)
│   │   ├── App.tsx                 Slim shell with AuthProvider + SyncProvider + Router
│   │   ├── Router.tsx              Lazy routes (props don't match legacy components yet)
│   │   └── providers/
│   ├── core/
│   │   ├── auth/                   authService.ts, authStore.ts, rosterSync.ts, offlineAuth.ts
│   │   ├── components/
│   │   │   ├── feedback/           InitialSyncModal, BackgroundSyncBadge, SyncIndicator
│   │   │   ├── layout/             Header (Sync All), StatusBar, Sidebar, AppErrorBoundary
│   │   │   └── ui/                 Modal, AdminPasswordModal, Card, …
│   │   ├── db/
│   │   │   ├── client.ts           Singleton Tauri SQL plugin wrapper
│   │   │   ├── schema.ts           Table-name constants, SYNCABLE_TABLES
│   │   │   └── migrations/         Numbered local SQLite migrations
│   │   ├── sync/
│   │   │   ├── SyncBootstrap.tsx   Mounted in legacy App; orchestrates everything
│   │   │   ├── InitialSync.ts      Foreground + background bulk pulls
│   │   │   ├── SyncEngine.ts       Recurring 30s push/pull loop
│   │   │   ├── SyncPuller.ts       Delta pulls from Supabase → SQLite
│   │   │   ├── SyncWorker.ts       Pushes _sync_queue → Supabase
│   │   │   ├── SyncQueue.ts        SQLite _sync_queue CRUD
│   │   │   ├── columnFilter.ts     Schema-aware row adapter (JSON, NOT NULL defaults)
│   │   │   ├── conflictResolver.ts updated_at last-writer-wins
│   │   │   ├── schemaDriftCache.ts Per-org missing-column cache (24h TTL)
│   │   │   └── networkMonitor.ts   Online/offline detection
│   │   ├── voucher/voucherService.ts        Range-allocation invoice numbering
│   │   ├── utils/
│   │   │   ├── adminConfig.ts      Admin password for Module Hide/Unhide
│   │   │   ├── rbac.ts             Role-based access tree
│   │   │   └── materialType.ts     trading_goods / service_material / packaging policies
│   │   ├── visibility/
│   │   │   ├── moduleVisibilityStore.ts     Per-user Zustand store (localStorage backed)
│   │   │   └── useModuleVisibility.ts       Hook + nav filter helper
│   │   └── services/storageService.ts       Re-export bridge (@core/services/storageService)
│   └── modules/                    Per-feature React components (legacy props-drilled)
│       ├── configuration/components/ModuleVisibility.tsx  Per-user hide/unhide screen
│       ├── inventory/
│       │   ├── components/
│       │   │   ├── Inventory.tsx
│       │   │   ├── EditProductModal.tsx     Hosts "Create in Material Master…"
│       │   │   ├── SyncMaterialMasterModal.tsx   Bulk reconciliation modal
│       │   │   └── AddMedicineModal.tsx     Accepts `initialValues` for prefill
│       │   └── services/materialMasterSync.ts    Grouping + master creation + auto-link
│       ├── reports/components/Reports.tsx        Pagination, MM-YYYY, Ctrl+F/C
│       └── pos/components/POSPage.tsx
├── supabase/
│   ├── *.sql                       All historical schema / migration / fix scripts (flat)
│   │                               (root SQL files were consolidated here)
│   ├── functions/
│   │   └── _shared/reserve_voucher_range.sql   MUST be deployed manually
│   └── info_sql.txt                Notes
├── src-tauri/                      Rust shell
└── tsconfig.json                   Excludes src/app/**, powersync.ts, a couple of unused files
```

All historical SQL scripts now live under `supabase/` in a flat layout
matching the existing convention (`*_schema.sql`, `add_*.sql`, `fix_*.sql`,
`*_update.sql`). The only file renamed during consolidation was the
ex-root `schema.sql` → `supabase/uuid_refactor_schema.sql`, because the
canonical master schema already owned `supabase/schema.sql`.

---

## 4. The dual-persistence problem

The repo has **two parallel storage layers**:

| Layer | Lives in | Read by | Written by |
|---|---|---|---|
| **Legacy in-memory cache** (`memoryCache: Record<string, any[]>`) | `services/storageService.ts` (module-level) | All legacy React components via `storage.fetchX()` / `storage.getData()` | `storage.saveData()` and the bridge |
| **New SQLite store** (`mdxera.db`) | Tauri plugin-sql | New sync code (`SyncPuller`, `InitialSync`) and `SyncIndicator` | `SyncBootstrap`, `SyncEngine`, hydration |

IndexedDB exists in the legacy code but is **disabled**
(`ENABLE_INDEXED_DB = false` in `services/indexedDbService.ts`). That
means the legacy app's only persistent store is SQLite — but the legacy
app doesn't read from it directly. The bridge is
`hydrateMemoryCacheFromSqlite(orgId)` which copies SQLite rows into
`memoryCache` on app start (and after every InitialSync foreground
phase).

**Mental model:**
- SQLite is the durable store.
- `memoryCache` is the view the legacy UI reads from.
- Hydration warms the view from the store.
- Writes update both: `saveData()` updates `memoryCache` synchronously
  AND enqueues to `_sync_queue` (SQLite) for the SyncEngine to push to
  Supabase.
- Reads always go through `memoryCache`.

---

## 5. Boot sequence

1. `index.tsx` mounts `<AppErrorBoundary><App/></AppErrorBoundary>`.
   `App` is the **legacy** root `App.tsx`. `src/app/App.tsx` is NOT used.
2. Legacy `App.tsx` mounts. `isAppLoading=true` shows a spinner.
3. `useEffect` calls `storage.getCurrentUser()`:
   - Supabase session lookup first.
   - Falls back to `authService.restoreSession()` (Tauri plugin-store +
     local HMAC session) when Supabase has none — does **not** wipe IDB
     in that case. See §10 for the persistent-login wiring.
4. If a user is found:
   - Fire-and-forget `storage.hydrateMemoryCacheFromSqlite(orgId)`.
   - `setCurrentUser(user)` — triggers `<SyncBootstrap>` to mount.
   - `useModuleVisibilityStore.loadForUser(user.user_id)` loads per-user
     module-visibility from `localStorage`.
   - `storage.fetchProfile()` to get the freshest profile.
   - `loadData(user, 'initial')` — pulls from Supabase, hydrates React.
5. `SyncBootstrap`'s effect:
   - Warms up voucher ranges.
   - Checks `isForegroundComplete()` from `_initial_sync_state`.
   - **Foreground complete:** starts `SyncEngine`; kicks off background if
     needed.
   - **Not complete + online:** sets `phase='running'` (modal appears),
     runs foreground sync, then starts SyncEngine + background phase.
   - **Not complete + offline:** sets `phase='skipped'`.
6. `mdxera:hydrate-complete` fires when hydration finishes → legacy App
   re-runs `loadData('sync')` to refresh React state from the
   now-populated cache.

---

## 6. Sync layer (technical details)

### 6.1 Tables tracked

`src/core/db/schema.ts` declares two sets:
- `SYNCABLE_TABLES` — ~35 tables that mirror Supabase.
- Internal-only: `_sync_queue`, `_sync_meta`, `_local_auth`, `_migrations`,
  `_initial_sync_state`, `voucher_reservations`.

### 6.2 SyncBootstrap (`src/core/sync/SyncBootstrap.tsx`)

Single React component mounted by legacy App when `currentUser` exists.
Owns the lifecycle:
- Subscribes to window event `mdxera:resync-all` (Sync All button) —
  clears `_initial_sync_state` + `_sync_meta` and re-arms itself.
- Exposes `window.__mdxera` helpers: `clearVoucherReservations()`,
  `triggerFullResync()`, `runForegroundSync()`, `startBackgroundSync()`,
  `snapshotSchemaDrift()`, `resetSchemaDriftCache()`.
- Renders `<InitialSyncModal>` only during `phase === 'running' | 'error'`.

### 6.3 InitialSync (`src/core/sync/InitialSync.ts`)

Two phases:
- **Foreground** (`FOREGROUND_TABLES`): masters required for POS to
  function. Serial with progress modal.
  `profiles → configurations → business_roles → team_members →
  company_codes → set_of_books → gl_master → gl_assignments →
  categories → sub_categories → material_master → inventory →
  customers → suppliers → distributors → doctor_master →
  supplier_product_map → customer_price_list → mbc_card_types →
  mbc_card_templates`.
- **Background** (`BACKGROUND_TABLES`): transaction history. Runs after
  foreground; shows a status-bar badge.
  `purchases → purchase_orders → sales_bill → sales_challans →
  delivery_challans → sales_returns → purchase_returns →
  journal_entry_header → journal_entry_lines → promotions → ewaybills →
  mbc_cards → mbc_card_history → physical_inventory → mrp_change_log`.

Each table paginates (1000 rows/batch via `.range()`), resumable from
`_initial_sync_state.synced_rows`, auto-retried (backoff 30s → 2min →
10min, max 3 attempts).

### 6.4 SyncEngine (`src/core/sync/SyncEngine.ts`)

Runs every 30s **after foreground sync is done**. Each cycle:
1. `checkConnectivity()` — GET `/rest/v1/profiles?select=user_id&limit=0`
   with apikey (returns 200; the bare `/rest/v1/` returns 401 even with
   apikey).
2. `processSyncQueue()` — pushes pending `_sync_queue` rows to Supabase.
3. Status: idle / syncing / offline / error.
4. Listens for online/offline events; immediate pull on reconnect.

SyncEngine does NOT auto-pull on `start()` — `SyncBootstrap` controls
when pulls happen so they don't race with InitialSync.

### 6.5 SyncPuller (`src/core/sync/SyncPuller.ts`)

Delta-pulls each table since `_sync_meta.last_pulled_at`. Per-table
overrides in `TABLE_META`:
- `profiles` uses `user_id` as PK (not `id`).
- `delivery_challans`, `sales_challans`, `physical_inventory`,
  `mrp_change_log`, `journal_entry_lines`, `sales_returns`,
  `purchase_returns` use `created_at` as delta column (no `updated_at`).
- `mbc_card_history` has `deltaCol: null` — always full pull.

Session-level `_permanentlyMissingTables: Set<string>`: any table that
returns "schema mismatch" is added and skipped for the rest of the
session — stops the 30-second cycle from re-querying it.

### 6.6 SyncWorker (`src/core/sync/SyncWorker.ts`)

Pushes `_sync_queue` to Supabase. Push order is FK-safe (`TABLE_PRIORITY`
map: `profiles=1 → ... → journal_entry_lines=81`). FK violations are
**deferred** (not failed) so parent rows can sync first. Real failures
use `formatError()` (extracts `message` / `code` / `details` / `hint`
from PostgrestError objects).

Coded-record tables (`material_master`, `doctor_master`) are pushed one
at a time. On 23505 (unique-code collision):
`claimNextCodeFromServer(table, org)` queries the live MAX, assigns
`max+1`, updates the local SQLite row, and retries up to 5 times.
Mirrors the same logic in the direct-online path of `storageService.saveData`.

### 6.7 columnFilter (`src/core/sync/columnFilter.ts`)

Adapts Supabase rows for SQLite insert:
- `getSchemaForTable()` introspects via `PRAGMA table_info` (cached).
- Drops unknown columns.
- JSON-stringifies nested objects/arrays.
- Booleans → 0/1.
- **NOT NULL defaults**: substitutes `''` / `0` for null inputs into
  NOT-NULL columns. Stops "NOT NULL constraint failed" errors when
  production has looser data.

### 6.8 db client (`src/core/db/client.ts`)

**The single most critical file.** Tauri's plugin-sql uses a SQLite
POOL — each `database.execute()` may land on a different connection.
This makes explicit BEGIN/COMMIT impossible (BEGIN on conn A,
COMMIT on conn C → "cannot commit - no transaction is active"). Our
wrapper:

- **No explicit transactions.** `db.transaction()` is in name only —
  runs statements serially inside a single queued block. Each statement
  auto-commits. **Lost atomicity is accepted** because all our use cases
  are `INSERT OR REPLACE` with retry.
- **Single op queue** (`_opQueue`): every `execute` / `select` /
  `transaction` runs to completion before the next starts.
- **Busy retry** (`withBusyRetry`): up to 4 attempts on SQLITE_BUSY with
  50/100/200/400 ms backoff.
- **PRAGMAs run 4× at init**: `journal_mode = WAL`,
  `busy_timeout = 10000`, `foreign_keys = ON`, `synchronous = NORMAL`.
  Run multiple times because each pool connection needs them and we
  can't pin to one.

---

## 7. Sync data flows (the four directions)

Three layers, four flows. This is the invariant guide.

### Layers

| Layer | What | Read by | Written by |
|---|---|---|---|
| **Supabase** (`public.*`) | Authoritative server-side store. RLS scopes every row to `organization_id`. | `SyncPuller`, `InitialSync`, `storageService.fetchAllPagesFromSupabase` | `SyncWorker.pushBatch`, `storageService.saveData` (direct online path) |
| **Local SQLite** (`mdxera.db`) | Durable mirror on disk. Owned by Tauri plugin-sql. Migrations in `src/core/db/migrations/`. | `hydrateMemoryCacheFromSqlite`, `storageService.getData` (offline fallback) | `SyncPuller.upsertLocalRow`, `storageService.persistLocalRowToSqlite`, `InitialSync.bulkInsertAdapted` |
| **Memory cache** | Hot in-memory cache the legacy app reads from. Module-scoped in `services/storageService.ts`. | Every React component via `storage.fetchX()` / `storage.getData()` | `storage.saveData()`, `hydrateMemoryCacheFromSqlite` |

### Direction 1 — Pull: Supabase → Local SQLite

Trigger: `SyncPuller.pullDeltaFromSupabase` (every 30s online),
`InitialSync.runForegroundSync` (first-time), `InitialSync.startBackgroundSync`.

Pipeline:
```
supabase.from(table).select('*').eq('organization_id', orgId).gt(deltaCol, since)
  → mirrorOwnerIdColumns(table, row)     // copies created_by_id → user_id
  → adaptRowForSqlite(table, row)        // drop unknowns, JSON-encode, bool→0/1, NOT NULL defaults
  → conflictResolver.resolveConflict()   // last-writer-wins on updated_at; local 'pending' wins
  → db.upsert(table, adapted)            // INSERT OR REPLACE
```

Guarantees:
- `organization_id` filter mandatory — no cross-tenant leak.
- Unknown columns dropped silently.
- Pending local rows aren't overwritten (`_sync_status = 'pending'` guard).
- `created_by_id` mirrors into local `user_id` for owner-tracked tables.

### Direction 2 — Hydrate: Local SQLite → Memory cache

Trigger: `hydrateMemoryCacheFromSqlite(orgId)` on boot (fire-and-forget)
and after each foreground InitialSync.

Pipeline:
```
db.select('SELECT * FROM ${table} WHERE organization_id = ?', [orgId])
  → decodeSqliteRow(row)        // SQLITE_JSON_COLUMNS + auto-detect [/{-prefixed strings
  → toCamel(row)                // snake_case → camelCase
  → memoryCache[STORE_KEY].push(decoded)
  → memoryCacheOrgScope[STORE_KEY] = orgId
```

Guarantees:
- `memoryCacheOrgScope` invalidates on org switch.
- JSON columns parsed back to native objects/arrays.
- Underscore-prefixed columns (`_sync_status`, `_local_only`) excluded.

### Direction 3 — Online push: memory cache → Supabase (direct)

Trigger: `storageService.saveData(table, payload, user)` when online.

Pipeline:
```
saveData()
  → enforce organization_id (always)
  → enforce user_id for owner-tracked tables
  → for material_master / doctor_master: generate next code via getNextMaterialCode/getNextDoctorCode
  → getSupabasePayload(table, payload)   // per-table picker
  → toSnake(remotePayload)
  → pushWithDriftLearning(table, snake, supabase.insert/upsert)
                                          // strips known-missing columns; learns on PGRST204
  → fromSupabase(result)                  // server response → camelCase
  → persistLocalRowToSqlite(synced)
```

Coded-table conflicts (23505 unique-code) auto-retry up to 5 attempts
inside `saveData` — see lines ~1043 onward. Each retry deletes the IDB
row, regenerates `materialCode`/`doctorCode`, retries.

### Direction 4 — Offline-queued push: memory cache → Supabase via `_sync_queue`

Trigger: same `saveData` call when `!navigator.onLine` OR a network
error trips the catch branch.

Offline-save pipeline:
```
saveData()
  → enforce organization_id, user_id
  → memoryCache patched (instant UI update)
  → persistLocalRowToSqlite(payload, 'pending')
  → enqueueForSync(table, isUpdate, payload, orgId)
```

Later, when SyncEngine flushes:
```
SyncWorker.processSyncQueue()
  → SyncQueue.getPending() ordered by created_at ASC
  → groupByTable() then sort by TABLE_PRIORITY (FK-safe)
  → for each table: pushBatch (or pushCodedRecordsIndividually for material/doctor)
      → normalizeForSupabase(row, table)
          // strip BOOKKEEPING_KEYS + LOCAL_ONLY_COLUMNS + schemaDriftCache misses
          // camelToSnake remaining keys
          // OWNER_TRACKING_TABLES: map user_id → created_by_id
          // purchases: sourcePurchaseOrderId → reference_doc_number
          // UUID guard on all FK columns
      → pushWithDriftLearning(...)
      → markEntityRowsSynced(table, ids)
      → markDone() the queue rows
      → FK violation → deferRecord
      → PGRST204 → schemaDriftCache.recordMissingColumns + retry
      → other failure → markFailed (3 attempts then 'failed')
```

Guarantees:
- Same output shape as Direction 3 — verified by
  `normalizeForSupabase.test.ts` (75 tests).
- `organization_id` survives every transformation.
- FK-safe push order.
- Network errors auto-fall-back to queue.
- Failed records auto-reset to 'pending' on next app start.
- DELETE ops queue too — offline deletes no longer silently lost.

### Organization isolation — the multi-tenant invariant

Every row in every layer carries `organization_id`:

| Layer | Enforcement |
|---|---|
| Supabase | RLS: `USING (organization_id::text = public.get_my_org_id())` on every table |
| Local SQLite | `organization_id TEXT NOT NULL` on every table; every SELECT filters on it |
| Memory cache | `memoryCacheOrgScope` invalidates on org switch |

`get_my_org_id()` reads `profiles.organization_id WHERE user_id = auth.uid()`.
If `auth.uid()` is null (no/expired JWT) the function returns ''  and every
write fails RLS with **42501**. This is the most common cause of "row violates
row-level security policy" — see §10 for how persistent login interacts with
this.

### Schema-drift handling

- **Server-has, local-doesn't (PULL):** `adaptRowForSqlite` drops unknown
  columns. Fix: add a migration in `src/core/db/migrations/` then clear
  `_sync_meta` to force re-pull.
- **Local-has, server-doesn't (PUSH):** `schemaDriftCache` learns from
  PGRST204 at runtime, persists to `localStorage` with 24h TTL, strips
  the column from every subsequent push until re-attempted.

Inspect from DevTools:
```js
console.table(window.__mdxera.snapshotSchemaDrift().suppliers)
await window.__mdxera.resetSchemaDriftCache()
```

### Adding a new table — checklist

1. Add Supabase schema as `supabase/<name>_schema.sql`.
2. Create migration in `src/core/db/migrations/` mirroring every column.
3. Add to `TABLE` and `SYNCABLE_TABLES` in `src/core/db/schema.ts`.
4. Add `TABLE_PRIORITY` entry in `SyncWorker.ts` (FK order).
5. Owner-tracked? Add to all three copies of `OWNER_TRACKING_TABLES`
   (storageService, SyncWorker, SyncPuller).
6. Local-only/computed fields? Add to `LOCAL_ONLY_COLUMNS` in SyncWorker.
7. JSON columns? Add to `SQLITE_JSON_COLUMNS` in storageService.
8. Add to `allTables` loop in `normalizeForSupabase.test.ts`.
9. Add to `FOREGROUND_TABLES` or `BACKGROUND_TABLES` in InitialSync.
10. Run `npm test`.

---

## 8. Voucher numbering

`src/core/voucher/voucherService.ts` implements **range allocation**:
- Device requests a chunk (default 100) via
  `supabase.rpc('reserve_voucher_range', ...)`.
- Server atomically advances `configurations.invoice_config.currentNumber`
  AND `internalCurrentNumber`.
- Device consumes numbers locally from `voucher_reservations` SQLite
  table.
- When pool < `LOW_WATER_MARK = 20`, prefetches another range.
- Offline: uses cached pool; throws cleanly when exhausted.

**The SQL function lives at
`supabase/functions/_shared/reserve_voucher_range.sql` and must be
deployed manually via Supabase SQL Editor.** No tooling auto-deploys it.
The function reads
`GREATEST(internalCurrentNumber, currentNumber, startingNumber)` so it
stays in sync with the legacy app's running counter.

For coded-record tables (`material_master`, `doctor_master`),
`getNextMaterialCode` / `getNextDoctorCode` in `storageService.ts`
reserve numbers locally — they consult IDB **and** memoryCache **and**
SQLite to find the local high-water mark (so a fresh browser session
with an empty IDB still picks the right next number). On 23505 the
direct-online path and SyncWorker both retry with the server's live max.

---

## 9. POS save flow (offline-safe)

1. `POS.handleSave` → `onSaveOrUpdateTransaction` →
   `App.handleSaveOrUpdateTransaction`.
2. `addTransaction(tx, user, isUpdate)` in legacy `storageService`:
   - **Online:** `ensurePostingContext` + `validateGLMappings`
     (Supabase reads).
   - **Offline:** skipped; server validates on push.
   - `saveData('sales_bill', tx, user, isUpdate)`:
     - Updates `memoryCache`.
     - `idb.put` (no-op since IDB disabled).
     - **Online:** tries `supabase.from('sales_bill').insert(...)`
       directly. Success → marks `_sync_status: 'synced'`. Network error
       → marks pending AND enqueues.
     - **Offline:** skips Supabase, marks pending, enqueues.
   - Stock deduction: `updateMemoryCacheBulk` for inventory (replaces
     old `clearTableMemoryCache` that wiped state offline). Each updated
     row also enqueued.
   - `syncSalesLedger`: SKIPPED when offline; otherwise GL postings.
3. App.tsx updates React state.

Result: offline saves are fully local + queued. SyncEngine pushes them
when online.

---

## 10. Auth and persistent login

### 10.1 What the user sees

Once logged in, the user stays logged in across app close/reopen
**until they manually log out**. No automatic expiry on the local side.

### 10.2 Wiring

- `src/core/auth/offlineAuth.ts:SESSION_TTL_DAYS = 365 * 100`. Local
  HMAC-signed session tokens effectively never expire.
- `services/storageService.ts:getCurrentUser` no longer wipes IDB when
  the Supabase session is missing. It falls back to
  `authService.restoreSession()` which checks the Tauri plugin-store +
  local HMAC token. The user is returned and continues to use the app.
- `App.tsx:handleLogout` sets `localStorage.MDXERA_MANUAL_LOGOUT='true'`
  before clearing, so the `supabase.auth.onAuthStateChange`
  `SIGNED_OUT` handler distinguishes intentional logout from transient
  blips.
- The `SIGNED_OUT` handler ignores transient events when either
  `supabase.auth.getSession()` returns a session OR
  `storage.getCurrentUser()` still resolves to a persisted user.

### 10.3 Failure mode — expired Supabase refresh token

A local session can outlive the Supabase refresh token (typically 30
days, depending on the project's Supabase auth settings). When this
happens:
- App still boots with the user "logged in" locally.
- Reads from cache work fine.
- Online writes hit HTTP **401 → PG 42501** ("row violates row-level
  security policy") because `auth.uid()` is null server-side and
  `get_my_org_id()` returns `''`.

Mitigation today:
- `src/modules/inventory/services/materialMasterSync.ts:ensureLiveAuth()`
  is called at the top of bulk-master and per-item create flows. If the
  session is dead, it throws a clear "Your session has expired. Please
  log out and log in again to continue." message.
- **The fix the user takes** is: log out, log in. The full login path
  refreshes the Supabase session and writes resume.

**Open work:** wire `ensureLiveAuth()` (or a global equivalent) into
every online-write path so the user always gets a clear message instead
of an opaque RLS error, OR re-prompt for password automatically when
the refresh token is dead. Today only the master-sync flow is guarded.

---

## 11. Per-user module visibility

Replaces the old "Module Columns" config under Global ERP Configuration.

### 11.1 What it does

Each user, on each device, can hide:
- Whole modules / submodules from the sidebar (Sales, Purchase,
  Inventory, Estimate Billing, Accounts Receivable, Accounts Payable,
  Suppliers, Customers, Material Master, etc.).
- Dashboard fields (Today's Sales, Profit, Stock Value, Purchases,
  Receivables, Payables, Expiry Alerts Bar).

Hidden modules are filtered out of the sidebar and direct navigation
shows a "Module Hidden" placeholder.

### 11.2 Storage

Per-user, per-device. Key:
`localStorage:mdxera:moduleVisibility:<user_id>`
Value: `{ hiddenScreens: string[], hiddenDashboardFields: string[] }`.

If you ever need cross-device sync of this preference, the extension
point is to write to a `team_members` JSON column instead — the rest of
the wiring already routes through a Zustand store.

### 11.3 Code locations

- `src/core/visibility/moduleVisibilityStore.ts` — Zustand store +
  localStorage helpers.
- `src/core/visibility/useModuleVisibility.ts` — hook + nav filter
  (`filterNavByVisibility`).
- `src/modules/configuration/components/ModuleVisibility.tsx` — the
  screen itself.
- `src/core/components/ui/AdminPasswordModal.tsx` — the lock modal.
- `src/core/utils/adminConfig.ts:ADMIN_MODULE_VISIBILITY_PASSWORD` —
  default `'mdxera@admin'`. Change this constant to rotate it.

### 11.4 Access paths and lock behavior

Two entry points:
1. **Global ERP Configuration → Module Hide / Unhide** (the new
   replacement for "Dashboard Module Configuration"; lives inside
   `Configuration.tsx`'s sidebar list).
2. **Utilities & Setup → Module Hide / Unhide** in the top header menu —
   navigates to the standalone route.

Both render the same `<ModuleVisibility>` component. On every visit the
component is in `authorized=false` state and shows
`<AdminPasswordModal>` first. The modal closes when the screen becomes
inactive (so navigating to Dashboard while the modal is open hides it).

Re-locking on navigate-away is wired through an `isActive` prop:
- App.tsx passes `isActive` to the standalone `<ModuleVisibility>` and
  to `<Configuration>` (which passes it through to its embedded
  `<ModuleVisibility>`).
- A `useEffect` resets `authorized` to `false` whenever `isActive`
  flips to false. Modal's `isOpen` is also tied to `isActive` so it
  doesn't render over other screens.

### 11.5 Wiring into the router and sidebar

- App.tsx imports `useModuleVisibilityStore` and `filterNavByVisibility`.
- Sidebar `navigationItems` is wrapped:
  `filterNavByVisibility(filterNavigationByPermissions(navigation, ...), hiddenScreens)`.
- `renderPage` checks `hiddenScreens.has(pageId)` (except for the
  visibility screen itself) and shows a "Module Hidden" placeholder.
- Dashboard combines the old `configurations.modules.dashboard.fields`
  lookup with `useModuleVisibility().isDashboardFieldHidden(fieldId)`.
- The expiry-alerts ticker on Dashboard gates on `showExpiryBar`
  derived from `isDashboardFieldHidden('expiryBar')`.

### 11.6 Removed pieces

- The old "Module Columns" section inside
  `src/modules/configuration/components/Configuration.tsx` (sidebar
  entry + section body + `moduleVisibility` member of the `ConfigSection`
  union) is gone.
- The old "Dashboard Module Configuration" section is gone — same screen
  now contains the new `ModuleVisibility` embed.

---

## 12. Inventory ↔ Material Master reconciliation

Inventory and Material Master used to be independent. After the merge,
many inventory rows still have no `code` and no matching master entry.
Three tools fix this:

### 12.1 Linking convention

`inventory.code === medicine.materialCode`. Group key is
`name + brand` (case-insensitive, trimmed). Multiple batches of one
material share name+brand and link via that single code.

`src/modules/inventory/services/materialMasterSync.ts:materialKey(name, brand)`
returns the normalized key. Used everywhere grouping/matching happens.

### 12.2 Bulk reconciliation — Sync to Master

- Button in the Inventory toolbar: "Sync to Master".
- Opens `SyncMaterialMasterModal` — groups inventory by name+brand,
  shows status (`Missing` / `In Master`) with batch count + total
  stock, default filter `Missing`.
- Multi-select, search, "select all visible", per-row checkbox.
- Sequential creation (NOT `Promise.all` — keeps the material-code
  counter race-free).
- Each new master is created with `BULK_DEFAULTS = { gstRate: 5,
  isPrescriptionRequired: false }` regardless of inventory source
  values. Everything else (name, brand, pack, MRP, etc.) is copied from
  a representative inventory row. After creation, every batch in the
  group gets the new code stamped via
  `storage.saveData('inventory', { ...item, code }, user, true)`.
- Progress bar; failed rows reported and logged.

### 12.3 Per-item creation — Alter modal

- "Create in Material Master…" button appears on `EditProductModal`
  only when:
  - the row has no linked master (matched by code or fallback to
    name+brand)
  - AND `currentUser` + `onAddMedicineMaster` props are wired.
- Click opens `AddMedicineModal` **prefilled** from the inventory row
  via the new `initialValues` prop (name, brand, manufacturer,
  composition, pack, barcode, hsnCode, gstRate, MRP, description,
  valuationMethod, standardPriceRate). The user can edit anything.
- `onAddMedicine` calls `App.handleAddMedicineMaster` which creates the
  master (with proper code generation) and auto-links sibling inventory
  rows.
- `onMedicineSaved` stamps `saved.materialCode` onto local
  `product.code` so the user just clicks Accept Alteration to also
  persist any other edits — no risk of saving an empty code over the
  freshly-linked one.

### 12.4 Auto-link on master create (anywhere)

`App.handleAddMedicineMaster` dynamic-imports
`linkInventoryToNewMaster(saved, inventory, currentUser)` after every
master save. That function finds every inventory row with matching
name+brand and no code, then stamps the new code onto each via
`storage.saveData('inventory', ..., true)` (online or offline; all
through the same path).

### 12.5 Offline material-code generation

`getHighestLocalMaterialCode` (in `services/storageService.ts`) reads
from **all three** sources:
1. IDB (`STORES.MATERIAL_MASTER`).
2. `memoryCache.MATERIAL_MASTER` (populated by hydration).
3. SQLite (`SELECT material_code FROM material_master WHERE
   organization_id = ?`).

This is the fix for "next code starts at 10000000 again" on fresh
browser sessions: hydration populates `memoryCache` + SQLite but not
IDB, so an IDB-only scan returned `MATERIAL_CODE_START - 1`. Reading
from all three covers every restart scenario.

### 12.6 Auth precondition

`ensureLiveAuth()` runs at the top of `createMasterFromGroup` and
`bulkCreateFromInventory`. If the Supabase session is dead it throws
"Your session has expired. Please log out and log in again to
continue." instead of letting the RLS rejection surface as an opaque
"new row violates row-level security policy".

### 12.7 Files touched

- `src/modules/inventory/services/materialMasterSync.ts` — `materialKey`,
  `groupInventoryByMaterial`, `createMasterFromGroup`,
  `bulkCreateFromInventory`, `linkInventoryToNewMaster`, `ensureLiveAuth`,
  `BULK_DEFAULTS`.
- `src/modules/inventory/components/SyncMaterialMasterModal.tsx` —
  bulk UI.
- `src/modules/inventory/components/EditProductModal.tsx` — opens
  AddMedicineModal prefilled.
- `src/modules/inventory/components/AddMedicineModal.tsx` — accepts
  `initialValues: Partial<Medicine>`.
- `src/modules/inventory/components/Inventory.tsx` — toolbar button,
  threads `onAddMedicineMaster` to EditProductModal.
- `App.tsx` — passes `addNotification`, `onRefresh`,
  `onAddMedicineMaster` to Inventory; calls
  `linkInventoryToNewMaster` after each master save.

---

## 13. Reports module conventions

`src/modules/reports/components/Reports.tsx` is the unified reports
screen for the management report set (Sales/Purchase/Inventory/Accounting
Reports, ~50+ entries listed in `REPORT_LIST`).

### 13.1 Conventions for every report

- **Pagination.** `currentReportPage` + `reportPageSize` (default 50;
  selectable 25/50/100/200/500). Auto-resets to page 1 when the active
  report or filtered row count changes. Controls live in a row directly
  below the table.
- **Expiry as MM-YYYY.** Any column whose header matches
  `/^(expiry|exp\.?|exp date)$/i` is rendered through `formatExpiryCell`
  which parses Date-like inputs and outputs `MM-YYYY`. Already-formatted
  values and unparseable strings pass through unchanged.
- **Filter pop-up.** `max-w-7xl`, height `85vh`, up-to-4-column grid.
  Each column has a search box that live-filters its value list and a
  "clear (n)" link for the selected count.
- **Column pop-up.** Show/hide which columns appear in the table.
- **Keyboard shortcuts:** `Ctrl/Cmd + F` opens the Filter pop-up,
  `Ctrl/Cmd + C` opens the Column pop-up. Both yield to the browser
  when focus is in an input/textarea/select. Ctrl+C also yields when
  text is selected so normal copy still works.

### 13.2 Adding a new report

Add an entry to `REPORT_LIST` with `id`, `name`, `group`. Add a case
branch in the big `switch (reportId)` that builds `reportHeaders` and
`rows`. The pagination / filter / column / shortcut wiring picks it up
automatically.

`supplierWisePurchase` (id `supplierWisePurchase`, group "Purchase
Reports") is the existing example for a grouped report — it builds a
`Map<supplier, aggregates>` then converts to rows.

---

## 13a. AI provider (Groq via Supabase Edge Function)

All AI features (purchase-bill OCR, prescription OCR, captions, chatbot,
GST queries, Substitute Finder, Promotions) go through one Supabase Edge
Function. The client doesn't talk to any LLM provider directly.

### Pipeline

```
client (services/geminiService.ts)
   → POST {SUPABASE_URL}/functions/v1/{VITE_AI_FUNCTION}
       → supabase/functions/groq_ai/index.ts  (Edge Function)
           → https://api.groq.com/openai/v1/chat/completions
               with key from Supabase Secret GROQ_API_KEY
```

The Edge Function re-wraps Groq's OpenAI-style response
(`choices[0].message.content`) into Gemini's shape
(`candidates[0].content.parts[0].text`) so the client's
`getTextFromResultData` parser doesn't change. This makes provider swaps
client-invisible.

### Configuration

| Secret / env var | Where | Purpose |
|---|---|---|
| `GROQ_API_KEY` | Supabase Dashboard → Edge Functions → Secrets | Required. Authenticates the Edge Function to Groq |
| `GROQ_DEFAULT_MODEL` | Supabase Dashboard → Edge Functions → Secrets | Optional org-default model. Falls back to `meta-llama/llama-4-scout-17b-16e-instruct` |
| `VITE_AI_FUNCTION` | `.env.local` on the client | Edge function name (default `groq_ai`). Set to `gemini-ocr-main` to flip back to Gemini |
| `VITE_AI_MODEL` | `.env.local` on the client | Per-call model override (e.g. `meta-llama/llama-4-maverick-17b-128e-instruct` for higher quality) |
| `VITE_GEMINI_MODEL`, `VITE_GOOGLE_MODEL` | `.env.local` on the client | Legacy fallbacks — still honored so existing setups aren't broken |

The client default model is `meta-llama/llama-4-scout-17b-16e-instruct`
(vision + text, fast, free tier). For more accuracy on dense invoices use
`meta-llama/llama-4-maverick-17b-128e-instruct`.

### What it covers vs what it doesn't

| Feature | Status |
|---|---|
| Purchase-bill OCR (multimodal: image + JSON prompt) | ✅ |
| Prescription / sales OCR | ✅ |
| Chatbot, GST Center text Q&A, Substitute Finder | ✅ |
| Promo captions | ✅ |
| **TTS** (`generateTextToSpeech`) | **Removed.** Groq has no TTS; the function was dead code (never called). Re-add via a real TTS provider if needed |
| **Image generation** (`generatePromotionalImage`) | Pass-through: the function still runs but Groq returns text, not image data. Promotions screen will get an empty image and fall back. Use a real image-gen provider if needed |

### Switching providers

To go back to Gemini:
1. Set `VITE_AI_FUNCTION=gemini-ocr-main` and `VITE_AI_MODEL=gemini-2.5-flash` in `.env.local`.
2. Rebuild — no source change needed.

The old Gemini Edge Function (`supabase/functions/gemini_ocr/index.ts`)
is still in the repo unchanged, so you can keep both deployed and flip
between them per-environment.

### Rotating the Groq key

1. https://console.groq.com/keys → revoke the old key, generate a new one.
2. Supabase Dashboard → Project Settings → Edge Functions → Secrets → update `GROQ_API_KEY`.
3. No client redeploy needed — the secret is read at function invocation.

**Never commit the key.** Never paste it in chat. Treat it like the
Tauri updater private key.

---

## 14. Service-material handling in POS

Material types live in `src/core/utils/materialType.ts`:
- `trading_goods` — default, inventorised + sellable.
- `finished_goods`, `consumables`, `service_material`, `packaging` —
  each has explicit `inventorised`, `salesEnabled`, `purchaseEnabled`,
  `productionEnabled`, `internalIssueEnabled` flags.

`service_material` is `inventorised: false`.

### 14.1 Inventory list

`Inventory.tsx` already filters
`getInventoryPolicy(item, medicines).inventorised`. Service materials
don't appear in the inventory list.

### 14.2 POS

- `POSPage.tsx:handleSave` and `addSelectedBatchToGrid` already gate the
  "Insufficient stock" warning on `policy.inventorised`. Service materials
  skip the warning, can be sold even with zero stock.
- The product-search result table at `POSPage.tsx:~1808` shows `—` (a
  dash) in Strips/Loose/Total stock columns for service items. Expired
  / Some-expired badges are also suppressed for service materials.

---

## 15. Releasing

Installers ship via GitHub Releases and the Tauri updater. End users
see "Check for updates" in **Settings → System & Updates** plus a
one-time notification at app boot when a newer build is available.

### 15.1 One-time setup (per repo)

GitHub Actions secrets on `mridupawanborah790-gif/mdxera-offline`:

| Name | Where to find the value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Paste the entire contents of `.updater-secrets/updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `mdxera-updater-key-2026` (or your own if you regenerated the key) |

The matching public key is baked into `src-tauri/tauri.conf.json`.
**Never commit the private key.** It lives only in `.updater-secrets/`
(gitignored) and in the GitHub secret.

Optional macOS notarization (so users don't see the Gatekeeper warning):

| Name | Description |
|---|---|
| `APPLE_CERTIFICATE` | base64-encoded `.p12` Developer ID cert |
| `APPLE_CERTIFICATE_PASSWORD` | Passphrase for the `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: ACME…` |
| `APPLE_ID` | Apple ID email |
| `APPLE_PASSWORD` | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

To base64 a cert: `base64 -i my-cert.p12 | pbcopy` (macOS) or
`[Convert]::ToBase64String([IO.File]::ReadAllBytes("my-cert.p12"))` (Windows).

### 15.2 Cutting a release

```bash
# 1. Bump the version in three places (keep them identical):
#    - package.json                       "version"
#    - src-tauri/Cargo.toml               package.version
#    - src-tauri/tauri.conf.json          "version"

git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "Release v1.2.3"

git tag v1.2.3
git push origin main --follow-tags
```

`.github/workflows/release.yml` then:
1. Builds Windows installers (`.msi` + `.exe` NSIS) and macOS bundles
   (`.dmg` + `.app`, Intel + Apple Silicon).
2. Signs every bundle with the updater key.
3. Creates a GitHub Release containing every installer **and**
   `latest.json` (the manifest the installed app polls).

~10–15 minutes per platform.

### 15.3 What end users see

- **First time:** download from the GitHub Release. Auto-updates only
  work for installs from v1.0.0 onwards of this codebase.
- **From then on:** silent check at boot. Non-blocking notification on
  newer version: *"Update available: v1.2.3 — open Settings → System &
  Updates to install."* User reviews release notes, hits Install,
  prompted to restart when the download completes.

### 15.4 Local testing

- `npm run tauri:build` — output under `src-tauri/target/release/bundle/`.
- Updater check only runs in desktop shell; `npm run dev` (browser)
  no-ops the service and shows "dev" as the version.
- For real-update flow: ship two consecutive tagged releases (e.g.
  `v0.0.1` then `v0.0.2`), install v0.0.1 locally, then trigger from
  the Settings panel.

### 15.5 Release troubleshooting

| Symptom | Likely cause |
|---|---|
| Workflow fails at "Build & publish" with "signing failed" | `TAURI_SIGNING_PRIVATE_KEY` or password secret is wrong |
| Updater says "no update found" right after release | Release assets still publishing — wait 1–2 min and retry |
| In-app updater errors with "Signature verification failed" | `tauri.conf.json` public key doesn't match the workflow's private key |
| macOS users blocked at first launch | Notarization secrets missing (or expired Developer ID cert) |
| Windows SmartScreen warns "Unrecognized publisher" | No EV/OV code-signing cert configured. Separate from the updater key |

### 15.6 If you lose the private key

You can't sign new updates with the same identity. Recovery:
1. Generate a new keypair:
   `npx @tauri-apps/cli signer generate -w .updater-secrets/updater.key --force`.
2. Replace `pubkey` in `src-tauri/tauri.conf.json`.
3. Update the GitHub secret with the new private key.
4. Cut a new release.
5. **Every existing user has to reinstall manually** — their installed
   binaries trust only the *old* public key.

Back up `.updater-secrets/` to a password manager or encrypted vault.

---

## 16. Operations runbook

### 16.1 Deploying the voucher SQL

```
Open Supabase Dashboard → SQL Editor
Paste supabase/functions/_shared/reserve_voucher_range.sql
Run
```

Verify:
```sql
SELECT proname FROM pg_proc WHERE proname = 'reserve_voucher_range';
```

### 16.2 Clearing a stale voucher cache (after deploying new SQL)

In DevTools (F12):
```js
await window.__mdxera.clearVoucherReservations();
```
Then click **Sync All** in the header (or restart) to fetch a fresh
range.

### 16.3 Forcing a full resync

Click **Sync All** in the header. Or:
```js
window.__mdxera.triggerFullResync();
```

### 16.4 Clearing failed queue records

Open the **SyncIndicator** in the StatusBar (the green/amber/red dot at
the bottom) → click → "Discard all" under Failed records.

### 16.5 Wiping local SQLite for a fresh start

Quit the app. Delete:
- `%APPDATA%/com.mdxera.erp/mdxera.db`
- `%APPDATA%/com.mdxera.erp/mdxera.db-wal`
- `%APPDATA%/com.mdxera.erp/mdxera.db-shm`

Restart and log in online — InitialSync rebuilds from scratch.

### 16.6 Verifying production voucher counter

```sql
SELECT invoice_config->>'currentNumber'         AS curr,
       invoice_config->>'internalCurrentNumber' AS internal
FROM configurations
WHERE organization_id = '<your org id>';
```

If `internal` is NULL on an established account, set it:
```sql
UPDATE configurations
SET invoice_config = jsonb_set(invoice_config, '{internalCurrentNumber}', '223')
WHERE organization_id = '<id>';
```

### 16.7 Inspecting schema-drift cache

```js
console.table(window.__mdxera.snapshotSchemaDrift().suppliers);
await window.__mdxera.resetSchemaDriftCache();
```

### 16.8 Rotating the Module Hide/Unhide admin password

Edit `src/core/utils/adminConfig.ts:ADMIN_MODULE_VISIBILITY_PASSWORD`,
rebuild, ship. The lock modal references this constant directly.

---

## 17. Development conventions

- **Never re-introduce explicit BEGIN/COMMIT.** `db.transaction()` runs
  statements serially; that's the safe pattern given Tauri's pool. If
  you need true atomicity, wrap in `try/catch` and clean up manually.
- **Don't await hydration in render-blocking paths.** Fire-and-forget
  and listen for `HYDRATE_COMPLETE_EVENT`.
- **All new sync targets must be in `SYNCABLE_TABLES`** AND have an
  entry in `TABLE_PRIORITY` (SyncWorker) so they push in FK-safe order.
- **JSON-encoded columns must be in `SQLITE_JSON_COLUMNS`**
  (`services/storageService.ts`) so they're decoded on hydration.
- **Don't call `db.transaction` recursively** — the queue will deadlock.
- **Reads go through `memoryCache` → SQLite → Supabase** in that order.
  Write to `memoryCache` synchronously, persist async.
- **All writes go through `storage.saveData(table, payload, user)`** —
  not `supabase.from(...)` directly. `saveData` enforces
  `organization_id`, generates codes for `material_master` /
  `doctor_master`, handles drift learning, retries on duplicate codes,
  and queues offline saves.
- **For bulk operations on coded-record tables**, use a sequential
  `for/await` loop, NOT `Promise.all`. Codes are reserved via a counter
  that races under parallelism.
- **React hook order matters** — never put a `useState` / `useMemo` /
  `useEffect` after an early-return inside a component. Easy to slip up
  when adding new state; if you do, you'll see "Rendered more hooks
  than during the previous render" in production.
- **When opening a new screen-level modal that should re-lock between
  visits**, drive it with an `isActive` prop the parent passes from
  App.tsx's `renderPage(pageId, isActive)`. Pages stay mounted in
  `mountedPages`, so a `useEffect` keyed on `isActive` is the only
  reliable reset signal.

---

## 18. Build / environment facts

- **Tauri** 2.x, **Vite** 5+, **React** 18, **TypeScript** strict.
- Tauri plugin: `@tauri-apps/plugin-sql` (SQLite).
- Zustand for new module stores (`authStore`, `moduleVisibilityStore`).
- Supabase project: `sblmbkgoiefqzykjksgm.supabase.co`.
- Anon key: hard-coded fallback in `src/core/db/supabaseClient.ts` and
  `src/core/sync/networkMonitor.ts`. Override with `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_ANON_KEY`.
- IndexedDB intentionally disabled (`ENABLE_INDEXED_DB = false`).
- TypeScript build **excludes**: `src/app/App.tsx`, `src/app/Router.tsx`,
  `services/powersync.ts`,
  `src/modules/inventory/services/inventoryService.ts`,
  `src/core/hooks/usePermissions.ts`. See `tsconfig.json`.
- `npm run tauri:dev` for dev, `npm run build` for production web,
  `npm run tauri:build` for installers, `npm test` for Vitest,
  `npx tsc --noEmit` for type-check.

---

## 19. Failure-mode quick reference

| Symptom | Likely cause | Where to look |
|---|---|---|
| Blank screen on launch | Uncaught render error; AppErrorBoundary shows details | DevTools console + boundary screen |
| "Rendered more hooks than during the previous render" | A hook (`useMemo`/`useState`/`useEffect`) was added after an early-return | The component listed in the error |
| "cannot commit - no transaction is active" | Someone re-introduced explicit BEGIN/COMMIT | `src/core/db/client.ts` and any callers that wrap statements manually |
| "database is locked" repeatedly | A long-running write is blocking; check SyncEngine isn't racing InitialSync | `SyncBootstrap.tsx` ordering |
| Voucher number starts from 1 | SQL not deployed OR stale `voucher_reservations` cache OR production `currentNumber` is null | §16.1 / §16.2 / §16.6 |
| Material code resets to 10000000 offline | `getHighestLocalMaterialCode` couldn't find existing codes (rare since the IDB+memCache+SQLite fix); or a fresh device hasn't completed InitialSync | `services/storageService.ts:getHighestLocalMaterialCode` |
| "new row violates row-level security policy" (PG 42501) on insert | Supabase session token is dead — `auth.uid()` is null and `get_my_org_id()` returns '' | §10. Log out, log in. Long-term: wire `ensureLiveAuth()` into more flows |
| POS save offline → "Network connection issue" | An old code path bypassed `enqueueForSync` | `services/storageService.ts:saveData` — the `!navigator.onLine` branch should enqueue |
| Hydration never fires the event | SQLite init failure; check console for `[storage] SQLite client unavailable` | `services/storageService.ts:hydrateMemoryCacheFromSqlite` |
| Sync All button missing | `currentUser` null OR App.tsx isn't passing `onResyncAll` | `App.tsx` Header props |
| Module Hide/Unhide modal won't close on Cancel | `onCancel` not wired by parent | `App.tsx:'moduleVisibility'` case passes `onCancel`; `Configuration.tsx` passes one too |
| Module Hide/Unhide modal appears on Dashboard after Cancel | `AdminPasswordModal isOpen` not gated on `isActive` | Already fixed in `ModuleVisibility.tsx`; check the prop chain if it recurs |
| Inventory item shows "Master exists: 100000XX — save to apply" but Accept doesn't link | `handleSave` should stamp `linkedMaster.materialCode` onto `product.code` before calling `onSave` | `EditProductModal.tsx:handleSave` |
| `[object Object]` shown in failed sync queue | Should be fixed — if it recurs, `formatError()` regression | `src/core/sync/SyncWorker.ts:formatError` |
| Duplicate `materialCode` rows in `material_master` | Pre-fix data; need manual cleanup | Material Master screen; or a one-shot SQL dedup |

---

## 20. Open work / known gaps

1. **`bank_master` not in `SYNCABLE_TABLES`.** Payment-with-accounting
   flows (`recordCustomerPaymentWithAccounting`,
   `recordSupplierPaymentWithAccounting`) hard-fail with "Payment
   posting requires online mode" because they read bank GLs directly
   from Supabase. Adding `bank_master` to InitialSync + SYNCABLE_TABLES
   unblocks offline payments. **Highest-impact remaining unlock.**
2. **Voucher numbering — Option B redesign.** The current dual system
   (legacy `currentNumber` + new `voucher_reservations` range
   allocation) produces visible inconsistencies (mixed `-2026` vs
   `-2026-27` FY format, Settings UI shows wrong "next number").
   Design scoped, implementation not started.
3. **`customerService.ts` exports `saveCustomer` / `deleteCustomer` /
   `updateCustomer`** that don't enforce `organization_id`. Currently
   unused but a footgun. Delete the file or add the enforcement.
4. **No CI test step.** `release.yml` doesn't run `npm test`. Add it
   as a one-line gate.
5. **`physical_inventory` uses `user_id` as FK** while others use
   `created_by_id`. Asymmetry is documented but easy to miss.
6. **Persistent login + Supabase refresh expiry** — see §10. Only the
   material-master flows are guarded with `ensureLiveAuth`. Wire it
   globally, or auto-prompt for password when the refresh token dies.
7. **Existing duplicate material codes from past offline-conflict
   bugs.** New writes won't create new dupes (see §12.5), but the
   existing ones need manual cleanup or a one-shot dedup utility.
8. **Legacy IDB is disabled but the code still calls `idb.*`.** All
   return null/[] silently — wastes cycles. Long-term: remove or
   re-enable with proper migration to SQLite.
9. **`src/app/App.tsx` + `src/app/Router.tsx`** are stubs (components
   lazy-loaded with empty props). Excluded from `tsconfig.json`. Either
   wire the props for a future cutover or delete the files.
10. **Inventory only shows partial data after sync** in some sessions —
    likely a per-table mid-batch failure that the "partial sync
    completed" warning hides. Worth surfacing per-table row counts in
    SyncIndicator.
11. **No conflict-resolution UI** — `conflictResolver.ts` uses
    last-write-wins on `updated_at`. Same bill edited on two devices
    silently loses the older edit.
12. **`mbc_card_history`** has neither `updated_at` nor `created_at` —
    full pull every cycle. Fine for small tables, bad for large.
13. **Multiple Header buttons share the same `R` underline shortcut** —
    Reload + (potentially) Resync.

---

*End of project reference. When you make a change that affects the
sync seams, the boot sequence, the visibility layer, the inventory ↔
master pipeline, or release/operations procedure — update this file
along with the code.*
