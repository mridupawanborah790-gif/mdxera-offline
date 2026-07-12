    
import { db as sqliteDb } from '../src/core/db/client';
import { TABLE as SCHEMA_TABLE } from '../src/core/db/schema';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseClient';
    import { idb, STORES } from './indexedDbService';
    import {
        RegisteredPharmacy, InventoryItem, Transaction, BillItem, Purchase, PurchaseItem, Supplier,
        Customer, PurchaseOrder, TransactionLedgerItem, UserRole, OrganizationMember,
        Medicine, SupplierProductMap, EWayBill, DoctorMaster,
        DeliveryChallan, DeliveryChallanStatus, PhysicalInventorySession, PhysicalInventoryStatus,
        CustomerPriceListEntry, SalesChallanStatus, SalesChallan, AppConfigurations,
        SalesReturn, PurchaseReturn
    } from '../types';
    import { parseNetworkAndApiError } from '../utils/error';
    import { normalizeImportDate } from '../utils/helpers';
    import { deductStockLooseFirst, normalizeUnitsPerPack } from '../utils/stock';
    import { resolveUnitsPerStrip, extractPackMultiplier } from '../utils/pack';
import { resolveStockHandlingConfig, logStockMovement } from '../utils/stockHandling';
    import { DEFAULT_CONFIG_MISSING_MESSAGE, loadDefaultPostingContext } from './companyDefaultsService';
import {
    reserveVoucherNumber as _reserveVoucherNumberImpl,
    markVoucherCancelled as _markVoucherCancelledImpl,
    type VoucherDocumentType as _VoucherDocumentTypeImpl,
    type VoucherReservationResult as _VoucherReservationResultImpl,
} from '../src/core/voucher/voucherService';
import {
    login as _loginImpl,
    signup as _signupImpl,
    logout as _logoutImpl,
    requestPasswordReset as _requestPasswordResetImpl,
    verifyRecoveryToken as _verifyRecoveryTokenImpl,
    updatePassword as _updatePasswordImpl,
    restoreSession as _restoreSessionImpl,
    ensureLiveAuth as _ensureLiveAuthImpl,
} from '../src/core/auth/authService';
import { SyncQueue } from '../src/core/sync/SyncQueue';
import { createClient } from '@supabase/supabase-js';
import { cacheOfflineCredentials } from '../src/core/auth/offlineAuth';
import { pushWithDriftLearning } from '../src/core/sync/schemaDriftCache';

// Tables the new SyncEngine knows how to push. Writes to these tables get
// enqueued when offline (or after a network failure) so the engine can flush
// them once connectivity returns. Tables not in this set fall back to the
// legacy "stay pending in IDB" behaviour.
const SYNC_QUEUE_TABLES = new Set<string>([
    'sales_bill', 'sales_returns', 'sales_challans', 'delivery_challans',
    'purchases', 'purchase_returns', 'purchase_orders',
    'inventory', 'material_master', 'customers', 'suppliers', 'distributors',
    'doctor_master', 'supplier_product_map', 'customer_price_list',
    'mbc_cards', 'mbc_card_history',
    'physical_inventory', 'mrp_change_log', 'ewaybills',
    'journal_entry_header', 'journal_entry_lines',
    'promotions', 'configurations',
    'team_members', 'business_roles',
]);

// In-memory cache for highest code sequences to prevent redundant database/network scans.
const highestMaterialCodeCache: Record<string, number> = {};
const highestDoctorCodeCache: Record<string, number> = {};

let columnFilterPromise: Promise<any> | null = null;
const getColumnFilter = (): Promise<any> => {
    if (!columnFilterPromise) {
        columnFilterPromise = import('../src/core/sync/columnFilter');
    }
    return columnFilterPromise;
};

async function enqueueForSync(
    tableName: string,
    isUpdate: boolean,
    payload: Record<string, unknown>,
    organizationId: string,
): Promise<void> {
    if (!SYNC_QUEUE_TABLES.has(tableName)) return;
    const recordId = typeof payload.id === 'string' ? payload.id : String(payload.id ?? '');
    if (!recordId) return;
    try {
        await SyncQueue.enqueue(isUpdate ? 'UPDATE' : 'INSERT', tableName, recordId, payload, organizationId);
    } catch (err) {
        // Non-fatal: the local IDB copy is still preserved; we just lose the
        // queued push. Logged so we can spot it during development.
        console.warn(`[storage] SyncQueue.enqueue(${tableName}) failed:`, err);
    }
}

// Columns whose SQLite values are JSON-encoded by columnFilter/InitialSync
// and need to be parsed back into native objects/arrays before the legacy
// app's components consume them. This is the authoritative list (matched
// against the SQLite schema in src/core/db/migrations/001_initial.ts) — but
// `decodeSqliteRow` also auto-detects any value that looks like JSON
// (starts with `[` or `{`) so a missed column can't crash the app.
const SQLITE_JSON_COLUMNS: Record<string, string[]> = {
    sales_bill: ['items'],
    sales_challans: ['items'],
    delivery_challans: ['items'],
    sales_returns: ['items'],
    purchase_returns: ['items'],
    purchases: ['items'],
    purchase_orders: ['items'],
    physical_inventory: ['items'],
    configurations: [
        'invoice_config', 'non_gst_invoice_config', 'purchase_config',
        'purchase_order_config', 'medicine_master_config',
        'physical_inventory_config', 'delivery_challan_config',
        'sales_challan_config', 'master_shortcuts', 'display_options',
        'modules', 'sidebar',
    ],
    customers: ['ledger'],
    suppliers: ['ledger', 'payment_details'],
    business_roles: ['work_centers', 'permissions_matrix'],
    team_members: ['assigned_roles', 'work_centers'],
    mbc_cards: ['transactions'],
    ewaybills: ['data'],
    promotions: ['rules'],
};

function looksLikeJson(s: string): boolean {
    if (s.length < 2) return false;
    const first = s.charCodeAt(0);
    // '[' = 91, '{' = 123
    return first === 91 || first === 123;
}

// SQLite-only bookkeeping columns added by columnFilter/migrations. Must NOT
// be sent back to Supabase, and must be stripped BEFORE toCamel converts them
// into PascalCase ("SyncStatus", "LocalOnly") which then leak into payloads.
const SQLITE_BOOKKEEPING_COLUMNS = ['_sync_status', '_local_only'];

function decodeSqliteRow(tableName: string, row: Record<string, any>): Record<string, any> {
    const jsonCols = SQLITE_JSON_COLUMNS[tableName] || [];
    const out = { ...row };

    // Strip bookkeeping columns up front.
    for (const col of SQLITE_BOOKKEEPING_COLUMNS) {
        delete out[col];
    }

    // 1. Known JSON columns — always attempt parse.
    for (const col of jsonCols) {
        const v = out[col];
        if (typeof v === 'string' && v.length > 0) {
            try { out[col] = JSON.parse(v); } catch { /* leave as-is */ }
        }
    }

    // 2. Defensive auto-detect — any other string value that smells like JSON
    //    (starts with `[` or `{`) gets parsed too. Failures are silently
    //    left as the raw string so this can never crash.
    for (const key in out) {
        const v = out[key];
        if (typeof v !== 'string') continue;
        if (!looksLikeJson(v)) continue;
        try { out[key] = JSON.parse(v); } catch { /* not JSON, keep string */ }
    }

    return out;
}

// Track in-flight hydrations so parallel callers share one pass instead of
// queuing up redundant ones (App.tsx boot + SyncBootstrap + getData fallback
// were all triggering separately and saturating the SQL connection).
const _hydrateInFlight = new Map<string, Promise<void>>();
const _hydratedOrgs = new Set<string>();

/** Fired when hydration finishes (success or failure). Listeners can refresh React state. */
export const HYDRATE_COMPLETE_EVENT = 'mdxera:hydrate-complete';

/**
 * Hydrate the in-memory cache from the SQLite store populated by the
 * offline-first InitialSync. Without this, the legacy app boots with an empty
 * memoryCache and (since IndexedDB is disabled) is data-less offline.
 *
 * Fire-and-forget: callers should NOT await this — the legacy app boots with
 * an empty cache and refills as soon as the function resolves and fires
 * `mdxera:hydrate-complete`. Any failure is logged and swallowed.
 */
export const hydrateMemoryCacheFromSqlite = async (organizationId: string): Promise<void> => {
    if (!organizationId) return;
    if (_hydratedOrgs.has(organizationId)) return;
    const cached = _hydrateInFlight.get(organizationId);
    if (cached) return cached;

    const work = async (): Promise<void> => {
        const db = sqliteDb;

        const TABLES_TO_HYDRATE = Object.values(STORES);

        // Run all table SELECTs concurrently. Tauri's plugin-sql can handle
        // many parallel reads on its single connection, and serial loads of 30
        // tables × ~500ms latency each blow the 15s overall timeout on first
        // launch.
        await Promise.all(
            TABLES_TO_HYDRATE.map(async (table) => {
                const storeKey = table.toUpperCase();
                try {
                    const rows = await db.select<Record<string, any>>(
                        `SELECT * FROM ${table} WHERE organization_id = ?`,
                        [organizationId],
                    );
                    if (!rows || rows.length === 0) {
                        memoryCache[storeKey] = [];
                        memoryCacheOrgScope[storeKey] = organizationId;
                        return;
                    }

                    const normalized = rows
                        .map(r => decodeSqliteRow(table, r))
                        .map(r => fromSupabase(table, r));

                    memoryCache[storeKey] = normalized;
                    memoryCacheOrgScope[storeKey] = organizationId;
                } catch (err) {
                    // Most likely: table doesn't exist locally yet. Safe to skip.
                    console.debug(`[storage] hydrate(${table}) skipped:`, (err as Error)?.message);
                    memoryCache[storeKey] = [];
                    memoryCacheOrgScope[storeKey] = organizationId;
                }
            }),
        );
    };

    const startedAt = Date.now();
    const promise = (async () => {
        try {
            await work();
            const elapsed = Date.now() - startedAt;
            console.info(`[storage] hydrateMemoryCacheFromSqlite completed in ${elapsed}ms`);
        } catch (err) {
            console.warn('[storage] hydrateMemoryCacheFromSqlite failed:', err);
        } finally {
            _hydrateInFlight.delete(organizationId);
            _hydratedOrgs.add(organizationId);
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent(HYDRATE_COMPLETE_EVENT, { detail: { organizationId } }));
            }
        }
    })();
    _hydrateInFlight.set(organizationId, promise);
    return promise;
};

    export const safeRandomUUID = (): string => {
        if (typeof window !== 'undefined' && window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    };

    export const generateUUID = () => safeRandomUUID();

    // Memory cache to fallback when IndexedDB is disabled
    const memoryCache: Record<string, any[]> = {};
    const memoryCacheOrgScope: Record<string, string> = {};

    export const hydrateTableFromSqlite = async (organizationId: string, table: string): Promise<void> => {
        try {
            const rows = await sqliteDb.select<Record<string, any>>(
                `SELECT * FROM ${table} WHERE organization_id = ?`,
                [organizationId],
            );
            const storeKey = table.toUpperCase();
            if (!rows || rows.length === 0) {
                memoryCache[storeKey] = [];
                memoryCacheOrgScope[storeKey] = organizationId;
                return;
            }
            const normalized = rows
                .map(r => decodeSqliteRow(table, r))
                .map(r => fromSupabase(table, r));

            memoryCache[storeKey] = normalized;
            memoryCacheOrgScope[storeKey] = organizationId;
        } catch (err) {
            console.warn(`[storage] hydrateTableFromSqlite(${table}) failed:`, err);
        }
    };

    // Cross-window synchronization
    const syncChannel = new BroadcastChannel('mdxera-sync-channel');
    syncChannel.onmessage = async (event) => {
        if (event.data?.action === 'invalidate' && event.data?.table) {
            const tableName = event.data.table;
            const storeKey = tableName.toUpperCase();
            if (memoryCache[storeKey]) {
                const orgId = memoryCacheOrgScope[storeKey];
                if (orgId) {
                    await hydrateTableFromSqlite(orgId, tableName);
                } else {
                    delete memoryCache[storeKey];
                    delete memoryCacheOrgScope[storeKey];
                }
                if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('mdxera-cache-invalidated', { detail: { table: tableName } }));
                }
            }
        }
    };


    const updateMemoryCacheBulk = (tableName: string, dataArray: any[], organizationId: string) => {
        const storeKey = tableName.toUpperCase();
        if (memoryCacheOrgScope[storeKey] !== organizationId) {
            memoryCache[storeKey] = [...dataArray];
            memoryCacheOrgScope[storeKey] = organizationId;
            return;
        }

        if (!memoryCache[storeKey]) {
            memoryCache[storeKey] = [...dataArray];
            return;
        }

        const cache = memoryCache[storeKey];
        for (const item of dataArray) {
            const idx = cache.findIndex(c => c.id === item.id);
            if (idx >= 0) cache[idx] = item;
            else cache.push(item);
        }
    };

    /**
     * Single-row variant of updateMemoryCacheBulk, exported so save paths that
     * bypass `saveData` (notably supplierService.createSupplierQuick) can keep
     * the legacy memoryCache in lockstep with their direct SQLite write.
     *
     * Without this, the flow looked like:
     *   1. User edits supplier, clicks Save
     *   2. createSupplierQuick writes to SQLite + sync queue and returns
     *   3. App.tsx setSuppliers(...) updates React state — visible briefly
     *   4. App.tsx then runs loadData('background') which re-reads memoryCache
     *   5. memoryCache still has the OLD row (createSupplierQuick never
     *      touched it) → setSuppliers gets called again with stale data
     *   6. UI reverts to pre-edit values. Restarting the app fixed it
     *      because hydration on next boot reads from SQLite (which DID
     *      have the new data).
     *
     * Calling this after any direct-SQLite write closes the loop.
     */
    export const updateMemoryCacheEntry = (tableName: string, entry: any, organizationId: string): void => {
        if (!entry || !entry.id) return;
        updateMemoryCacheBulk(tableName, [entry], organizationId);
    };

    const clearTableMemoryCache = (tableName: keyof typeof STORES) => {
        const storeKey = tableName.toUpperCase() as keyof typeof STORES;
        if (memoryCache[storeKey]) {
            delete memoryCache[storeKey];
        }
        if (memoryCacheOrgScope[storeKey]) {
            delete memoryCacheOrgScope[storeKey];
        }
    };

    const extractTrailingNumber = (value: string): { digits: string; startIndex: number; endIndex: number } | null => {
        const match = value.match(/(\d+)(?!.*\d)/);
        if (!match || match.index === undefined) return null;
        return {
            digits: match[1],
            startIndex: match.index,
            endIndex: match.index + match[1].length
        };
    };

    const buildSequentialSalesBillId = (templateId: string, latestId?: string | null): string => {
        if (!latestId) return templateId;

        const latestNumberPart = extractTrailingNumber(latestId);
        const templateNumberPart = extractTrailingNumber(templateId);

        if (!latestNumberPart || !templateNumberPart) return templateId;

        const nextNumber = Number(latestNumberPart.digits) + 1;
        if (!Number.isFinite(nextNumber)) return templateId;

        const targetPadding = Math.max(templateNumberPart.digits.length, latestNumberPart.digits.length);
        const paddedNext = String(nextNumber).padStart(targetPadding, '0');

        return `${templateId.slice(0, templateNumberPart.startIndex)}${paddedNext}${templateId.slice(templateNumberPart.endIndex)}`;
    };

const MATERIAL_CODE_START = 10000000;
const MATERIAL_CODE_LENGTH = 8;
const DOCTOR_CODE_PREFIX = 'DOC-';
const DOCTOR_CODE_START = 1;

const parseDoctorCodeNumber = (value: unknown): number | null => {
    if (typeof value !== 'string' || !value.startsWith(DOCTOR_CODE_PREFIX)) return null;
    const numPart = value.substring(DOCTOR_CODE_PREFIX.length);
    const parsed = parseInt(numPart, 10);
    return isNaN(parsed) ? null : parsed;
};

const getHighestLocalDoctorCode = async (organizationId: string): Promise<number> => {
    const localRows = await idb.getAll(STORES.DOCTOR_MASTER);
    return localRows.reduce((max, row) => {
        if (row?.organization_id !== organizationId) return max;
        const parsed = parseDoctorCodeNumber(row?.doctorCode);
        return parsed !== null && parsed > max ? parsed : max;
    }, DOCTOR_CODE_START - 1);
};

const getHighestRemoteDoctorCode = async (organizationId: string): Promise<number> => {
    const { data, error } = await supabase
        .from('doctor_master')
        .select('doctor_code')
        .eq('organization_id', organizationId)
        .not('doctor_code', 'is', null);

    if (error) throw error;
    
    return (data || []).reduce((max, r) => {
        const parsed = parseDoctorCodeNumber(r.doctor_code);
        return parsed !== null && parsed > max ? parsed : max;
    }, DOCTOR_CODE_START - 1);
};

const getNextDoctorCode = async (organizationId: string): Promise<string> => {
    let highest = highestDoctorCodeCache[organizationId];
    
    if (highest === undefined) {
        const localHighest = await getHighestLocalDoctorCode(organizationId);
        let remoteHighest = DOCTOR_CODE_START - 1;

        if (navigator.onLine) {
            try {
                remoteHighest = await getHighestRemoteDoctorCode(organizationId);
            } catch { }
        }
        highest = Math.max(localHighest, remoteHighest);
        highestDoctorCodeCache[organizationId] = highest;
    }

    const next = highest + 1;
    highestDoctorCodeCache[organizationId] = next;
    return `${DOCTOR_CODE_PREFIX}${String(next).padStart(6, '0')}`;
};
const MATERIAL_TYPE_LABEL_TO_DB: Record<string, string> = {
    'Trading Goods': 'trading_goods',
    'Finished Goods': 'finished_goods',
    'Consumables': 'consumables',
    'Service Material': 'service_material',
    'Packaging': 'packaging'
};

const parseMaterialCodeNumber = (value: unknown): number | null => {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    // Match any sequence of digits, even if it's shorter than 8 digits
    const match = trimmed.match(/^\d+$/);
    if (!match) return null;
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) ? parsed : null;
};

const getIncrementedMaterialCode = (currentCode: unknown): string | null => {
    const parsed = parseMaterialCodeNumber(currentCode);
    if (parsed === null) return null;
    return String(parsed + 1).padStart(MATERIAL_CODE_LENGTH, '0');
};

