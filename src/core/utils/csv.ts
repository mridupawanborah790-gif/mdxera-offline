
import type { InventoryItem, Customer, Supplier, Purchase, Transaction, BillItem, PurchaseItem, Medicine, SupplierProductMap } from '@core/types';
import { parseNumber, normalizeImportDate } from './helpers';
import { generateUUID } from '@core/services/storageService';

function formatCsvField(field: any): string {
    if (field === null || typeof field === 'undefined') return '';
    const str = String(field).trim();
    if (/[",\n\r]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

export function arrayToCsvRow(arr: any[]): string {
    return arr.map(formatCsvField).join(',');
}

/**
 * Save text content as a file.
 *
 * Tauri's WebView2 does NOT install a download handler by default, so the
 * traditional `URL.createObjectURL(blob)` + `<a download>` click pattern
 * silently fails inside the desktop app — that's why CSV exports and migration
 * templates appeared to "do nothing" in the installed Windows build.
 *
 * Strategy (in order):
 *   1. `window.showSaveFilePicker` (File System Access API) — supported by
 *      Edge WebView2 / Chromium. Gives a proper "Save As" dialog and writes
 *      reliably both in Tauri and in regular browsers.
 *   2. Blob URL + hidden anchor click — the legacy browser fallback.
 *   3. Data URL navigation — last-ditch fallback for older webviews.
 */
export const downloadCsv = async (csvContent: string, fileName: string): Promise<void> => {
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });

    type SaveFilePicker = (opts: {
        suggestedName?: string;
        types?: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<{
        createWritable: () => Promise<{
            write: (data: Blob | string) => Promise<void>;
            close: () => Promise<void>;
        }>;
    }>;
    const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;

    if (typeof picker === 'function') {
        try {
            const handle = await picker({
                suggestedName: fileName,
                types: [{
                    description: 'CSV File',
                    accept: { 'text/csv': ['.csv'] },
                }],
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            return;
        } catch (err) {
            // AbortError = user cancelled — don't fall through to a duplicate save.
            const name = (err as { name?: string })?.name;
            if (name === 'AbortError') return;
            console.warn('[downloadCsv] showSaveFilePicker failed, falling back to blob anchor', err);
        }
    }

    // Fallback 1: blob URL + anchor (works in regular browsers).
    try {
        const link = document.createElement('a');
        if (link.download !== undefined) {
            const url = URL.createObjectURL(blob);
            link.setAttribute('href', url);
            link.setAttribute('download', fileName);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            return;
        }
    } catch (err) {
        console.warn('[downloadCsv] blob anchor fallback failed', err);
    }

    // Fallback 2: data URL navigation. Crude but works when nothing else does.
    const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', dataUrl);
    link.setAttribute('download', fileName);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};

export function parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuote = false;
    
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (inQuote) {
            if (char === '"') {
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuote = false;
                }
            } else {
                current += char;
            }
        } else {
            if (char === '"') {
                inQuote = true;
            } else if (char === ',') {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
    }
    result.push(current.trim());
    return result;
}

interface CsvHeaderMap { [key: string]: number; }

const normalizeHeader = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

const getHeaderMap = (headers: string[], expectedHeaders: string[]): CsvHeaderMap => {
    const map: CsvHeaderMap = {};

    const normalizedHeaderIndex = new Map<string, number>();
    headers.forEach((header, index) => {
        const normalized = normalizeHeader(header);
        if (!normalizedHeaderIndex.has(normalized)) {
            normalizedHeaderIndex.set(normalized, index);
        }
    });

    expectedHeaders.forEach((expectedHeader) => {
        const normalizedExpectedHeader = normalizeHeader(expectedHeader);
        const matchedIndex = normalizedHeaderIndex.get(normalizedExpectedHeader);
        if (matchedIndex !== undefined) {
            map[expectedHeader] = matchedIndex;
        }
    });

    return map;
};

// --- Template Generators ---

export const downloadMasterTemplate = () => {
    const headers = ['name', 'materialCode', 'brand', 'manufacturer', 'marketer', 'composition', 'pack', 'hsnCode', 'gstRate', 'mrp', 'isPrescriptionRequired', 'isActive', 'barcode', 'directions'];
    const example = ['Dolo 650mg', 'DOLO650', 'Micro Labs', 'Micro Labs Ltd', 'Micro Labs', 'Paracetamol 650mg', '15s', '3004', '12', '30.50', 'true', 'true', '8901234567890', '1-0-1 After Meals'];
    downloadCsv([arrayToCsvRow(headers), arrayToCsvRow(example)].join('\n'), 'master_data_template.csv');
};

export const downloadInventoryTemplate = () => {
    const headers = ['Name', 'Brand', 'Category', 'Manufacturer', 'Stock', 'UnitsPerPack', 'PackType', 'UnitOfMeasurement', 'PackUnit', 'BaseUnit', 'MinStockLimit', 'Batch', 'Expiry', 'PurchasePrice', 'PTR', 'MRP', 'RateA', 'RateB', 'RateC', 'GSTPercent', 'HSNCode', 'Composition', 'Barcode', 'Deal', 'Free', 'SupplierName', 'RackNumber', 'Cost', 'Value', 'MaterialCode', 'Description', 'PurchaseDeal', 'PurchaseFree', 'TaxBasis', 'IsActive'];
    const example = ['Pan D Capsule', 'Alkem', 'Medicine', 'Alkem Laboratories', '100', '10', '10s', 'Tablet', 'Strip', 'Tablet', '10', 'BCH990', '07/26', '140.00', '150.00', '199.00', '180.00', '175.00', '170.00', '12', '3004', 'Composition Details', '8901234567890', '10', '1', 'S K Agencies', 'A-12', '14.00', '1400.00', 'ITEM001', 'Sample Description', '10', '1', '1-Tax Exclusive', 'TRUE'];
    downloadCsv([arrayToCsvRow(headers), arrayToCsvRow(example)].join('\n'), 'inventory_stock_template.csv');
};

export const downloadSupplierTemplate = () => {
    const headers = ['name', 'gstNumber', 'panNumber', 'phone', 'email', 'address', 'state', 'district', 'drugLicense', 'upiId', 'accountNumber', 'ifscCode', 'openingBalance', 'asOfDate', 'isActive'];
    const example = ['Global Pharma Dist', '27AAAAA0000A1Z5', 'ABCDE1234F', '9876543210', 'info@global.com', '123 Market St', 'Maharashtra', 'Mumbai', 'MH-MZ4-12345', 'global@upi', '1234567890', 'SBIN0001234', '5000', '2024-04-01', 'TRUE'];
    downloadCsv([arrayToCsvRow(headers), arrayToCsvRow(example)].join('\n'), 'supplier_master_template.csv');
};

export const downloadCustomerTemplate = () => {
    const headers = ['name', 'phone', 'email', 'address', 'area', 'pincode', 'district', 'state', 'gstNumber', 'drugLicense', 'panCard', 'defaultDiscount', 'customerType', 'openingBalance', 'asOfDate', 'isActive', 'defaultRateTier', 'assignedStaffName'];
    const example = ['Life Care Clinic', '9988776655', 'care@life.com', 'Suite 10, Apollo Bld', 'Andheri', '400001', 'Mumbai', 'Maharashtra', '27BXXXX1234X1Z2', 'DL-C-123', 'ABCDE1234G', '5', 'regular', '1200', '2024-04-01', 'TRUE', 'none', 'John Doe'];
    downloadCsv([arrayToCsvRow(headers), arrayToCsvRow(example)].join('\n'), 'customer_master_template.csv');
};

export const downloadNomenclatureTemplate = () => {
    const headers = ['supplierName', 'supplierProductName', 'masterProductName'];
    const example = ['S K Agencies', 'DOLO-650 15T', 'Dolo 650mg'];
    downloadCsv([arrayToCsvRow(headers), arrayToCsvRow(example)].join('\n'), 'vendor_nomenclature_template.csv');
};

export const downloadSalesImportTemplate = () => {
    const headers = ['id', 'date', 'customerName', 'customerPhone', 'itemName', 'itemBatch', 'itemExpiry', 'itemQuantity', 'itemMrp', 'itemRate', 'itemGstPercent', 'itemDiscountPercent', 'paymentMode', 'referredBy'];
    const example = ['INV-001', '2024-05-10', 'Walking Customer', '', 'Dolo 650mg', 'BCH101', '12/25', '2', '30.50', '30.50', '12', '5', 'Cash', 'Dr. Smith'];
    downloadCsv([arrayToCsvRow(headers), arrayToCsvRow(example)].join('\n'), 'sales_bill_import_template.csv');
};

export const downloadPurchaseImportTemplate = () => {
    const headers = ['supplier', 'invoiceNumber', 'date', 'itemName', 'itemBatch', 'itemExpiry', 'itemQuantity', 'itemFreeQuantity', 'itemPurchasePrice', 'itemMrp', 'itemGstPercent', 'itemHsnCode', 'itemDiscountPercent'];
    const example = ['Global Pharma', 'BILL/990', '2024-05-08', 'Pan D Capsule', 'PND-99', '01/27', '10', '0', '140.00', '199.00', '12', '3004', '0'];
    downloadCsv([arrayToCsvRow(headers), arrayToCsvRow(example)].join('\n'), 'purchase_bill_import_template.csv');
};

// --- Parsers ---

export function parseMedicineMasterCsv(lines: string[]): Omit<Medicine, 'id' | 'organization_id' | 'user_id' | 'created_at' | 'updated_at'>[] {
    const headers = parseCsvLine(lines[0]);
    const headerMap = getHeaderMap(headers, ['name', 'materialCode', 'brand', 'manufacturer', 'marketer', 'composition', 'pack', 'hsnCode', 'gstRate', 'mrp', 'isPrescriptionRequired', 'isActive', 'barcode', 'directions']);
    
    return lines.slice(1).filter(line => line.trim() !== '').map(line => {
        const values = parseCsvLine(line);
        const get = (key: string) => headerMap[key] !== undefined ? values[headerMap[key]] : '';
        return {
            name: get('name'),
            materialCode: get('materialCode') || get('name'), 
            brand: get('brand'),
            manufacturer: get('manufacturer'),
            marketer: get('marketer'),
            composition: get('composition'),
            pack: get('pack'),
            hsnCode: get('hsnCode'),
            gstRate: parseNumber(get('gstRate')),
            mrp: get('mrp') || '0', 
            isPrescriptionRequired: String(get('isPrescriptionRequired')).toLowerCase() === 'true',
            // Renamed isActive to is_active
            is_active: String(get('isActive')).toLowerCase() !== 'false',
            barcode: get('barcode'),
            directions: get('directions'),
        };
    });
}

export function parseNomenclatureCsv(lines: string[]): Partial<SupplierProductMap>[] {
    const headers = parseCsvLine(lines[0]);
    const headerMap = getHeaderMap(headers, ['supplierName', 'supplierProductName', 'masterProductName', 'autoApply']);
    return lines.slice(1).filter(line => line.trim() !== '').map(line => {
        const values = parseCsvLine(line);
        const get = (key: string) => headerMap[key] !== undefined ? values[headerMap[key]] : '';
        return {
            // Fix: Map CSV keys to snake_case property names of SupplierProductMap
            supplier_id: get('supplierName'), 
            supplier_product_name: get('supplierProductName'),
            master_medicine_id: get('masterProductName'), 
            auto_apply: String(get('autoApply')).toLowerCase() === 'true'
        };
    });
}

export function parseInventoryCsv(lines: string[]): Omit<InventoryItem, 'id' | 'organization_id' | 'user_id' | 'created_at' | 'updated_at'>[] {
    const headers = parseCsvLine(lines[0]);
    const headerMap = getHeaderMap(headers, [
        'Name', 'Brand', 'Category', 'Manufacturer', 'Stock', 'UnitsPerPack', 'PackType', 'UnitOfMeasurement',
        'PackUnit', 'BaseUnit', 'MinStockLimit', 'Batch', 'Expiry', 'PurchasePrice', 'PTR', 'MRP', 'RateA',
        'RateB', 'RateC', 'GSTPercent', 'HSNCode', 'Composition', 'Barcode', 'Deal', 'Free', 'SupplierName',
        'RackNumber', 'Cost', 'Value', 'MaterialCode', 'Description', 'PurchaseDeal', 'PurchaseFree', 'TaxBasis', 'IsActive'
    ]);

    const normalizeInventoryExpiry = (rawExpiry: string | undefined, itemName: string): string => {
        if (typeof rawExpiry === 'undefined') return '';
        const cleanExpiry = String(rawExpiry).trim();
        if (!cleanExpiry) return '';

        // Accepted format: YYYY-MM-DD (kept as-is after validation)
        const yyyyMmDdMatch = cleanExpiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (yyyyMmDdMatch) {
            const year = Number(yyyyMmDdMatch[1]);
            const month = Number(yyyyMmDdMatch[2]);
            const day = Number(yyyyMmDdMatch[3]);
            const lastDay = new Date(year, month, 0).getDate();
            const isValid = month >= 1 && month <= 12 && day >= 1 && day <= lastDay;
            if (isValid) return cleanExpiry;
        }

        // Accepted format: MMM-YY (case-insensitive), normalized to last day of month
        const mmmYyMatch = cleanExpiry.match(/^([A-Za-z]{3})-(\d{2})$/);
        if (mmmYyMatch) {
            const monthMap: Record<string, number> = {
                jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
                jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
            };
            const month = monthMap[mmmYyMatch[1].toLowerCase()];
            const year = 2000 + Number(mmmYyMatch[2]);
            if (month) {
                const lastDay = new Date(year, month, 0).getDate();
                return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
            }
        }

        throw new Error(
            `Invalid expiry format for item: ${itemName}\nEntered value: ${cleanExpiry}\nAllowed formats: MMM-YY or YYYY-MM-DD`
        );
    };

    return lines.slice(1).filter(line => line.trim() !== '').map(line => {
        const values = parseCsvLine(line);
        const getItem = (key: string, parseFn: (val: string) => any = (v) => v) => 
            headerMap[key] !== undefined ? parseFn(values[headerMap[key]]) : undefined;

        const uPP = getItem('UnitsPerPack', parseNumber) || 1;
        const purchasePrice = getItem('PurchasePrice', parseNumber) || 0;
        const stock = getItem('Stock', parseNumber) || 0;

        const itemName = getItem('Name') || 'UNKNOWN PRODUCT';

        return {
            name: itemName,
            brand: getItem('Brand') || '',
            category: getItem('Category') || 'General',
            manufacturer: getItem('Manufacturer') || '',
            stock: stock,
            unitsPerPack: uPP,
            packType: getItem('PackType') || '',
            unitOfMeasurement: getItem('UnitOfMeasurement') || '',
            packUnit: getItem('PackUnit') || '',
            baseUnit: getItem('BaseUnit') || '',
            minStockLimit: getItem('MinStockLimit', parseNumber) || 10,
            batch: getItem('Batch') || 'UNSET', // Fallback for batch
            expiry: normalizeInventoryExpiry(getItem('Expiry'), itemName),
            purchasePrice: purchasePrice,
            ptr: getItem('PTR', parseNumber) || 0,
            mrp: getItem('MRP', parseNumber) || 0,
            rateA: getItem('RateA', parseNumber) || 0,
            rateB: getItem('RateB', parseNumber) || 0,
            rateC: getItem('RateC', parseNumber) || 0,
            gstPercent: getItem('GSTPercent', parseNumber) || 0,
            hsnCode: getItem('HSNCode') || '',
            composition: getItem('Composition') || '',
            barcode: getItem('Barcode') || '',
            deal: getItem('Deal', parseNumber) || 0,
            free: getItem('Free', parseNumber) || 0,
            supplierName: getItem('SupplierName') || '',
            rackNumber: getItem('RackNumber') || '',
            cost: getItem('Cost', parseNumber) || (uPP > 0 ? (purchasePrice / uPP) : purchasePrice),
            value: getItem('Value', parseNumber) || (uPP > 0 ? ((purchasePrice / uPP) * stock) : (purchasePrice * stock)),
            code: getItem('MaterialCode') || '',
            description: getItem('Description') || '',
            purchaseDeal: getItem('PurchaseDeal', parseNumber) || 0,
            purchaseFree: getItem('PurchaseFree', parseNumber) || 0,
            taxBasis: getItem('TaxBasis') || '1-Tax Exclusive',
            // Renamed isActive to is_active
            is_active: getItem('IsActive', (v) => String(v).toLowerCase() !== 'false') ?? true
        };
    });
}

// Fixed parseDistributorCsv to match Supplier interface requirements (payment_details and opening_balance)
export function parseDistributorCsv(lines: string[]): (Omit<Supplier, 'id' | 'ledger' | 'organization_id' | 'created_at' | 'updated_at'> & { openingBalance: number; asOfDate: string })[] {
    const headers = parseCsvLine(lines[0]);
    const headerMap = getHeaderMap(headers, [
        'name', 'gstNumber', 'panNumber', 'phone', 'email', 'address', 'state', 'district', 'drugLicense',
        'upiId', 'accountNumber', 'ifscCode', 'openingBalance', 'asOfDate', 'isActive'
    ]);

    return lines.slice(1).filter(line => line.trim() !== '').map(line => {
        const values = parseCsvLine(line);
        const getItem = (key: string, parseFn: (val: string) => any = (v) => v) => 
            headerMap[key] !== undefined ? parseFn(values[headerMap[key]]) : undefined;

        const opening_balance = getItem('openingBalance', parseNumber) || 0;

        return {
            name: getItem('name') || 'UNKNOWN SUPPLIER',
            gst_number: getItem('gstNumber') || '',
            pan_number: getItem('panNumber') || '',
            phone: getItem('phone') || '',
            email: getItem('email') || '',
            address: getItem('address') || '',
            state: getItem('state') || '',
            district: getItem('district') || '',
            drug_license: getItem('drugLicense') || '',
            payment_details: {
                upi_id: getItem('upiId') || '',
                account_number: getItem('accountNumber') || '',
                ifsc_code: getItem('ifscCode') || ''
            },
            is_active: getItem('isActive', (v) => String(v).toLowerCase() !== 'false') ?? true,
            opening_balance,
            openingBalance: opening_balance,
            asOfDate: getItem('asOfDate', normalizeImportDate) || new Date().toISOString().split('T')[0]
        };
    });
}

export function parseCustomerCsv(lines: string[]): (Omit<Customer, 'id' | 'ledger' | 'organization_id' | 'created_at' | 'updated_at'> & { openingBalance: number; asOfDate: string })[] {
    const headers = parseCsvLine(lines[0]);
    const headerMap = getHeaderMap(headers, [
        'name', 'phone', 'email', 'address', 'area', 'pincode', 'district', 'state', 'gstNumber', 
        'drugLicense', 'panCard', 'defaultDiscount', 'customerType', 'openingBalance', 'asOfDate', 'isActive',
        'defaultRateTier', 'assignedStaffName', 'assignedStaffId'
    ]);

    return lines.slice(1).filter(line => line.trim() !== '').map(line => {
        const values = parseCsvLine(line);
        const getItem = (key: string, parseFn: (val: string) => any = (v) => v) => 
            headerMap[key] !== undefined ? parseFn(values[headerMap[key]]) : undefined;

        return {
            name: getItem('name') || 'UNKNOWN CUSTOMER',
            phone: getItem('phone') || '',
            email: getItem('email') || '',
            address: getItem('address') || '',
            area: getItem('area') || '',
            pincode: getItem('pincode') || '',
            district: getItem('district') || '',
            state: getItem('state') || '',
            gstNumber: getItem('gstNumber') || '',
            drugLicense: getItem('drugLicense') || '',
            panCard: getItem('panCard') || '',
            defaultDiscount: getItem('defaultDiscount', parseNumber) || 0,
            customerType: getItem('customerType', (v) => String(v).toLowerCase() as 'regular' | 'retail' || 'regular'),
            // Renamed isActive to is_active
            is_active: getItem('isActive', (v) => String(v).toLowerCase() !== 'false') ?? true,
            defaultRateTier: getItem('defaultRateTier', (v) => String(v).toLowerCase() as 'none' | 'rateA' | 'rateB' | 'rateC' || 'none'),
            assignedStaffName: getItem('assignedStaffName') || '',
            assignedStaffId: getItem('assignedStaffId') || '',
            openingBalance: getItem('openingBalance', parseNumber) || 0,
            asOfDate: getItem('asOfDate', normalizeImportDate) || new Date().toISOString().split('T')[0]
        };
    });
}

export function parsePurchaseCsv(lines: string[]): Omit<Purchase, 'id' | 'organization_id' | 'user_id' | 'created_at' | 'updated_at'>[] {
    const headers = parseCsvLine(lines[0]);
    const headerMap = getHeaderMap(headers, [
        'supplier', 'invoiceNumber', 'date', 'itemName', 'itemBatch', 'itemExpiry', 'itemQuantity', 'itemFreeQuantity',
        'itemPurchasePrice', 'itemMrp', 'itemGstPercent', 'itemHsnCode', 'itemDiscountPercent', 'itemSchemeDiscountPercent',
        'itemSchemeDiscountAmount', 'referenceDocNumber', 'eWayBillNo', 'eWayBillDate', 'roundOff', 'schemeDiscount'
    ]);

    const purchasesMap = new Map<string, Omit<Purchase, 'id' | 'organization_id' | 'user_id' | 'created_at' | 'updated_at'>>();

    lines.slice(1).filter(line => line.trim() !== '').forEach(line => {
        const values = parseCsvLine(line);
        const getItem = (key: string, parseFn: (val: string) => any = (v) => v) => 
            headerMap[key] !== undefined ? parseFn(values[headerMap[key]]) : undefined;

        const invoiceNumber = getItem('invoiceNumber');
        const supplier = getItem('supplier');
        const purchaseDate = getItem('date', normalizeImportDate);

        if (!invoiceNumber || !supplier || !purchaseDate) return;

        const purchaseKey = `${supplier}_${invoiceNumber}_${purchaseDate}`;
        let purchase = purchasesMap.get(purchaseKey);

        if (!purchase) {
            purchase = {
                purchaseSerialId: '', 
                supplier: supplier,
                invoiceNumber: invoiceNumber,
                date: purchaseDate,
                items: [],
                subtotal: 0,
                totalGst: 0,
                totalAmount: 0,
                totalItemDiscount: 0,
                totalItemSchemeDiscount: 0,
                schemeDiscount: getItem('schemeDiscount', parseNumber) || 0,
                roundOff: getItem('roundOff', parseNumber) || 0,
                status: 'completed',
                referenceDocNumber: getItem('referenceDocNumber'),
                eWayBillNo: getItem('eWayBillNo'),
                eWayBillDate: getItem('eWayBillDate', normalizeImportDate),
            };
            purchasesMap.set(purchaseKey, purchase);
        }

        const qty = getItem('itemQuantity', parseNumber) || 0;
        const freeQty = getItem('itemFreeQuantity', parseNumber) || 0;
        const rate = getItem('itemPurchasePrice', parseNumber) || 0;
        const discP = getItem('itemDiscountPercent', parseNumber) || 0;
        const schP = getItem('itemSchemeDiscountPercent', parseNumber) || 0;
        const schAmt = getItem('itemSchemeDiscountAmount', parseNumber) || 0;
        const gstP = getItem('itemGstPercent', parseNumber) || 0;

        const lineGross = qty * rate;
        const lineDisc = lineGross * (discP / 100);
        const lineSchDisc = (lineGross - lineDisc) * (schP / 100) + schAmt; 
        const lineNetBeforeTax = lineGross - lineDisc - lineSchDisc;
        const itemTaxable = lineNetBeforeTax;
        const itemGst = itemTaxable * (gstP / 100); 

        const item: PurchaseItem = {
            id: generateUUID(),
            name: getItem('itemName') || 'UNKNOWN ITEM',
            brand: '', 
            category: 'General',
            batch: getItem('itemBatch') || 'UNSET', // Fallback for batch
            expiry: getItem('itemExpiry', normalizeImportDate) || '2099-12-31',
            quantity: qty,
            looseQuantity: 0,
            freeQuantity: freeQty,
            purchasePrice: rate,
            mrp: getItem('itemMrp', parseNumber) || 0,
            gstPercent: gstP,
            hsnCode: getItem('itemHsnCode') || '',
            discountPercent: discP,
            schemeDiscountPercent: schP,
            schemeDiscountAmount: schAmt,
            matchStatus: 'pending',
        };
        (purchase.items as PurchaseItem[]).push(item);
        
        purchase.subtotal += itemTaxable;
        purchase.totalGst += itemGst;
        purchase.totalItemDiscount += lineDisc;
        purchase.totalItemSchemeDiscount += lineSchDisc;
        purchase.totalAmount += (itemTaxable + itemGst); 
    });

    return Array.from(purchasesMap.values());
}

export function parseSalesCsv(lines: string[]): Omit<Transaction, 'organization_id' | 'user_id' | 'created_at' | 'updated_at'>[] {
    const headers = parseCsvLine(lines[0]);
    const headerMap = getHeaderMap(headers, [
        'id', 'date', 'customerName', 'customerPhone', 'itemName', 'itemBatch', 'itemExpiry', 'itemQuantity', 
        'itemMrp', 'itemRate', 'itemGstPercent', 'itemDiscountPercent', 'paymentMode', 'referredBy',
        'subtotal', 'totalItemDiscount', 'totalGst', 'schemeDiscount', 'roundOff', 'total'
    ]);

    const transactionsMap = new Map<string, Omit<Transaction, 'organization_id' | 'user_id' | 'created_at' | 'updated_at'>>();

    lines.slice(1).filter(line => line.trim() !== '').forEach(line => {
        const values = parseCsvLine(line);
        const getItem = (key: string, parseFn: (val: string) => any = (v) => v) => 
            headerMap[key] !== undefined ? parseFn(values[headerMap[key]]) : undefined;

        const transactionId = getItem('id');
        const transactionDate = getItem('date', normalizeImportDate);
        const customerName = getItem('customerName') || 'Walking Customer';

        if (!transactionId || !transactionDate) return;

        let transaction = transactionsMap.get(transactionId);

        if (!transaction) {
            transaction = {
                id: transactionId,
                date: transactionDate,
                customerName: customerName,
                customerPhone: getItem('customerPhone') || '',
                referredBy: getItem('referredBy') || '',
                items: [],
                total: getItem('total', parseNumber) || 0,
                itemCount: 0, 
                status: 'completed',
                paymentMode: getItem('paymentMode') || 'Cash',
                billType: 'regular', 
                subtotal: getItem('subtotal', parseNumber) || 0,
                totalItemDiscount: getItem('totalItemDiscount', parseNumber) || 0,
                totalGst: getItem('totalGst', parseNumber) || 0,
                schemeDiscount: getItem('schemeDiscount', parseNumber) || 0,
                roundOff: getItem('roundOff', parseNumber) || 0
            };
            transactionsMap.set(transactionId, transaction);
        }

        const qty = getItem('itemQuantity', parseNumber) || 0;
        const rate = getItem('itemRate', parseNumber) || getItem('itemMrp', parseNumber) || 0;
        const discP = getItem('itemDiscountPercent', parseNumber) || 0;
        const gstP = getItem('itemGstPercent', parseNumber) || 0;

        if (transaction.total === 0 && transaction.subtotal === 0 && transaction.totalGst === 0) {
            const lineGross = qty * rate;
            const lineDisc = lineGross * (discP / 100);
            const lineNet = lineGross - lineDisc;
            const itemTaxable = lineNet / (1 + (gstP / 100));
            const itemGst = lineNet - itemTaxable;

            transaction.subtotal += itemTaxable;
            transaction.totalGst += itemGst;
            transaction.totalItemDiscount += lineDisc;
            transaction.total += lineNet;
        }

        const item: BillItem = {
            id: generateUUID(),
            inventoryItemId: '', 
            name: getItem('itemName') || 'UNKNOWN ITEM',
            mrp: getItem('itemMrp', parseNumber) || rate,
            quantity: qty,
            unit: 'pack', 
            gstPercent: gstP,
            discountPercent: discP,
            itemFlatDiscount: 0,
            batch: getItem('itemBatch') || 'UNSET', // Fallback for batch
            expiry: getItem('itemExpiry', normalizeImportDate) || '',
            rate: rate,
            unitsPerPack: 1 
        };
        (transaction.items as BillItem[]).push(item);
        
        transaction.itemCount += qty;
    });

    return Array.from(transactionsMap.values());
}
