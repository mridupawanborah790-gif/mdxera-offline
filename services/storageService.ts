    import { supabase } from './supabaseClient';
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

    export const generateUUID = () => crypto.randomUUID();

    // Memory cache to fallback when IndexedDB is disabled
    const memoryCache: Record<string, any[]> = {};
    const memoryCacheOrgScope: Record<string, string> = {};

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
    const localHighest = await getHighestLocalDoctorCode(organizationId);
    let remoteHighest = DOCTOR_CODE_START - 1;

    if (navigator.onLine) {
        try {
            remoteHighest = await getHighestRemoteDoctorCode(organizationId);
        } catch { }
    }

    const next = Math.max(localHighest, remoteHighest) + 1;
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
        const localRows = await idb.getAll(STORES.MATERIAL_MASTER);
        return localRows.reduce((max, row) => {
            if (row?.organization_id !== organizationId) return max;
            const parsed = parseMaterialCodeNumber(row?.materialCode);
            return parsed !== null && parsed > max ? parsed : max;
        }, MATERIAL_CODE_START - 1);
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
        const localHighest = await getHighestLocalMaterialCode(organizationId);
        let remoteHighest = MATERIAL_CODE_START - 1;

        if (navigator.onLine) {
            try {
                remoteHighest = await getHighestRemoteMaterialCode(organizationId);
            } catch {
                // Fallback to local sequence when remote read fails.
            }
        }

        const next = Math.max(localHighest, remoteHighest) + 1;
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

    const CUSTOMERS_ALLOWED_FIELDS = [
        'id', 'organization_id', 'user_id', 'created_by_id',
        'name', 'customerType', 'phone', 'mobile', 'email',
        'address', 'address_line1', 'address_line2', 'area', 'city', 'pincode', 'district', 'state', 'country',
        'gstNumber', 'gst_number', 'drugLicense', 'drug_license', 'panNumber', 'pan_number',
        'ledger', 'defaultDiscount', 'default_discount', 'defaultRateTier', 'default_rate_tier', 'is_active', 'is_blocked',
        'assignedStaffId', 'assigned_staff_id', 'assignedStaffName', 'assigned_staff_name', 'opening_balance', 'customerGroup', 'customer_group', 'controlGlId', 'control_gl_id',
        'creditLimit', 'credit_limit', 'creditDays', 'credit_days', 'creditStatus', 'credit_status', 'creditControlMode', 'credit_control_mode', 
        'allowOverride', 'allow_override', 'overrideApprovalRequired', 'override_approval_required', 'enableCreditLimit', 'enable_credit_limit',
        'remarks', 'referredBy', 'referred_by', 'currentBalance', 'current_balance', 'paymentTerms', 'payment_terms', 'createdAt', 'updatedAt'
    ];

    const SUPPLIERS_ALLOWED_FIELDS = [
        'id', 'organization_id', 'user_id', 'created_by_id',
        'name', 'brandAgencies', 'category', 'contactPerson',
        'phone', 'mobile', 'email', 'website',
        'address', 'address_line1', 'address_line2', 'area', 'city', 'pincode', 'district', 'state', 'country',
        'gstNumber', 'panNumber', 'drugLicense', 'foodLicense', 'tanNumber', 'paymentDetails',
        'opening_balance', 'supplierGroup', 'controlGlId', 'currentBalance', 'ledger',
        'is_active', 'is_blocked', 'remarks', 'createdAt', 'updatedAt'
    ];

    const isValidUuid = (value: any): boolean => 
        typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

    // Standardize Primary Keys to 'id' for all tables.
    // This aligns with the migration_proper_fix.sql and avoids collisions with Owner IDs.
    const UUID_PK_TABLES: string[] = [];
    const TEXT_PK_TABLES = ['sales_returns', 'purchase_returns'];
    
    // Tables that track ownership via created_by_id (Auth UUID)
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

        // Remove internal sync metadata — never send to DB
        delete sanitized.sync_status;
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
                'retailer_gstin', 'dl_valid_to', 'food_license', 
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
                'retailer_gstin', 'dl_valid_to', 'food_license', 
                'bank_account_name', 'bank_account_number', 'bank_ifsc_code', 
                'bank_upi_id', 'authorized_signatory', 'pharmacy_logo_url', 'dashboard_logo_url', 
                'terms_and_conditions', 'purchase_order_terms', 'organization_type', 'subscription_plan', 
                'subscription_status', 'subscription_id', 'is_active', 'is_blocked'
            ];
            
            const skipValueConversionKeys = ['master_shortcuts', 'masterShortcuts', 'master_shortcut_order', 'masterShortcutOrder'];
            
            let snakeKey = preservedKeys.includes(key) ? key : key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
            
            acc[snakeKey] = (preservedKeys.includes(key) || skipValueConversionKeys.includes(key))
                ? obj[key]
                : toSnake(obj[key]);
                
            return acc;
        }, {} as any);
    };

    const isNetworkError = (error: any): boolean => {
        if (!navigator.onLine) return true;
        const msg = error?.message?.toLowerCase() || '';
        return (
            msg.includes('fetch') ||
            msg.includes('network') ||
            msg.includes('timeout') ||
            msg.includes('failed to connect') ||
            error?.code === 'PGRST301' || 
            error?.status === 0 ||
            error?.status === 502 || 
            error?.status === 503 || 
            error?.status === 504    
        );
    };

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
        
        if (navigator.onLine) {
            try {
                const remotePayload = getSupabasePayload(tableName, dbPayload);
                const snakeData = toSnake(remotePayload);
                
                if (tableName === 'configurations') {
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
                        const { data: saved, error } = await supabase.from(tableName).insert(snakeData).select().single();
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
                            dbPayload.materialCode = await getNextMaterialCode(user.organization_id);
                            snakeData.material_code = dbPayload.materialCode;
                        } else if (tableName === 'doctor_master') {
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
                    const onConflictColumn = tableName === 'physical_inventory' ? 'voucher_no' : 'id';
                    const { data: saved, error } = await supabase.from(tableName).upsert(snakeData, { onConflict: onConflictColumn }).select().single();
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

                return syncedData;
            } catch (e: any) {
                if (isNetworkError(e)) {
                    console.warn(`Supabase sync failed for ${tableName} due to network, local copy preserved as pending.`, e);
                    dbPayload.sync_status = 'pending';
                    await idb.put(STORES[tableName.toUpperCase() as keyof typeof STORES], dbPayload);
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

    export const deleteData = async (tableName: string, id: string): Promise<void> => {
        const storeKey = tableName.toUpperCase() as keyof typeof STORES;
        await idb.delete(STORES[storeKey], id);
        if (navigator.onLine) {
            await supabase.from(tableName).delete().eq('id', id);
        }
    };

    export const fetchInventory = (user: RegisteredPharmacy) => getData('inventory', [], user);
    export const fetchMedicineMaster = (user: RegisteredPharmacy) => getData('material_master', [], user);
    export const fetchTransactions = (user: RegisteredPharmacy) => getData('sales_bill', [], user);
    export const fetchPurchases = (user: RegisteredPharmacy) => getData('purchases', [], user);
    export const fetchSuppliers = (user: RegisteredPharmacy) => getData('suppliers', [], user);
    export const fetchCustomers = (user: RegisteredPharmacy) => getData('customers', [], user);
    export const fetchPurchaseOrders = (user: RegisteredPharmacy) => getData('purchase_orders', [], user);
    export const fetchTeamMembers = (user: RegisteredPharmacy) => getData('team_members', [], user);
    export const fetchSupplierProductMaps = (user: RegisteredPharmacy) => getData('supplier_product_map', [], user);
    export const fetchCustomerPriceList = (user: RegisteredPharmacy) => getData('customer_price_list', [], user);

    export const fetchDoctors = async (user: RegisteredPharmacy): Promise<DoctorMaster[]> => {
        const data = await getData('doctor_master', [], user);
        return (data || []).sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''));
    };

    // Added missing fetchPhysicalInventory function
    export const fetchPhysicalInventory = (user: RegisteredPharmacy) => getData('physical_inventory', [], user);

    // Added missing fetchEWayBills function
    export const fetchEWayBills = (user: RegisteredPharmacy) => getData('ewaybills', [], user);

    export type VoucherDocumentType =
        | 'sales-gst'
        | 'sales-non-gst'
        | 'purchase-entry'
        | 'purchase-order'
        | 'sales-challan'
        | 'delivery-challan'
        | 'physical-inventory';

    interface VoucherReservationResult {
        documentNumber: string;
        usedNumber: number;
        nextNumber: number;
        remainingCount: number | null;
    }

    const getVoucherConfigKey = (docType: VoucherDocumentType): keyof AppConfigurations => {
        switch (docType) {
            case 'sales-gst':
                return 'invoiceConfig';
            case 'sales-non-gst':
                return 'nonGstInvoiceConfig';
            case 'purchase-entry':
                return 'purchaseConfig';
            case 'purchase-order':
                return 'purchaseOrderConfig';
            case 'sales-challan':
                return 'salesChallanConfig';
            case 'delivery-challan':
                return 'deliveryChallanConfig';
            case 'physical-inventory':
                return 'physicalInventoryConfig';
            default:
                return 'invoiceConfig';
        }
    };


    export const reserveVoucherNumber = async (
        docType: VoucherDocumentType, 
        user: RegisteredPharmacy,
        isPreview: boolean = false
    ): Promise<VoucherReservationResult> => {
        const { data, error } = await supabase.rpc('reserve_voucher_number', {
            p_organization_id: user.organization_id,
            p_document_type: docType,
            p_is_preview: isPreview
        });

        if (error) {
            throw new Error(parseNetworkAndApiError(error));
        }

        const payload = Array.isArray(data) ? data[0] : data;
        if (!payload?.success) {
            throw new Error(payload?.message || 'Unable to reserve voucher number.');
        }

        return {
            documentNumber: payload.document_number,
            usedNumber: payload.used_number,
            nextNumber: payload.next_number,
            remainingCount: payload.remaining_count ?? null
        };
    };

    export const markVoucherCancelled = async (
        docType: VoucherDocumentType,
        user: RegisteredPharmacy,
        documentNumber: string,
        referenceId?: string
    ): Promise<void> => {
        // Attempt to REVERT the counter if this was the latest generated number.
        // This prevents gaps if a user creates and immediately discards an audit/bill.
        const { error } = await supabase.rpc('revert_voucher_number', {
            p_organization_id: user.organization_id,
            p_document_type: docType,
            p_document_number: documentNumber
        });

        if (error) {
            console.warn('Voucher revert failed (likely not the latest in sequence), falling back to audit log:', error);
            // Fallback: Just log it as cancelled without reverting the counter
            await supabase.rpc('log_voucher_number_event', {
                p_organization_id: user.organization_id,
                p_document_type: docType,
                p_event_type: 'cancelled',
                p_document_number: documentNumber,
                p_reference_id: referenceId || null,
            });
        }
    };

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

    export const getData = async (tableName: string, defaultValue: any[] = [], user: RegisteredPharmacy | null): Promise<any[]> => {
        if (!user) return defaultValue;
        const storeKey = tableName.toUpperCase() as keyof typeof STORES;
        
        // Priority 1: Check Memory Cache (for when IDB is disabled or during same session)
        if (
            memoryCacheOrgScope[storeKey] === user.organization_id &&
            memoryCache[storeKey] &&
            memoryCache[storeKey].length > 0
        ) {
            return memoryCache[storeKey];
        }

        // Priority 2: Local IndexedDB for instant UI
        const cached = await idb.getAll(STORES[storeKey]);

        // If we found data in IDB, populate memory cache to keep them in sync
        if (cached && cached.length > 0) {
            memoryCache[storeKey] = [...cached];
            memoryCacheOrgScope[storeKey] = user.organization_id;
        }

        // Priority 2: Fetch updates in background if online
        if (navigator.onLine) {
            if (cached.length === 0) {
                try {
                    const allData = await fetchAllPagesFromSupabase(tableName, user.organization_id);
                    if (allData.length > 0) {
                        const normalized = allData.map(d => fromSupabase(tableName, d));
                        
                        // Always update memory cache so the session stays consistent
                        memoryCache[storeKey] = [...normalized];
                        memoryCacheOrgScope[storeKey] = user.organization_id;
                        
                        await idb.putBulk(STORES[storeKey], normalized);
                        return normalized;
                    }
                } catch (e) {
                    console.error(`Initial fetch failed for ${tableName}:`, e);
                }
            } else {
                setTimeout(async () => {
                    try {
                        const allData = await fetchAllPagesFromSupabase(tableName, user.organization_id);
                        if (allData.length > 0) {
                            const normalized = allData.map(d => fromSupabase(tableName, d));
                            
                            // Always update memory cache so the session stays consistent
                            memoryCache[storeKey] = [...normalized];
                            memoryCacheOrgScope[storeKey] = user.organization_id;
                            
                            await idb.putBulk(STORES[storeKey], normalized);
                        }
                    } catch (e) {
                        console.error(`Background fetch failed for ${tableName}:`, e);
                    }
                }, 0);
            }
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

        const { data: glRows } = await supabase
            .from('gl_master')
            .select('gl_code')
            .eq('organization_id', organizationId)
            .eq('set_of_books_id', setOfBooksId)
            .in('gl_code', requiredCodes);
        const foundCodes = new Set((glRows || []).map(r => String(r.gl_code)));
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

        // Posting Context and Accounting validation - only for COMPLETED bills
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
                        clearTableMemoryCache('INVENTORY');
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
                clearTableMemoryCache('INVENTORY');

                if (navigator.onLine) {
                    try {
                        const remotePayload = updatedInventory.map(inv => toSnake(getSupabasePayload('inventory', inv)));
                        const { error } = await supabase.from('inventory').upsert(remotePayload);
                        if (error) throw error;
                    } catch (e) {
                        console.warn('Supabase batch inventory sync failed after sales transaction, local copy preserved.', e);
                    }
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
        // Posting Context and Accounting validation - only for COMPLETED bills
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
        await syncPurchaseLedger(p, user);
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
            await syncPurchaseLedger(p, user);
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

        await syncPurchaseLedger(p, user);
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

    export const login = async (email: string, pass: string): Promise<RegisteredPharmacy> => {
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password: pass });
        if (authError) throw authError;
        const { data: profile } = await supabase.from('profiles').select('*').eq('user_id', authData.user!.id).single();
        if (!profile) throw new Error("Profile not found.");
        const normalized = toCamel(profile);
        if (!normalized.id) normalized.id = normalized.user_id;
        await idb.put(STORES.PROFILES, normalized);
        return normalized;
    };

    export const signup = async (email: string, pass: string, fullName: string, pharmacyName: string): Promise<RegisteredPharmacy> => {
        const orgId = generateUUID();
        const { data: authData, error: authError } = await supabase.auth.signUp({ email, password: pass, options: { data: { full_name: fullName, pharmacy_name: pharmacyName, role: 'owner', organization_id: orgId } } });
        if (authError) throw authError;
        const profile = { user_id: authData.user!.id, organization_id: orgId, email, full_name: fullName, pharmacy_name: pharmacyName, role: 'owner', is_active: true };
        await supabase.from('profiles').insert(toSnake(profile));
        const user = { ...profile, id: profile.user_id } as unknown as RegisteredPharmacy;
        await idb.put(STORES.PROFILES, user);
        return user;
    };

    export const clearCurrentUser = async () => {
        await supabase.auth.signOut();
        await idb.clearAllStores();
    };

    export const requestPasswordReset = async (email: string) => {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: `${window.location.origin}/`,
        });
        if (error) throw error;
    };

    export const verifyRecoveryToken = async (email: string, token: string) => {
        const cleanToken = token.trim();
        const isOtp = /^\d{6}$/.test(cleanToken);
        
        if (isOtp) {
            const { error } = await supabase.auth.verifyOtp({
                email,
                token: cleanToken,
                type: 'recovery',
            });
            if (error) throw error;
        } else {
            const { error } = await supabase.auth.verifyOtp({
                token_hash: cleanToken,
                type: 'recovery',
            });
            if (error) throw error;
        }
    };

    export const updatePassword = async (newPassword: string) => {
        const { error } = await supabase.auth.updateUser({ password: newPassword });
        if (error) throw error;
    };

    export const getCurrentUser = async (): Promise<RegisteredPharmacy | null> => {
        // 1. Get fresh session from Supabase to verify true authentication state
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.user) {
            // Clear stale local profile cache if no auth session exists
            await idb.clearAllStores();
            return null;
        }

        const userId = session.user.id;

        // 2. Try to fetch fresh profile from network first if online
        if (navigator.onLine) {
            try {
                const freshProfile = await fetchProfile(userId);
                if (freshProfile) return freshProfile;
            } catch (err) {
                console.warn('Failed to fetch fresh profile during app initialization:', err);
            }
        }

        // 3. Fallback to cached profile specifically for this user
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
        const newMember: OrganizationMember = {
            id,
            email,
            name,
            role,
            status: 'active',
            isLocked: false,
            passwordLocked: false,
            ...extra,
            assignedRoles: extra?.assignedRoles || [],
        };
        await idb.put(STORES.TEAM_MEMBERS, { ...newMember, organization_id });
        if (navigator.onLine) await supabase.from('team_members').upsert(toSnake({ ...newMember, organization_id }));
    };

    export const updateMemberRole = async (memberId: string, newRole: UserRole) => {
        const member = await idb.get(STORES.TEAM_MEMBERS, memberId) as OrganizationMember;
        if (member) {
            member.role = newRole;
            await idb.put(STORES.TEAM_MEMBERS, member);
        }
        if (navigator.onLine) await supabase.from('team_members').update({ role: newRole }).eq('id', memberId);
    };

    export const removeTeamMember = async (memberId: string) => {
        await idb.delete(STORES.TEAM_MEMBERS, memberId);
        if (navigator.onLine) await supabase.from('team_members').delete().eq('id', memberId);
    };

    export const addLedgerEntry = async (entry: TransactionLedgerItem, owner: { type: 'customer' | 'supplier' | 'distributor', id: string }, user: RegisteredPharmacy) => {
        const type = owner.type === 'distributor' ? 'supplier' : owner.type;
        const tableName = type === 'customer' ? 'customers' : 'suppliers';
        
        const entity = await getDataById<Customer | Supplier>(tableName, owner.id, user);

        if (!entity) throw new Error(`${type} not found`);
        const ledger = Array.isArray(entity.ledger) ? [...entity.ledger] : [];
        const prevBalance = ledger.length > 0 ? Number(ledger[ledger.length - 1].balance || 0) : Number(entity.opening_balance || 0);
        const newBalance = prevBalance + Number(entry.debit || 0) - Number(entry.credit || 0);
        entity.ledger = [...ledger, { ...entry, balance: newBalance }];
        return await saveData(tableName, entity, user, true);
    };