const normalizeMaterialMasterType = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return MATERIAL_TYPE_LABEL_TO_DB[trimmed] || trimmed;
};

    const getHighestLocalMaterialCode = async (organizationId: string): Promise<number> => {
        // Look in BOTH IDB and memoryCache. memoryCache is populated by
        // hydrateMemoryCacheFromSqlite — on a fresh browser session, IDB may
        // be empty even when SQLite has the full master list. Without the
        // memoryCache check, the next code would be MATERIAL_CODE_START
        // (10000000), guaranteeing collisions with already-synced rows.
        const reduceMax = (rows: any[], current: number) =>
            rows.reduce((max, row) => {
                if (row?.organization_id !== organizationId) return max;
                const parsed = parseMaterialCodeNumber(row?.materialCode);
                return parsed !== null && parsed > max ? parsed : max;
            }, current);

        let highest = MATERIAL_CODE_START - 1;
        try {
            const idbRows = await idb.getAll(STORES.MATERIAL_MASTER);
            highest = reduceMax(idbRows, highest);
        } catch { /* IDB unavailable; fall through */ }

        const cached = memoryCache['MATERIAL_MASTER'];
        if (Array.isArray(cached)) highest = reduceMax(cached, highest);

        // SQLite is the durable source of truth. Query it directly so we
        // catch rows that were synced into SQLite but never put into IDB
        // (hydration writes only to memoryCache; persistLocalRowToSqlite
        // mirrors writes to SQLite). One small SELECT is cheap.
        try {
            const rows = await sqliteDb.select<{ material_code: string }>(
                `SELECT material_code FROM material_master WHERE organization_id = ?`,
                [organizationId],
            );
            for (const r of rows) {
                const parsed = parseMaterialCodeNumber(r?.material_code);
                if (parsed !== null && parsed > highest) highest = parsed;
            }
        } catch { /* SQLite unavailable; rely on the above */ }

        return highest;
    };

    const getHighestRemoteMaterialCode = async (organizationId: string): Promise<number> => {
        let allCodes: string[] = [];
        let from = 0;
        const PAGE_SIZE = 1000;
        let hasMore = true;

        // Fetch all material codes for this organization to accurately find the numeric maximum.
        // We avoid string-based sorting in the database because it fails with mixed-length numbers 
        // (e.g., '9' sorts higher than '10000000').
        while (hasMore) {
            const { data, error } = await supabase
                .from('material_master')
                .select('material_code')
                .eq('organization_id', organizationId)
                .range(from, from + PAGE_SIZE - 1);

            if (error) throw error;
            
            if (data && data.length > 0) {
                allCodes = [...allCodes, ...data.map(r => r.material_code)];
                hasMore = data.length === PAGE_SIZE;
                from += PAGE_SIZE;
            } else {
                hasMore = false;
            }
        }

        return allCodes.reduce((max, code) => {
            const parsed = parseMaterialCodeNumber(code);
            return parsed !== null && parsed > max ? parsed : max;
        }, MATERIAL_CODE_START - 1);
    };

    const getNextMaterialCode = async (organizationId: string): Promise<string> => {
        let highest = highestMaterialCodeCache[organizationId];
        
        if (highest === undefined) {
            const localHighest = await getHighestLocalMaterialCode(organizationId);
            let remoteHighest = MATERIAL_CODE_START - 1;

            if (navigator.onLine) {
                try {
                    remoteHighest = await getHighestRemoteMaterialCode(organizationId);
                } catch {
                    // Fallback to local sequence when remote read fails.
                }
            }
            highest = Math.max(localHighest, remoteHighest);
            highestMaterialCodeCache[organizationId] = highest;
        }

        const next = highest + 1;
        highestMaterialCodeCache[organizationId] = next;
        return String(next).padStart(MATERIAL_CODE_LENGTH, '0');
    };

    const SALES_BILL_ALLOWED_FIELDS = [
        'id', 'invoiceNumber', 'organization_id', 'user_id', 'created_by_id', 'date',
        'customerName', 'customerId', 'customerPhone', 'customerAddress', 'referredBy',
        'items', 'itemCount',
        'subtotal', 'totalItemDiscount', 'totalGst', 'schemeDiscount', 'adjustment', 'narration', 'roundOff', 'total', 'amountReceived',
        'status', 'paymentMode', 'billType',
        'prescriptionUrl', 'prescriptionImages', 'linkedChallans',
        'createdAt', 'updatedAt'
    ];

    const SALES_CHALLAN_ALLOWED_FIELDS = [
        'id', 'challanSerialId', 'organization_id', 'user_id', 'created_by_id', 'date',
        'customerName', 'customerId', 'customerPhone',
        'items', 'totalAmount', 'subtotal', 'totalGst', 'status', 'narration', 'remarks',
        'createdAt', 'updatedAt'
    ];

    const PURCHASES_ALLOWED_FIELDS = [
        'id', 'organization_id', 'user_id', 'created_by_id',
        'purchaseSerialId', 'supplier', 'invoiceNumber', 'date',
        'subtotal', 'totalGst', 'totalItemDiscount', 'totalItemSchemeDiscount', 'schemeDiscount', 'roundOff', 'totalAmount',
        'items',
        'status', 'eWayBillNo', 'eWayBillDate', 'referenceDocNumber', 'idempotency_key', 'linkedChallans',
        'createdAt', 'updatedAt'
    ];

    // NOTE: `controlGlId` / `control_gl_id` is intentionally NOT listed here.
    // public.customers has a BEFORE INSERT/UPDATE trigger (see
    // supabase/company_auto_gl_defaults.sql -> auto_map_party_control_gl)
    // that resolves control_gl_id from the party-group mapping and raises
    // P0001 ("Control GL is auto-mapped from group and cannot be manually
    // edited") if the client sends a different value. Whatever we resolved
    // locally (especially via the offline GL-code fallback) often doesn't
    // match — so we let the server fill it. SyncPuller pulls the trigger's
    // result back into the local mirror.
    const CUSTOMERS_ALLOWED_FIELDS = [
        'id', 'organization_id', 'user_id', 'created_by_id',
        'name', 'customerType', 'phone', 'mobile', 'email',
        'address', 'address_line1', 'address_line2', 'area', 'city', 'pincode', 'district', 'state', 'country',
        'gstNumber', 'gst_number', 'drugLicense', 'drug_license', 'panNumber', 'pan_number',
        'ledger', 'defaultDiscount', 'default_discount', 'defaultRateTier', 'default_rate_tier', 'is_active', 'is_blocked',
        'assignedStaffId', 'assigned_staff_id', 'assignedStaffName', 'assigned_staff_name', 'opening_balance', 'customerGroup', 'customer_group',
        'creditLimit', 'credit_limit', 'creditDays', 'credit_days', 'creditStatus', 'credit_status', 'creditControlMode', 'credit_control_mode',
        'allowOverride', 'allow_override', 'overrideApprovalRequired', 'override_approval_required', 'enableCreditLimit', 'enable_credit_limit',
        'remarks', 'referredBy', 'referred_by', 'currentBalance', 'current_balance', 'paymentTerms', 'payment_terms', 'createdAt', 'updatedAt'
    ];

    // Same trigger applies to suppliers — `controlGlId` is intentionally omitted.
    const SUPPLIERS_ALLOWED_FIELDS = [
        'id', 'organization_id', 'user_id', 'created_by_id',
        'name', 'brandAgencies', 'brand_agencies', 'category', 'contactPerson', 'contact_person',
        'phone', 'mobile', 'email', 'website',
        'address', 'address_line1', 'address_line2', 'area', 'city', 'pincode', 'district', 'state', 'country',
        'gstNumber', 'gst_number', 'panNumber', 'pan_number', 'drugLicense', 'drug_license', 'foodLicense', 'food_license', 'tanNumber', 'tan_number', 'paymentDetails', 'payment_details',
        'opening_balance', 'supplierGroup', 'supplier_group', 'currentBalance', 'current_balance', 'ledger',
        'is_active', 'is_blocked', 'remarks', 'createdAt', 'created_at', 'updatedAt', 'updated_at'
    ];

    const isValidUuid = (value: any): boolean => 
        typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

    // Standardize Primary Keys to 'id' for all tables.
    // This aligns with the migration_proper_fix.sql and avoids collisions with Owner IDs.
    const UUID_PK_TABLES: string[] = [];
    const TEXT_PK_TABLES = ['sales_returns', 'purchase_returns'];
    
    // Tables that track ownership via created_by_id (Auth UUID).
    // Exported (via the re-export at the bottom of this file) so SyncWorker
    // can apply the same user_id -> created_by_id mapping its offline-queue
    // push path, otherwise rows that flushed through SyncWorker land with
    // created_by_id = NULL on Supabase while rows pushed directly via the
    // online path (getSupabasePayload below) have it populated.
    const OWNER_TRACKING_TABLES = [
        'inventory', 'purchases', 'suppliers', 'customers', 'sales_bill',
        'sales_returns', 'purchase_returns', 'material_master', 'purchase_orders',
        'sales_challans', 'delivery_challans', 'physical_inventory', 'doctor_master'
    ];

    const pickFields = (payload: Record<string, any>, allowedFields: string[]) => {
        return allowedFields.reduce((acc, key) => {
            if (payload[key] !== undefined) {
                acc[key] = payload[key];
            }
            return acc;
        }, {} as Record<string, any>);
    };

    const getSupabasePayload = (tableName: string, payload: Record<string, any>): Record<string, any> => {
        // 1. Start with a copy of the payload
        let sanitized: Record<string, any> = { ...payload };

        // NEW: Explicitly filter fields for critical transactional tables to ensure new fields like 'narration' and 'adjustment' are prioritized.
        if (tableName === 'sales_bill') {
            sanitized = pickFields(payload, SALES_BILL_ALLOWED_FIELDS);
            // Explicit override to ensure these are never lost during picking
            if (payload.narration !== undefined) sanitized.narration = payload.narration;
            if (payload.adjustment !== undefined) sanitized.adjustment = payload.adjustment;
        } else if (tableName === 'sales_challans') {
            sanitized = pickFields(payload, SALES_CHALLAN_ALLOWED_FIELDS);
            if (payload.narration !== undefined) sanitized.narration = payload.narration;
        } else if (tableName === 'customers') {
            sanitized = pickFields(payload, CUSTOMERS_ALLOWED_FIELDS);
        } else if (tableName === 'suppliers') {
            sanitized = pickFields(payload, SUPPLIERS_ALLOWED_FIELDS);
        }

        // 2. Standard Primary Key Handling
        // All modernized tables now use 'id' as the PK.
        if (tableName === 'sales_bill' || tableName === 'physical_inventory') {
            if (!payload.id) {
                 sanitized.id = (tableName === 'sales_bill' ? payload.invoiceNumber : null) || generateUUID();
            }
            // Compatibility: Support both 'id' and 'voucher_no' column names in database
            // This prevents "null value in column voucher_no violates not-null constraint" errors on legacy schemas.
            sanitized.voucher_no = sanitized.id;
            
            // SPECIAL: For physical_inventory, if 'id' is a custom voucher (e.g. PHY-001)
            // and it's being used as the primary key, we must NOT delete it in step 3.
        } else if (!TEXT_PK_TABLES.includes(tableName)) {
            // Ensure 'id' is a valid UUID. If it's not, we intentionally DO NOT strip it here.
            // Stripping it causes Supabase to silently insert a new record instead of updating.
            // If the ID is invalid for a UUID column, it's better to let Supabase throw a 
            // explicit error than to create silent duplicates in the database.
            if (payload.id && !isValidUuid(payload.id)) {
                // delete sanitized.id; 
            }
        }

        // Mapping for linked Purchase Order in purchases table
        if (tableName === 'purchases') {
            if (payload.sourcePurchaseOrderId) {
                // sourcePurchaseOrderId is the app's field, reference_doc_number is the DB's field
                sanitized.reference_doc_number = payload.sourcePurchaseOrderId;
                delete sanitized.sourcePurchaseOrderId;
            }
            // Strip frontend-only field used for tracking the receive flow mode
            delete sanitized.sourceReceiveMode;
        }

        // 3. Apply Ownership Tracking Mappings
        if (OWNER_TRACKING_TABLES.includes(tableName)) {
            // Map the app's 'user_id' (Auth User UUID) to 'created_by_id' in DB
            // Special: physical_inventory uses 'user_id' column directly as a FK to auth.users
            if (payload.user_id && isValidUuid(payload.user_id)) {
                if (tableName !== 'physical_inventory') {
                    sanitized.created_by_id = payload.user_id;
                }
            }

            // Map performedById if present (critical for physical_inventory)
            if (payload.performedById && isValidUuid(payload.performedById)) {
                sanitized.performed_by_id = payload.performedById;
            }
            
            // Critical: Only delete user_id if it's NOT a recognized column or primary key.
            // physical_inventory NEEDS the user_id column for its own foreign key constraint.
            if (!UUID_PK_TABLES.includes(tableName) && tableName !== 'physical_inventory') {
                delete sanitized.user_id;
            }
        }

        // 6. Generic UUID Guard for all ID fields and metadata cleanup
        for (const field in sanitized) {
            // NEW: Convert empty strings to null for doctor_master to avoid 409 conflicts on unique constraints (like doctor_code)
            if (tableName === 'doctor_master' && typeof sanitized[field] === 'string' && sanitized[field].trim() === '') {
                sanitized[field] = null;
                continue;
            }

            // Handle both camelCase 'performedById' and snake_case 'performed_by_id', 'created_by_id', 'user_id'
            const isIdField = field.endsWith('Id') || 
                             field === 'performed_by_id' || 
                             field === 'created_by_id' || 
                             field === 'user_id' ||
                             field === 'assigned_staff_id';

            if (isIdField && sanitized[field]) {
                // Exempt fields that are known to be text IDs rather than strict UUIDs
                if (field === 'id' && (tableName === 'sales_bill' || tableName === 'physical_inventory' || TEXT_PK_TABLES.includes(tableName))) continue;
                if (field === 'originalInvoiceId' || field === 'originalPurchaseInvoiceId' || field === 'purchaseSerialId' || field === 'serialId' || field === 'challanSerialId') continue;
                
                if (!isValidUuid(sanitized[field])) {
                    sanitized[field] = null;
                }
            }
        }

        // Remove internal sync metadata — never send to DB. Covers every
        // casing produced by toSnake/toCamel from `_sync_status`/`_local_only`.
        delete sanitized.sync_status;
        delete sanitized.syncStatus;
        delete sanitized.SyncStatus;
        delete sanitized._sync_status;
        delete sanitized._syncStatus;
        delete sanitized.local_only;
        delete sanitized.localOnly;
        delete sanitized.LocalOnly;
        delete sanitized._local_only;
        delete sanitized._localOnly;
        delete sanitized.record_uuid;
        
        // Explicitly remove remarks for tables that don't support it in the DB schema.
        // purchase_orders has a valid 'remarks' column, so we must NOT strip it there.
        if (tableName !== 'purchase_orders') {
            delete sanitized.remarks;
        }
        
        // RE-APPLY NARATION AND ADJUSTMENT AT THE END TO PREVENT ACCIDENTAL DELETION
        if (tableName === 'sales_bill' || tableName === 'sales_challans') {
            // Use absolute assignment to bypass any filtering done in previous steps
            if (payload.narration !== undefined) sanitized.narration = payload.narration;
            if (payload.adjustment !== undefined) sanitized.adjustment = payload.adjustment;
        }

        // Strip frontend-only unmapped fields from legacy tables to prevent schema cache errors
        if (['sales_bill', 'purchases'].includes(tableName)) {
            delete sanitized.company_code_id;
            delete sanitized.companyCodeId;
            delete sanitized.set_of_books_id;
            delete sanitized.setOfBooksId;
        }

        // Additional sales_bill-only strips (UI/accounting fields with no Supabase column)
        if (tableName === 'sales_bill') {
            delete sanitized.balanceAfterBill;
            delete sanitized.balance_after_bill;
            delete sanitized.previousBalanceBeforeBill;
            delete sanitized.previous_balance_before_bill;
            delete sanitized.hideRetailerOnBill;
            delete sanitized.hide_retailer_on_bill;
            delete sanitized.billedById;
            delete sanitized.billed_by_id;
            delete sanitized.billedByName;
            delete sanitized.billed_by_name;
            delete sanitized.taxCalculationType;
            delete sanitized.tax_calculation_type;
            delete sanitized.eWayBillNo;
            delete sanitized.e_way_bill_no;
            delete sanitized.eWayBillDate;
            delete sanitized.e_way_bill_date;
            delete sanitized.doctorId;
            delete sanitized.doctor_id;
        }

        // Additional purchases-only strips (fields with no Supabase column)
        if (tableName === 'purchases') {
            delete sanitized.cancelledAt;
            delete sanitized.cancelled_at;
            delete sanitized.cancelledBy;
            delete sanitized.cancelled_by;
            delete sanitized.cancellationReason;
            delete sanitized.cancellation_reason;
        }

        // Strip local-only fields from inventory — these exist in the TypeScript
        // InventoryItem model or SQLite schema but have no column in Supabase inventory.
        if (tableName === 'inventory') {
            // SQLite-only FK for local joins against material_master
            delete sanitized.material_id;
            delete sanitized.materialId;
            // UI/promo display fields
            delete sanitized.deal;
            delete sanitized.free;
            delete sanitized.purchaseDeal;
            delete sanitized.purchase_deal;
            delete sanitized.purchaseFree;
            delete sanitized.purchase_free;
            delete sanitized.taxBasis;
            delete sanitized.tax_basis;
            // Fields from material_master that leak into InventoryItem
            delete sanitized.description;
            delete sanitized.manufacturer;
            delete sanitized.code;
            delete sanitized.unitOfMeasurement;
            delete sanitized.unit_of_measurement;
            delete sanitized.packUnit;
            delete sanitized.pack_unit;
            delete sanitized.baseUnit;
            delete sanitized.base_unit;
            delete sanitized.outerPack;
            delete sanitized.outer_pack;
            delete sanitized.unitsPerOuterPack;
            delete sanitized.units_per_outer_pack;
        }

        // Workaround for incomplete database schemas on Returns tables
        if (tableName === 'sales_returns') {
            // These columns do not exist in the older legacy return schema version
            delete sanitized.customer_id;
            delete sanitized.customerId;
            delete sanitized.status;
            delete sanitized.updated_at;
            delete sanitized.updatedAt;
            delete sanitized.user_id;
            delete sanitized.created_by_id;
            delete sanitized.performed_by_id;
            delete sanitized.performedById;
        }
        
        if (tableName === 'purchase_returns') {
            delete sanitized.supplier_id;
            delete sanitized.supplierId;
            delete sanitized.status;
            delete sanitized.updated_at;
            delete sanitized.updatedAt;
            delete sanitized.user_id;
            delete sanitized.created_by_id;
            delete sanitized.performed_by_id;
            delete sanitized.performedById;
        }

        return sanitized;
    };

    export const toCamel = (obj: any): any => {
        if (!obj || typeof obj !== 'object' || obj instanceof Date) return obj;
        if (Array.isArray(obj)) return obj.map(toCamel);
        return Object.keys(obj).reduce((acc, key) => {
            const preservedKeys = [
                'organization_id', 'user_id', 'created_by_id', 'assigned_staff_id', 'performed_by_id',
                'narration', 'adjustment',
                'supplier_id', 'master_medicine_id', 'supplier_product_name', 'auto_apply', 
                'full_name', 'pharmacy_name', 'manager_name', 'address_line1', 'address_line2', 
                'contact_person', 'opening_balance', 'supplier_group', 'control_gl_id',
                'retailer_gstin', 'dl_valid_to', 'food_license', 'gst_number', 'drug_license', 'pan_number', 'tan_number',
                'bank_account_name', 'bank_account_number', 'bank_ifsc_code', 
                'bank_upi_id', 'authorized_signatory', 'pharmacy_logo_url', 'dashboard_logo_url', 
                'terms_and_conditions', 'purchase_order_terms', 'organization_type', 'subscription_plan', 
                'subscription_status', 'subscription_id', 'is_active', 'is_blocked'
            ];

            // Skip key conversion for these specific metadata fields that contain IDs
            const skipValueConversionKeys = ['master_shortcuts', 'masterShortcuts', 'master_shortcut_order', 'masterShortcutOrder'];

            let camelKey = preservedKeys.includes(key) ? key : key.replace(/_([a-z0-9])/g, (_, letter) => letter.toUpperCase());

            // If it's one of the shortcut keys, don't recursively convert its values/keys
            acc[camelKey] = (preservedKeys.includes(key) || skipValueConversionKeys.includes(key)) 
                ? obj[key] 
                : toCamel(obj[key]);

            return acc;
        }, {} as any);
    };

    export const fromSupabase = (tableName: string, payload: Record<string, any>): any => {
        if (!payload) return payload;
        let normalized = toCamel(payload);

        // Map linked Purchase Order back to sourcePurchaseOrderId for app logic
        if (tableName === 'purchases' && payload.reference_doc_number) {
            normalized.sourcePurchaseOrderId = payload.reference_doc_number;
        }

        // Handle stringified JSON/Array columns for Purchase Orders (common if columns are 'text' in DB)
        if (tableName === 'purchase_orders') {
            if (typeof normalized.receiveLinks === 'string' && normalized.receiveLinks.trim().startsWith('[')) {
                try { normalized.receiveLinks = JSON.parse(normalized.receiveLinks); } catch (e) { normalized.receiveLinks = []; }
            }
            if (typeof normalized.sourcePurchaseBillIds === 'string' && normalized.sourcePurchaseBillIds.trim().startsWith('[')) {
                try { normalized.sourcePurchaseBillIds = JSON.parse(normalized.sourcePurchaseBillIds); } catch (e) { normalized.sourcePurchaseBillIds = []; }
            }
        }

        // Map db primary key back to app.id
        if (tableName === 'physical_inventory' && payload.voucher_no) {
            // CRITICAL: For stock audits, 'voucher_no' (e.g. PHY-001) is the primary identifier in the app
            normalized.id = payload.voucher_no;
        } else if (UUID_PK_TABLES.includes(tableName) && payload.user_id) {
            // For modern schema tables, 'user_id' is the actual record UUID
            normalized.id = payload.user_id;
        } else if (payload.id) {
            // For legacy or text-id tables, use 'id'
            normalized.id = payload.id;
        } else if (payload.voucher_no) {
            // Fallback for legacy schemas where 'id' was renamed to 'voucher_no'
            normalized.id = payload.voucher_no;
        }

        // Map db.created_by_id back to app.user_id (owner)
        if (payload.created_by_id && !normalized.user_id) {
            normalized.user_id = payload.created_by_id;
        }

        // Normalize boolean fields to prevent SQLite integer/string coercion bugs
        const booleanKeys = ['isLocked', 'passwordLocked', 'isSystemRole', 'isPrescriptionRequired', 'is_active', 'is_blocked', 'auto_apply'];
        for (const key of booleanKeys) {
            if (normalized[key] !== undefined) {
                const val = normalized[key];
                normalized[key] = val === true || val === 1 || val === '1' || (typeof val === 'string' && (val.toLowerCase().trim() === 'true' || val.trim() === '1'));
            }
        }

        // Special: Normalize nested permissions matrix booleans if present
        if (tableName === 'business_roles' && normalized.permissionsMatrix && typeof normalized.permissionsMatrix === 'object') {
            const matrix = normalized.permissionsMatrix;
            for (const section in matrix) {
                if (matrix[section] && typeof matrix[section] === 'object') {
                    const permSet = matrix[section];
                    for (const action in permSet) {
                        const val = permSet[action];
                        permSet[action] = val === true || val === 1 || val === '1' || (typeof val === 'string' && (val.toLowerCase().trim() === 'true' || val.trim() === '1'));
                    }
                }
            }
        }

        return normalized;
    };
    export const toSnake = (obj: any): any => {
        if (!obj || typeof obj !== 'object' || obj instanceof Date) return obj;
        if (Array.isArray(obj)) return obj.map(toSnake);
        return Object.keys(obj).reduce((acc, key) => {
            if (key.startsWith('_')) return acc;
            const preservedKeys = [
                'organization_id', 'user_id', 'created_by_id', 'assigned_staff_id', 'performed_by_id',
                'narration', 'adjustment',
                'supplier_id', 'master_medicine_id', 'supplier_product_name', 'auto_apply', 
                'full_name', 'pharmacy_name', 'manager_name', 'address_line1', 'address_line2', 
                'contact_person', 'opening_balance', 'supplier_group', 'control_gl_id',
                'retailer_gstin', 'dl_valid_to', 'food_license', 'gst_number', 'drug_license', 'pan_number', 'tan_number',
                'bank_account_name', 'bank_account_number', 'bank_ifsc_code', 
                'bank_upi_id', 'authorized_signatory', 'pharmacy_logo_url', 'dashboard_logo_url', 
                'terms_and_conditions', 'purchase_order_terms', 'organization_type', 'subscription_plan', 
                'subscription_status', 'subscription_id', 'is_active', 'is_blocked'
            ];
            
            // JSONB config columns whose contents are read by SQL using camelCase keys — never snake_case them.
            const skipValueConversionKeys = [
                'master_shortcuts', 'masterShortcuts', 'master_shortcut_order', 'masterShortcutOrder',
                'invoiceConfig', 'nonGstInvoiceConfig', 'purchaseConfig', 'purchaseOrderConfig',
                'salesChallanConfig', 'deliveryChallanConfig', 'physicalInventoryConfig',
                'fiscalYearConfig',
            ];

            let snakeKey = preservedKeys.includes(key) ? key : key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
            
            acc[snakeKey] = (preservedKeys.includes(key) || skipValueConversionKeys.includes(key))
                ? obj[key]
                : toSnake(obj[key]);
                
            return acc;
        }, {} as any);
    };

    export const ensureLiveAuth = async (): Promise<void> => {
        await _ensureLiveAuthImpl();
    };

    const isNetworkError = (error: any): boolean => {
        if (!navigator.onLine) return true;
        const msg = error?.message?.toLowerCase() || '';
        return (
            msg.includes('fetch') ||
            msg.includes('network') ||
            msg.includes('timeout') ||
            msg.includes('failed to connect') ||
            msg.includes('session has expired') ||
            msg.includes('jwt') ||
            msg.includes('row-level security') ||
            error?.code === 'PGRST301' ||
            error?.code === '42501' ||
            error?.status === 0 ||
            error?.status === 401 ||
            error?.status === 403 ||
            error?.status === 502 ||
            error?.status === 503 ||
            error?.status === 504
        );
    };

    // Persist a locally-saved row into the SQLite mirror so it survives app
    // restarts even before the SyncEngine flushes it to Supabase. Without this,
    // hydrateMemoryCacheFromSqlite on next boot reads the stale pre-save row
    // and the user sees their offline work disappear. Pulls reuse the same
    // adapter (adaptRowForSqlite) so we get the same schema-drop / JSON encode
    // / boolean conversion / NOT-NULL default behaviour the inbound path uses.
    //
    // syncStatus 'pending' is the signal SyncPuller honours when deciding
    // whether to overwrite a local row with a remote one — keep using it for
    // any write that hasn't been confirmed by Supabase.
    async function persistLocalRowToSqlite(
        tableName: string,
        payload: Record<string, unknown>,
        syncStatus: 'pending' | 'synced' = 'pending',
    ): Promise<void> {
        if (!SYNC_QUEUE_TABLES.has(tableName)) return;
        try {
            const [{ adaptRowForSqlite }] = await Promise.all([
                getColumnFilter(),
            ]);
            // Don't run getSupabasePayload here — that strip targets Supabase's
            // narrower schema and would drop columns that DO exist locally
            // (e.g. inventory.code, added in migration 011). adaptRowForSqlite
            // is already schema-aware and keeps only columns SQLite actually
            // has, so the local persister can take the raw payload.
            const snake = toSnake(payload);
            const adapted = await adaptRowForSqlite(tableName, snake, { syncStatus });
            if (!adapted) return; // local table doesn't exist yet
            await sqliteDb.upsert(tableName, adapted);
        } catch (err) {
            // Non-fatal: memoryCache and the _sync_queue still have the row.
            console.warn(`[storage] persistLocalRowToSqlite(${tableName}) failed:`, err);
        }
    }

    async function persistLocalRowsToSqlite(
        tableName: string,
        payloads: Record<string, unknown>[],
        syncStatus: 'pending' | 'synced' = 'pending',
    ): Promise<void> {
        if (payloads.length === 0) return;
        for (const p of payloads) {
            await persistLocalRowToSqlite(tableName, p, syncStatus);
        }
    }

