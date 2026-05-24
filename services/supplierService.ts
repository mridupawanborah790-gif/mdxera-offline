import { supabase } from './supabaseClient';
import { idb, STORES } from './indexedDbService';
import type { Supplier, RegisteredPharmacy } from '../types';
import { generateUUID, toSnake, toCamel } from './storageService';
import { db as sqliteDb } from '../src/core/db/client';
import { TABLE as SQLITE_TABLE } from '../src/core/db/schema';
import { SyncQueue } from '../src/core/sync/SyncQueue';

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
        await SyncQueue.enqueue(
            supplierPayload.id ? 'UPDATE' : 'INSERT',
            SQLITE_TABLE.SUPPLIERS,
            payload.id,
            snake as Record<string, unknown>,
            organizationId
        );
        const saved = toCamel(snake) as Supplier;
        await idb.put(STORES.SUPPLIERS, saved);
        return {
            status: supplierPayload.id ? 'updated' : 'created',
            supplier: saved,
            message: supplierPayload.id ? 'Updated locally — will sync when online' : 'Saved locally — will sync when online',
        };
    }

    const { data, error } = await supabase
        .from('suppliers')
        .upsert(toSnake(payload))
        .select('*')
        .single();

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

    return {
        status: supplierPayload.id ? 'updated' : 'created',
        supplier: saved,
        message: supplierPayload.id ? 'Updated Successfully' : 'Saved Successfully',
    };
};
