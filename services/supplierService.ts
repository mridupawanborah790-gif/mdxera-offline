import { supabase } from './supabaseClient';
import { idb, STORES } from './indexedDbService';
import type { Supplier, RegisteredPharmacy } from '../types';
import { generateUUID, toSnake, toCamel, updateMemoryCacheEntry } from './storageService';
import { db as sqliteDb } from '../src/core/db/client';
import { TABLE as SQLITE_TABLE } from '../src/core/db/schema';
import { SyncQueue } from '../src/core/sync/SyncQueue';
import {
  pushWithDriftLearning,
  stripDriftedColumns,
} from '../src/core/sync/schemaDriftCache';

export type SupplierSaveStatus = 'created' | 'updated' | 'duplicate';

export interface SupplierQuickResult {
    status: SupplierSaveStatus;
    supplier: Supplier;
    message: string;
}

export const formatSupplierApiError = (error: any): string => {
    if (!error) return 'Unknown supplier API error';
    if (typeof error === 'string') return error;

    const parts = [error.message, error.details, error.hint]
        .filter((part) => typeof part === 'string' && part.trim().length > 0)
        .map((part) => part.trim());

    if (parts.length > 0) return parts.join(' | ');
    return String(error);
};

type SupplierPayload = Partial<Supplier> & { id?: string; name: string };

const normalize = (value?: string | null) => (value || '').trim().toLowerCase();
const normalizeAlphaNum = (value?: string | null) => (value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();

export const findDuplicateSupplier = (suppliers: Supplier[], payload: SupplierPayload): Supplier | null => {
    const name = normalize(payload.name);
    const gst = normalizeAlphaNum(payload.gst_number);
    const phone = normalize(payload.phone || payload.mobile);
    const currentId = payload.id || '';

    return suppliers.find((candidate) => {
        if (!candidate || candidate.id === currentId) return false;
        const sameName = !!name && normalize(candidate.name) === name;
        const sameGst = !!gst && normalizeAlphaNum(candidate.gst_number) === gst;
        const candidatePhone = normalize(candidate.phone || candidate.mobile);
        const samePhone = !!phone && candidatePhone === phone;
        return sameName || sameGst || samePhone;
    }) || null;
};

export const createSupplierQuick = async (
    organizationId: string,
    supplierPayload: SupplierPayload,
    context: {
        currentUser: RegisteredPharmacy;
        existingSuppliers?: Supplier[];
        defaultControlGlId?: string;
        isUpdate?: boolean;
    }
): Promise<SupplierQuickResult> => {
    if (!organizationId) throw new Error('Organization is required to create supplier.');
    const name = (supplierPayload.name || '').trim();
    if (!name) throw new Error('Supplier Name is required.');

    const duplicate = findDuplicateSupplier(context.existingSuppliers || [], supplierPayload);
    if (duplicate) {
        return { status: 'duplicate', supplier: duplicate, message: 'Supplier already exists' };
    }

    const now = new Date().toISOString();
    const payload: any = {
        ...supplierPayload,
        id: supplierPayload.id || generateUUID(),
        organization_id: organizationId,
        user_id: context.currentUser.user_id || context.currentUser.id,
        name,
        supplier_group: supplierPayload.supplier_group || 'Sundry Creditors',
        control_gl_id: supplierPayload.control_gl_id || context.defaultControlGlId || '',
        updated_at: now,
    };

    if (!supplierPayload.id) payload.created_at = now;

    // OFFLINE-FIRST: when offline, write to local SQLite + IndexedDB and queue
    // the Supabase upsert for the SyncEngine to flush later.
    if (!navigator.onLine) {
        const snake = toSnake(payload);
        try {
            await sqliteDb.upsert(SQLITE_TABLE.SUPPLIERS, snake as Record<string, unknown>);
        } catch (e) {
            console.warn('[createSupplierQuick offline] sqlite upsert failed', e);
        }
        // Pre-strip the queued payload of columns we already know are missing
        // on this org's Supabase. SyncWorker would catch it anyway via its
        // own retry-on-PGRST204 loop, but stripping at enqueue-time skips a
        // server round-trip (and the resulting warning in the StatusBar).
        const queuedPayload = stripDriftedColumns(SQLITE_TABLE.SUPPLIERS, snake as Record<string, unknown>);
        await SyncQueue.enqueue(
            supplierPayload.id ? 'UPDATE' : 'INSERT',
            SQLITE_TABLE.SUPPLIERS,
            payload.id,
            queuedPayload,
            organizationId
        );
        const saved = toCamel(snake) as Supplier;
        await idb.put(STORES.SUPPLIERS, saved);
        // Mirror into the legacy memoryCache so the next loadData('background')
        // sees the updated row instead of reverting React state to the
        // pre-edit value. Without this, an offline edit "disappears" from
        // the UI as soon as App.tsx re-runs loadData.
        updateMemoryCacheEntry('suppliers', saved, organizationId);
        return {
            status: supplierPayload.id ? 'updated' : 'created',
            supplier: saved,
            message: supplierPayload.id ? 'Updated locally — will sync when online' : 'Saved locally — will sync when online',
        };
    }

    // Strip control_gl_id before pushing — the auto_map_party_control_gl
    // trigger on public.suppliers resolves it from supplier_group and rejects
    // any client-supplied value that doesn't match (raises P0001
    // "Control GL is auto-mapped from group and cannot be manually edited").
    // The local row keeps its control_gl_id; SyncPuller refreshes it with the
    // server's value on the next delta cycle.
    const remotePayload = toSnake(payload) as Record<string, unknown>;
    delete remotePayload.control_gl_id;
    delete remotePayload.controlGlId;

    // Wrap in pushWithDriftLearning so PGRST204 from a column the deployed
    // Supabase doesn't have (e.g. brand_agencies on an older schema) is
    // auto-learned and the row is retried instantly. Same mechanism the
    // SyncWorker uses for queued pushes — keeps online and offline flows
    // converging on the same set of accepted columns.
    const { data, error } = await pushWithDriftLearning<Record<string, unknown>>(
        'suppliers',
        remotePayload,
        async (filtered) => {
            const result = await supabase
                .from('suppliers')
                .upsert(filtered as Record<string, unknown>)
                .select('*')
                .single();
            return { data: result.data as Record<string, unknown> | null, error: result.error };
        },
    );

    if (error) throw new Error(formatSupplierApiError(error));

    const saved = toCamel(data) as Supplier;

    // Sync with local IndexedDB immediately to prevent stale data reverts during background reload
    await idb.put(STORES.SUPPLIERS, saved);
    // Mirror to SQLite so the next offline read sees the new/updated row.
    try {
        await sqliteDb.upsert(SQLITE_TABLE.SUPPLIERS, toSnake(payload) as Record<string, unknown>);
    } catch (e) {
        console.warn('[createSupplierQuick online] sqlite mirror failed', e);
    }
    // Mirror into the legacy memoryCache so the App.tsx setSuppliers update
    // isn't overwritten by the loadData('background') re-read that follows.
    // See storageService.updateMemoryCacheEntry for the full explanation.
    updateMemoryCacheEntry('suppliers', saved, organizationId);

    return {
        status: supplierPayload.id ? 'updated' : 'created',
        supplier: saved,
        message: supplierPayload.id ? 'Updated Successfully' : 'Saved Successfully',
    };
};