export const saveData = async (tableName: string, data: any, user: RegisteredPharmacy | null, isUpdate: boolean = false): Promise<any> => {
        if (!user?.organization_id) throw new Error("Organizational identity not verified.");
        const dbPayload: any = { ...data, organization_id: user.organization_id };
        const currentUserId = user?.user_id || user?.id;
        const ownershipTrackingTables = ['inventory', 'sales_bill', 'purchases', 'suppliers', 'customers', 'material_master', 'purchase_orders', 'sales_challans', 'delivery_challans', 'physical_inventory', 'doctor_master'];
        if (ownershipTrackingTables.includes(tableName) && currentUserId && !dbPayload.user_id) {
            dbPayload.user_id = currentUserId;
        }

        if (tableName === 'material_master' && !isUpdate) {
            dbPayload.materialCode = await getNextMaterialCode(user.organization_id);
        }

        if (tableName === 'doctor_master' && !isUpdate) {
            dbPayload.doctorCode = await getNextDoctorCode(user.organization_id);
        }

        if (tableName === 'material_master') {
            const normalizedMaterialType = normalizeMaterialMasterType(dbPayload.materialMasterType);
            if (normalizedMaterialType) {
                dbPayload.materialMasterType = normalizedMaterialType;
            }
        }
        
        // If it's not an update and has no ID, generate one. 
        // If it HAS an ID but is NOT an update (new bill with reserved number), we keep the ID.
        if (!isUpdate && !dbPayload.id) dbPayload.id = generateUUID();
        
        // Initial assumption: if we are offline, it's pending.
        if (!navigator.onLine) {
            dbPayload.sync_status = 'pending';
        }

        // Update memory cache
        const storeKey = tableName.toUpperCase();
        if (!memoryCache[storeKey]) {
            // Populate from IDB first if we have data there, so we don't lose existing items from the view
            const existingItems = await idb.getAll(STORES[storeKey as keyof typeof STORES]);
            memoryCache[storeKey] = Array.isArray(existingItems) ? [...existingItems] : [];
            memoryCacheOrgScope[storeKey] = user.organization_id;
        }
        if (memoryCacheOrgScope[storeKey] !== user.organization_id) {
            memoryCache[storeKey] = [];
            memoryCacheOrgScope[storeKey] = user.organization_id;
        }
        
        const index = memoryCache[storeKey].findIndex(item => item.id === dbPayload.id);
        if (index >= 0) memoryCache[storeKey][index] = dbPayload;
        else memoryCache[storeKey].push(dbPayload);

        await idb.put(STORES[tableName.toUpperCase() as keyof typeof STORES], dbPayload);

        // ONLINE PATH: don't try Supabase, enqueue for the SyncEngine to flush later.
        if (!navigator.onLine) {
            // Mirror the write into SQLite as 'pending' BEFORE enqueueing so a
            // crash between the two leaves a recoverable row (hydration will
            // pick it up; the worker can replay from _sync_queue).
            await persistLocalRowToSqlite(tableName, dbPayload, 'pending');
            await enqueueForSync(tableName, isUpdate, dbPayload, user.organization_id);
            syncChannel.postMessage({ action: 'invalidate', table: tableName });
            return dbPayload;
        }

        if (navigator.onLine) {
            try {
                await ensureLiveAuth();
                const remotePayload = getSupabasePayload(tableName, dbPayload);
                const snakeData = toSnake(remotePayload);
                
                if (tableName === 'configurations') {
                    // Strip JSONB columns that exist locally but not in production
                    // Supabase. Sending them triggers PGRST204 and the whole upsert
                    // is rejected. Mirrors the same filter in SyncWorker so the
                    // direct online path and the queued-push path agree.
                    delete snakeData.medicine_master_config;
                    delete snakeData.fiscal_year_config;

                    // Special handling for configurations to prevent stale voucher sequence overwrites.
                    // We fetch the latest config from DB and merge ONLY the volatile sequence fields.
                    const { data: existing, error: fetchError } = await supabase
                        .from('configurations')
                        .select('*')
                        .eq('organization_id', user.organization_id)
                        .maybeSingle();
                    
                    if (!fetchError && existing) {
                        const voucherColumns = ['invoice_config', 'non_gst_invoice_config', 'purchase_config', 'purchase_order_config', 'sales_challan_config', 'delivery_challan_config', 'physical_inventory_config'];
                        
                        voucherColumns.forEach(col => {
                            if (existing[col] && snakeData[col]) {
                                // Deep merge the JSONB: Keep client's structural settings but DB's running numbers
                                const dbVal = existing[col];
                                const clientVal = snakeData[col];
                                
                                snakeData[col] = {
                                    ...clientVal,
                                    currentNumber: dbVal.currentNumber ?? dbVal.current_number ?? clientVal.currentNumber,
                                    fy: dbVal.fy ?? clientVal.fy,
                                    internalCurrentNumber: dbVal.internalCurrentNumber ?? dbVal.internal_current_number ?? clientVal.internalCurrentNumber
                                };
                            }
                        });

                        // Explicitly preserve master_shortcut_order if it exists in DB but not in payload
                        // Or merge if both exist (favoring client's new order)
                        if (existing.master_shortcut_order && !snakeData.master_shortcut_order) {
                            snakeData.master_shortcut_order = existing.master_shortcut_order;
                        }
                    }
                }

                let result;
                // Use .insert() for new records to ensure we don't accidentally overwrite existing data
                // Use .upsert() only when explicitly requested as an update
                if (!isUpdate && ['sales_bill', 'purchases', 'purchase_orders', 'material_master', 'doctor_master'].includes(tableName)) {
                    const maxAttempts = (tableName === 'material_master' || tableName === 'doctor_master') ? 5 : 1;
                    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                        if (tableName === 'material_master' || tableName === 'doctor_master') {
                            console.info(`[${tableName}:create] insert payload`, {
                                attempt,
                                mode: 'insert',
                                id: snakeData.id,
                                organization_id: snakeData.organization_id,
                                code: tableName === 'material_master' ? snakeData.material_code : snakeData.doctor_code
                            });
                        }
                        // pushWithDriftLearning auto-learns + strips any
                        // column the deployed Supabase doesn't have
                        // (PGRST204) and retries — so a one-off schema-drift
                        // doesn't fail the whole insert. Genuine errors
                        // (duplicate key 23505, etc.) propagate unchanged
                        // for the surrounding retry loop to handle.
                        const insertResult = await pushWithDriftLearning<Record<string, any>>(
                            tableName,
                            snakeData,
                            async (filtered) => {
                                const r = await supabase
                                    .from(tableName)
                                    .insert(filtered as Record<string, unknown>)
                                    .select()
                                    .single();
                                return { data: r.data as Record<string, any> | null, error: r.error };
                            },
                        );
                        const { data: saved, error } = insertResult;
                        if (!error) {
                            result = saved;
                            break;
                        }

                        if (tableName === 'material_master' || tableName === 'doctor_master') {
                            console.error(`[${tableName}:create] insert failed`, {
                                attempt,
                                mode: 'insert',
                                organization_id: snakeData.organization_id,
                                code: tableName === 'material_master' ? snakeData.material_code : snakeData.doctor_code,
                                error
                            });
                        }

                        if (error.code !== '23505') throw error;

                        if (tableName !== 'material_master' && tableName !== 'doctor_master') {
                            throw new Error(`Voucher number ${dbPayload.id} already exists in database. Please refresh and try again.`);
                        }

                        await idb.delete(STORES[tableName.toUpperCase() as keyof typeof STORES], dbPayload.id);
                        
                        dbPayload.id = generateUUID();
                        if (tableName === 'material_master') {
                            delete highestMaterialCodeCache[user.organization_id];
                            dbPayload.materialCode = await getNextMaterialCode(user.organization_id);
                            snakeData.material_code = dbPayload.materialCode;
                        } else if (tableName === 'doctor_master') {
                            delete highestDoctorCodeCache[user.organization_id];
                            dbPayload.doctorCode = await getNextDoctorCode(user.organization_id);
                            snakeData.doctor_code = dbPayload.doctorCode;
                        }
                        
                        await idb.put(STORES[tableName.toUpperCase() as keyof typeof STORES], dbPayload);
                        snakeData.id = dbPayload.id;

                        await new Promise(r => setTimeout(r, 100 + Math.random() * 200));

                        if (attempt === maxAttempts) {
                            throw new Error(`Unable to generate a unique ${tableName === 'material_master' ? 'Material Code' : 'Doctor Code'} after multiple attempts. Please try again.`);
                        }
                    }
                } else {
                    const onConflictColumn = 'id';
                    // Drift-aware upsert: any PGRST204 from a missing column
                    // is auto-learned and the upsert is retried without it.
                    const upsertResult = await pushWithDriftLearning<Record<string, any>>(
                        tableName,
                        snakeData,
                        async (filtered) => {
                            const r = await supabase
                                .from(tableName)
                                .upsert(filtered as Record<string, unknown>, { onConflict: onConflictColumn })
                                .select()
                                .single();
                            return { data: r.data as Record<string, any> | null, error: r.error };
                        },
                    );
                    const { data: saved, error } = upsertResult;
                    if (error) throw error;
                    result = saved;
                }
                
                if (['sales_bill', 'sales_challans'].includes(tableName)) {
                    console.info(`[storage:${tableName}] payload before save:`, snakeData);
                }

                // On successful supabase save, mark as synced and update local storage.
                // MERGE GUARD: Prefer local values if server returns null/undefined for critical fields (schema cache issues)
                let syncedData;
                if (result) {
                    const serverData = fromSupabase(tableName, result);
                    syncedData = { ...dbPayload, ...serverData, sync_status: 'synced' };
                    
                    // Specific guard for narration/adjustment if they came back empty but were sent with values
                    if (dbPayload.narration && !serverData.narration) syncedData.narration = dbPayload.narration;
                    if (dbPayload.adjustment !== undefined && serverData.adjustment === undefined) syncedData.adjustment = dbPayload.adjustment;
                } else {
                    syncedData = { ...dbPayload, sync_status: 'synced' };
                }
                
                const currentStoreKey = tableName.toUpperCase() as keyof typeof STORES;
                await idb.put(STORES[currentStoreKey], syncedData);
                
                // Instead of clearing the cache (which causes data loss in loops when IDB is disabled),
                // we ensure the memory cache is updated with the latest synced data.
                if (memoryCache[storeKey]) {
                    const idx = memoryCache[storeKey].findIndex(item => item.id === syncedData.id);
                    if (idx >= 0) memoryCache[storeKey][idx] = syncedData;
                    else memoryCache[storeKey].push(syncedData);
                }

                // Mirror the confirmed row into SQLite as 'synced' so hydration
                // on next boot reflects the server-confirmed state without
                // having to wait for the next puller cycle.
                await persistLocalRowToSqlite(tableName, syncedData, 'synced');
                syncChannel.postMessage({ action: 'invalidate', table: tableName });

                return syncedData;
            } catch (e: any) {
                if (isNetworkError(e)) {
                    console.warn(`Supabase sync failed for ${tableName} due to network, queueing for retry.`, e);
                    dbPayload.sync_status = 'pending';
                    await idb.put(STORES[tableName.toUpperCase() as keyof typeof STORES], dbPayload);
                    // Keep the local copy durable so a restart before SyncEngine
                    // flushes doesn't lose the write.
                    await persistLocalRowToSqlite(tableName, dbPayload, 'pending');
                    await enqueueForSync(tableName, isUpdate, dbPayload, user.organization_id);
                    syncChannel.postMessage({ action: 'invalidate', table: tableName });
                    return dbPayload; // DO NOT throw for network errors, let UI continue
                }

                if (tableName === 'material_master') {
                    console.error('[material_master:create] hard failure', {
                        mode: isUpdate ? 'update' : 'insert',
                        payload: {
                            id: dbPayload.id,
                            organization_id: dbPayload.organization_id,
                            name: dbPayload.name,
                            materialCode: dbPayload.materialCode,
                            materialMasterType: dbPayload.materialMasterType
                        },
                        error: e
                    });
                    if (!isUpdate) {
                        await idb.delete(STORES[tableName.toUpperCase() as keyof typeof STORES], dbPayload.id);
                        const message = e?.message || 'Unknown database error';
                        throw new Error(`Material Master save failed: ${message}`);
                    }
                }

                // ENHANCED ERROR LOGGING:
                // Identify which field is causing the 'uuid = text' mismatch
                const errorMsg = e?.message || '';
                if (errorMsg.includes('uuid = text') || errorMsg.includes('operator does not exist')) {
                    const remotePayload = getSupabasePayload(tableName, dbPayload);
                    const snakeData = toSnake(remotePayload);
                    
                    // Find potential culprit fields (fields that are expected to be UUIDs but are strings)
                    const potentialUuidFields = Object.keys(snakeData).filter(key => 
                        key.endsWith('_id') || key === 'id' || key === 'user_id' || key === 'customer_id' || key === 'supplier_id' || key === 'master_medicine_id'
                    );
                    
                    const culprits = potentialUuidFields.map(key => `${key}: ${snakeData[key]} (${isValidUuid(snakeData[key]) ? 'VALID' : 'INVALID'})`);
                    
                    console.error(`DETAILED DATA ERROR in ${tableName}:`, {
                        message: errorMsg,
                        culprits,
                        fullPayload: snakeData
                    });
                    
                    // Re-throw with more context so parseNetworkAndApiError can show it
                    throw new Error(`Data Type Mismatch in ${tableName}: ${errorMsg}. (Fields: ${culprits.join(', ')})`);
                }

                // ROLLBACK: If it's a hard error (like Duplicate Key 23505), 
                // we MUST NOT keep this invalid record in local storage.
                if (!isUpdate) {
                    console.error(`Hard failure during save for ${tableName}. Rolling back local record.`, e);
                    await idb.delete(STORES[tableName.toUpperCase() as keyof typeof STORES], dbPayload.id);
                }
                throw e; 
            }
        }
        return dbPayload;
    };

    export const saveBulkData = async (tableName: string, dataArray: any[], user: RegisteredPharmacy | null): Promise<void> => {
        if (!user) return;
        for (const item of dataArray) {
            await saveData(tableName, item, user);
        }
    };

    export const deleteData = async (tableName: string, id: string, user?: RegisteredPharmacy | null): Promise<void> => {
        const storeKey = tableName.toUpperCase() as keyof typeof STORES;
        await idb.delete(STORES[storeKey], id);

        if (memoryCache[storeKey]) {
            memoryCache[storeKey] = memoryCache[storeKey].filter((item: any) => item.id !== id);
        }

        // Mirror the delete into local SQLite so a restart before the queue
        // flushes doesn't bring the row back via hydration. Best-effort —
        // a missing local row is fine.
        if (SYNC_QUEUE_TABLES.has(tableName)) {
            try {
                const idCol = tableName === 'profiles' ? 'user_id' : 'id';
                await sqliteDb.execute(`DELETE FROM ${tableName} WHERE ${idCol} = ?`, [id]);
            } catch (err) {
                console.warn(`[storage] deleteData(${tableName}) local mirror failed:`, err);
            }
        }

        // OFFLINE PATH: previous behaviour was to silently skip the Supabase
        // delete when offline — which meant the row stayed alive on the
        // server forever and would be pulled back on the next sync,
        // appearing to "undelete" itself. Enqueue the DELETE so SyncWorker
        // can flush it when connectivity returns.
        const orgId = user?.organization_id;
        if (!navigator.onLine) {
            if (orgId && SYNC_QUEUE_TABLES.has(tableName)) {
                try {
                    await SyncQueue.enqueue('DELETE', tableName, id, { id }, orgId);
                    syncChannel.postMessage({ action: 'invalidate', table: tableName });
                } catch (err) {
                    console.warn(`[storage] deleteData(${tableName}) enqueue failed:`, err);
                }
            }
            return;
        }

        // ONLINE PATH: try Supabase directly. On network error, fall back to
        // the queue so the user's intent is preserved.
        try {
            await ensureLiveAuth();
            const { error } = await supabase.from(tableName).delete().eq('id', id);
            if (error) throw error;
            syncChannel.postMessage({ action: 'invalidate', table: tableName });
        } catch (err) {
            if (isNetworkError(err) && orgId && SYNC_QUEUE_TABLES.has(tableName)) {
                try {
                    await SyncQueue.enqueue('DELETE', tableName, id, { id }, orgId);
                    syncChannel.postMessage({ action: 'invalidate', table: tableName });
                } catch (queueErr) {
                    console.warn(`[storage] deleteData(${tableName}) fallback enqueue failed:`, queueErr);
                }
                return;
            }
            throw err;
        }
    };

    export const fetchInventory = (user: RegisteredPharmacy, forceSync = false) => getData('inventory', [], user, forceSync);
    export const fetchMedicineMaster = (user: RegisteredPharmacy, forceSync = false) => getData('material_master', [], user, forceSync);
    export const fetchTransactions = (user: RegisteredPharmacy, forceSync = false) => getData('sales_bill', [], user, forceSync);
    export const fetchPurchases = (user: RegisteredPharmacy, forceSync = false) => getData('purchases', [], user, forceSync);
    export const fetchSuppliers = (user: RegisteredPharmacy, forceSync = false) => getData('suppliers', [], user, forceSync);
    export const fetchCustomers = (user: RegisteredPharmacy, forceSync = false) => getData('customers', [], user, forceSync);
    export const fetchPurchaseOrders = (user: RegisteredPharmacy, forceSync = false) => getData('purchase_orders', [], user, forceSync);
    export const fetchTeamMembers = (user: RegisteredPharmacy, forceSync = false) => getData('team_members', [], user, forceSync);
    export const fetchSupplierProductMaps = (user: RegisteredPharmacy, forceSync = false) => getData('supplier_product_map', [], user, forceSync);
    export const fetchCustomerPriceList = (user: RegisteredPharmacy, forceSync = false) => getData('customer_price_list', [], user, forceSync);

    export const fetchDoctors = async (user: RegisteredPharmacy, forceSync = false): Promise<DoctorMaster[]> => {
        const data = await getData('doctor_master', [], user, forceSync);
        return (data || []).sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''));
    };

    // Added missing fetchPhysicalInventory function
    export const fetchPhysicalInventory = (user: RegisteredPharmacy, forceSync = false) => getData('physical_inventory', [], user, forceSync);

    // Added missing fetchEWayBills function
    export const fetchEWayBills = (user: RegisteredPharmacy) => getData('ewaybills', [], user);

    // Voucher numbering — moved to @core/voucher/voucherService for offline-first support.
    // These are re-exported here for backwards compatibility with existing imports.
    export type VoucherDocumentType = _VoucherDocumentTypeImpl;
    export type VoucherReservationResult = _VoucherReservationResultImpl;
    export const reserveVoucherNumber = _reserveVoucherNumberImpl;
    export const markVoucherCancelled = _markVoucherCancelledImpl;

    /**
     * Fetches all organization records from Supabase by handling PostgREST pagination (default 1000 limit).
     */
    const fetchAllPagesFromSupabase = async (tableName: string, orgId: string): Promise<any[]> => {
        let allData: any[] = [];
        let from = 0;
        const PAGE_SIZE = 1000;
        let hasMore = true;

        while (hasMore) {
            const { data, error } = await supabase
                .from(tableName)
                .select('*')
                .eq('organization_id', orgId)
                .range(from, from + PAGE_SIZE - 1);

            if (error) throw error;

            if (data && data.length > 0) {
                allData = [...allData, ...data];
                if (data.length < PAGE_SIZE) {
                    hasMore = false;
                } else {
                    from += PAGE_SIZE;
                }
            } else {
                hasMore = false;
            }
        }

        return allData;
    };

                export const getData = async (tableName: string, defaultValue: any[] = [], user: RegisteredPharmacy | null, forceSync = false): Promise<any[]> => {
        if (!user) return defaultValue;
        const storeKey = tableName.toUpperCase() as keyof typeof STORES;

        if (forceSync && navigator.onLine) {
            delete memoryCache[storeKey];
            delete memoryCacheOrgScope[storeKey];
            syncChannel.postMessage({ action: 'pull_now' });
        }

        if (
            memoryCacheOrgScope[storeKey] === user.organization_id &&
            memoryCache[storeKey] &&
            memoryCache[storeKey].length > 0
        ) {
            return [...memoryCache[storeKey]];
        }

        try {
            await hydrateMemoryCacheFromSqlite(user.organization_id);
            if (memoryCache[storeKey] && memoryCache[storeKey].length > 0) {
                return [...memoryCache[storeKey]];
            }
        } catch {
            /* fall through */
        }

        const cached = await idb.getAll(STORES[storeKey]);

        if (cached && cached.length > 0) {
            memoryCache[storeKey] = [...cached];
            memoryCacheOrgScope[storeKey] = user.organization_id;
        }

        if (navigator.onLine) {
            if ((memoryCache[storeKey] == null || memoryCache[storeKey].length === 0) && cached.length === 0) {
                try {
                    const allData = await fetchAllPagesFromSupabase(tableName, user.organization_id);
                    if (allData.length > 0) {
                        const normalized = allData.map(d => fromSupabase(tableName, d));
                        memoryCache[storeKey] = [...normalized];
                        memoryCacheOrgScope[storeKey] = user.organization_id;
                        await idb.putBulk(STORES[storeKey], normalized);
                        return normalized;
                    }
                } catch (e) {
                    console.error(`Initial fetch failed for ${tableName}:`, e);
                }
            }
        }
        
        if (memoryCache[storeKey] && memoryCache[storeKey].length > 0) {
            return [...memoryCache[storeKey]];
        }

        return cached.length > 0 ? cached : defaultValue;
    };

    export const getDataById = async <T = any>(
        tableName: string,
        id: string,
        user: RegisteredPharmacy | null,
        options: { forceRefresh?: boolean } = {}
    ): Promise<T | null> => {
        if (!user || !id) return null;

        const storeKey = tableName.toUpperCase() as keyof typeof STORES;
        const { forceRefresh = false } = options;
        const cached = await idb.get(STORES[storeKey], id);
        if (cached && !forceRefresh) {
            return cached as T;
        }

        // IDB is disabled in this build, so `cached` is always null. Fall back
        // to memoryCache before going to Supabase — otherwise every caller of
        // getDataById (upsertAutoLedgerEntry, addSalesReturn lookups, etc.)
        // either fails silently offline or wastes a network round-trip online.
        if (!forceRefresh) {
            const scopedCache = memoryCacheOrgScope[storeKey] === user.organization_id ? memoryCache[storeKey] : undefined;
            const localHit = scopedCache?.find((row: any) => {
                if (!row || !row.id) return false;
                return String(row.id).trim().toLowerCase() === String(id).trim().toLowerCase();
            });
            if (localHit) return localHit as T;
        }

        // Fallback to SQLite (Offline App)
        try {
            const rows = await sqliteDb.select<Record<string, any>>(
                `SELECT * FROM ${tableName} WHERE id = ? LIMIT 1`,
                [id]
            );
            if (rows && rows.length > 0) {
                const decoded = decodeSqliteRow(tableName, rows[0]);
                const normalized = fromSupabase(tableName, decoded);
                // Verify organization scope
                if (normalized && normalized.organizationId && normalized.organizationId !== user.organization_id) {
                    console.warn(`[getDataById] SQLite hit found for table ${tableName} with ID ${id} but organizationId mismatch`);
                    return null;
                }
                // Warm cache
                if (!memoryCache[storeKey]) {
                    memoryCache[storeKey] = [];
                }
                const index = memoryCache[storeKey].findIndex((item: any) => 
                    item && item.id && String(item.id).trim().toLowerCase() === String(id).trim().toLowerCase()
                );
                if (index >= 0) {
                    memoryCache[storeKey][index] = normalized;
                } else {
                    memoryCache[storeKey].push(normalized);
                }
                return normalized as T;
            }
        } catch (err) {
            console.warn(`[getDataById] SQLite fallback query failed for table ${tableName}:`, err);
        }

        if (!navigator.onLine) {
            return null;
        }

        try {
            const { data, error } = await supabase
                .from(tableName)
                .select('*')
                .eq('organization_id', user.organization_id)
                .eq('id', id)
                .maybeSingle();

            if (error) throw error;
            if (!data) return null;

            const normalized = fromSupabase(tableName, data);
            await idb.put(STORES[storeKey], normalized);
            return normalized as T;
        } catch (e) {
            console.error(`Failed to fetch ${tableName} record by id:`, e);
            return null;
        }
    };


    const ensurePostingContext = async (
        payload: { companyCodeId?: string; setOfBooksId?: string },
        user: RegisteredPharmacy
    ): Promise<{ companyCodeId: string; setOfBooksId: string }> => {
        // Transaction posting must always follow the configured default company + default set of books.
        // Ignore payload-level company/books values to prevent cross-company ledger posting.
        const defaults = await loadDefaultPostingContext(user.organization_id);
        return {
            companyCodeId: defaults.companyCodeId,
            setOfBooksId: defaults.setOfBooksId,
        };
    };

    const validateGLMappings = async (organizationId: string, setOfBooksId: string, type: 'sales' | 'purchase') => {
        if (!setOfBooksId || !isValidUuid(setOfBooksId) || !isValidUuid(organizationId)) {
            return; // Skip validation for legacy/incomplete configurations
        }
        const requiredCodes = type === 'sales'
            ? ['400100', '210110', '210120', '210130', '510000']
            : ['510000']; // Purchase validation happens line-by-line later but we check round-off here

        let glRows: { gl_code: string }[] = [];
        try {
            const placeholders = requiredCodes.map(() => '?').join(',');
            const rows = await sqliteDb.select<{ gl_code: string }>(
                `SELECT gl_code FROM ${SCHEMA_TABLE.GL_MASTER} WHERE organization_id = ? AND set_of_books_id = ? AND gl_code IN (${placeholders})`,
                [organizationId, setOfBooksId, ...requiredCodes]
            );
            if (rows && rows.length > 0) {
                glRows = rows;
            }
        } catch (err) {
            console.warn('[validateGLMappings] SQLite query failed, trying Supabase:', err);
        }

        const foundCodesLocal = new Set(glRows.map(r => String(r.gl_code)));
        const missingLocal = requiredCodes.filter(c => !foundCodesLocal.has(c));
        if (missingLocal.length > 0 && navigator.onLine) {
            try {
                const { data: remoteRows } = await supabase
                    .from('gl_master')
                    .select('gl_code')
                    .eq('organization_id', organizationId)
                    .eq('set_of_books_id', setOfBooksId)
                    .in('gl_code', requiredCodes);
                if (remoteRows && remoteRows.length > 0) {
                    const combined = [...glRows];
                    for (const r of remoteRows) {
                        if (!combined.some(c => String(c.gl_code) === String(r.gl_code))) {
                            combined.push({ gl_code: r.gl_code });
                        }
                    }
                    glRows = combined;
                }
            } catch (err) {
                console.warn('[validateGLMappings] Supabase query failed:', err);
            }
        }

        const foundCodes = new Set(glRows.map(r => String(r.gl_code)));
        const missing = requiredCodes.filter(c => !foundCodes.has(c));
        
        if (missing.length > 0) {
            const labels: Record<string, string> = {
                '400100': 'Sales',
                '210110': 'Output CGST',
                '210120': 'Output SGST',
                '210130': 'Output IGST',
                '510000': 'Round Off'
            };
            const missingLabels = missing.map(c => `${labels[c]} (${c})`).join(', ');
            throw new Error(`GL mapping incomplete for the selected Set of Books. Missing: ${missingLabels}. Please configure these accounts in GL Master.`);
        }
    };

    const normalizeInventoryKey = (name?: string, batch?: string) => `${String(name || '').trim().toLowerCase()}|${String(batch || 'UNSET').trim().toLowerCase()}`;

    const getBillItemStockUnits = (item: BillItem, inventoryItem?: InventoryItem): number => {
        const resolvedUpp = normalizeUnitsPerPack(item.unitsPerPack ?? inventoryItem?.unitsPerPack, item.packType || inventoryItem?.packType);
        return (Number(item.quantity || 0) * resolvedUpp) + Number(item.looseQuantity || 0);
    };

    export const addTransaction = async (tx: Transaction, user: RegisteredPharmacy, isUpdate: boolean = false) => {
        if (!tx.user_id) tx.user_id = user.user_id;

        const oldTx = isUpdate ? await idb.get(STORES.SALES_BILL, tx.id) as Transaction | undefined : undefined;
        const oldStatus = oldTx?.status || 'completed';
        const newStatus = tx.status || 'completed';

        // Draft/Hold logic:
        // 1. If it stays draft/hold -> just save and return
        if (newStatus === 'hold' || newStatus === 'draft') {
            // Even if it was completed before, if we move it to hold (reversal), 
            // we should probably allow it, but for now we focus on the basic case.
            if (oldStatus !== 'completed') {
                return await saveData('sales_bill', tx, user, isUpdate);
            }
        }

        // Posting Context and Accounting validation - only for COMPLETED bills.
        // Offline: skip the server-side validation (Supabase is unreachable).
        // The SyncEngine will re-validate when it pushes the bill to the server,
        // and any failure surfaces there with the existing error message.
        if (navigator.onLine) {
            try {
                const postingContext = await ensurePostingContext(tx, user);
                tx.companyCodeId = postingContext.companyCodeId;
                tx.setOfBooksId = postingContext.setOfBooksId;

                await validateGLMappings(user.organization_id, tx.setOfBooksId, 'sales');
            } catch (e: any) {
                // Only block if we are actually trying to post a completed bill
                if (newStatus === 'completed') {
                    throw new Error(e?.message || DEFAULT_CONFIG_MISSING_MESSAGE);
                }
                console.warn('[storage:addTransaction] Accounting validation failed for non-completed bill:', e.message);
            }
        } else {
            console.info('[storage:addTransaction] Offline — skipping accounting validation; bill will be validated when synced.');
        }

        // Handle stock reversal for updates BEFORE saving new data to IDB
        // Only reverse if the OLD status was completed (actually deducted stock)
        if (isUpdate && oldStatus === 'completed') {
            if (oldTx && oldTx.items) {
                const currentInventory = await fetchInventory(user);
                const inventoryById = new Map(currentInventory.map((inv) => [inv.id, inv]));
                const inventoryByKey = new Map(currentInventory.map((inv) => [normalizeInventoryKey(inv.name, inv.batch), inv]));
                const unitsToAddByInventoryId = new Map<string, number>();

                for (const item of oldTx.items) {
                    const matchedInventory = (item.inventoryItemId ? inventoryById.get(item.inventoryItemId) : undefined)
                        || inventoryByKey.get(normalizeInventoryKey(item.name, item.batch));
                    if (!matchedInventory) continue;
                    const current = unitsToAddByInventoryId.get(matchedInventory.id) || 0;
                    unitsToAddByInventoryId.set(matchedInventory.id, current + getBillItemStockUnits(item, matchedInventory));
                }

                if (unitsToAddByInventoryId.size > 0) {
                    const inventoryIds = Array.from(unitsToAddByInventoryId.keys());
                    const inventoryRecords = await Promise.all(
                        inventoryIds.map(id => idb.get(STORES.INVENTORY, id) as Promise<InventoryItem | null>)
                    );

                    const updatedInventory: InventoryItem[] = inventoryRecords
                        .filter((inv): inv is InventoryItem => Boolean(inv))
                        .map(inv => {
                            const unitsToAdd = unitsToAddByInventoryId.get(inv.id) || 0;
                            return {
                                ...inv,
                                stock: Number(inv.stock || 0) + unitsToAdd,
                            };
                        });

                    if (updatedInventory.length > 0) {
                        await idb.putBulk(STORES.INVENTORY, updatedInventory);
                        updateMemoryCacheBulk(STORES.INVENTORY, updatedInventory, user.organization_id);

                        // Persist the reversal locally too. Without this, items
                        // dropped from an updated bill have their stock reverted
                        // only in memoryCache — Supabase keeps the old (lower)
                        // value and the next puller resync wipes the reversal.
                        await persistLocalRowsToSqlite('inventory', updatedInventory as unknown as Record<string, unknown>[], 'pending');
                        for (const inv of updatedInventory) {
                            await enqueueForSync('inventory', true, inv as unknown as Record<string, unknown>, user.organization_id);
                        }
                    }
                }
            }
        }

        const res = await saveData('sales_bill', tx, user, isUpdate);

        // If it's a draft/hold (and not a transition to completed which was handled above or will be below), skip impacts
        if (newStatus === 'draft' || newStatus === 'hold') {
            return res;
        }

        // Now process stock deduction (for new completed or transition hold -> completed or update completed)
        const cfgRows = await getData('configurations', [{ organization_id: user.organization_id }], user) as AppConfigurations[];
        const stockHandling = resolveStockHandlingConfig(cfgRows?.[0]);
        const allowNegativeStock = stockHandling.allowNegativeStock;

        // Batch inventory updates
        const currentInventory = await fetchInventory(user);
        const inventoryById = new Map(currentInventory.map((inv) => [inv.id, inv]));
        const inventoryByKey = new Map(currentInventory.map((inv) => [normalizeInventoryKey(inv.name, inv.batch), inv]));
        const unitsToDeductByInventoryId = new Map<string, number>();
        for (const item of tx.items) {
            const matchedInventory = (item.inventoryItemId ? inventoryById.get(item.inventoryItemId) : undefined)
                || inventoryByKey.get(normalizeInventoryKey(item.name, item.batch));
            if (!matchedInventory) continue;
            const current = unitsToDeductByInventoryId.get(matchedInventory.id) || 0;
            unitsToDeductByInventoryId.set(matchedInventory.id, current + getBillItemStockUnits(item, matchedInventory));
        }

        if (unitsToDeductByInventoryId.size > 0) {
            const inventoryIds = Array.from(unitsToDeductByInventoryId.keys());
            const inventoryRecords = await Promise.all(
                inventoryIds.map(async id => {
                    const cached = await idb.get(STORES.INVENTORY, id) as InventoryItem | null;
                    return cached || inventoryById.get(id) || null;
                })
            );

            const updatedInventory: InventoryItem[] = inventoryRecords
                .filter((inv): inv is InventoryItem => Boolean(inv))
                .map(inv => {
                    const unitsToDeduct = unitsToDeductByInventoryId.get(inv.id) || 0;
                    const stockBefore = Number(inv.stock || 0);
                    const stockAfter = deductStockLooseFirst(stockBefore, unitsToDeduct, inv.unitsPerPack, inv.packType, allowNegativeStock);
                    logStockMovement({ transactionType: 'sales-outward', voucherId: tx.id, item: inv.name, batch: inv.batch || 'UNSET', qty: unitsToDeduct, qtyOut: unitsToDeduct, stockBefore, stockAfter, organizationId: user.organization_id, validationResult: 'allowed', mode: stockHandling.mode });
                    return {
                        ...inv,
                        stock: stockAfter,
                    };
                });

            if (updatedInventory.length > 0) {
                await idb.putBulk(STORES.INVENTORY, updatedInventory);
                // Patch the memoryCache in-place instead of clearing it; otherwise
                // a subsequent fetchInventory call goes hunting on Supabase and
                // returns [] when offline — wiping the React state.
                updateMemoryCacheBulk(STORES.INVENTORY, updatedInventory, user.organization_id);

                let supabaseUpsertSucceeded = false;
                if (navigator.onLine) {
                    try {
                        const remotePayload = updatedInventory.map(inv => toSnake(getSupabasePayload('inventory', inv)));
                        const { error } = await supabase.from('inventory').upsert(remotePayload);
                        if (error) throw error;
                        supabaseUpsertSucceeded = true;
                    } catch (e) {
                        console.warn('Supabase batch inventory sync failed after sales transaction, local copy preserved.', e);
                    }
                }

                // Mirror the deducted stock into SQLite so the inventory page
                // reflects the new values across restarts AND so hydration
                // doesn't clobber the local memoryCache with stale stock.
                await persistLocalRowsToSqlite(
                    'inventory',
                    updatedInventory as unknown as Record<string, unknown>[],
                    supabaseUpsertSucceeded ? 'synced' : 'pending',
                );

                // Also enqueue each updated inventory row for the SyncEngine to push later.
                // (Online-but-upsert-succeeded rows are still enqueued; the
                //  worker dedupes by id, and a redundant push is cheaper than
                //  silently losing a write if the success was partial.)
                for (const inv of updatedInventory) {
                    await enqueueForSync('inventory', true, inv as unknown as Record<string, unknown>, user.organization_id);
                }
            }
        }

        try {
            await syncSalesLedger(tx, user, isUpdate);
        } catch (e) {
            if (isNetworkError(e)) {
                console.warn('Sales ledger sync deferred due to network connectivity.', e);
            } else {
                throw e;
            }
        }
        return res;
    };

    export const syncPendingData = async (user: RegisteredPharmacy): Promise<{ success: number; failed: number }> => {
        if (!navigator.onLine || !user) return { success: 0, failed: 0 };
        
        let successCount = 0;
        let failedCount = 0;
        
        const storesToSync = [
            STORES.SALES_BILL,
            STORES.PURCHASES,
            STORES.INVENTORY,
            STORES.CUSTOMERS,
            STORES.SUPPLIERS,
            STORES.MATERIAL_MASTER,
            STORES.PURCHASE_ORDERS,
            STORES.SALES_CHALLANS,
            STORES.DELIVERY_CHALLANS,
            STORES.PHYSICAL_INVENTORY,
            STORES.SALES_RETURNS,
            STORES.PURCHASE_RETURNS
        ];

        for (const storeName of storesToSync) {
            try {
                const allItems = await idb.getAll(storeName);
                const pendingItems = allItems.filter(item => item.sync_status === 'pending');
                
                for (const item of pendingItems) {
                    try {
                        const tableName = Object.keys(STORES).find(key => (STORES as any)[key] === storeName)?.toLowerCase();
                        if (!tableName) continue;
                        
                        // Re-run saveData which will attempt to push to Supabase
                        await saveData(tableName, item, user, true); 
                        
                        // Special cases for transactions that need ledger sync
                        if (tableName === 'sales_bill') {
                            await syncSalesLedger(item as Transaction, user, true).catch(err => {
                                console.warn('Ledger sync still failing for pending bill:', item.id, err);
                            });
                        } else if (tableName === 'purchases') {
                            await syncPurchaseLedger(item as Purchase, user).catch(err => {
                                console.warn('Ledger sync still failing for pending purchase:', item.id, err);
                            });
                        }
                        
                        successCount++;
                    } catch (itemErr) {
                        console.error(`Failed to sync pending item ${item.id} in ${storeName}:`, itemErr);
                        failedCount++;
                    }
                }
            } catch (storeErr) {
                console.error(`Failed to process sync for store ${storeName}:`, storeErr);
            }
        }
        
        return { success: successCount, failed: failedCount };
    };

    export const generateNextSalesBillId = async (templateId: string, user: RegisteredPharmacy): Promise<string> => {
        const localBills = await idb.getAll(STORES.SALES_BILL) as Transaction[];
        const localLatest = localBills
            .filter(bill => bill.organization_id === user.organization_id)
            .sort((a, b) => {
                const aDate = new Date(a.createdAt || a.date || 0).getTime();
                const bDate = new Date(b.createdAt || b.date || 0).getTime();
                return bDate - aDate;
            })[0]?.id;

        if (!navigator.onLine) {
            return buildSequentialSalesBillId(templateId, localLatest);
        }

        try {
            const { data, error } = await supabase
                .from('sales_bill')
                .select('id')
                .eq('organization_id', user.organization_id)
                .order('created_at', { ascending: false })
                .order('id', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (error) throw error;
            return buildSequentialSalesBillId(templateId, data?.id || localLatest);
        } catch {
            return buildSequentialSalesBillId(templateId, localLatest);
        }
    };

    const normalizeSupplierInvoiceKey = (value?: string | null) => String(value || '').trim().toLowerCase();
    const INACTIVE_PURCHASE_STATUSES = new Set(['cancelled', 'void', 'deleted']);

    const assertNoDuplicateActivePurchaseInvoice = async (payload: Purchase, user: RegisteredPharmacy) => {
        const supplierKey = normalizeSupplierInvoiceKey(payload.supplier);
        const invoiceKey = normalizeSupplierInvoiceKey(payload.invoiceNumber);
        if (!supplierKey || !invoiceKey) return;

        const localPurchases = await idb.getAll(STORES.PURCHASES) as Purchase[];
        const duplicateActiveLocal = localPurchases.find(row => {
            if (!row) return false;
            if (row.organization_id !== user.organization_id) return false;
            if (row.id === payload.id) return false;
            if (normalizeSupplierInvoiceKey(row.supplier) !== supplierKey) return false;
            if (normalizeSupplierInvoiceKey(row.invoiceNumber) !== invoiceKey) return false;
            const normalizedStatus = String(row.status || 'completed').trim().toLowerCase();
            return !INACTIVE_PURCHASE_STATUSES.has(normalizedStatus);
        });

        if (duplicateActiveLocal) {
            throw new Error('Supplier Invoice Number already exists for this supplier. Duplicate entry not allowed.');
        }
    };

    export const addPurchase = async (p: Purchase, user: RegisteredPharmacy) => {
        // Posting Context and Accounting validation - only for COMPLETED bills.
        // Offline: skip; will re-validate on server when SyncEngine pushes it.
        if (navigator.onLine) {
            try {
                const postingContext = await ensurePostingContext(p, user);
                p.companyCodeId = postingContext.companyCodeId;
                p.setOfBooksId = postingContext.setOfBooksId;

                await validateGLMappings(user.organization_id, p.setOfBooksId, 'purchase');
            } catch (e: any) {
                // Only block if we are actually trying to post a completed bill
                if (p.status === 'completed') {
                    throw new Error(e?.message || DEFAULT_CONFIG_MISSING_MESSAGE);
                }
                console.warn('[storage:addPurchase] Accounting validation failed for non-completed bill:', e.message);
            }
        } else {
            console.info('[storage:addPurchase] Offline — skipping accounting validation.');
        }

        await assertNoDuplicateActivePurchaseInvoice(p, user);
        const res = await saveData('purchases', p, user);

        // If it's a draft/hold, we do not update inventory or ledger
        if (p.status === 'draft' || p.status === 'hold') {
            return res;
        }

        // Use a Map to accumulate stock changes for this purchase
        // Key is inventoryItemId or "name|batch" if not linked
        const stockChanges = new Map<string, { units: number, freeUnits: number, item: PurchaseItem }>();

        for (const item of p.items) {
            if (!item.name) continue;
            const key = item.inventoryItemId || `${(item.name || '').toLowerCase().trim()}|${(item.batch || 'UNSET').toLowerCase().trim()}`;
            const existing = stockChanges.get(key) || { units: 0, freeUnits: 0, item };

            const uPP = item.unitsPerPack || 1;
            const freeUnits = Number(item.freeQuantity || 0) * uPP;
            const units = (Number(item.quantity) * uPP) + Number(item.looseQuantity || 0) + freeUnits;

            stockChanges.set(key, { units: existing.units + units, freeUnits: (existing.freeUnits || 0) + freeUnits, item });
        }

        const currentInventory = await fetchInventory(user);

        const applyTierRates = (inv: InventoryItem, src: PurchaseItem) => {
            if (src.rateA !== undefined) inv.rateA = Number(src.rateA || 0);
            if (src.rateB !== undefined) inv.rateB = Number(src.rateB || 0);
            if (src.rateC !== undefined) inv.rateC = Number(src.rateC || 0);
        };

        for (const [key, change] of stockChanges.entries()) {
            let existingInv: InventoryItem | undefined;

            if (change.item.inventoryItemId) {
                existingInv = currentInventory.find(i => i.id === change.item.inventoryItemId);
            }

            if (!existingInv) {
                const nameClean = (change.item.name || '').toLowerCase().trim();
                const batchClean = (change.item.batch || 'UNSET').toLowerCase().trim();
                existingInv = currentInventory.find(i =>
                    (i.name || '').toLowerCase().trim() === nameClean &&
                    (i.batch || 'UNSET').toLowerCase().trim() === batchClean
                );
            }

            if (existingInv) {
                const stockBefore = Number(existingInv.stock || 0);
                existingInv.stock = stockBefore + change.units;
                existingInv.purchaseFree = Number(existingInv.purchaseFree || 0) + change.freeUnits;
                logStockMovement({ transactionType: 'purchase-inward', voucherId: p.id, item: existingInv.name, batch: existingInv.batch || 'UNSET', qty: change.units, qtyIn: change.units, stockBefore, stockAfter: existingInv.stock, organizationId: user.organization_id, validationResult: 'allowed', mode: 'strict' });
                // Normalize expiry if present in purchase item
                if (change.item.expiry) {
                    existingInv.expiry = normalizeImportDate(change.item.expiry) || existingInv.expiry;
                }
                applyTierRates(existingInv, change.item);
                await saveData('inventory', existingInv, user, true);
            } else {
                const uPP = change.item.unitsPerPack || 1;
                const newInv: Omit<InventoryItem, 'id'> = {
                    organization_id: user.organization_id,
                    name: change.item.name,
                    brand: change.item.brand || '',
                    category: change.item.category || 'General',
                    manufacturer: change.item.manufacturer || '',
                    stock: change.units,
                    purchaseFree: change.freeUnits,
                    unitsPerPack: uPP,
                    batch: change.item.batch || 'UNSET',
                    expiry: normalizeImportDate(change.item.expiry) || '',
                    purchasePrice: change.item.purchasePrice,
                    mrp: change.item.mrp,
                    gstPercent: change.item.gstPercent || 0,
                    hsnCode: change.item.hsnCode || '',
                    code: change.item.materialCode || '',
                    rateA: change.item.rateA,
                    rateB: change.item.rateB,
                    rateC: change.item.rateC,
                    minStockLimit: 10,
                    is_active: true
                };
                logStockMovement({ transactionType: 'purchase-inward', voucherId: p.id, item: newInv.name, batch: newInv.batch || 'UNSET', qty: change.units, qtyIn: change.units, stockBefore: 0, stockAfter: change.units, organizationId: user.organization_id, validationResult: 'allowed', mode: 'strict' });
                await saveData('inventory', newInv, user);
            }
        }
        try {
            await syncPurchaseLedger(p, user);
        } catch (e) {
            console.warn('[storage:addPurchase] Purchase ledger/journal sync deferred:', e);
        }
        return res;
    };

    export const updatePurchase = async (p: Purchase, user: RegisteredPharmacy) => {
        await assertNoDuplicateActivePurchaseInvoice(p, user);
        let original = await idb.get(STORES.PURCHASES, p.id) as Purchase;
        
        // Robustness: If missing in local IDB (e.g. after clear), try fetching from remote
        // so that status transition logic (draft/hold -> completed) works correctly.
        if (!original && navigator.onLine) {
            try {
                const { data } = await supabase.from('purchases').select('*').eq('id', p.id).maybeSingle();
                if (data) original = fromSupabase('purchases', data);
            } catch (err) {
                console.warn('[storage:updatePurchase] Failed to fetch original from remote:', err);
            }
        }

        const res = await saveData('purchases', p, user, true);
        if (!original) {
            console.warn('[storage:updatePurchase] Original record not found, skipping stock adjustment logic.');
            return res;
        }

        // Draft/Hold logic:
        // 1. If it stays draft/hold -> just return
        if ((p.status === 'draft' || (p.status as string) === 'hold') && (original.status === 'draft' || (original.status as string) === 'hold')) {
            return { ...p, ...res };
        }

        const applyTierRates = (inv: InventoryItem, src: PurchaseItem) => {
            if (src.rateA !== undefined) inv.rateA = Number(src.rateA || 0);
            if (src.rateB !== undefined) inv.rateB = Number(src.rateB || 0);
            if (src.rateC !== undefined) inv.rateC = Number(src.rateC || 0);
        };

        // 2. If it goes from draft/hold -> completed -> Treat it like addPurchase (full stock add)
        // But we don't call addPurchase because it would call saveData again.
        if (p.status === 'completed' && (original.status === 'draft' || (original.status as string) === 'hold')) {
            console.info(`[storage:updatePurchase] Finalizing ${original.status} bill ${p.id} -> Completed. Triggering full stock inward.`);
            const stockChanges = new Map<string, { units: number, freeUnits: number, item: PurchaseItem }>();
            for (const item of p.items) {
                if (!item.name) continue;
                const key = item.inventoryItemId || `${(item.name || '').toLowerCase().trim()}|${(item.batch || 'UNSET').toLowerCase().trim()}`;
                const existing = stockChanges.get(key) || { units: 0, freeUnits: 0, item };
                const uPP = item.unitsPerPack || 1;
                const freeUnits = Number(item.freeQuantity || 0) * uPP;
                const units = (Number(item.quantity) * uPP) + Number(item.looseQuantity || 0) + freeUnits;
                stockChanges.set(key, { units: existing.units + units, freeUnits: (existing.freeUnits || 0) + freeUnits, item });
            }

            const currentInventory = await fetchInventory(user);
            for (const [key, change] of stockChanges.entries()) {
                let existingInv: InventoryItem | undefined;
                if (change.item.inventoryItemId) existingInv = currentInventory.find(i => i.id === change.item.inventoryItemId);
                if (!existingInv) {
                    const nameClean = (change.item.name || '').toLowerCase().trim();
                    const batchClean = (change.item.batch || 'UNSET').toLowerCase().trim();
                    existingInv = currentInventory.find(i => (i.name || '').toLowerCase().trim() === nameClean && (i.batch || 'UNSET').toLowerCase().trim() === batchClean);
                }

                if (existingInv) {
                    const stockBefore = Number(existingInv.stock || 0);
                    existingInv.stock = stockBefore + change.units;
                    existingInv.purchaseFree = Number(existingInv.purchaseFree || 0) + change.freeUnits;
                    logStockMovement({ transactionType: 'purchase-inward', voucherId: p.id, item: existingInv.name, batch: existingInv.batch || 'UNSET', qty: change.units, qtyIn: change.units, stockBefore, stockAfter: existingInv.stock, organizationId: user.organization_id, validationResult: 'allowed', mode: 'strict' });
                    if (change.item.expiry) existingInv.expiry = normalizeImportDate(change.item.expiry) || existingInv.expiry;
                    applyTierRates(existingInv, change.item);
                    await saveData('inventory', existingInv, user, true);
                } else {
                    const uPP = change.item.unitsPerPack || 1;
                    const newInv: Omit<InventoryItem, 'id'> = {
                        organization_id: user.organization_id,
                        name: change.item.name, brand: change.item.brand || '', category: change.item.category || 'General', manufacturer: change.item.manufacturer || '',
                        stock: change.units, purchaseFree: change.freeUnits, unitsPerPack: uPP, batch: change.item.batch || 'UNSET',
                        expiry: normalizeImportDate(change.item.expiry) || '', purchasePrice: change.item.purchasePrice, mrp: change.item.mrp,
                        gstPercent: change.item.gstPercent || 0, hsnCode: change.item.hsnCode || '', code: change.item.materialCode || '',
                        rateA: change.item.rateA, rateB: change.item.rateB, rateC: change.item.rateC, minStockLimit: 10, is_active: true
                    };
                    logStockMovement({ transactionType: 'purchase-inward', voucherId: p.id, item: newInv.name, batch: newInv.batch || 'UNSET', qty: change.units, qtyIn: change.units, stockBefore: 0, stockAfter: change.units, organizationId: user.organization_id, validationResult: 'allowed', mode: 'strict' });
                    await saveData('inventory', newInv, user);
                }
            }
            try {
                await syncPurchaseLedger(p, user);
            } catch (e) {
                console.warn('[storage:updatePurchase] Finalize purchase ledger/journal sync deferred:', e);
            }
            return { ...p, ...res };
        }

        // 3. If it stays completed -> Standard diff adjustment logic
        if (p.status !== 'completed') {
            return { ...p, ...res };
        }

        // To properly adjust stock, we calculate the diff between original and new
        const currentInventory = await fetchInventory(user);

        // map key: identification string
        const itemMap = new Map<string, { oldUnits: number, oldFreeUnits: number, newUnits: number, newFreeUnits: number, item: PurchaseItem }>();

        // Process original items
        for (const item of original.items) {
            if (!item.name) continue;
            const key = item.inventoryItemId || `${item.name.toLowerCase().trim()}|${(item.batch || 'UNSET').toLowerCase().trim()}`;
            const uPP = item.unitsPerPack || 1;
            const freeUnits = Number(item.freeQuantity || 0) * uPP;
            const units = (Number(item.quantity) * uPP) + Number(item.looseQuantity || 0) + freeUnits;
            itemMap.set(key, { oldUnits: units, oldFreeUnits: freeUnits, newUnits: 0, newFreeUnits: 0, item });
        }

        // Process new items
        for (const item of p.items) {
            if (!item.name) continue;
            const key = item.inventoryItemId || `${item.name.toLowerCase().trim()}|${(item.batch || 'UNSET').toLowerCase().trim()}`;
            const existing = itemMap.get(key) || { oldUnits: 0, oldFreeUnits: 0, newUnits: 0, newFreeUnits: 0, item };
            const uPP = item.unitsPerPack || 1;
            const freeUnits = Number(item.freeQuantity || 0) * uPP;
            const units = (Number(item.quantity) * uPP) + Number(item.looseQuantity || 0) + freeUnits;
            itemMap.set(key, { ...existing, newUnits: units, newFreeUnits: freeUnits, item });
        }

        // Apply changes
        for (const [key, data] of itemMap.entries()) {
            const diff = data.newUnits - data.oldUnits;
            const freeDiff = (data.newFreeUnits || 0) - (data.oldFreeUnits || 0);
            if (diff === 0 && freeDiff === 0) continue;

            let invItem: InventoryItem | undefined;
            if (data.item.inventoryItemId) {
                invItem = currentInventory.find(i => i.id === data.item.inventoryItemId);
            }

            if (!invItem) {
                const nameClean = data.item.name.toLowerCase().trim();
                const batchClean = (data.item.batch || 'UNSET').toLowerCase().trim();
                invItem = currentInventory.find(i =>
                    (i.name || '').toLowerCase().trim() === nameClean &&
                    (i.batch || 'UNSET').toLowerCase().trim() === batchClean
                );
            }

            if (invItem) {
                const stockBefore = Number(invItem.stock || 0);
                invItem.stock = stockBefore + diff;
                invItem.purchaseFree = Number(invItem.purchaseFree || 0) + freeDiff;
                logStockMovement({ transactionType: 'purchase-edit-repost', voucherId: p.id, item: invItem.name, batch: invItem.batch || 'UNSET', qty: Math.abs(diff), qtyIn: diff > 0 ? diff : 0, qtyOut: diff < 0 ? Math.abs(diff) : 0, stockBefore, stockAfter: invItem.stock, organizationId: user.organization_id, validationResult: 'allowed', mode: 'strict' });
                // Normalize expiry if present in purchase item
                if (data.item.expiry) {
                    invItem.expiry = normalizeImportDate(data.item.expiry) || invItem.expiry;
                }
                applyTierRates(invItem, data.item);
                const updated = await saveData('inventory', invItem, user, true);
                
                // Update local reference to keep currentInventory in sync for next loop iteration
                if (updated && invItem.id) {
                    const idx = currentInventory.findIndex(i => i.id === invItem!.id);
                    if (idx >= 0) currentInventory[idx] = updated;
                }
            } else if (diff > 0) {
                // New inventory item created during update
                const uPP = data.item.unitsPerPack || 1;
                const newInv: Omit<InventoryItem, 'id'> = {
                    organization_id: user.organization_id,
                    name: data.item.name,
                    brand: data.item.brand || '',
                    category: data.item.category || 'General',
                    manufacturer: data.item.manufacturer || '',
                    stock: diff,
                    purchaseFree: data.newFreeUnits,
                    unitsPerPack: uPP,
                    batch: data.item.batch || 'UNSET',
                    expiry: normalizeImportDate(data.item.expiry) || '',
                    purchasePrice: data.item.purchasePrice,
                    mrp: data.item.mrp,
                    gstPercent: data.item.gstPercent || 0,
                    hsnCode: data.item.hsnCode || '',
                    code: data.item.materialCode || '',
                    rateA: data.item.rateA,
                    rateB: data.item.rateB,
                    rateC: data.item.rateC,
                    minStockLimit: 10,
                    is_active: true
                };
                logStockMovement({ transactionType: 'purchase-edit-repost', voucherId: p.id, item: newInv.name, batch: newInv.batch || 'UNSET', qty: diff, qtyIn: diff, stockBefore: 0, stockAfter: diff, organizationId: user.organization_id, validationResult: 'allowed', mode: 'strict' });
                const saved = await saveData('inventory', newInv, user);
                if (saved) currentInventory.push(saved);
            }
        }

        try {
            await syncPurchaseLedger(p, user);
        } catch (e) {
            console.warn('[storage:updatePurchase] Purchase ledger/journal sync deferred:', e);
        }
        return res;
    };
    export const saveCustomerPriceList = (entry: CustomerPriceListEntry, user: RegisteredPharmacy) => saveData('customer_price_list', entry, user);

    export const updateProfile = async (profile: RegisteredPharmacy): Promise<RegisteredPharmacy> => {
        const dbPayload = toSnake(profile);
        const { data, error } = await supabase.from('profiles').upsert(dbPayload).select().single();
        if (error) throw error;
        const normalized = toCamel(data);
        if (!normalized.id) normalized.id = normalized.user_id;
        await idb.put(STORES.PROFILES, normalized);
        return normalized;
    };

    export const fetchProfile = async (userId: string): Promise<RegisteredPharmacy | null> => {
        if (navigator.onLine) {
            try {
                const { data, error } = await supabase.from('profiles').select('*').eq('user_id', userId).single();
                if (data && !error) {
                    const normalized = toCamel(data);
                    if (!normalized.id) normalized.id = normalized.user_id;
                    await idb.put(STORES.PROFILES, normalized);
                    return normalized;
                }
            } catch (e) { }
        }
        return await idb.get(STORES.PROFILES, userId) as RegisteredPharmacy || null;
    };

    // Auth — moved to @core/auth/authService for hybrid online/offline support.
    // Re-exported here for backwards compatibility (existing callers expect the
    // old signature that returns RegisteredPharmacy directly, not AuthResult).
    export const login = async (email: string, pass: string): Promise<RegisteredPharmacy> => {
        const { user } = await _loginImpl(email, pass);
        return user;
    };

    export const signup = _signupImpl;

    export const clearCurrentUser = async () => {
        // Clear in-memory caches
        for (const key of Object.keys(memoryCache)) {
            delete memoryCache[key];
        }
        for (const key of Object.keys(memoryCacheOrgScope)) {
            delete memoryCacheOrgScope[key];
        }

        try {
            await _logoutImpl();
        } catch (e) {
            console.error('[storage] logout failed during clearCurrentUser:', e);
        }
        try {
            await Promise.race([
                idb.clearAllStores(),
                new Promise<any>((_, reject) => setTimeout(() => reject(new Error('IndexedDB clear timed out')), 3000))
            ]);
        } catch (e) {
            console.error('[storage] IndexedDB clear failed or timed out:', e);
        }
        _hydratedOrgs.clear();
    };

    export const resetHydrationState = () => {
        _hydratedOrgs.clear();
    };

    export const requestPasswordReset = _requestPasswordResetImpl;
    export const verifyRecoveryToken = _verifyRecoveryTokenImpl;
    export const updatePassword = _updatePasswordImpl;

    export const getCurrentUser = async (): Promise<RegisteredPharmacy | null> => {
        // Always try the persisted session first — it round-trips a full user
        // object via Tauri plugin-store + localStorage and already handles the
        // Supabase token refresh internally. If it returns a user, we have a
        // valid logged-in profile no matter what IndexedDB / Supabase auth say.
        // This is the path that keeps the user logged in across app
        // close/reopen including offline reloads.
        let restored: RegisteredPharmacy | null = null;
        try {
            restored = await _restoreSessionImpl();
        } catch (err) {
            console.warn('[storage] restoreSession failed:', err);
        }

        // Figure out the user id we care about. Supabase's own cached session
        // is checked as a secondary source — useful if restoreSession returns
        // null but Supabase's auth library still has a fresh session in
        // memory/localStorage from a prior login on the same device.
        let userId: string | null = restored?.user_id ?? null;
        if (!userId) {
            try {
                const { data: { session } } = await supabase.auth.getSession();
                userId = session?.user?.id ?? null;
            } catch { /* offline / supabase init error — ignore */ }
        }
        if (!userId) return null;

        // If we're online, try to refresh the profile from Supabase so the
        // user sees any cross-device changes (name, roles, etc.).
        if (navigator.onLine) {
            try {
                const freshProfile = await Promise.race([
                    fetchProfile(userId),
                    new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Profile fetch timed out')), 3000))
                ]);
                if (freshProfile) return freshProfile;
            } catch (err) {
                console.warn('Failed to fetch fresh profile during app initialization:', err);
            }
        }

        // Prefer the persisted profile from restoreSession — it's the
        // authoritative offline copy. (Falling through to IndexedDB used to
        // happen here but IDB is disabled in this build, so that path returned
        // null and the user was bounced to the login screen on every offline
        // reload.) Only hit IDB as a last resort for any future build that
        // re-enables it.
        if (restored) return restored;
        const cached = await idb.get(STORES.PROFILES, userId) as RegisteredPharmacy | null;
        return cached || null;
    };

    export const addTeamMember = async (
        email: string,
        role: UserRole,
        name: string,
        pass: string,
        organization_id: string,
        extra?: Partial<OrganizationMember>
    ) => {
        const id = generateUUID();
        let technicalId: string | undefined = undefined;

        if (navigator.onLine) {
            try {
                const tempClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                    auth: {
                        persistSession: false,
                        autoRefreshToken: false,
                        detectSessionInUrl: false
                    }
                });

                const { data: authData, error: authError } = await tempClient.auth.signUp({
                    email,
                    password: pass,
                    options: {
                        data: {
                            full_name: name,
                            organization_id,
                            role,
                        }
                    }
                });

                if (authError) {
                    console.error("[addTeamMember] Supabase signUp failed:", authError);
                } else if (authData?.user) {
                    technicalId = authData.user.id;
                }
            } catch (err) {
                console.error("[addTeamMember] error during tempClient.auth.signUp:", err);
            }
        }

        const newMember: OrganizationMember = {
            id,
            technicalId,
            email,
            name,
            role,
            status: 'active',
            isLocked: false,
            passwordLocked: false,
            ...extra,
            assignedRoles: extra?.assignedRoles || [],
        };
        const mockUser = { organization_id } as RegisteredPharmacy;
        await saveData('team_members', newMember, mockUser, false);

        // Pre-cache local auth credentials on this device so the user can log in locally/offline immediately
        try {
            const localUserRecord = {
                id: technicalId || id,
                organization_id,
                email,
                full_name: name,
                pharmacy_name: '',
                role,
                is_active: true,
            } as RegisteredPharmacy;

            await cacheOfflineCredentials(localUserRecord, pass, extra?.assignedRoles || []);
        } catch (localAuthErr) {
            console.error("[addTeamMember] failed to cache local auth credentials:", localAuthErr);
        }
    };

    export const updateMemberRole = async (memberId: string, newRole: UserRole) => {
        const member = await idb.get(STORES.TEAM_MEMBERS, memberId) as OrganizationMember;
        if (member) {
            member.role = newRole;
            await idb.put(STORES.TEAM_MEMBERS, member);
        }
        if (navigator.onLine) await supabase.from('team_members').update({ role: newRole }).eq('id', memberId);
    };

    export const removeTeamMember = async (memberId: string, user?: RegisteredPharmacy | null) => {
        await deleteData('team_members', memberId, user);
    };

    export const addLedgerEntry = async (entry: TransactionLedgerItem, owner: { type: 'customer' | 'supplier' | 'distributor', id: string }, user: RegisteredPharmacy) => {
        const type = owner.type === 'distributor' ? 'supplier' : owner.type;
        const tableName = type === 'customer' ? 'customers' : 'suppliers';
        
        const entity = await getDataById<Customer | Supplier>(tableName, owner.id, user);

        if (!entity) throw new Error(`${type} not found`);
        const ledger = Array.isArray(entity.ledger) ? [...entity.ledger] : [];
        const nextLedger = [...ledger, entry];
        entity.ledger = recalculateLedger(nextLedger, Number(entity.opening_balance || 0), type);
        return await saveData(tableName, entity, user, true);
    };