export const fetchBankMasters = async (user: RegisteredPharmacy): Promise<Array<{ id: string; bankName: string; accountName: string; accountNumber: string; accountType?: string; linkedBankGlId?: string; defaultBank?: boolean; activeStatus?: string }>> => {
        if (!navigator.onLine) return [];
        const { data, error } = await supabase
            .from('bank_master')
            .select('*')
            .eq('organization_id', user.organization_id)
            .order('created_at', { ascending: true });
        if (error) throw error;

        return (data || [])
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
        let customer = await idb.get(STORES.CUSTOMERS, args.customerId) as Customer | undefined;

        // Fallback to Supabase if local fetch fails (e.g. IndexedDB disabled)
        if (!customer && navigator.onLine) {
            const { data, error } = await supabase
                .from('customers')
                .select('*')
                .eq('organization_id', user.organization_id)
                .eq('id', args.customerId)
                .maybeSingle();
            if (data) {
                customer = fromSupabase('customers', data) as Customer;
            }
        }

        if (!customer) throw new Error('Customer not found');

        if (!navigator.onLine) throw new Error('Payment posting with accounting requires online mode.');
        const isCashMode = String(args.paymentMode || '').trim().toLowerCase() === 'cash';
        let bank: any = null;
        if (args.bankAccountId) {
            const { data: bankRow, error: bankErr } = await supabase
                .from('bank_master')
                .select('*')
                .eq('organization_id', user.organization_id)
                .eq('id', args.bankAccountId)
                .maybeSingle();
            if (bankErr) throw bankErr;
            if (!bankRow) throw new Error('Selected bank / cash account not found');
            bank = bankRow;
        }
        if (!isCashMode && !bank) throw new Error('Selected bank / cash account not found');

        const postingContext = await loadDefaultPostingContext(user.organization_id);
        const companyCodeId = postingContext.companyCodeId;
        const setOfBooksId = postingContext.setOfBooksId;

        let journalEntryId: string | undefined;
        let journalEntryNumber: string | undefined;
        let receiptAccountName = bank?.bankName || bank?.bank_name || (isCashMode ? 'Cash Account' : 'Bank Account');

        if (navigator.onLine) {
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
            let supplier = await idb.get(STORES.SUPPLIERS, args.supplierId as any) as Supplier | undefined;

            // Fallback to Supabase if local fetch fails (e.g. IndexedDB disabled)
            if (!supplier && navigator.onLine) {
                const { data, error } = await supabase
                    .from('suppliers')
                    .select('*')
                    .eq('organization_id', user.organization_id)
                    .eq('id', args.supplierId)
                    .maybeSingle();
                if (data) {
                    supplier = fromSupabase('suppliers', data) as Supplier;
                }
            }

            if (!supplier) {
                const allSuppliers = await idb.getAll(STORES.SUPPLIERS) as Supplier[];
                const targetSupplierId = String(args.supplierId || '').trim().toLowerCase();
                supplier = allSuppliers.find((row) => String(row?.id || '').trim().toLowerCase() === targetSupplierId);
            }
            if (!supplier) throw new Error('Supplier not found');
            const resolvedSupplierId = String(supplier.id);
        if (!navigator.onLine) throw new Error('Payment posting with accounting requires online mode.');
        const isCashMode = String(args.paymentMode || '').trim().toLowerCase() === 'cash';
        let bank: any = null;
        if (!isCashMode) {
            if (!args.bankAccountId) throw new Error('Bank account is required for selected payment mode.');
            const { data: bankRow, error: bankErr } = await supabase
                .from('bank_master')
                .select('*')
                .eq('organization_id', user.organization_id)
                .eq('id', args.bankAccountId)
                .maybeSingle();
            if (bankErr) throw bankErr;
            if (!bankRow) throw new Error('Selected bank account not found');
            bank = bankRow;
        }

        const postingContext = await loadDefaultPostingContext(user.organization_id);
        const companyCodeId = postingContext.companyCodeId;
        const setOfBooksId = postingContext.setOfBooksId;

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
        let payoutAccountName = 'Cash Account';
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

        const ledgerEntryId = generateUUID();
        await addLedgerEntry({
            id: ledgerEntryId,
            date: args.date,
            type: 'payment',
            description: args.description,
            entryCategory: args.entryCategory || 'invoice_payment',
            debit: 0,
            credit: Number(args.amount),
            balance: 0,
            paymentMode: args.paymentMode,
            bankAccountId: isCashMode ? undefined : args.bankAccountId,
            bankName: payoutAccountName,
            referenceInvoiceId: args.referenceInvoiceId,
            referenceInvoiceNumber: args.referenceInvoiceNumber,
            journalEntryId: header.id,
            journalEntryNumber: header.journal_entry_number,
        }, { type: 'supplier', id: resolvedSupplierId }, user);

        return {
            journalEntryId: header.id,
            journalEntryNumber: header.journal_entry_number,
            ledgerEntryId,
        };
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
            if (!entry || entry.status === 'cancelled') return sum;
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
        const normalizedCustomerName = String(customer.name || '').trim().toLowerCase();
        const customerLedger = Array.isArray(customer.ledger) ? customer.ledger : [];
        const adjustedCategories = new Set([
            'invoice_payment_adjustment',
            'down_payment_adjustment',
            'invoice_payment_adjustment_reversal',
            'down_payment_adjustment_reversal',
        ]);
        const resolveAdjustedAmountFromLedger = (invoiceId: string, invoiceNumber?: string): number => {
            const normalizedInvoiceNumber = String(invoiceNumber || '').trim().toLowerCase();
            return customerLedger.reduce((sum, entry) => {
                if (!entry || entry.status === 'cancelled') return sum;
                const entryCategory = String(entry.entryCategory || '');
                if (!adjustedCategories.has(entryCategory)) return sum;
                const referenceId = String(entry.referenceInvoiceId || '').trim();
                const referenceNumber = String(entry.referenceInvoiceNumber || '').trim().toLowerCase();
                const matchesInvoice = referenceId === invoiceId
                    || (normalizedInvoiceNumber && referenceNumber === normalizedInvoiceNumber)
                    || referenceId === normalizedInvoiceRef
                    || referenceNumber === normalizedInvoiceRefLower;
                if (!matchesInvoice) return sum;
                const multiplier = entryCategory.endsWith('_reversal') ? -1 : 1;
                return sum + (Number(entry.adjustedAmount || 0) * multiplier);
            }, 0);
        };
        const resolveLocalInvoice = async (): Promise<number | null> => {
            const localTxns = await idb.getAll(STORES.SALES_BILL) as Transaction[];
            const localMatch = localTxns.find((row) => {
                if (!row || row.status === 'cancelled') return false;
                const belongsToCustomer = row.customerId === customer.id || String(row.customerName || '').trim().toLowerCase() === normalizedCustomerName;
                if (!belongsToCustomer) return false;
                return row.id === normalizedInvoiceRef || String(row.invoiceNumber || '').trim().toLowerCase() === normalizedInvoiceRefLower;
            });
            if (!localMatch) return null;
            const invoiceTotal = Number(localMatch.total || 0);
            const adjustedAmount = resolveAdjustedAmountFromLedger(localMatch.id, localMatch.invoiceNumber);
            const pendingBalance = Number((invoiceTotal - adjustedAmount).toFixed(2));
            if (pendingBalance <= 0) throw new Error('Invoice is already fully settled and cannot receive duplicate payment.');
            return invoiceTotal;
        };

        const localTotal = await resolveLocalInvoice();
        if (localTotal !== null) return localTotal;

        if (navigator.onLine) {
            const { data: invoices } = await supabase
                .from('sales_bill')
                .select('id, invoiceNumber, customerId, customerName, total, status')
                .eq('organization_id', user.organization_id)
                .or(`id.eq.${normalizedInvoiceRef},invoiceNumber.eq.${normalizedInvoiceRef}`);

            const remoteMatch = (invoices || []).find((row: { id?: string; invoiceNumber?: string; customerId?: string; customerName?: string; total?: number; status?: string; }) => {
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
        const localPurchases = await idb.getAll(STORES.PURCHASES) as Purchase[];
        const localMatch = localPurchases.find((row) => row?.id === invoiceId && row?.status !== 'cancelled' && String(row?.supplier || '').trim().toLowerCase() === String(supplier.name || '').trim().toLowerCase());
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

    const sortLedgerEntries = (entries: TransactionLedgerItem[]) => {
        return [...entries].sort((a, b) => {
            const dateDiff = new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime();
            if (dateDiff !== 0) return dateDiff;
            return (a.id || '').localeCompare(b.id || '');
        });
    };

    const recalculateLedger = (entries: TransactionLedgerItem[], openingBalance = 0): TransactionLedgerItem[] => {
        let runningBalance = Number(openingBalance || 0);
        return sortLedgerEntries(entries).map((entry) => {
            runningBalance += Number(entry.debit || 0) - Number(entry.credit || 0);
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

        entity.ledger = recalculateLedger(ledger, Number(entity.opening_balance || 0));
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

        entity.ledger = recalculateLedger(nextLedger, entity.opening_balance || 0);
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
        if (!navigator.onLine) return;

        if (!isValidUuid(args.setOfBooksId) || !isValidUuid(args.companyCodeId) || !isValidUuid(user.organization_id)) {
            console.warn('Skipping journal post: Invalid UUID in posting context', { setOfBooksId: args.setOfBooksId, companyCodeId: args.companyCodeId });
            return;
        }

        const { data: setOfBooks, error: sobError } = await supabase
            .from('set_of_books')
            .select('id, set_of_books_id, company_code_id, default_customer_gl_id, default_supplier_gl_id')
            .eq('organization_id', user.organization_id)
            .eq('id', args.setOfBooksId)
            .single();
        if (sobError || !setOfBooks || setOfBooks.company_code_id !== args.companyCodeId) {
            throw new Error(DEFAULT_CONFIG_MISSING_MESSAGE);
        }

        const glIds = Array.from(new Set(args.lines.map(l => l.glId)));
        const { data: glRows, error: glError } = await supabase
            .from('gl_master')
            .select('id, gl_code, gl_name, set_of_books_id')
            .eq('organization_id', user.organization_id)
            .eq('set_of_books_id', args.setOfBooksId)
            .in('id', glIds);
        if (glError) throw glError;
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

        const { data: companyRow } = await supabase
            .from('company_codes')
            .select('code')
            .eq('id', args.companyCodeId)
            .maybeSingle();

        const { data: header, error: headerError } = await supabase
            .from('journal_entry_header')
            .insert({
                organization_id: user.organization_id,
                journal_entry_number: buildJournalNumber(args.documentType === 'SALES' ? 'SAL' : 'PUR'),
                posting_date: args.postingDate,
                status: 'Posted',
                reference_type: args.referenceType,
                reference_id: args.referenceId,
                reference_document_id: args.referenceId,
                document_type: args.documentType,
                document_reference: args.documentReference,
                company: companyRow?.code || args.companyCodeId,
                company_code_id: args.companyCodeId,
                set_of_books: setOfBooks.set_of_books_id || args.setOfBooksId,
                set_of_books_id: args.setOfBooksId,
                total_debit: totalDebit,
                total_credit: totalCredit,
            })
            .select('id')
            .single();
        if (headerError) throw headerError;

        const { error: lineError } = await supabase
            .from('journal_entry_lines')
            .insert(enrichedLines.map((line, index) => ({
                organization_id: user.organization_id,
                journal_entry_id: header.id,
                reference_document_id: args.referenceId,
                document_type: args.documentType,
                line_number: index + 1,
                gl_code: line.gl_code,
                gl_name: line.gl_name,
                debit: Number(line.debit.toFixed(2)),
                credit: Number(line.credit.toFixed(2)),
                line_memo: line.memo,
            })));
        if (lineError) throw lineError;
    };

    const findCustomerForTransaction = async (tx: Transaction): Promise<Customer | undefined> => {
        const customers = await idb.getAll(STORES.CUSTOMERS) as Customer[];
        if (!tx.customerId) return undefined;
        return customers.find(c => c.id === tx.customerId);
    };

    const findSupplierForPurchase = async (purchase: Purchase): Promise<Supplier | undefined> => {
        const suppliers = await idb.getAll(STORES.SUPPLIERS) as Supplier[];
        const supplierName = (purchase.supplier || '').trim().toLowerCase();
        return suppliers.find(s => (s.name || '').trim().toLowerCase() === supplierName);
    };

    export const syncSalesLedger = async (tx: Transaction, user: RegisteredPharmacy, isUpdate: boolean = false) => {
        const customer = await findCustomerForTransaction(tx);
        const paymentMode = String(tx.paymentMode || '').toLowerCase();
        const isImmediatePayment = ['cash', 'card', 'upi', 'bank'].includes(paymentMode);
        const hasSelectedCustomer = !!(customer && tx.customerId);
        const autoSaleLedgerId = `auto-sale-${tx.id}`;
        const autoPaymentLedgerId = `auto-sale-payment-${tx.id}`;
        const autoAdjustmentLedgerId = `auto-sale-adjustment-${tx.id}`;
        
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

        const postingContext = await ensurePostingContext(tx, user);
        tx.companyCodeId = postingContext.companyCodeId;
        tx.setOfBooksId = postingContext.setOfBooksId;

        const { data: books } = await supabase
            .from('set_of_books')
            .select('default_customer_gl_id')
            .eq('organization_id', user.organization_id)
            .eq('id', tx.setOfBooksId)
            .single();
        const customerControlGl = books?.default_customer_gl_id;
        if (!customerControlGl) throw new Error('GL Assignment missing for Material Type under selected Set of Books. Please configure in Utilities & Setup.');

        const { data: glRows, error: glError } = await supabase
            .from('gl_master')
            .select('id, gl_code')
            .eq('organization_id', user.organization_id)
            .eq('set_of_books_id', tx.setOfBooksId)
            .in('gl_code', ['100001', '400100', '210110', '210120', '210130', '510000']);
        if (glError) throw glError;
        const glByCode = new Map((glRows || []).map((row: any) => [String(row.gl_code), String(row.id)]));

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
        const supplier = await findSupplierForPurchase(purchase);
        
        if (supplier) {
            await upsertAutoLedgerEntry(
                { type: 'supplier', id: supplier.id },
                user,
                {
                    id: `auto-purchase-${purchase.id}`,
                    date: purchase.date,
                    type: 'purchase',
                    description: `Purchase Voucher ${purchase.invoiceNumber || purchase.id}`,
                    debit: Number(purchase.totalAmount || 0),
                    credit: 0,
                },
                purchase.status !== 'cancelled'
            );
        }

        if (purchase.status === 'cancelled') return;


        const postingContext = await ensurePostingContext(purchase, user);
        purchase.companyCodeId = postingContext.companyCodeId;
        purchase.setOfBooksId = postingContext.setOfBooksId;

        if (!isValidUuid(purchase.setOfBooksId) || !isValidUuid(user.organization_id)) {
            console.warn('Skipping purchase ledger sync: Invalid UUID in posting context', { setOfBooksId: purchase.setOfBooksId });
            return;
        }

        const { data: assignments, error: assignmentError } = await supabase
            .from('gl_assignments')
            .select('material_master_type, purchase_gl, tax_gl')
            .eq('organization_id', user.organization_id)
            .eq('set_of_books_id', purchase.setOfBooksId);
        if (assignmentError) throw assignmentError;

        const assignmentByType = new Map((assignments || []).map((a: any) => [a.material_master_type, a]));
        const { data: books } = await supabase
            .from('set_of_books')
            .select('default_supplier_gl_id')
            .eq('organization_id', user.organization_id)
            .eq('id', purchase.setOfBooksId)
            .single();
        const supplierControlGl = books?.default_supplier_gl_id;
        if (!supplierControlGl) throw new Error('GL Assignment missing for Material Type under selected Set of Books. Please configure in Utilities & Setup.');

        const { data: glRows, error: glError } = await supabase
            .from('gl_master')
            .select('id, gl_code')
            .eq('organization_id', user.organization_id)
            .eq('set_of_books_id', purchase.setOfBooksId)
            .in('gl_code', ['510000']);
        if (glError) throw glError;
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
        const customers = await idb.getAll(STORES.CUSTOMERS) as Customer[];
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
        const suppliers = await idb.getAll(STORES.SUPPLIERS) as Supplier[];
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
                debit: 0,
                credit: Number(purchaseReturn.totalValue || 0),
            },
            true
        );
    };

    export const addSalesReturn = async (sr: SalesReturn, user: RegisteredPharmacy) => {
        const cfgRows = await getData('configurations', [{ organization_id: user.organization_id }], user) as AppConfigurations[];
        const stockHandling = resolveStockHandlingConfig(cfgRows?.[0]);
        const res = await saveData('sales_returns', sr, user);
        
        // Update stock: Sales Return means items are coming BACK to inventory
        for (const item of sr.items || []) {
            if (!item.inventoryItemId) continue;
            const inv = await idb.get(STORES.INVENTORY, item.inventoryItemId) as InventoryItem | undefined;
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

        // Strict stock validation BEFORE persisting return voucher (transaction-safe behavior).
        for (const item of pr.items || []) {
            if (!item.inventoryItemId) continue;
            const inv = await idb.get(STORES.INVENTORY, item.inventoryItemId) as InventoryItem | undefined;
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
            const inv = await idb.get(STORES.INVENTORY, item.inventoryItemId) as InventoryItem | undefined;
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

        const { data: books } = await supabase
            .from('set_of_books')
            .select('default_customer_gl_id')
            .eq('organization_id', user.organization_id)
            .eq('id', postingContext.setOfBooksId)
            .single();

        const receivableGl = args.customerControlGlId || books?.default_customer_gl_id;
        if (!receivableGl) {
            throw new Error('Customer/Receivable GL is not configured for default set of books.');
        }

        const { data: cashGlRows, error: cashGlError } = await supabase
            .from('gl_master')
            .select('id, gl_code')
            .eq('organization_id', user.organization_id)
            .eq('set_of_books_id', postingContext.setOfBooksId)
            .eq('gl_code', '100001')
            .limit(1);
        if (cashGlError) throw cashGlError;

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
        const next = crypto.randomUUID();
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