export const fetchBankMasters = async (user: RegisteredPharmacy): Promise<Array<{ id: string; bankName: string; accountName: string; accountNumber: string; accountType?: string; linkedBankGlId?: string; defaultBank?: boolean; activeStatus?: string }>> => {
        const cacheKey = `mdxera_bank_masters_${user.organization_id}`;
        
        if (navigator.onLine) {
            try {
                const { data, error } = await supabase
                    .from('bank_master')
                    .select('*')
                    .eq('organization_id', user.organization_id)
                    .order('created_at', { ascending: true });
                if (error) throw error;

                const result = (data || [])
                    .filter((b) => b.activeStatus === 'Active' || b.active_status === 'Active' || b.activeStatus === undefined)
                    .map((b) => ({
                        id: String(b.id),
                        bankName: String(b.bankName || b.bank_name || ''),
                        accountName: String(b.accountName || b.account_name || ''),
                        accountNumber: String(b.accountNumber || b.account_number || ''),
                        accountType: String(b.accountType || b.account_type || ''),
                        linkedBankGlId: b.linkedBankGlId || b.linked_bank_gl_id || undefined,
                        defaultBank: !!(b.defaultBank || b.default_bank),
                        activeStatus: b.activeStatus || b.active_status,
                    }));
                
                localStorage.setItem(cacheKey, JSON.stringify(result));
                return result;
            } catch (e) {
                console.warn('[fetchBankMasters] Supabase fetch failed, falling back to cache:', e);
            }
        }

        try {
            const cached = localStorage.getItem(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (cacheErr) {
            console.warn('[fetchBankMasters] Cache read failed:', cacheErr);
        }

        return [];
    };

    export const recordCustomerPaymentWithAccounting = async (
        args: {
            customerId: string;
            amount: number;
            date: string;
            description: string;
            paymentMode: string;
            bankAccountId: string;
            referenceInvoiceId?: string;
            referenceInvoiceNumber?: string;
            entryCategory?: 'invoice_payment' | 'down_payment';
            ledgerEntryId?: string;
        },
        user: RegisteredPharmacy
    ): Promise<{ journalEntryId?: string; journalEntryNumber?: string; ledgerEntryId: string }> => {
        const customer = await getDataById<Customer>('customers', args.customerId, user);
        if (!customer) throw new Error('Customer not found');

        const isCashMode = String(args.paymentMode || '').trim().toLowerCase() === 'cash';
        
        // Resolve bank locally or online
        const cacheKey = `mdxera_bank_masters_${user.organization_id}`;
        let bank: any = null;
        if (args.bankAccountId) {
            if (navigator.onLine) {
                try {
                    const { data: bankRow, error: bankErr } = await supabase
                        .from('bank_master')
                        .select('*')
                        .eq('organization_id', user.organization_id)
                        .eq('id', args.bankAccountId)
                        .maybeSingle();
                    if (bankErr) throw bankErr;
                    bank = bankRow;
                } catch (e) {
                    console.warn('[recordCustomerPayment] Supabase bank fetch failed, using local cache:', e);
                }
            }
            
            if (!bank) {
                try {
                    const cached = localStorage.getItem(cacheKey);
                    if (cached) {
                        const list = JSON.parse(cached);
                        bank = list.find((b: any) => b && b.id && String(b.id).trim().toLowerCase() === String(args.bankAccountId).trim().toLowerCase());
                    }
                } catch {}
            }
            if (!bank) throw new Error('Selected bank / cash account not found');
        }
        if (!isCashMode && !bank) throw new Error('Selected bank / cash account not found');

        const postingContext = await loadDefaultPostingContext(user.organization_id);
        const companyCodeId = postingContext.companyCodeId;
        const setOfBooksId = postingContext.setOfBooksId;

        let journalEntryId: string | undefined;
        let journalEntryNumber: string | undefined;
        let receiptAccountName = bank?.bankName || bank?.bank_name || (isCashMode ? 'Cash Account' : 'Bank Account');

        if (navigator.onLine) {
            try {
                const { data: books, error: bookErr } = await supabase
                    .from('set_of_books')
                    .select('default_customer_gl_id')
                    .eq('organization_id', user.organization_id)
                    .eq('id', setOfBooksId)
                    .single();
                if (bookErr) throw bookErr;
                const customerControlGlId = books?.default_customer_gl_id;
                const bankGlId = bank?.linkedBankGlId || bank?.linked_bank_gl_id;
                if (!customerControlGlId) throw new Error('Customer/Receivable GL is not configured for default set of books.');
                let receiptGl: any = null;
                if (isCashMode) {
                    if (bankGlId) {
                        const { data: cashBankGl, error: cashBankGlError } = await supabase
                            .from('gl_master')
                            .select('id, gl_code, gl_name')
                            .eq('organization_id', user.organization_id)
                            .eq('set_of_books_id', setOfBooksId)
                            .eq('id', bankGlId)
                            .maybeSingle();
                        if (cashBankGlError) throw cashBankGlError;
                        receiptGl = cashBankGl;
                        receiptAccountName = bank?.bankName || bank?.bank_name || 'Cash Account';
                    }
                    if (!receiptGl) {
                        const { data: cashGl, error: cashGlError } = await supabase
                            .from('gl_master')
                            .select('id, gl_code, gl_name')
                            .eq('organization_id', user.organization_id)
                            .eq('set_of_books_id', setOfBooksId)
                            .eq('gl_code', '100001')
                            .maybeSingle();
                        if (cashGlError) throw cashGlError;
                        if (!cashGl) throw new Error('No default cash account is configured. Please select or configure a cash account before posting cash receipt.');
                        receiptGl = cashGl;
                        receiptAccountName = 'Cash Account';
                    }
                } else {
                    if (!bankGlId) throw new Error('Selected bank has no linked bank GL. Configure in Bank Master.');
                    const { data: bankGl, error: bankGlErr } = await supabase
                        .from('gl_master')
                        .select('id, gl_code, gl_name')
                        .eq('organization_id', user.organization_id)
                        .eq('set_of_books_id', setOfBooksId)
                        .eq('id', bankGlId)
                        .maybeSingle();
                    if (bankGlErr) throw bankGlErr;
                    if (!bankGl) throw new Error('GL Assignment missing for selected bank in active Set of Books.');
                    receiptGl = bankGl;
                }

                const { data: receivableGl, error: receivableErr } = await supabase
                    .from('gl_master')
                    .select('id, gl_code, gl_name')
                    .eq('organization_id', user.organization_id)
                    .eq('set_of_books_id', setOfBooksId)
                    .eq('id', customerControlGlId)
                    .maybeSingle();
                if (receivableErr) throw receivableErr;
                if (!receivableGl) throw new Error('GL Assignment missing for customer control in active Set of Books.');

                const { data: header, error: headerError } = await supabase
                    .from('journal_entry_header')
                    .insert({
                        organization_id: user.organization_id,
                        journal_entry_number: `RCPT-${Date.now()}`,
                        posting_date: args.date,
                        status: 'Posted',
                        reference_type: args.entryCategory === 'down_payment' ? 'CUSTOMER_ADVANCE' : 'CUSTOMER_PAYMENT',
                        reference_id: args.referenceInvoiceId || args.customerId,
                        reference_document_id: args.referenceInvoiceId || args.customerId,
                        document_type: 'RECEIPT',
                        document_reference: args.referenceInvoiceNumber || args.customerId,
                        company: companyCodeId,
                        company_code_id: companyCodeId,
                        set_of_books: setOfBooksId,
                        set_of_books_id: setOfBooksId,
                        total_debit: Number(args.amount.toFixed(2)),
                        total_credit: Number(args.amount.toFixed(2)),
                    })
                    .select('id, journal_entry_number')
                    .single();
                if (headerError) throw headerError;

                journalEntryId = header?.id;
                journalEntryNumber = header?.journal_entry_number;

                const { error: lineError } = await supabase
                    .from('journal_entry_lines')
                    .insert([
                        {
                            organization_id: user.organization_id,
                            journal_entry_id: header.id,
                            reference_document_id: args.referenceInvoiceId || args.customerId,
                            document_type: 'RECEIPT',
                            line_number: 1,
                            gl_code: String(receiptGl.gl_code),
                            gl_name: String(receiptGl.gl_name),
                            debit: Number(args.amount.toFixed(2)),
                            credit: 0,
                            line_memo: isCashMode ? 'Payment received in cash' : 'Payment received in bank',
                        },
                        {
                            organization_id: user.organization_id,
                            journal_entry_id: header.id,
                            reference_document_id: args.referenceInvoiceId || args.customerId,
                            document_type: 'RECEIPT',
                            line_number: 2,
                            gl_code: String(receivableGl.gl_code),
                            gl_name: String(receivableGl.gl_name),
                            debit: 0,
                            credit: Number(args.amount.toFixed(2)),
                            line_memo: 'Customer receivable adjusted',
                        },
                    ]);
                if (lineError) throw lineError;
            } catch (err) {
                console.warn('[recordCustomerPayment] Failed to post online journal entries:', err);
            }
        }

        const ledgerEntryId = args.ledgerEntryId || generateUUID();
        await upsertAutoLedgerEntry(
            { type: 'customer', id: args.customerId },
            user,
            {
                id: ledgerEntryId,
                date: args.date,
                type: 'payment',
                description: args.description,
                entryCategory: args.entryCategory || 'invoice_payment',
                debit: 0,
                credit: Number(args.amount),
                paymentMode: args.paymentMode,
                bankAccountId: args.bankAccountId || undefined,
                bankName: receiptAccountName,
                referenceInvoiceId: args.referenceInvoiceId,
                referenceInvoiceNumber: args.referenceInvoiceNumber,
                journalEntryId,
                journalEntryNumber,
            },
            true
        );

        return { journalEntryId, journalEntryNumber, ledgerEntryId };
    };

    export const recordSupplierPaymentWithAccounting = async (
        args: {
            supplierId: string;
            amount: number;
            date: string;
            description: string;
            paymentMode: string;
            bankAccountId: string;
            referenceInvoiceId?: string;
            referenceInvoiceNumber?: string;
            entryCategory?: 'invoice_payment' | 'down_payment';
        },
        user: RegisteredPharmacy
    ): Promise<{ journalEntryId?: string; journalEntryNumber?: string; ledgerEntryId: string }> => {
        const supplier = await getDataById<Supplier>('suppliers', args.supplierId, user);
        if (!supplier) throw new Error('Supplier not found');
        const resolvedSupplierId = String(supplier.id);
        const isCashMode = String(args.paymentMode || '').trim().toLowerCase() === 'cash';
        
        // Resolve bank locally or online
        const cacheKey = `mdxera_bank_masters_${user.organization_id}`;
        let bank: any = null;
        if (!isCashMode) {
            if (!args.bankAccountId) throw new Error('Bank account is required for selected payment mode.');
            if (navigator.onLine) {
                try {
                    const { data: bankRow, error: bankErr } = await supabase
                        .from('bank_master')
                        .select('*')
                        .eq('organization_id', user.organization_id)
                        .eq('id', args.bankAccountId)
                        .maybeSingle();
                    if (bankErr) throw bankErr;
                    bank = bankRow;
                } catch (e) {
                    console.warn('[recordSupplierPayment] Supabase bank fetch failed, using local cache:', e);
                }
            }
            
            if (!bank) {
                try {
                    const cached = localStorage.getItem(cacheKey);
                    if (cached) {
                        const list = JSON.parse(cached);
                        bank = list.find((b: any) => b && b.id && String(b.id).trim().toLowerCase() === String(args.bankAccountId).trim().toLowerCase());
                    }
                } catch {}
            }
            if (!bank) throw new Error('Selected bank account not found');
        }

        const postingContext = await loadDefaultPostingContext(user.organization_id);
        const companyCodeId = postingContext.companyCodeId;
        const setOfBooksId = postingContext.setOfBooksId;

        let journalEntryId: string | undefined;
        let journalEntryNumber: string | undefined;
        let payoutAccountName = 'Cash Account';

        if (navigator.onLine) {
            try {
                const { data: books, error: bookErr } = await supabase
                    .from('set_of_books')
                    .select('default_supplier_gl_id')
                    .eq('organization_id', user.organization_id)
                    .eq('id', setOfBooksId)
                    .single();
                if (bookErr) throw bookErr;
                const supplierControlGlId = books?.default_supplier_gl_id;
                if (!supplierControlGlId) throw new Error('Supplier/Payable GL is not configured for default set of books.');

                const { data: payableGl, error: payableGlErr } = await supabase
                    .from('gl_master')
                    .select('id, gl_code, gl_name')
                    .eq('organization_id', user.organization_id)
                    .eq('set_of_books_id', setOfBooksId)
                    .eq('id', supplierControlGlId)
                    .maybeSingle();
                if (payableGlErr) throw payableGlErr;
                if (!payableGl) throw new Error('Supplier control GL missing in active Set of Books.');

                let payoutGl: any;
                if (isCashMode) {
                    const { data: cashGl, error: cashGlErr } = await supabase
                        .from('gl_master')
                        .select('id, gl_code, gl_name')
                        .eq('organization_id', user.organization_id)
                        .eq('set_of_books_id', setOfBooksId)
                        .eq('gl_code', '100001')
                        .maybeSingle();
                    if (cashGlErr) throw cashGlErr;
                    if (!cashGl) throw new Error('Cash GL (100001) is not configured in active Set of Books.');
                    payoutGl = cashGl;
                } else {
                    const bankGlId = bank.linkedBankGlId || bank.linked_bank_gl_id;
                    if (!bankGlId) throw new Error('Selected bank has no linked bank GL. Configure in Bank Master.');

                    const { data: bankGl, error: bankGlErr } = await supabase
                        .from('gl_master')
                        .select('id, gl_code, gl_name')
                        .eq('organization_id', user.organization_id)
                        .eq('set_of_books_id', setOfBooksId)
                        .eq('id', bankGlId)
                        .maybeSingle();
                    if (bankGlErr) throw bankGlErr;
                    if (!bankGl) throw new Error('GL Assignment missing for selected bank in active Set of Books.');
                    payoutGl = bankGl;
                    payoutAccountName = bank.bankName || bank.bank_name || 'Bank Account';
                }

                const supplierPaymentVoucherNumber = `PMT-${Date.now()}`;

                const { data: header, error: headerError } = await supabase
                    .from('journal_entry_header')
                    .insert({
                        organization_id: user.organization_id,
                        journal_entry_number: supplierPaymentVoucherNumber,
                        posting_date: args.date,
                        status: 'Posted',
                        reference_type: args.entryCategory === 'down_payment' ? 'SUPPLIER_ADVANCE' : 'SUPPLIER_PAYMENT',
                        reference_id: args.referenceInvoiceId || resolvedSupplierId,
                        reference_document_id: args.referenceInvoiceId || resolvedSupplierId,
                        document_type: 'PAYMENT',
                        document_reference: args.referenceInvoiceNumber || resolvedSupplierId,
                        company: companyCodeId,
                        company_code_id: companyCodeId,
                        set_of_books: setOfBooksId,
                        set_of_books_id: setOfBooksId,
                        total_debit: Number(args.amount.toFixed(2)),
                        total_credit: Number(args.amount.toFixed(2)),
                    })
                    .select('id, journal_entry_number')
                    .single();
                if (headerError) throw headerError;

                journalEntryId = header?.id;
                journalEntryNumber = header?.journal_entry_number;

                const { error: lineError } = await supabase
                    .from('journal_entry_lines')
                    .insert([
                        {
                            organization_id: user.organization_id,
                            journal_entry_id: header.id,
                            reference_document_id: args.referenceInvoiceId || resolvedSupplierId,
                            document_type: 'PAYMENT',
                            line_number: 1,
                            gl_code: String(payableGl.gl_code),
                            gl_name: String(payableGl.gl_name),
                            debit: Number(args.amount.toFixed(2)),
                            credit: 0,
                            line_memo: 'Supplier payable adjusted',
                        },
                        {
                            organization_id: user.organization_id,
                            journal_entry_id: header.id,
                            reference_document_id: args.referenceInvoiceId || resolvedSupplierId,
                            document_type: 'PAYMENT',
                            line_number: 2,
                            gl_code: String(payoutGl.gl_code),
                            gl_name: String(payoutGl.gl_name),
                            debit: 0,
                            credit: Number(args.amount.toFixed(2)),
                            line_memo: isCashMode ? 'Payment made from cash account' : 'Payment made from bank account',
                        },
                    ]);
                if (lineError) throw lineError;
            } catch (err) {
                console.warn('[recordSupplierPayment] Failed to post online journal entries:', err);
            }
        }

        const ledgerEntryId = generateUUID();
        await addLedgerEntry({
            id: ledgerEntryId,
            date: args.date,
            type: 'payment',
            description: args.description,
            entryCategory: args.entryCategory || 'invoice_payment',
            debit: Number(args.amount),
            credit: 0,
            balance: 0,
            paymentMode: args.paymentMode,
            bankAccountId: isCashMode ? undefined : args.bankAccountId,
            bankName: payoutAccountName,
            referenceInvoiceId: args.referenceInvoiceId,
            referenceInvoiceNumber: args.referenceInvoiceNumber,
            journalEntryId,
            journalEntryNumber,
        }, { type: 'supplier', id: resolvedSupplierId }, user);

        return { journalEntryId, journalEntryNumber, ledgerEntryId };
    };

    export const recordCustomerDownPaymentAdjustment = async (
        args: {
            customerId: string;
            date: string;
            downPaymentId: string;
            referenceInvoiceId: string;
            referenceInvoiceNumber?: string;
            amount: number;
            description?: string;
        },
        user: RegisteredPharmacy
    ) => addLedgerEntry({
        id: generateUUID(),
        date: args.date,
        type: 'payment',
        entryCategory: 'down_payment_adjustment',
        description: args.description || 'Advance adjusted against invoice',
        debit: 0,
        credit: 0,
        adjustedAmount: Number(args.amount),
        sourceDownPaymentId: args.downPaymentId,
        referenceInvoiceId: args.referenceInvoiceId,
        referenceInvoiceNumber: args.referenceInvoiceNumber,
        balance: 0,
    }, { type: 'customer', id: args.customerId }, user);

    export const recordSupplierDownPaymentAdjustment = async (
        args: {
            supplierId: string;
            date: string;
            downPaymentId: string;
            referenceInvoiceId: string;
            referenceInvoiceNumber?: string;
            amount: number;
            description?: string;
        },
        user: RegisteredPharmacy
    ) => addLedgerEntry({
        id: generateUUID(),
        date: args.date,
        type: 'payment',
        entryCategory: 'down_payment_adjustment',
        description: args.description || 'Advance adjusted against invoice',
        debit: 0,
        credit: 0,
        adjustedAmount: Number(args.amount),
        sourceDownPaymentId: args.downPaymentId,
        referenceInvoiceId: args.referenceInvoiceId,
        referenceInvoiceNumber: args.referenceInvoiceNumber,
        balance: 0,
    }, { type: 'supplier', id: args.supplierId }, user);

    const getInvoiceAdjustedAmount = (ledger: TransactionLedgerItem[], invoiceId: string): number => {
        if (!invoiceId) return 0;
        return (ledger || []).reduce((sum, entry) => {
            if (!entry || (entry.status === 'cancelled' && entry.type !== 'payment')) return sum;
            if (entry.referenceInvoiceId !== invoiceId) return sum;
            if (!['invoice_payment_adjustment', 'down_payment_adjustment', 'invoice_payment_adjustment_reversal', 'down_payment_adjustment_reversal'].includes(String(entry.entryCategory || ''))) {
                return sum;
            }
            return sum + Number(entry.adjustedAmount || 0);
        }, 0);
    };

    const getCustomerInvoiceTotal = async (customer: Customer, invoiceRef: string, user: RegisteredPharmacy): Promise<number> => {
        const normalizedInvoiceRef = String(invoiceRef || '').trim();
        if (!normalizedInvoiceRef) throw new Error('Selected invoice is not available for this customer.');
        const normalizedInvoiceRefLower = normalizedInvoiceRef.toLowerCase();
        
        const customerLedger = Array.isArray(customer.ledger) ? customer.ledger : [];
        const openingEntry = customerLedger.find(e => e && e.id === normalizedInvoiceRef && e.type === 'openingBalance');
        if (openingEntry) {
            return Number(openingEntry.debit || 0) - Number(openingEntry.credit || 0);
        }
        if (normalizedInvoiceRef === 'opening-balance-id-fallback') {
            return Number(customer.opening_balance || 0);
        }

        const normalizedCustomerName = String(customer.name || '').trim().toLowerCase();
        const adjustedCategories = new Set([
            'invoice_payment_adjustment',
            'down_payment_adjustment',
            'invoice_payment_adjustment_reversal',
            'down_payment_adjustment_reversal',
        ]);
        const resolveAdjustedAmountFromLedger = (invoiceId: string, invoiceNumber?: string): number => {
            const normalizedInvoiceNumber = String(invoiceNumber || '').trim().toLowerCase();
            return customerLedger.reduce((sum, entry) => {
                if (!entry || (entry.status === 'cancelled' && entry.type !== 'payment')) return sum;
                const entryCategory = String(entry.entryCategory || '');
                if (!adjustedCategories.has(entryCategory)) return sum;
                const referenceId = String(entry.referenceInvoiceId || '').trim();
                const referenceNumber = String(entry.referenceInvoiceNumber || '').trim().toLowerCase();
                const matchesInvoice = referenceId === invoiceId
                    || (normalizedInvoiceNumber && referenceNumber === normalizedInvoiceNumber)
                    || referenceId === normalizedInvoiceRef
                    || referenceNumber === normalizedInvoiceRefLower;
                if (!matchesInvoice) return sum;
                return sum + Number(entry.adjustedAmount || 0);
            }, 0);
        };
        const resolveLocalInvoice = async (): Promise<number | null> => {
            // Legacy IndexedDB check
            const localTxns = await idb.getAll(STORES.SALES_BILL) as Transaction[];
            let match = localTxns.find((row) => {
                if (!row || row.status === 'cancelled') return false;
                const belongsToCustomer = row.customerId === customer.id || String(row.customerName || '').trim().toLowerCase() === normalizedCustomerName;
                if (!belongsToCustomer) return false;
                return row.id === normalizedInvoiceRef || String(row.invoiceNumber || '').trim().toLowerCase() === normalizedInvoiceRefLower;
            });

            // Modern SQLite check (Offline App)
            if (!match) {
                try {
                    const rows = await sqliteDb.select<Transaction>(`SELECT * FROM ${SCHEMA_TABLE.SALES_BILL} WHERE organization_id = ?`, [user.organization_id]);
                    let decodedMatch = undefined;
                    for (const rawRow of rows) {
                        const row = fromSupabase('sales_bill', decodeSqliteRow('sales_bill', rawRow));
                        if (!row || row.status === 'cancelled') continue;
                        const belongsToCustomer = row.customerId === customer.id || String(row.customerName || '').trim().toLowerCase() === normalizedCustomerName;
                        if (!belongsToCustomer) continue;
                        if (row.id === normalizedInvoiceRef || String(row.invoiceNumber || '').trim().toLowerCase() === normalizedInvoiceRefLower) {
                            decodedMatch = row;
                            break;
                        }
                    }
                    if (decodedMatch) {
                        match = decodedMatch;
                    }
                } catch (err) {
                    console.warn('[getCustomerInvoiceTotal] SQLite query failed:', err);
                }
            }

            if (!match) return null;
            const invoiceTotal = Number(match.total || 0);
            const adjustedAmount = resolveAdjustedAmountFromLedger(match.id, match.invoiceNumber);
            const pendingBalance = Number((invoiceTotal - adjustedAmount).toFixed(2));
            if (pendingBalance <= 0) throw new Error('Invoice is already fully settled and cannot receive duplicate payment.');
            return invoiceTotal;
        };

        const localTotal = await resolveLocalInvoice();
        if (localTotal !== null) return localTotal;

        if (navigator.onLine) {
            const { data: rawInvoices, error } = await supabase
                .from('sales_bill')
                .select('*')
                .eq('organization_id', user.organization_id)
                .or(`id.ilike.${invoiceRef.trim()},invoice_number.ilike.${invoiceRef.trim()}`);
            if (error) console.warn('[getCustomerInvoiceTotal] Supabase error:', error);
            
            const invoices = (rawInvoices || []).map(r => fromSupabase('sales_bill', r));
            const remoteMatch = invoices.find((row: any) => {
                if (!row || row.status === 'cancelled') return false;
                const belongsToCustomer = row.customerId === customer.id || String(row.customerName || '').trim().toLowerCase() === normalizedCustomerName;
                if (!belongsToCustomer) return false;
                const rowInvoiceNumber = String(row.invoiceNumber || '').trim().toLowerCase();
                return row.id === normalizedInvoiceRef || rowInvoiceNumber === normalizedInvoiceRefLower;
            });
            if (remoteMatch) {
                const invoiceTotal = Number(remoteMatch.total || 0);
                const adjustedAmount = resolveAdjustedAmountFromLedger(String(remoteMatch.id || ''), String(remoteMatch.invoiceNumber || ''));
                const pendingBalance = Number((invoiceTotal - adjustedAmount).toFixed(2));
                if (pendingBalance <= 0) throw new Error('Invoice is already fully settled and cannot receive duplicate payment.');
                return invoiceTotal;
            }
        }

        throw new Error('Selected invoice is not available for this customer.');
    };

    const getSupplierInvoiceTotal = async (supplier: Supplier, invoiceId: string, user: RegisteredPharmacy): Promise<number> => {
        const normalizedInvoiceId = String(invoiceId || '').trim();
        if (!normalizedInvoiceId) throw new Error('Selected invoice is not available for this supplier.');
        
        const supplierLedger = Array.isArray(supplier.ledger) ? supplier.ledger : [];
        const openingEntry = supplierLedger.find(e => e && e.id === normalizedInvoiceId && e.type === 'openingBalance');
        if (openingEntry) {
            return Number(openingEntry.credit || 0) - Number(openingEntry.debit || 0);
        }
        if (normalizedInvoiceId === 'opening-balance-id-fallback') {
            return Number(supplier.opening_balance || 0);
        }

        // Legacy IndexedDB check
        const localPurchases = await idb.getAll(STORES.PURCHASES) as Purchase[];
        let localMatch = localPurchases.find((row) => row?.id === invoiceId && row?.status !== 'cancelled' && String(row?.supplier || '').trim().toLowerCase() === String(supplier.name || '').trim().toLowerCase());

        // Modern SQLite check (Offline App)
        if (!localMatch) {
            try {
                const rows = await sqliteDb.select<Purchase>(`SELECT * FROM ${SCHEMA_TABLE.PURCHASES} WHERE organization_id = ?`, [user.organization_id]);
                let decodedMatch = undefined;
                for (const rawRow of rows) {
                    const row = fromSupabase('purchases', decodeSqliteRow('purchases', rawRow));
                    if (row?.id === invoiceId && row?.status !== 'cancelled' && String(row?.supplier || '').trim().toLowerCase() === String(supplier.name || '').trim().toLowerCase()) {
                        decodedMatch = row;
                        break;
                    }
                }
                if (decodedMatch) {
                    localMatch = decodedMatch;
                }
            } catch (err) {
                console.warn('[getSupplierInvoiceTotal] SQLite query failed:', err);
            }
        }

        if (localMatch) return Number(localMatch.totalAmount || 0);

        if (navigator.onLine) {
            const { data } = await supabase
                .from('purchases')
                .select('id, supplier, totalAmount, status')
                .eq('organization_id', user.organization_id)
                .eq('id', invoiceId)
                .maybeSingle();
            if (data && data.status !== 'cancelled' && String(data.supplier || '').trim().toLowerCase() === String(supplier.name || '').trim().toLowerCase()) {
                return Number(data.totalAmount || 0);
            }
        }
        throw new Error('Selected invoice is not available for this supplier.');
    };

    export const recordCustomerInvoicePaymentAdjustment = async (
        args: {
            customerId: string;
            date: string;
            sourcePaymentId: string;
            referenceInvoiceId: string;
            referenceInvoiceNumber?: string;
            amount: number;
            description?: string;
        },
        user: RegisteredPharmacy
    ) => {
        if (Number(args.amount) <= 0) throw new Error('Adjustment amount must be greater than zero.');
        const customer = await getDataById<Customer>('customers', args.customerId, user);
        if (!customer) throw new Error('Customer not found');
        const invoiceTotal = await getCustomerInvoiceTotal(customer, args.referenceInvoiceId, user);
        const currentAdjusted = getInvoiceAdjustedAmount(Array.isArray(customer.ledger) ? customer.ledger : [], args.referenceInvoiceId);
        const pendingBalance = Number((invoiceTotal - currentAdjusted).toFixed(2));
        if (pendingBalance <= 0) throw new Error('Invoice is already fully settled and cannot receive duplicate payment.');
        if (Number(args.amount) > pendingBalance + 0.001) throw new Error('Cannot allocate more than invoice pending balance.');

        return addLedgerEntry({
            id: generateUUID(),
            date: args.date,
            type: 'payment',
            entryCategory: 'invoice_payment_adjustment',
            description: args.description || 'Payment adjusted against invoice',
            debit: 0,
            credit: 0,
            adjustedAmount: Number(args.amount),
            sourcePaymentId: args.sourcePaymentId,
            referenceInvoiceId: args.referenceInvoiceId,
            referenceInvoiceNumber: args.referenceInvoiceNumber,
            balance: 0,
        }, { type: 'customer', id: args.customerId }, user);
    };

    export const recordSupplierInvoicePaymentAdjustment = async (
        args: {
            supplierId: string;
            date: string;
            sourcePaymentId: string;
            referenceInvoiceId: string;
            referenceInvoiceNumber?: string;
            amount: number;
            description?: string;
        },
        user: RegisteredPharmacy
    ) => {
        if (Number(args.amount) <= 0) throw new Error('Adjustment amount must be greater than zero.');
        const supplier = await getDataById<Supplier>('suppliers', args.supplierId, user);
        if (!supplier) throw new Error('Supplier not found');
        const invoiceTotal = await getSupplierInvoiceTotal(supplier, args.referenceInvoiceId, user);
        const currentAdjusted = getInvoiceAdjustedAmount(Array.isArray(supplier.ledger) ? supplier.ledger : [], args.referenceInvoiceId);
        const pendingBalance = Number((invoiceTotal - currentAdjusted).toFixed(2));
        if (pendingBalance <= 0) throw new Error('Invoice is already fully settled and cannot receive duplicate payment.');
        if (Number(args.amount) > pendingBalance + 0.001) throw new Error('Cannot allocate more than invoice pending balance.');

        return addLedgerEntry({
            id: generateUUID(),
            date: args.date,
            type: 'payment',
            entryCategory: 'invoice_payment_adjustment',
            description: args.description || 'Payment adjusted against invoice',
            debit: 0,
            credit: 0,
            adjustedAmount: Number(args.amount),
            sourcePaymentId: args.sourcePaymentId,
            referenceInvoiceId: args.referenceInvoiceId,
            referenceInvoiceNumber: args.referenceInvoiceNumber,
            balance: 0,
        }, { type: 'supplier', id: args.supplierId }, user);
    };
    const AUTO_LEDGER_PREFIX = '[AUTO_LEDGER]';

    const getEntryTypeWeight = (entry: TransactionLedgerItem): number => {
        if (entry.type === 'openingBalance') return 0;
        if (entry.type === 'purchase' || entry.type === 'sale') return 1;
        if (entry.type === 'payment' && (entry.entryCategory === 'invoice_payment' || entry.entryCategory === 'down_payment')) return 2;
        if (String(entry.entryCategory || '').includes('adjustment')) return 3;
        return 4;
    };

    const sortLedgerEntries = (entries: TransactionLedgerItem[]) => {
        return [...entries].sort((a, b) => {
            const dateDiff = new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime();
            if (dateDiff !== 0) return dateDiff;
            const weightA = getEntryTypeWeight(a);
            const weightB = getEntryTypeWeight(b);
            if (weightA !== weightB) return weightA - weightB;
            return (a.id || '').localeCompare(b.id || '');
        });
    };

    const recalculateLedger = (entries: TransactionLedgerItem[], openingBalance = 0, partyType: 'customer' | 'supplier'): TransactionLedgerItem[] => {
        const hasOpeningBalanceEntry = entries.some(entry => entry.type === 'openingBalance' && entry.status !== 'cancelled');
        let runningBalance = hasOpeningBalanceEntry ? 0 : Number(openingBalance || 0);
        return sortLedgerEntries(entries).map((entry) => {
            if (entry.status !== 'cancelled' || entry.type === 'payment') {
                if (partyType === 'supplier') {
                    runningBalance += Number(entry.credit || 0) - Number(entry.debit || 0);
                } else {
                    runningBalance += Number(entry.debit || 0) - Number(entry.credit || 0);
                }
            }
            return { ...entry, balance: runningBalance };
        });
    };

    const isAutoLedgerEntry = (entry: TransactionLedgerItem, referenceKey: string): boolean => {
        return entry.id === referenceKey || (entry.description || '').includes(`${AUTO_LEDGER_PREFIX}:${referenceKey}`);
    };

    const canCancelLedgerPaymentEntry = (entry: TransactionLedgerItem): boolean => {
        if (!entry || entry.type !== 'payment') return false;
        if (entry.status === 'cancelled') return false;
        return entry.entryCategory === 'invoice_payment' || entry.entryCategory === 'down_payment';
    };

    export const cancelPartyPaymentEntry = async (
        args: {
            ownerType: 'customer' | 'supplier';
            ownerId: string;
            paymentEntryId: string;
            cancellationDate: string;
            reason: string;
            cancelledBy?: string;
        },
        user: RegisteredPharmacy
    ): Promise<void> => {
        const tableName = args.ownerType === 'customer' ? 'customers' : 'suppliers';
        const entity = await getDataById<Customer | Supplier>(tableName, args.ownerId, user);
        if (!entity) throw new Error(`${args.ownerType === 'customer' ? 'Customer' : 'Supplier'} not found`);

        const ledger = Array.isArray(entity.ledger) ? [...entity.ledger] : [];
        const targetIndex = ledger.findIndex((entry) => entry.id === args.paymentEntryId);
        if (targetIndex < 0) throw new Error('Payment voucher not found in ledger.');

        const targetEntry = ledger[targetIndex];
        if (!canCancelLedgerPaymentEntry(targetEntry)) {
            throw new Error('Cannot cancel this payment voucher.');
        }

        const cancellationVoucherNumber = `REV-${Date.now()}`;
        const cancellationCategory = targetEntry.entryCategory === 'down_payment' ? 'down_payment_cancellation' : 'payment_cancellation';

        ledger[targetIndex] = {
            ...targetEntry,
            status: 'cancelled',
            cancelledAt: args.cancellationDate,
            cancelledBy: args.cancelledBy || user.id,
            cancellationReason: args.reason,
            cancellationVoucherNumber,
        };

        const linkedAdjustments = ledger.filter((entry) => {
            if (entry.status === 'cancelled') return false;
            if (entry.entryCategory === 'down_payment_adjustment') {
                return entry.sourceDownPaymentId === targetEntry.id;
            }
            if (entry.entryCategory === 'invoice_payment_adjustment') {
                return entry.sourcePaymentId === targetEntry.id;
            }
            return false;
        });

        for (const adjustment of linkedAdjustments) {
            const adjustmentIndex = ledger.findIndex((entry) => entry.id === adjustment.id);
            if (adjustmentIndex >= 0) {
                ledger[adjustmentIndex] = {
                    ...ledger[adjustmentIndex],
                    status: 'cancelled',
                    cancelledAt: args.cancellationDate,
                    cancelledBy: args.cancelledBy || user.id,
                    cancellationReason: `Reversed by cancellation of payment ${targetEntry.journalEntryNumber || targetEntry.id}`,
                    cancellationVoucherNumber,
                };
            }
            ledger.push({
                id: generateUUID(),
                date: args.cancellationDate,
                type: 'payment',
                entryCategory: adjustment.entryCategory === 'down_payment_adjustment' ? 'down_payment_adjustment_reversal' : 'invoice_payment_adjustment_reversal',
                description: `Reversal for ${adjustment.description || 'adjustment'}`,
                debit: 0,
                credit: 0,
                adjustedAmount: -Math.abs(Number(adjustment.adjustedAmount || 0)),
                sourceDownPaymentId: adjustment.sourceDownPaymentId,
                sourcePaymentId: adjustment.sourcePaymentId,
                referenceInvoiceId: adjustment.referenceInvoiceId,
                referenceInvoiceNumber: adjustment.referenceInvoiceNumber,
                reversedEntryId: adjustment.id,
                cancellationVoucherNumber,
                balance: 0,
            });
        }

        ledger.push({
            id: generateUUID(),
            date: args.cancellationDate,
            type: 'payment',
            entryCategory: cancellationCategory,
            description: `Cancellation reversal for ${targetEntry.description}`,
            debit: Number(targetEntry.credit || 0),
            credit: Number(targetEntry.debit || 0),
            paymentMode: targetEntry.paymentMode,
            bankAccountId: targetEntry.bankAccountId,
            bankName: targetEntry.bankName,
            referenceInvoiceId: targetEntry.referenceInvoiceId,
            referenceInvoiceNumber: targetEntry.referenceInvoiceNumber,
            reversedEntryId: targetEntry.id,
            cancellationReason: args.reason,
            cancellationVoucherNumber,
            balance: 0,
        });

        entity.ledger = recalculateLedger(ledger, Number(entity.opening_balance || 0), args.ownerType);
        await saveData(tableName, entity, user, true);
    };

    const upsertAutoLedgerEntry = async (
        owner: { type: 'customer' | 'supplier', id: string },
        user: RegisteredPharmacy,
        entry: Omit<TransactionLedgerItem, 'balance'>,
        shouldPost: boolean
    ) => {
        const tableName = owner.type === 'customer' ? 'customers' : 'suppliers';
        const entity = await getDataById<Customer | Supplier>(tableName, owner.id, user);
        if (!entity) return;

        const nextLedger = (entity.ledger || []).filter((item) => !isAutoLedgerEntry(item, entry.id));
        if (shouldPost) {
            nextLedger.push({
                ...entry,
                description: `${entry.description} ${AUTO_LEDGER_PREFIX}:${entry.id}`.trim(),
                balance: 0,
            });
        }

        entity.ledger = recalculateLedger(nextLedger, entity.opening_balance || 0, owner.type);
        await saveData(tableName, entity, user, true);
    };


    const mapMaterialType = (value?: string): string => {
        const v = String(value || '').toLowerCase();
        if (v.includes('finish')) return 'Finished Goods';
        if (v.includes('consum')) return 'Consumables';
        if (v.includes('service')) return 'Service Material';
        if (v.includes('pack')) return 'Packaging';
        return 'Trading Goods';
    };

    const buildJournalNumber = (prefix: 'SAL' | 'PUR') => `${prefix}-${Date.now()}`;


    const resolveLinkedBankGlId = async (
        user: RegisteredPharmacy,
        companyCodeId: string
    ): Promise<string | null> => {
        if (!navigator.onLine) return null;

        const { data, error } = await supabase
            .from('bank_master')
            .select('linked_bank_gl_id')
            .eq('organization_id', user.organization_id)
            .eq('company_code_id', companyCodeId)
            .eq('default_bank', true)
            .eq('active_status', 'Active')
            .not('linked_bank_gl_id', 'is', null)
            .limit(1);

        if (error) throw error;
        return data?.[0]?.linked_bank_gl_id ? String(data[0].linked_bank_gl_id) : null;
    };

    const postJournal = async (
        user: RegisteredPharmacy,
        args: {
            referenceId: string;
            referenceType: 'SALES_BILL' | 'PURCHASE_BILL';
            documentType: 'SALES' | 'PURCHASE';
            documentReference: string;
            postingDate: string;
            companyCodeId: string;
            setOfBooksId: string;
            lines: Array<{ glId: string; debit: number; credit: number; memo: string }>;
        }
    ) => {
        if (!isValidUuid(args.setOfBooksId) || !isValidUuid(args.companyCodeId) || !isValidUuid(user.organization_id)) {
            console.warn('Skipping journal post: Invalid UUID in posting context', { setOfBooksId: args.setOfBooksId, companyCodeId: args.companyCodeId });
            return;
        }

        let setOfBooks: any = null;
        try {
            const sobRows = await sqliteDb.select<{ id: string; set_of_books_id: string; company_code_id: string; default_customer_gl_id: string; default_supplier_gl_id: string }>(
                `SELECT id, set_of_books_id, company_code_id, default_customer_gl_id, default_supplier_gl_id FROM ${SCHEMA_TABLE.SET_OF_BOOKS} WHERE organization_id = ? AND id = ? LIMIT 1`,
                [user.organization_id, args.setOfBooksId]
            );
            if (sobRows && sobRows.length > 0) {
                setOfBooks = sobRows[0];
            }
        } catch (err) {
            console.warn('[postJournal] SQLite query for set_of_books failed:', err);
        }

        if (!setOfBooks && navigator.onLine) {
            try {
                const { data } = await supabase
                    .from('set_of_books')
                    .select('id, set_of_books_id, company_code_id, default_customer_gl_id, default_supplier_gl_id')
                    .eq('organization_id', user.organization_id)
                    .eq('id', args.setOfBooksId)
                    .single();
                setOfBooks = data;
            } catch (err) {
                console.warn('[postJournal] Supabase query for set_of_books failed:', err);
            }
        }

        if (!setOfBooks || setOfBooks.company_code_id !== args.companyCodeId) {
            throw new Error(DEFAULT_CONFIG_MISSING_MESSAGE);
        }

        const glIds = Array.from(new Set(args.lines.map(l => l.glId)));
        let glRows: any[] = [];
        try {
            const placeholders = glIds.map(() => '?').join(',');
            const rows = await sqliteDb.select<any>(
                `SELECT id, gl_code, gl_name, set_of_books_id FROM ${SCHEMA_TABLE.GL_MASTER} WHERE organization_id = ? AND set_of_books_id = ? AND id IN (${placeholders})`,
                [user.organization_id, args.setOfBooksId, ...glIds]
            );
            if (rows) {
                glRows = rows;
            }
        } catch (err) {
            console.warn('[postJournal] SQLite query for gl_master failed:', err);
        }

        const foundIds = new Set(glRows.map(r => String(r.id)));
        const missingIds = glIds.filter(id => !foundIds.has(id));
        if (missingIds.length > 0 && navigator.onLine) {
            try {
                const { data: remoteRows } = await supabase
                    .from('gl_master')
                    .select('id, gl_code, gl_name, set_of_books_id')
                    .eq('organization_id', user.organization_id)
                    .eq('set_of_books_id', args.setOfBooksId)
                    .in('id', missingIds);
                if (remoteRows) {
                    glRows = [...glRows, ...remoteRows];
                }
            } catch (err) {
                console.warn('[postJournal] Supabase query for gl_master failed:', err);
            }
        }

        const glById = new Map((glRows || []).map((g: any) => [g.id, g]));

        const enrichedLines = args.lines.map((line) => {
            const gl = glById.get(line.glId);
            if (!gl || gl.set_of_books_id !== args.setOfBooksId) {
                throw new Error('GL Assignment missing for Material Type under selected Set of Books. Please configure in Utilities & Setup.');
            }
            return {
                ...line,
                gl_code: gl.gl_code,
                gl_name: gl.gl_name,
            };
        });

        const totalDebit = Number(enrichedLines.reduce((sum, l) => sum + l.debit, 0).toFixed(2));
        const totalCredit = Number(enrichedLines.reduce((sum, l) => sum + l.credit, 0).toFixed(2));
        if (Math.abs(totalDebit - totalCredit) > 0.01) {
            throw new Error('Generated accounting journals are not balanced.');
        }

        let companyCode = '';
        try {
            const ccRows = await sqliteDb.select<{ code: string }>(
                `SELECT code FROM company_codes WHERE organization_id = ? AND id = ? LIMIT 1`,
                [user.organization_id, args.companyCodeId]
            );
            if (ccRows && ccRows.length > 0) {
                companyCode = ccRows[0].code;
            }
        } catch (err) {
            console.warn('[postJournal] SQLite query for company_codes failed:', err);
        }

        if (!companyCode && navigator.onLine) {
            try {
                const { data } = await supabase
                    .from('company_codes')
                    .select('code')
                    .eq('id', args.companyCodeId)
                    .maybeSingle();
                if (data) companyCode = data.code;
            } catch (err) {
                console.warn('[postJournal] Supabase query for company_codes failed:', err);
            }
        }

        // Check if journal entry header already exists for this reference to prevent duplicate postings
        let existingHeader: any = null;
        try {
            const rows = await sqliteDb.select<any>(
                `SELECT id, journal_entry_number FROM journal_entry_header 
                 WHERE organization_id = ? AND reference_id = ? LIMIT 1`,
                [user.organization_id, args.referenceId]
            );
            if (rows && rows.length > 0) {
                existingHeader = rows[0];
            }
        } catch (err) {
            console.warn('[postJournal] Failed to query existing local header:', err);
        }

        if (!existingHeader && navigator.onLine) {
            try {
                const { data } = await supabase
                    .from('journal_entry_header')
                    .select('id, journal_entry_number')
                    .eq('organization_id', user.organization_id)
                    .eq('reference_id', args.referenceId)
                    .maybeSingle();
                if (data) {
                    existingHeader = data;
                }
            } catch (err) {
                console.warn('[postJournal] Failed to query existing remote header:', err);
            }
        }

        const getDeterministicUuid = (source: string): string => {
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source)) {
                return 'a' + source.substring(1);
            }
            let hash = 0;
            for (let i = 0; i < source.length; i++) {
                hash = (hash << 5) - hash + source.charCodeAt(i);
                hash |= 0;
            }
            const hex = Math.abs(hash).toString(16).padEnd(32, '0');
            return `${hex.substring(0,8)}-${hex.substring(8,12)}-4${hex.substring(12,15)}-a${hex.substring(15,18)}-${hex.substring(18,30)}`;
        };

        const headerId = existingHeader?.id || getDeterministicUuid(args.referenceId);
        const journalNumber = existingHeader?.journal_entry_number || buildJournalNumber(args.documentType === 'SALES' ? 'SAL' : 'PUR');

        // Delete old lines locally first to prevent orphans/imbalances when re-posting
        try {
            await sqliteDb.execute(
                `DELETE FROM journal_entry_lines WHERE journal_entry_id = ?`,
                [headerId]
            );
        } catch (err) {
            console.warn('[postJournal] Failed to delete existing local lines:', err);
        }

        // If online, also delete existing remote lines to prepare for updated rewrite
        if (navigator.onLine) {
            try {
                await ensureLiveAuth();
                await supabase
                    .from('journal_entry_lines')
                    .delete()
                    .eq('journal_entry_id', headerId);
            } catch (err) {
                console.warn('[postJournal] Failed to clean remote lines:', err);
            }
        }

        const headerPayload = {
            id: headerId,
            organization_id: user.organization_id,
            journal_entry_number: journalNumber,
            posting_date: args.postingDate,
            status: 'Posted',
            reference_type: args.referenceType,
            reference_id: args.referenceId,
            reference_document_id: args.referenceId,
            document_type: args.documentType,
            document_reference: args.documentReference,
            company: companyCode || args.companyCodeId,
            company_code_id: args.companyCodeId,
            set_of_books: setOfBooks.set_of_books_id || args.setOfBooksId,
            set_of_books_id: args.setOfBooksId,
            total_debit: totalDebit,
            total_credit: totalCredit,
            currency_code: 'INR',
            created_by: user.id || null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            _sync_status: navigator.onLine ? 'synced' : 'pending'
        };

        const linePayloads = enrichedLines.map((line, index) => ({
            id: getDeterministicUuid(`${headerId}-line-${index}`),
            organization_id: user.organization_id,
            journal_entry_id: headerId,
            reference_document_id: args.referenceId,
            document_type: args.documentType,
            line_number: index + 1,
            gl_code: line.gl_code,
            gl_name: line.gl_name,
            account_code: line.gl_code,
            account_name: line.gl_name,
            ledger_code: line.gl_code,
            ledger_name: line.gl_name,
            debit: Number(line.debit.toFixed(2)),
            credit: Number(line.credit.toFixed(2)),
            line_memo: line.memo,
            created_at: new Date().toISOString(),
            _sync_status: navigator.onLine ? 'synced' : 'pending'
        }));

        // Write locally to SQLite first
        await sqliteDb.upsert('journal_entry_header', headerPayload);
        await sqliteDb.bulkUpsert('journal_entry_lines', linePayloads);

        if (navigator.onLine) {
            try {
                await ensureLiveAuth();

                const { error: remoteHeaderErr } = await supabase
                    .from('journal_entry_header')
                    .insert(toSnake({
                        id: headerPayload.id,
                        organization_id: headerPayload.organization_id,
                        journal_entry_number: headerPayload.journal_entry_number,
                        posting_date: headerPayload.posting_date,
                        status: headerPayload.status,
                        reference_type: headerPayload.reference_type,
                        reference_id: headerPayload.reference_id,
                        reference_document_id: headerPayload.reference_document_id,
                        document_type: headerPayload.document_type,
                        document_reference: headerPayload.document_reference,
                        company: headerPayload.company,
                        company_code_id: headerPayload.company_code_id,
                        set_of_books: headerPayload.set_of_books,
                        set_of_books_id: headerPayload.set_of_books_id,
                        total_debit: headerPayload.total_debit,
                        total_credit: headerPayload.total_credit,
                        currency_code: headerPayload.currency_code,
                        created_by: headerPayload.created_by
                    }));
                if (remoteHeaderErr) throw remoteHeaderErr;

                const { error: remoteLinesErr } = await supabase
                    .from('journal_entry_lines')
                    .insert(linePayloads.map(line => toSnake({
                        organization_id: line.organization_id,
                        journal_entry_id: line.journal_entry_id,
                        reference_document_id: line.reference_document_id,
                        document_type: line.document_type,
                        line_number: line.line_number,
                        gl_code: line.gl_code,
                        gl_name: line.gl_name,
                        debit: line.debit,
                        credit: line.credit,
                        line_memo: line.line_memo
                    })));
                if (remoteLinesErr) throw remoteLinesErr;

            } catch (remoteErr) {
                console.warn('[postJournal] Supabase insertion failed, queuing for sync instead:', remoteErr);
                await sqliteDb.execute(`UPDATE journal_entry_header SET _sync_status = 'pending' WHERE id = ?`, [headerId]);
                await sqliteDb.execute(`UPDATE journal_entry_lines SET _sync_status = 'pending' WHERE journal_entry_id = ?`, [headerId]);

                await enqueueForSync('journal_entry_header', false, headerPayload, user.organization_id);
                for (const line of linePayloads) {
                    await enqueueForSync('journal_entry_lines', false, line, user.organization_id);
                }
            }
        } else {
            await sqliteDb.execute(`UPDATE journal_entry_header SET _sync_status = 'pending' WHERE id = ?`, [headerId]);
            await sqliteDb.execute(`UPDATE journal_entry_lines SET _sync_status = 'pending' WHERE journal_entry_id = ?`, [headerId]);

            await enqueueForSync('journal_entry_header', false, headerPayload, user.organization_id);
            for (const line of linePayloads) {
                await enqueueForSync('journal_entry_lines', false, line, user.organization_id);
            }
        }
    };

    // idb.getAll always returns [] (IDB disabled), so these used to always
    // resolve to undefined — meaning syncSalesLedger / syncPurchaseLedger
    // silently skipped every ledger update even online. Read the same list
    // the UI does (memoryCache via getData) and the lookup actually works.
    const findCustomerForTransaction = async (tx: Transaction, user: RegisteredPharmacy): Promise<Customer | undefined> => {
        if (!tx.customerId) return undefined;
        const customers = await getData('customers', [], user) as Customer[];
        return customers.find(c => c.id === tx.customerId);
    };

    const findSupplierForPurchase = async (purchase: Purchase, user: RegisteredPharmacy): Promise<Supplier | undefined> => {
        const suppliers = await getData('suppliers', [], user) as Supplier[];
        const supplierName = (purchase.supplier || '').trim().toLowerCase();
        if (!supplierName) return undefined;
        return suppliers.find(s => (s.name || '').trim().toLowerCase() === supplierName);
    };

    export const syncSalesLedger = async (tx: Transaction, user: RegisteredPharmacy, isUpdate: boolean = false) => {
        const customer = await findCustomerForTransaction(tx, user);
        const paymentMode = String(tx.paymentMode || '').toLowerCase();
        const isImmediatePayment = ['cash', 'card', 'upi', 'bank'].includes(paymentMode);
        const hasSelectedCustomer = !!(customer && tx.customerId);
        const autoSaleLedgerId = `auto-sale-${tx.id}`;
        const autoPaymentLedgerId = `auto-sale-payment-${tx.id}`;
        const autoAdjustmentLedgerId = `auto-sale-adjustment-${tx.id}`;

        // ── Customer-ledger updates (always run, online + offline) ──────────
        // upsertAutoLedgerEntry writes via saveData('customers',...) which is
        // queue-safe — the ledger row appears immediately in the local view
        // and the customers table sync push propagates it to Supabase later.
        if (hasSelectedCustomer) {
            await upsertAutoLedgerEntry(
                { type: 'customer', id: customer.id },
                user,
                {
                    id: autoSaleLedgerId,
                    date: tx.date,
                    type: 'sale',
                    description: `Sales Voucher ${tx.invoiceNumber || tx.id}`,
                    debit: Number(tx.total || 0),
                    credit: 0,
                    referenceInvoiceId: tx.id,
                    referenceInvoiceNumber: tx.invoiceNumber,
                },
                tx.status !== 'cancelled'
            );
        }

        if (tx.status === 'cancelled') {
            if (hasSelectedCustomer) {
                await upsertAutoLedgerEntry({ type: 'customer', id: customer.id }, user, { id: autoPaymentLedgerId, date: tx.date, type: 'payment', description: `Auto payment for sales ${tx.invoiceNumber || tx.id}`, debit: 0, credit: 0 }, false);
                await upsertAutoLedgerEntry({ type: 'customer', id: customer.id }, user, { id: autoAdjustmentLedgerId, date: tx.date, type: 'payment', description: `Auto adjustment for sales ${tx.invoiceNumber || tx.id}`, debit: 0, credit: 0 }, false);
            }
            return;
        }

        // Offline path stops here: the bill + customer ledger are queued.
        // The GL/journal posting below relies on Supabase RPCs (GL master
        // lookup, journal_entry_header insert) — recomputed when online.
        // For immediate-payment sales offline, also drop a placeholder payment
        // ledger row so the customer card shows the cash receipt right away.
        if (!navigator.onLine) {
            if (hasSelectedCustomer && isImmediatePayment) {
                await upsertAutoLedgerEntry(
                    { type: 'customer', id: customer.id },
                    user,
                    {
                        id: autoPaymentLedgerId,
                        date: tx.date,
                        type: 'payment',
                        entryCategory: 'invoice_payment',
                        description: `Payment Received Voucher for ${tx.invoiceNumber || tx.id} (offline)`,
                        debit: 0,
                        credit: Number(tx.total || 0),
                        referenceInvoiceId: tx.id,
                        referenceInvoiceNumber: tx.invoiceNumber,
                    },
                    true
                );
                await upsertAutoLedgerEntry(
                    { type: 'customer', id: customer.id },
                    user,
                    {
                        id: autoAdjustmentLedgerId,
                        date: tx.date,
                        type: 'payment',
                        entryCategory: 'invoice_payment_adjustment',
                        description: `Auto-adjustment against invoice ${tx.invoiceNumber || tx.id} (offline)`,
                        debit: 0,
                        credit: 0,
                        adjustedAmount: Number(tx.total || 0),
                        sourcePaymentId: autoPaymentLedgerId,
                        referenceInvoiceId: tx.id,
                        referenceInvoiceNumber: tx.invoiceNumber,
                    },
                    true
                );
            }
            console.info('[storage:syncSalesLedger] Offline — customer ledger written locally, proceeding with journal generation');
        }

        const postingContext = await ensurePostingContext(tx, user);
        tx.companyCodeId = postingContext.companyCodeId;
        tx.setOfBooksId = postingContext.setOfBooksId;

        let customerControlGl: string | undefined;
        try {
            const sobRows = await sqliteDb.select<{ default_customer_gl_id: string }>(
                `SELECT default_customer_gl_id FROM ${SCHEMA_TABLE.SET_OF_BOOKS} WHERE organization_id = ? AND id = ? LIMIT 1`,
                [user.organization_id, tx.setOfBooksId]
            );
            if (sobRows && sobRows.length > 0) {
                customerControlGl = sobRows[0].default_customer_gl_id;
            }
        } catch (err) {
            console.warn('[syncSalesLedger] SQLite query for set_of_books failed:', err);
        }

        if (!customerControlGl && navigator.onLine) {
            try {
                const { data: books } = await supabase
                    .from('set_of_books')
                    .select('default_customer_gl_id')
                    .eq('organization_id', user.organization_id)
                    .eq('id', tx.setOfBooksId)
                    .single();
                customerControlGl = books?.default_customer_gl_id;
            } catch (err) {
                console.warn('[syncSalesLedger] Supabase query for set_of_books failed:', err);
            }
        }

        if (!customerControlGl) throw new Error('GL Assignment missing for Material Type under selected Set of Books. Please configure in Utilities & Setup.');

        let glRows: { id: string; gl_code: string }[] = [];
        const requiredCodes = ['100001', '400100', '210110', '210120', '210130', '510000'];
        try {
            const placeholders = requiredCodes.map(() => '?').join(',');
            const rows = await sqliteDb.select<{ id: string; gl_code: string }>(
                `SELECT id, gl_code FROM ${SCHEMA_TABLE.GL_MASTER} WHERE organization_id = ? AND set_of_books_id = ? AND gl_code IN (${placeholders})`,
                [user.organization_id, tx.setOfBooksId, ...requiredCodes]
            );
            if (rows) {
                glRows = rows;
            }
        } catch (err) {
            console.warn('[syncSalesLedger] SQLite query for gl_master failed:', err);
        }

        const foundCodes = new Set(glRows.map(r => String(r.gl_code)));
        const missingCodes = requiredCodes.filter(c => !foundCodes.has(c));
        if (missingCodes.length > 0 && navigator.onLine) {
            try {
                const { data: remoteRows } = await supabase
                    .from('gl_master')
                    .select('id, gl_code')
                    .eq('organization_id', user.organization_id)
                    .eq('set_of_books_id', tx.setOfBooksId)
                    .in('gl_code', requiredCodes);
                if (remoteRows) {
                    const combined = [...glRows];
                    for (const r of remoteRows) {
                        if (!combined.some(c => String(c.gl_code) === String(r.gl_code))) {
                            combined.push({ id: r.id, gl_code: r.gl_code });
                        }
                    }
                    glRows = combined;
                }
            } catch (err) {
                console.warn('[syncSalesLedger] Supabase query for gl_master failed:', err);
            }
        }

        const glByCode = new Map(glRows.map((row) => [String(row.gl_code), String(row.id)]));

        const salesGl = glByCode.get('400100');
        const outputCgstGl = glByCode.get('210110');
        const outputSgstGl = glByCode.get('210120');
        const outputIgstGl = glByCode.get('210130');
        const roundOffGl = glByCode.get('510000');
        if (!salesGl || !outputCgstGl || !outputSgstGl || !outputIgstGl || !roundOffGl) {
            throw new Error('Set of Books GL mapping incomplete. Required: Sales (400100), Output CGST (210110), Output SGST (210120), Output IGST (210130), Round Off (510000).');
        }

        const lineAcc = new Map<string, { debit: number; credit: number; memo: string }>();
        const addLine = (glId: string, debit: number, credit: number, memo: string) => {
            const cur = lineAcc.get(glId) || { debit: 0, credit: 0, memo };
            cur.debit += debit;
            cur.credit += credit;
            lineAcc.set(glId, cur);
        };

        const mappedBankGl = isImmediatePayment ? await resolveLinkedBankGlId(user, tx.companyCodeId) : null;
        const cashOrBankGl = mappedBankGl || glByCode.get('100001');
        const debitControlGl = hasSelectedCustomer ? customerControlGl : (isImmediatePayment && cashOrBankGl ? cashOrBankGl : customerControlGl);
        addLine(String(debitControlGl), Number(tx.total || 0), 0, hasSelectedCustomer ? 'Customer control' : (isImmediatePayment ? 'Cash / bank receipt' : 'Customer control'));

        let inferredTaxableValue = 0;
        let cgstTotal = 0;
        let sgstTotal = 0;
        let igstTotal = 0;

        for (const item of tx.items || []) {
            const taxable = Number((item as any).taxableValue || 0);
            const gst = Number((item as any).gstAmount || 0);
            const explicitCgst = Number((item as any).cgstValue || 0);
            const explicitSgst = Number((item as any).sgstValue || 0);
            const explicitIgst = Number((item as any).igstValue || 0);

            inferredTaxableValue += taxable;
            if (explicitCgst > 0 || explicitSgst > 0 || explicitIgst > 0) {
                cgstTotal += explicitCgst;
                sgstTotal += explicitSgst;
                igstTotal += explicitIgst;
            } else if (gst > 0) {
                cgstTotal += Number((gst / 2).toFixed(4));
                sgstTotal += Number((gst / 2).toFixed(4));
            }
        }

        inferredTaxableValue = Number(inferredTaxableValue.toFixed(2));
        cgstTotal = Number(cgstTotal.toFixed(2));
        sgstTotal = Number(sgstTotal.toFixed(2));
        igstTotal = Number(igstTotal.toFixed(2));

        const transactionTax = Number(Number(tx.totalGst || 0).toFixed(2));
        const splitTax = Number((cgstTotal + sgstTotal + igstTotal).toFixed(2));

        // Keep tax split aligned with the persisted transaction-level GST so journal totals remain balanced.
        if (Math.abs(transactionTax - splitTax) > 0.01) {
            if (igstTotal > 0 && cgstTotal === 0 && sgstTotal === 0) {
                igstTotal = transactionTax;
            } else if (cgstTotal > 0 || sgstTotal > 0) {
                cgstTotal = Number((transactionTax / 2).toFixed(2));
                sgstTotal = Number((transactionTax - cgstTotal).toFixed(2));
                igstTotal = 0;
            } else if (transactionTax > 0) {
                cgstTotal = Number((transactionTax / 2).toFixed(2));
                sgstTotal = Number((transactionTax - cgstTotal).toFixed(2));
            }
        }

        const totalTax = Number((cgstTotal + sgstTotal + igstTotal).toFixed(2));
        let taxableValue = Number((Number(tx.total || 0) - totalTax - Number(tx.roundOff || 0)).toFixed(2));
        if (Math.abs(taxableValue) <= 0.01) taxableValue = 0;
        if (taxableValue < 0 && inferredTaxableValue > 0) {
            taxableValue = inferredTaxableValue;
        }

        addLine(String(salesGl), 0, taxableValue, 'Sales account');
        if (cgstTotal > 0) addLine(String(outputCgstGl), 0, cgstTotal, 'Output CGST');
        if (sgstTotal > 0) addLine(String(outputSgstGl), 0, sgstTotal, 'Output SGST');
        if (igstTotal > 0) addLine(String(outputIgstGl), 0, igstTotal, 'Output IGST');

        const roundOff = Number(tx.roundOff || 0);
        if (Math.abs(roundOff) > 0.0001) {
            if (roundOff > 0) addLine(String(roundOffGl), 0, roundOff, 'Round off');
            else addLine(String(roundOffGl), Math.abs(roundOff), 0, 'Round off');
        }

        const lines = Array.from(lineAcc.entries()).map(([glId, v]) => ({ glId, debit: v.debit, credit: v.credit, memo: v.memo }));

        await postJournal(user, {
            referenceId: tx.id,
            referenceType: 'SALES_BILL',
            documentType: 'SALES',
            documentReference: tx.id,
            postingDate: tx.date,
            companyCodeId: tx.companyCodeId,
            setOfBooksId: tx.setOfBooksId,
            lines,
        });

        if (hasSelectedCustomer && isImmediatePayment) {
            const existingPayment = Array.isArray(customer.ledger)
                ? customer.ledger.find((entry) => isAutoLedgerEntry(entry, autoPaymentLedgerId))
                : undefined;

            let paymentMeta = {
                journalEntryId: existingPayment?.journalEntryId,
                journalEntryNumber: existingPayment?.journalEntryNumber,
            };

            if (!existingPayment) {
                const paymentResult = await recordCustomerPaymentWithAccounting({
                    customerId: customer.id,
                    amount: Number(tx.total || 0),
                    date: tx.date,
                    description: `Payment Received Voucher for ${tx.invoiceNumber || tx.id}`,
                    paymentMode: 'Cash',
                    bankAccountId: '',
                    referenceInvoiceId: tx.id,
                    referenceInvoiceNumber: tx.invoiceNumber,
                    entryCategory: 'invoice_payment',
                    ledgerEntryId: autoPaymentLedgerId,
                }, user);
                paymentMeta = {
                    journalEntryId: paymentResult.journalEntryId,
                    journalEntryNumber: paymentResult.journalEntryNumber,
                };
            }

            await upsertAutoLedgerEntry(
                { type: 'customer', id: customer.id },
                user,
                {
                    id: autoAdjustmentLedgerId,
                    date: tx.date,
                    type: 'payment',
                    entryCategory: 'invoice_payment_adjustment',
                    description: `Auto-adjustment against invoice ${tx.invoiceNumber || tx.id}`,
                    debit: 0,
                    credit: 0,
                    adjustedAmount: Number(tx.total || 0),
                    sourcePaymentId: autoPaymentLedgerId,
                    referenceInvoiceId: tx.id,
                    referenceInvoiceNumber: tx.invoiceNumber,
                    journalEntryId: paymentMeta.journalEntryId,
                    journalEntryNumber: paymentMeta.journalEntryNumber,
                },
                true
            );
        }
    };

    export const syncPurchaseLedger = async (purchase: Purchase, user: RegisteredPharmacy) => {
        const supplier = await findSupplierForPurchase(purchase, user);

        // Supplier-ledger update runs always (online + offline) — saveData
        // queues it for sync. The GL/journal posting below stays online-only.
        if (supplier) {
            await upsertAutoLedgerEntry(
                { type: 'supplier', id: supplier.id },
                user,
                {
                    id: `auto-purchase-${purchase.id}`,
                    date: purchase.date,
                    type: 'purchase',
                    description: `Purchase Voucher ${purchase.invoiceNumber || purchase.id}`,
                    debit: 0,
                    credit: Number(purchase.totalAmount || 0),
                },
                purchase.status !== 'cancelled'
            );
        }

        if (purchase.status === 'cancelled') return;

        if (!navigator.onLine) {
            console.info('[storage:syncPurchaseLedger] Offline — supplier ledger written locally, proceeding with journal generation');
        }

        const postingContext = await ensurePostingContext(purchase, user);
        purchase.companyCodeId = postingContext.companyCodeId;
        purchase.setOfBooksId = postingContext.setOfBooksId;

        if (!isValidUuid(purchase.setOfBooksId) || !isValidUuid(user.organization_id)) {
            console.warn('Skipping purchase ledger sync: Invalid UUID in posting context', { setOfBooksId: purchase.setOfBooksId });
            return;
        }

        let assignments: { material_master_type: string; purchase_gl: string; tax_gl: string }[] = [];
        try {
            const rows = await sqliteDb.select<{ material_master_type: string; purchase_gl: string; tax_gl: string }>(
                `SELECT material_master_type, purchase_gl, tax_gl FROM ${SCHEMA_TABLE.GL_ASSIGNMENTS} WHERE organization_id = ? AND set_of_books_id = ?`,
                [user.organization_id, purchase.setOfBooksId]
            );
            if (rows) {
                assignments = rows;
            }
        } catch (err) {
            console.warn('[syncPurchaseLedger] SQLite query for gl_assignments failed:', err);
        }

        if (assignments.length === 0 && navigator.onLine) {
            try {
                const { data: remoteAssignments } = await supabase
                    .from('gl_assignments')
                    .select('material_master_type, purchase_gl, tax_gl')
                    .eq('organization_id', user.organization_id)
                    .eq('set_of_books_id', purchase.setOfBooksId);
                if (remoteAssignments) {
                    assignments = remoteAssignments;
                }
            } catch (err) {
                console.warn('[syncPurchaseLedger] Supabase query for gl_assignments failed:', err);
            }
        }

        const assignmentByType = new Map((assignments || []).map((a: any) => [a.material_master_type, a]));

        let supplierControlGl: string | undefined;
        try {
            const sobRows = await sqliteDb.select<{ default_supplier_gl_id: string }>(
                `SELECT default_supplier_gl_id FROM ${SCHEMA_TABLE.SET_OF_BOOKS} WHERE organization_id = ? AND id = ? LIMIT 1`,
                [user.organization_id, purchase.setOfBooksId]
            );
            if (sobRows && sobRows.length > 0) {
                supplierControlGl = sobRows[0].default_supplier_gl_id;
            }
        } catch (err) {
            console.warn('[syncPurchaseLedger] SQLite query for set_of_books failed:', err);
        }

        if (!supplierControlGl && navigator.onLine) {
            try {
                const { data: books } = await supabase
                    .from('set_of_books')
                    .select('default_supplier_gl_id')
                    .eq('organization_id', user.organization_id)
                    .eq('id', purchase.setOfBooksId)
                    .single();
                supplierControlGl = books?.default_supplier_gl_id;
            } catch (err) {
                console.warn('[syncPurchaseLedger] Supabase query for set_of_books failed:', err);
            }
        }

        if (!supplierControlGl) throw new Error('GL Assignment missing for Material Type under selected Set of Books. Please configure in Utilities & Setup.');

        let glRows: { id: string; gl_code: string }[] = [];
        try {
            const rows = await sqliteDb.select<{ id: string; gl_code: string }>(
                `SELECT id, gl_code FROM ${SCHEMA_TABLE.GL_MASTER} WHERE organization_id = ? AND set_of_books_id = ? AND gl_code = ? LIMIT 1`,
                [user.organization_id, purchase.setOfBooksId, '510000']
            );
            if (rows) {
                glRows = rows;
            }
        } catch (err) {
            console.warn('[syncPurchaseLedger] SQLite query for gl_master failed:', err);
        }

        if (glRows.length === 0 && navigator.onLine) {
            try {
                const { data: remoteRows } = await supabase
                    .from('gl_master')
                    .select('id, gl_code')
                    .eq('organization_id', user.organization_id)
                    .eq('set_of_books_id', purchase.setOfBooksId)
                    .in('gl_code', ['510000']);
                if (remoteRows) {
                    glRows = remoteRows;
                }
            } catch (err) {
                console.warn('[syncPurchaseLedger] Supabase query for gl_master failed:', err);
            }
        }

        const roundOffGl = (glRows || []).find((row: any) => String(row.gl_code) === '510000')?.id;

        const lineAcc = new Map<string, { debit: number; credit: number; memo: string }>();
        const addLine = (glId: string, debit: number, credit: number, memo: string) => {
            const cur = lineAcc.get(glId) || { debit: 0, credit: 0, memo };
            cur.debit += debit;
            cur.credit += credit;
            lineAcc.set(glId, cur);
        };

        addLine(String(supplierControlGl), 0, Number(purchase.totalAmount || 0), 'Supplier control');

        let totalItemTaxable = 0;
        let totalItemGst = 0;

        for (const item of purchase.items || []) {
            const materialType = mapMaterialType((item as any).category);
            const assignment = assignmentByType.get(materialType) || assignmentByType.get('Trading Goods');
            if (!assignment?.purchase_gl || !assignment?.tax_gl) {
                throw new Error('GL Assignment missing for Material Type under selected Set of Books. Please configure in Utilities & Setup.');
            }
            const taxable = Number((item as any).taxableValue || 0);
            const gst = Number((item as any).gstAmount || 0);
            totalItemTaxable += taxable;
            totalItemGst += gst;
            addLine(String(assignment.purchase_gl), taxable, 0, `${materialType} purchase`);
            if (gst > 0) addLine(String(assignment.tax_gl), gst, 0, `${materialType} tax`);
        }

        const fallbackAssignment = assignmentByType.get('Trading Goods') || (assignments || [])[0];
        if (Math.abs(totalItemTaxable) <= 0.01 && Number(purchase.subtotal || 0) > 0) {
            if (!fallbackAssignment?.purchase_gl) {
                throw new Error('GL Assignment missing for Material Type under selected Set of Books. Please configure in Utilities & Setup.');
            }
            addLine(String(fallbackAssignment.purchase_gl), Number(purchase.subtotal || 0), 0, 'Purchase value');
        }
        if (Math.abs(totalItemGst) <= 0.01 && Number(purchase.totalGst || 0) > 0) {
            if (!fallbackAssignment?.tax_gl) {
                throw new Error('GL Assignment missing for Material Type under selected Set of Books. Please configure in Utilities & Setup.');
            }
            addLine(String(fallbackAssignment.tax_gl), Number(purchase.totalGst || 0), 0, 'Purchase tax');
        }

        const roundOff = Number(purchase.roundOff || 0);
        if (Math.abs(roundOff) > 0.0001) {
            if (!roundOffGl) throw new Error('Set of Books GL mapping incomplete. Required: Round Off (510000).');
            if (roundOff > 0) addLine(String(roundOffGl), roundOff, 0, 'Round off');
            else addLine(String(roundOffGl), 0, Math.abs(roundOff), 'Round off');
        }

        const lines = Array.from(lineAcc.entries()).map(([glId, v]) => ({ glId, debit: v.debit, credit: v.credit, memo: v.memo }));

        await postJournal(user, {
            referenceId: purchase.id,
            referenceType: 'PURCHASE_BILL',
            documentType: 'PURCHASE',
            documentReference: purchase.invoiceNumber || purchase.id,
            postingDate: purchase.date,
            companyCodeId: purchase.companyCodeId,
            setOfBooksId: purchase.setOfBooksId,
            lines,
        });
    };

    export const syncSalesReturnLedger = async (salesReturn: SalesReturn, user: RegisteredPharmacy) => {
        // idb.getAll is a no-op (IDB disabled). Use memoryCache via getData so
        // the customer lookup actually finds someone — otherwise every sales
        // return silently skipped its ledger entry.
        const customers = await getData('customers', [], user) as Customer[];
        const customer = salesReturn.customerId
            ? customers.find(c => c.id === salesReturn.customerId)
            : customers.find(c => (c.name || '').trim().toLowerCase() === (salesReturn.customerName || '').trim().toLowerCase());
        if (!customer) return;

        await upsertAutoLedgerEntry(
            { type: 'customer', id: customer.id },
            user,
            {
                id: `auto-sales-return-${salesReturn.id}`,
                date: salesReturn.date,
                type: 'return',
                description: `Sales Return ${salesReturn.id}`,
                debit: 0,
                credit: Number(salesReturn.totalRefund || 0),
                referenceInvoiceId: salesReturn.originalInvoiceId,
                referenceInvoiceNumber: salesReturn.originalInvoiceNumber,
            },
            true
        );
    };

    export const syncPurchaseReturnLedger = async (purchaseReturn: PurchaseReturn, user: RegisteredPharmacy) => {
        // idb.getAll is a no-op (IDB disabled). Same memoryCache-via-getData
        // fix as the sales-return sibling.
        const suppliers = await getData('suppliers', [], user) as Supplier[];
        const supplier = suppliers.find(s => (s.name || '').trim().toLowerCase() === (purchaseReturn.supplier || '').trim().toLowerCase());
        if (!supplier) return;

        await upsertAutoLedgerEntry(
            { type: 'supplier', id: supplier.id },
            user,
            {
                id: `auto-purchase-return-${purchaseReturn.id}`,
                date: purchaseReturn.date,
                type: 'return',
                description: `Purchase Return ${purchaseReturn.id}`,
                debit: Number(purchaseReturn.totalValue || 0),
                credit: 0,
            },
            true
        );
    };

    export const addSalesReturn = async (sr: SalesReturn, user: RegisteredPharmacy) => {
        const cfgRows = await getData('configurations', [{ organization_id: user.organization_id }], user) as AppConfigurations[];
        const stockHandling = resolveStockHandlingConfig(cfgRows?.[0]);
        const res = await saveData('sales_returns', sr, user);

        // Update stock: Sales Return means items are coming BACK to inventory.
        // idb.get is a no-op (IDB disabled), so look the row up via memoryCache
        // — otherwise every return would silently skip the stock adjustment.
        const currentInventory = await fetchInventory(user);
        const inventoryById = new Map(currentInventory.map((inv) => [inv.id, inv]));
        for (const item of sr.items || []) {
            if (!item.inventoryItemId) continue;
            const inv = inventoryById.get(item.inventoryItemId);
            if (inv) {
                const upp = normalizeUnitsPerPack(inv.unitsPerPack, inv.packType);
                // Sales returnQuantity in UI is currently in PACKS (original bill quantity units)
                const unitsToAdd = (Number(item.returnQuantity || 0) * upp);
                const stockBefore = Number(inv.stock || 0);
                const stockAfter = stockBefore + unitsToAdd;
                logStockMovement({ transactionType: 'sales-return-inward', voucherId: sr.id, item: inv.name, batch: inv.batch || 'UNSET', qty: unitsToAdd, qtyIn: unitsToAdd, stockBefore, stockAfter, organizationId: user.organization_id, validationResult: 'allowed', mode: stockHandling.mode });
                await saveData('inventory', { ...inv, stock: stockAfter }, user, true);
            }
        }

        await syncSalesReturnLedger(sr, user);
        return res;
    };

    export const addPurchaseReturn = async (pr: PurchaseReturn, user: RegisteredPharmacy) => {
        const cfgRows = await getData('configurations', [{ organization_id: user.organization_id }], user) as AppConfigurations[];
        const stockHandling = resolveStockHandlingConfig(cfgRows?.[0]);

        // idb.get is a no-op (IDB disabled), so use the memoryCache-backed
        // inventory list for lookups — otherwise validation always passes and
        // the deduction loop silently skips every item.
        const currentInventory = await fetchInventory(user);
        const inventoryById = new Map(currentInventory.map((inv) => [inv.id, inv]));

        // Strict stock validation BEFORE persisting return voucher (transaction-safe behavior).
        for (const item of pr.items || []) {
            if (!item.inventoryItemId) continue;
            const inv = inventoryById.get(item.inventoryItemId);
            if (!inv) continue;
            const unitsToDeduct = Number(item.returnQuantity || 0);
            const stockBefore = Number(inv.stock || 0);
            if (stockHandling.mode === 'strict' && stockBefore < unitsToDeduct) {
                logStockMovement({ transactionType: 'purchase-return-outward-validation', voucherId: pr.id, item: inv.name, batch: inv.batch || 'UNSET', qty: unitsToDeduct, qtyOut: unitsToDeduct, stockBefore, stockAfter: stockBefore, organizationId: user.organization_id, validationResult: 'blocked', mode: stockHandling.mode });
                throw new Error('Insufficient stock. Billing not allowed because Strict Stock Enforcement is enabled.');
            }
        }

        const res = await saveData('purchase_returns', pr, user);

        // Update stock: Purchase Return means items are going OUT of inventory
        for (const item of pr.items || []) {
            if (!item.inventoryItemId) continue;
            const inv = inventoryById.get(item.inventoryItemId);
            if (inv) {
                // Purchase returnQuantity in UI is already in TOTAL UNITS (calculated in buildPurchaseReturnItems)
                const unitsToDeduct = Number(item.returnQuantity || 0);
                const stockBefore = Number(inv.stock || 0);

                if (stockHandling.mode === 'strict' && stockBefore < unitsToDeduct) {
                    logStockMovement({ transactionType: 'purchase-return-outward-validation', voucherId: pr.id, item: inv.name, batch: inv.batch || 'UNSET', qty: unitsToDeduct, qtyOut: unitsToDeduct, stockBefore, stockAfter: stockBefore, organizationId: user.organization_id, validationResult: 'blocked', mode: stockHandling.mode });
                    throw new Error('Insufficient stock. Billing not allowed because Strict Stock Enforcement is enabled.');
                }

                const stockAfter = stockBefore - unitsToDeduct;
                logStockMovement({ transactionType: 'purchase-return-outward', voucherId: pr.id, item: inv.name, batch: inv.batch || 'UNSET', qty: unitsToDeduct, qtyOut: unitsToDeduct, stockBefore, stockAfter, organizationId: user.organization_id, validationResult: 'allowed', mode: stockHandling.mode });
                await saveData('inventory', { ...inv, stock: stockAfter }, user, true);
            }
        }

        await syncPurchaseReturnLedger(pr, user);
        return res;
    };

    type ManualSalesPostingInput = {
        voucherId: string;
        voucherDate: string;
        paymentMode: string;
        grandTotal: number;
        taxableValue: number;
        taxAmount: number;
        discountAmount: number;
        salesGlId: string;
        taxGlId?: string;
        discountGlId?: string;
        customerControlGlId: string;
        narration?: string;
    };

    export const postManualSalesVoucher = async (args: ManualSalesPostingInput, user: RegisteredPharmacy): Promise<void> => {
        const postingContext = await ensurePostingContext({}, user);

        let defaultCustomerGlId: string | undefined;
        try {
            const sobRows = await sqliteDb.select<{ default_customer_gl_id: string }>(
                `SELECT default_customer_gl_id FROM ${SCHEMA_TABLE.SET_OF_BOOKS} WHERE organization_id = ? AND id = ? LIMIT 1`,
                [user.organization_id, postingContext.setOfBooksId]
            );
            if (sobRows && sobRows.length > 0) {
                defaultCustomerGlId = sobRows[0].default_customer_gl_id;
            }
        } catch (err) {
            console.warn('[postManualSalesVoucher] SQLite query for set_of_books failed:', err);
        }

        if (!defaultCustomerGlId && navigator.onLine) {
            try {
                const { data } = await supabase
                    .from('set_of_books')
                    .select('default_customer_gl_id')
                    .eq('organization_id', user.organization_id)
                    .eq('id', postingContext.setOfBooksId)
                    .single();
                defaultCustomerGlId = data?.default_customer_gl_id;
            } catch (err) {
                console.warn('[postManualSalesVoucher] Supabase query for set_of_books failed:', err);
            }
        }

        const receivableGl = args.customerControlGlId || defaultCustomerGlId;
        if (!receivableGl) {
            throw new Error('Customer/Receivable GL is not configured for default set of books.');
        }

        let cashGlId: string | undefined;
        try {
            const rows = await sqliteDb.select<{ id: string }>(
                `SELECT id FROM ${SCHEMA_TABLE.GL_MASTER} WHERE organization_id = ? AND set_of_books_id = ? AND gl_code = ? LIMIT 1`,
                [user.organization_id, postingContext.setOfBooksId, '100001']
            );
            if (rows && rows.length > 0) {
                cashGlId = rows[0].id;
            }
        } catch (err) {
            console.warn('[postManualSalesVoucher] SQLite query for gl_master failed:', err);
        }

        if (!cashGlId && navigator.onLine) {
            try {
                const { data } = await supabase
                    .from('gl_master')
                    .select('id, gl_code')
                    .eq('organization_id', user.organization_id)
                    .eq('set_of_books_id', postingContext.setOfBooksId)
                    .eq('gl_code', '100001')
                    .limit(1);
                cashGlId = data?.[0]?.id;
            } catch (err) {
                console.warn('[postManualSalesVoucher] Supabase query for gl_master failed:', err);
            }
        }

        const cashGlRows = cashGlId ? [{ id: cashGlId }] : [];

        const isImmediatePayment = ['cash', 'card', 'upi', 'bank'].includes(String(args.paymentMode || '').toLowerCase());
        const linkedBankGlId = isImmediatePayment ? await resolveLinkedBankGlId(user, postingContext.companyCodeId) : null;
        const debitGlId = isImmediatePayment ? String(linkedBankGlId || cashGlRows?.[0]?.id || receivableGl) : String(receivableGl);

        const lineAcc = new Map<string, { debit: number; credit: number; memo: string }>();
        const addLine = (glId: string, debit: number, credit: number, memo: string) => {
            const cur = lineAcc.get(glId) || { debit: 0, credit: 0, memo };
            cur.debit += Number(debit || 0);
            cur.credit += Number(credit || 0);
            lineAcc.set(glId, cur);
        };

        addLine(debitGlId, Number(args.grandTotal || 0), 0, isImmediatePayment ? 'Cash/Bank collection' : 'Customer receivable');
        addLine(String(args.salesGlId), 0, Number(args.taxableValue || 0), 'Manual sales income');
        if (Number(args.taxAmount || 0) > 0 && args.taxGlId) addLine(String(args.taxGlId), 0, Number(args.taxAmount || 0), 'Output tax');
        if (Number(args.discountAmount || 0) > 0 && args.discountGlId) addLine(String(args.discountGlId), Number(args.discountAmount || 0), 0, 'Discount allowed');

        const lines = Array.from(lineAcc.entries()).map(([glId, v]) => ({
            glId,
            debit: Number(v.debit.toFixed(2)),
            credit: Number(v.credit.toFixed(2)),
            memo: v.memo,
        }));

        const totalDebit = Number(lines.reduce((sum, line) => sum + line.debit, 0).toFixed(2));
        const totalCredit = Number(lines.reduce((sum, line) => sum + line.credit, 0).toFixed(2));
        if (Math.abs(totalDebit - totalCredit) > 0.01) {
            throw new Error(`Journal is not balanced. Debit ${totalDebit.toFixed(2)} != Credit ${totalCredit.toFixed(2)}.`);
        }

        await postJournal(user, {
            referenceId: args.voucherId,
            referenceType: 'SALES_BILL',
            documentType: 'SALES',
            documentReference: args.voucherId,
            postingDate: args.voucherDate,
            companyCodeId: postingContext.companyCodeId,
            setOfBooksId: postingContext.setOfBooksId,
            lines: lines.map((line) => ({ ...line, memo: args.narration || line.memo })),
        });

        const existingTx = await idb.get(STORES.SALES_BILL, args.voucherId) as Transaction | undefined;
        if (existingTx) {
            await saveData('sales_bill', { ...existingTx, status: 'completed' }, user);
        }
    };

    export const pushPartnerOrder = async (senderOrgId: string, senderName: string, receiverEmail: string, payload: any, senderPoId: string) => {
        if (navigator.onLine) {
            const { error } = await supabase.from('partner_orders').insert({ sender_org_id: senderOrgId, sender_name: senderName, receiver_email: receiverEmail, payload, sender_po_id: senderPoId, status: 'pending' });
            if (error) throw error;
        }
    };

    const latestSyncPayloadBySession = new Map<string, any>();

    const MOBILE_SYNC_TABLE = 'mobile_purchase_sync';
    const MOBILE_BILL_SYNC_TABLE = 'mobile_bill_sync_queue';

    export interface MobileSyncServerBill {
        id: string;
        session_id: string;
        organization_id: string;
        user_id: string;
        device_id: string;
        invoice_id: string;
        payload: any;
        status: 'synced' | 'imported' | 'failed';
        imported_at?: string | null;
        import_error?: string | null;
        created_at?: string;
        updated_at?: string;
    }

    export interface MobileBillSyncRecord {
        id: string;
        session_id: string;
        organization_id: string;
        user_id: string;
        device_id: string;
        status: 'synced' | 'imported' | 'failed';
        payload: any;
        error_message: string | null;
        created_at: string;
        imported_at: string | null;
    }

    export interface SaveMobileBillUploadInput {
        sessionId: string;
        organizationId: string;
        userId: string;
        deviceId: string;
        payload: any;
    }

    export interface FetchMobileBillUploadInput {
        organizationId: string;
        userId: string;
        deviceId: string;
        sessionId?: string | null;
    }

    export const getOrCreateMobileDeviceId = (): string => {
        const key = 'mdxera.mobile.device_id';
        const existing = localStorage.getItem(key);
        if (existing) return existing;
        const next = safeRandomUUID();
        localStorage.setItem(key, next);
        return next;
    };

    const toMobileSyncBill = (row: any): MobileSyncServerBill => ({
        id: String(row.id),
        session_id: String(row.session_id),
        organization_id: String(row.organization_id),
        user_id: String(row.user_id),
        device_id: String(row.device_id),
        invoice_id: String(row.invoice_id),
        payload: row.payload,
        status: row.status,
        imported_at: row.imported_at ?? null,
        import_error: row.import_error ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
    });

    export const createMobileSyncedBill = async (payload: Omit<MobileSyncServerBill, 'id' | 'status' | 'imported_at' | 'import_error' | 'created_at' | 'updated_at'>): Promise<MobileSyncServerBill> => {
        const row = {
            session_id: payload.session_id,
            organization_id: payload.organization_id,
            user_id: payload.user_id,
            device_id: payload.device_id,
            invoice_id: payload.invoice_id,
            payload: payload.payload,
            status: 'synced',
        };

        const { data, error } = await supabase.from(MOBILE_SYNC_TABLE).insert(row).select('*').single();
        if (error) throw error;
        return toMobileSyncBill(data);
    };

    export const fetchPendingMobileBills = async (filters: { organizationId: string; userId: string; deviceId: string; sessionId?: string | null; }): Promise<MobileSyncServerBill[]> => {
        let query = supabase
            .from(MOBILE_SYNC_TABLE)
            .select('*')
            .eq('organization_id', filters.organizationId)
            .eq('user_id', filters.userId)
            .eq('device_id', filters.deviceId)
            .eq('status', 'synced')
            .order('created_at', { ascending: false });

        if (filters.sessionId) {
            query = query.eq('session_id', filters.sessionId);
        }

        const { data, error } = await query;
        if (error) throw error;
        return (data || []).map(toMobileSyncBill);
    };

    export const markMobileBillImported = async (id: string, status: 'imported' | 'failed', importError?: string | null): Promise<void> => {
        const patch: Record<string, any> = {
            status,
            import_error: importError || null,
            updated_at: new Date().toISOString(),
        };
        if (status === 'imported') {
            patch.imported_at = new Date().toISOString();
            patch.import_error = null;
        }

        const { error } = await supabase.from(MOBILE_SYNC_TABLE).update(patch).eq('id', id).neq('status', 'imported');
        if (error) throw error;
    };

    export const broadcastSyncMessage = async (sessionId: string, data: any) => {
        latestSyncPayloadBySession.set(sessionId, data);
        const channel = supabase.channel(`sync:${sessionId}`);
        await channel.subscribe(async (status) => {
            if (status === 'SUBSCRIBED') await channel.send({ type: 'broadcast', event: 'capture', payload: data });
        });
    };

    export const saveMobileBillUpload = async ({
        sessionId,
        organizationId,
        userId,
        deviceId,
        payload,
    }: SaveMobileBillUploadInput): Promise<MobileBillSyncRecord> => {
        const recordPayload = {
            session_id: sessionId,
            organization_id: organizationId,
            user_id: userId,
            device_id: deviceId,
            status: 'synced',
            payload,
            error_message: null,
        };

        const { data, error } = await supabase
            .from(MOBILE_BILL_SYNC_TABLE)
            .insert(recordPayload)
            .select()
            .single();

        if (error) throw error;
        return data as MobileBillSyncRecord;
    };

    export const fetchLatestPendingMobileBillUpload = async ({
        organizationId,
        userId,
        deviceId,
        sessionId,
    }: FetchMobileBillUploadInput): Promise<MobileBillSyncRecord | null> => {
        let query = supabase
            .from(MOBILE_BILL_SYNC_TABLE)
            .select('*')
            .eq('organization_id', organizationId)
            .eq('user_id', userId)
            .eq('device_id', deviceId)
            .eq('status', 'synced')
            .order('created_at', { ascending: false })
            .limit(1);

        if (sessionId) {
            query = query.eq('session_id', sessionId);
        }

        const { data, error } = await query.maybeSingle();
        if (error) throw error;
        return (data as MobileBillSyncRecord | null) ?? null;
    };

    export const markMobileBillUploadImported = async (id: string) => {
        const { data, error } = await supabase
            .from(MOBILE_BILL_SYNC_TABLE)
            .update({ status: 'imported', imported_at: new Date().toISOString(), error_message: null })
            .eq('id', id)
            .eq('status', 'synced')
            .select('id,status,imported_at')
            .maybeSingle();

        if (error) throw error;
        return data;
    };

    export const markMobileBillUploadFailed = async (id: string, errorMessage: string) => {
        const { error } = await supabase
            .from(MOBILE_BILL_SYNC_TABLE)
            .update({ status: 'failed', error_message: errorMessage })
            .eq('id', id);

        if (error) throw error;
    };

    export const listenForSyncMessage = (sessionId: string, callback: (data: any) => void) => {
        return supabase
            .channel(`sync:${sessionId}`)
            .on('broadcast', { event: 'capture' }, ({ payload }) => {
                latestSyncPayloadBySession.set(sessionId, payload);
                callback(payload);
            })
            .subscribe();
    };

    export const getLatestSyncMessage = (sessionId: string) => latestSyncPayloadBySession.get(sessionId) ?? null;

    export const updateSalesChallanStatus = async (id: string, status: SalesChallanStatus, user: RegisteredPharmacy) => {
        const challan = await idb.get(STORES.SALES_CHALLANS, id) as SalesChallan;
        if (challan) await saveData('sales_challans', { ...challan, status }, user);
    };

    export const updateChallanStatus = async (id: string, status: DeliveryChallanStatus, user: RegisteredPharmacy) => {
        const challan = await idb.get(STORES.DELIVERY_CHALLANS, id) as DeliveryChallan;
        if (challan) await saveData('delivery_challans', { ...challan, status }, user);
    };

    export const finalizePhysicalInventorySession = async (session: PhysicalInventorySession, user: RegisteredPharmacy) => {
        const finalized = { 
            ...session, 
            status: PhysicalInventoryStatus.COMPLETED, 
            endDate: new Date().toISOString(),
            performedById: user.user_id,
            performedByName: user.full_name
        };
        
        // 1. Save the session itself
        await saveData('physical_inventory', finalized, user);
        
        // 2. Fetch current state to ensure we have the most recent data (especially if IDB is disabled)
        const currentInventory = await fetchInventory(user);
        const inventoryById = new Map(currentInventory.map(i => [i.id, i]));
        
        // Also fetch medicine master for potential new inventory items (discovery)
        const meds = await fetchMedicineMaster(user);
        const medsById = new Map(meds.map(m => [m.id, m]));

        // Get config for stock movement logging
        const cfgRows = await getData('configurations', [{ organization_id: user.organization_id }], user) as AppConfigurations[];
        const stockHandling = resolveStockHandlingConfig(cfgRows?.[0]);

        // 3. Process each item in the audit
        for (const item of session.items) {
            let invItem: InventoryItem | undefined;
            
            // Try to find existing inventory record
            if (item.inventoryItemId && !item.inventoryItemId.startsWith('mm-')) {
                invItem = inventoryById.get(item.inventoryItemId);
            }
            
            if (invItem) {
                // UPDATE EXISTING
                const stockBefore = Number(invItem.stock || 0);
                const stockAfter = Number(item.physicalCount);
                const variance = stockAfter - stockBefore;
                
                if (variance !== 0) {
                    logStockMovement({ 
                        transactionType: 'stock-audit-adjustment', 
                        voucherId: session.id, 
                        item: invItem.name, 
                        batch: invItem.batch || 'UNSET', 
                        qty: Math.abs(variance), 
                        qtyIn: variance > 0 ? variance : 0,
                        qtyOut: variance < 0 ? Math.abs(variance) : 0,
                        stockBefore, 
                        stockAfter, 
                        organizationId: user.organization_id, 
                        validationResult: 'allowed', 
                        mode: stockHandling.mode 
                    });
                    
                    invItem.stock = stockAfter;
                    await saveData('inventory', invItem, user, true);
                }
            } else if (item.inventoryItemId?.startsWith('mm-')) {
                // CREATE NEW FROM MEDICINE MASTER (DISCOVERY)
                const medId = item.inventoryItemId.replace('mm-', '');
                const med = medsById.get(medId);
                
                if (med && item.physicalCount > 0) {
                    const newInv: Omit<InventoryItem, 'id'> = {
                        organization_id: user.organization_id,
                        name: med.name,
                        brand: med.brand || '',
                        category: med.category || 'Medicine',
                        manufacturer: med.manufacturer || '',
                        stock: item.physicalCount,
                        unitsPerPack: resolveUnitsPerStrip(extractPackMultiplier(med.pack) ?? 1, med.pack),
                        batch: item.batch || 'UNSET',
                        expiry: item.expiry || '',
                        purchasePrice: 0, // Audit usually doesn't provide purchase price for new items
                        mrp: parseFloat(med.mrp || '0'),
                        gstPercent: med.gstRate || 0,
                        hsnCode: med.hsnCode || '',
                        minStockLimit: 10,
                        is_active: true
                    };
                    
                    logStockMovement({ 
                        transactionType: 'stock-audit-new-item', 
                        voucherId: session.id, 
                        item: newInv.name, 
                        batch: newInv.batch, 
                        qty: item.physicalCount, 
                        qtyIn: item.physicalCount,
                        stockBefore: 0, 
                        stockAfter: item.physicalCount, 
                        organizationId: user.organization_id, 
                        validationResult: 'allowed', 
                        mode: stockHandling.mode 
                    });
                    
                    await saveData('inventory', newInv, user);
                }
            }
        }
    };
