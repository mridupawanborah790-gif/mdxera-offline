
import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import Card from '@core/components/ui/Card';
import AddProductModal from '@modules/inventory/components/AddProductModal';
import EditProductModal from '@modules/inventory/components/EditProductModal';
import ExportInventoryModal from '../components/ExportInventoryModal';
import MrpChangeLogModal from '../components/MrpChangeLogModal';
import InventoryBatchDetailModal from '../components/InventoryBatchDetailModal';
import SyncMaterialMasterModal from '../components/SyncMaterialMasterModal';
import type { InventoryItem, RegisteredPharmacy, ModuleConfig, AppConfigurations, Medicine, MrpChangeLogEntry } from '@core/types';
import { fuzzyMatch } from '@core/utils/search';
import { formatExpiryToMMYY, normalizeImportDate } from '@core/utils/helpers';
import { configurableModules } from '@core/utils/constants';
import { getInventoryPolicy } from '@core/utils/materialType';
import { extractPackMultiplier, resolveUnitsPerStrip } from '@core/utils/pack';
import { shouldHandleScreenShortcut } from '@core/utils/screenShortcuts';

// Standardized typography matching POS screen "Product Selection Matrix"
const uniformTextStyle = "text-2xl font-normal tracking-tight uppercase leading-tight";
const DEFAULT_ITEMS_PER_PAGE = 15;
const ROWS_PER_PAGE_OPTIONS = [10, 15, 25, 50] as const;

// Icons
const SearchIcon = (props: React.SVGProps<SVGSVGElement>) => <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>;
const ColumnsIcon = (props: React.SVGProps<SVGSVGElement>) => <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7m0-18H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7m0-18v18"/></svg>;
const ExportIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
);
const PrintIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polyline points="6 9 6 2 18 2 18 9" />
    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
    <rect x="6" y="14" width="12" height="8" />
  </svg>
);

interface InventoryProps {
    inventory: InventoryItem[];
    medicines: Medicine[];
    currentUser: RegisteredPharmacy | null;
    onCreatePurchaseOrder: (selectedIds: string[]) => void;
    initialFilters?: { lowStockOnly?: boolean } | null;
    onFiltersChange?: () => void;
    config: ModuleConfig;
    onUpdateConfig: (newConfig: ModuleConfig) => void;
    onBulkAddInventory: (items: Omit<InventoryItem, 'id'>[]) => void;
    onAddProduct: (item: Omit<InventoryItem, 'id'>) => void;
    onAddProductLocal?: (item: Omit<InventoryItem, 'id'>) => void;
    onUpdateProduct: (item: InventoryItem) => Promise<void>;
    mrpChangeLogs?: MrpChangeLogEntry[];
    configurations?: AppConfigurations | null;
    addNotification?: (message: string, type: 'success' | 'error' | 'warning') => void;
    onRefresh?: () => Promise<void> | void;
    onAddMedicineMaster?: (med: Omit<Medicine, 'id'>) => Promise<Medicine | void> | Medicine | void;
}

interface GroupedInventoryRow {
    key: string;
    items: InventoryItem[];
    representative: InventoryItem;
    name: string;
    totalPackQty: number;
    totalLooseQty: number;
    totalStock: number;
    totalValue: number;
    batchLabel: string;
    mrpLabel: string;
    rateALabel: string;
    rateBLabel: string;
    rateCLabel: string;
    batchCount: number;
    hasMixedMrp: boolean;
    hasMixedRate: boolean;
}

const Inventory: React.FC<InventoryProps> = ({
    inventory,
    medicines,
    currentUser,
    onCreatePurchaseOrder,
    initialFilters,
    onFiltersChange,
    config,
    onUpdateConfig,
    onBulkAddInventory,
    onAddProduct,
    onUpdateProduct,
    mrpChangeLogs = [],
    configurations,
    addNotification,
    onRefresh,
    onAddMedicineMaster,
}) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [isExportModalOpen, setIsExportModalOpen] = useState(false);
    const [isSyncMasterModalOpen, setIsSyncMasterModalOpen] = useState(false);
    const [itemToEdit, setItemToEdit] = useState<InventoryItem | null>(null);
    const [lowStockFilter, setLowStockFilter] = useState(false);
    const [isColumnSelectorOpen, setIsColumnSelectorOpen] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [rowsPerPage, setRowsPerPage] = useState<number>(DEFAULT_ITEMS_PER_PAGE);
    const [isMrpLogOpen, setIsMrpLogOpen] = useState(false);
    const [detailRowKey, setDetailRowKey] = useState<string | null>(null);
    const [expiryFilter, setExpiryFilter] = useState<'all' | 'nearExpiry' | 'expired'>('all');
    const columnSelectorRef = useRef<HTMLDivElement>(null);
    const tableBodyRef = useRef<HTMLTableSectionElement>(null);

    const inventoryModuleFields = useMemo(() => 
        configurableModules.find(m => m.id === 'inventory')?.fields || [], 
    []);

    const medicineByCode = useMemo(() => {
        const toKey = (value?: string | null) => (value || '').trim().toLowerCase();
        const map = new Map<string, Medicine>();
        medicines.forEach(med => {
            const key = toKey(med.materialCode);
            if (key) map.set(key, med);
        });
        return map;
    }, [medicines]);

    const getEffectiveFields = useCallback((item: InventoryItem) => {
        const itemCode = (item.code || '').trim().toLowerCase();
        const linkedMedicine = itemCode ? medicineByCode.get(itemCode) : undefined;
        const masterPack = linkedMedicine?.pack || '';
        const effectivePackType = (item.packType || '').trim() || masterPack.trim();
        const effectiveUnitsPerPack = resolveUnitsPerStrip(
            extractPackMultiplier(effectivePackType) ?? item.unitsPerPack,
            effectivePackType,
        );
        return {
            effectivePackType,
            effectiveUnitsPerPack,
            effectiveGst: Number(item.gstPercent ?? linkedMedicine?.gstRate ?? 0),
            effectiveHsnCode: item.hsnCode || linkedMedicine?.hsnCode || '',
            effectiveMrp: Number(item.mrp ?? linkedMedicine?.mrp ?? 0),
            effectiveRateA: Number(item.rateA ?? linkedMedicine?.rateA ?? 0),
            effectiveRateB: Number(item.rateB ?? linkedMedicine?.rateB ?? 0),
            effectiveRateC: Number(item.rateC ?? linkedMedicine?.rateC ?? 0),
            isManagedByMaster: Boolean(linkedMedicine),
        };
    }, [medicineByCode]);

    const nearExpiryThresholdDays = useMemo(() => {
        const configuredThreshold = Number(configurations?.displayOptions?.expiryThreshold ?? 90);
        if (!Number.isFinite(configuredThreshold) || configuredThreshold < 0) return 90;
        return Math.floor(configuredThreshold);
    }, [configurations?.displayOptions?.expiryThreshold]);

    const parseInventoryExpiryDate = useCallback((expiry?: string | null): Date | null => {
        if (!expiry) return null;
        const normalized = normalizeImportDate(expiry);
        if (!normalized) return null;
        const date = new Date(normalized);
        if (Number.isNaN(date.getTime())) return null;
        date.setHours(0, 0, 0, 0);
        return date;
    }, []);

    const expiryWindow = useMemo(() => {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const nearExpiryEnd = new Date(todayStart);
        nearExpiryEnd.setDate(nearExpiryEnd.getDate() + nearExpiryThresholdDays);
        return { todayStart, nearExpiryEnd };
    }, [nearExpiryThresholdDays]);

    const baseFilteredItems = useMemo(() => {
        let items = Array.isArray(inventory) ? [...inventory] : [];
        items = items.filter(i => getInventoryPolicy(i, medicines).inventorised);

        return items.sort((a, b) => {
            const nameA = (a.name || '').toLowerCase();
            const nameB = (b.name || '').toLowerCase();
            return nameA.localeCompare(nameB);
        });
    }, [inventory, medicines]);

    const filteredItems = useMemo(() => {
        return baseFilteredItems.filter(item => {
            if (lowStockFilter && Number(item.stock || 0) > Number(item.minStockLimit || 0)) {
                return false;
            }

            if (searchTerm) {
                const matchesSearch =
                    fuzzyMatch(item.name, searchTerm) ||
                    fuzzyMatch(item.brand, searchTerm) ||
                    fuzzyMatch(item.batch, searchTerm) ||
                    fuzzyMatch(item.composition, searchTerm) ||
                    fuzzyMatch(item.supplierName, searchTerm) ||
                    fuzzyMatch(item.barcode, searchTerm);
                if (!matchesSearch) return false;
            }

            if (expiryFilter === 'all') return true;
            const expDate = parseInventoryExpiryDate(item.expiry);
            if (!expDate) return false;
            if (expiryFilter === 'expired') return expDate < expiryWindow.todayStart;
            return expDate >= expiryWindow.todayStart && expDate <= expiryWindow.nearExpiryEnd;
        });
    }, [baseFilteredItems, lowStockFilter, searchTerm, expiryFilter, parseInventoryExpiryDate, expiryWindow]);

    const groupedItems = useMemo<GroupedInventoryRow[]>(() => {
        const map = new Map<string, InventoryItem[]>();
        const toKey = (item: InventoryItem) => `${(item.code || '').trim().toLowerCase()}|${(item.name || '').trim().toLowerCase()}`;

        filteredItems.forEach(item => {
            const key = toKey(item);
            if (!map.has(key)) map.set(key, []);
            map.get(key)!.push(item);
        });

        const rows = Array.from(map.entries()).map(([key, items]) => {
            const representative = items[0];
            const totalStock = items.reduce((sum, item) => sum + (Number(item.stock) || 0), 0);
            const unitsPerPack = Math.max(1, Number(representative.unitsPerPack) || 1);
            const totalPackQty = Math.floor(totalStock / unitsPerPack);
            const totalLooseQty = totalStock % unitsPerPack;
            const totalValue = items.reduce((sum, item) => {
                const computedValue = Number(item.value ?? (item.stock * (item.cost || (item.purchasePrice / (item.unitsPerPack || 1)) || 0)));
                return sum + computedValue;
            }, 0);

            const uniqueBatches = new Set(items.map(item => (item.batch || '').trim()).filter(Boolean));
            const uniqueMrps = new Set(items.map(item => Number(item.mrp || 0).toFixed(2)));
            const uniqueRateA = new Set(items.map(item => Number(item.rateA || 0).toFixed(2)));
            const uniqueRateB = new Set(items.map(item => Number(item.rateB || 0).toFixed(2)));
            const uniqueRateC = new Set(items.map(item => Number(item.rateC || 0).toFixed(2)));

            return {
                key,
                items,
                representative,
                name: representative.name,
                totalPackQty,
                totalLooseQty,
                totalStock,
                totalValue,
                batchCount: items.length,
                batchLabel: uniqueBatches.size <= 1 ? (items[0]?.batch || '-') : `MULTI (${items.length})`,
                mrpLabel: uniqueMrps.size <= 1 ? `₹${Number(representative.mrp || 0).toFixed(2)}` : 'MIXED',
                rateALabel: uniqueRateA.size <= 1 ? `₹${Number(representative.rateA || 0).toFixed(2)}` : 'MIXED',
                rateBLabel: uniqueRateB.size <= 1 ? `₹${Number(representative.rateB || 0).toFixed(2)}` : 'MIXED',
                rateCLabel: uniqueRateC.size <= 1 ? `₹${Number(representative.rateC || 0).toFixed(2)}` : 'MIXED',
                hasMixedMrp: uniqueMrps.size > 1,
                hasMixedRate: uniqueRateA.size > 1 || uniqueRateB.size > 1 || uniqueRateC.size > 1,
            };
        });

        return rows;
    }, [filteredItems]);

    const detailRow = useMemo(
        () => (detailRowKey ? groupedItems.find(row => row.key === detailRowKey) || null : null),
        [detailRowKey, groupedItems],
    );

    const totalPages = Math.max(1, Math.ceil(groupedItems.length / rowsPerPage));

    const paginatedItems = useMemo(() => {
        const startIndex = (currentPage - 1) * rowsPerPage;
        return groupedItems.slice(startIndex, startIndex + rowsPerPage);
    }, [groupedItems, currentPage, rowsPerPage]);

    useEffect(() => {
        if (currentPage > totalPages) {
            setCurrentPage(totalPages);
            setSelectedIndex(0);
        }
    }, [currentPage, totalPages]);

    useEffect(() => {
        if (initialFilters?.lowStockOnly) {
            setLowStockFilter(true);
            setCurrentPage(1);
            if (onFiltersChange) onFiltersChange();
        }
    }, [initialFilters, onFiltersChange]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (columnSelectorRef.current && !columnSelectorRef.current.contains(event.target as Node)) {
                setIsColumnSelectorOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Scroll selected row into view
    useEffect(() => {
        if (tableBodyRef.current) {
            const selectedRow = tableBodyRef.current.querySelector(`[data-row-index="${selectedIndex}"]`);
            if (selectedRow) {
                selectedRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        }
    }, [selectedIndex]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!shouldHandleScreenShortcut(e, 'inventory')) return;
            if (e.key === 'F7') {
                e.preventDefault();
                setIsColumnSelectorOpen(prev => !prev);
                return;
            }

            const isModalOpen = !!itemToEdit || isAddModalOpen || isExportModalOpen || !!detailRowKey;
            if (isModalOpen || isColumnSelectorOpen) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIndex(prev => Math.min(prev + 1, paginatedItems.length - 1));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIndex(prev => Math.max(prev - 1, 0));
            } else if (e.key === 'ArrowRight' && currentPage < totalPages) {
                e.preventDefault();
                setCurrentPage(p => p + 1);
                setSelectedIndex(0);
            } else if (e.key === 'ArrowLeft' && currentPage > 1) {
                e.preventDefault();
                setCurrentPage(p => p - 1);
                setSelectedIndex(0);
            } else if (e.key === 'F2') {
                e.preventDefault();
                setIsAddModalOpen(true);
            } else if (e.key === 'F3') {
                e.preventDefault();
                setIsExportModalOpen(true);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const selectedRow = paginatedItems[selectedIndex];
                if (selectedRow) {
                    setDetailRowKey(selectedRow.key);
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [paginatedItems, selectedIndex, itemToEdit, isAddModalOpen, isExportModalOpen, isColumnSelectorOpen, currentPage, totalPages, detailRowKey]);

    const isFieldVisible = (fieldId: string) => config?.fields?.[fieldId] !== false;

    const toggleField = (fieldId: string) => {
        const currentFields = config.fields || {};
        const newFields = {
            ...currentFields,
            [fieldId]: !isFieldVisible(fieldId)
        };
        onUpdateConfig({ ...config, fields: newFields });
    };

    const totalValuation = useMemo(() => groupedItems.reduce((sum, row) => sum + row.totalValue, 0), [groupedItems]);

    const handleNextProduct = () => {
        const nextIdxInPage = (selectedIndex + 1);
        if (nextIdxInPage < paginatedItems.length) {
            setSelectedIndex(nextIdxInPage);
            setItemToEdit(paginatedItems[nextIdxInPage].representative);
        } else if (currentPage < totalPages) {
            setCurrentPage(p => p + 1);
            setSelectedIndex(0);
            setItemToEdit(groupedItems[currentPage * rowsPerPage]?.representative || null);
        }
    };

    const handlePreviousProduct = () => {
        const prevIdxInPage = (selectedIndex - 1);
        if (prevIdxInPage >= 0) {
            setSelectedIndex(prevIdxInPage);
            setItemToEdit(paginatedItems[prevIdxInPage].representative);
        } else if (currentPage > 1) {
            setCurrentPage(p => p - 1);
            setSelectedIndex(rowsPerPage - 1);
            setItemToEdit(groupedItems[(currentPage - 2) * rowsPerPage + (rowsPerPage - 1)]?.representative || null);
        }
    };

    const handlePrintInventory = () => {
        type PrintableColumn = {
            id: string;
            label: string;
            type: 'text' | 'number';
            minChars: number;
            maxChars?: number;
            getValue: (item: InventoryItem) => string | number;
        };

        const printableColumns = [
            isFieldVisible('colName') ? { id: 'name', label: 'Item Name', type: 'text', minChars: 24, maxChars: 56, getValue: (item: InventoryItem) => item.name || '' } : null,
            isFieldVisible('colCategory') ? { id: 'category', label: 'Category', type: 'text', minChars: 10, maxChars: 18, getValue: (item: InventoryItem) => item.category || '' } : null,
            isFieldVisible('colHsn') ? { id: 'hsn', label: 'HSN', type: 'text', minChars: 8, maxChars: 16, getValue: (item: InventoryItem) => getEffectiveFields(item).effectiveHsnCode || '' } : null,
            isFieldVisible('colBarcode') ? { id: 'barcode', label: 'Barcode', type: 'text', minChars: 10, maxChars: 18, getValue: (item: InventoryItem) => item.barcode || '' } : null,
            isFieldVisible('colBatch') ? { id: 'batch', label: 'Batch', type: 'text', minChars: 9, maxChars: 16, getValue: (item: InventoryItem) => item.batch || '' } : null,
            isFieldVisible('colStrips') ? { id: 'packQty', label: 'Pack Qty', type: 'number', minChars: 6, maxChars: 8, getValue: (item: InventoryItem) => Math.floor(item.stock / getEffectiveFields(item).effectiveUnitsPerPack) } : null,
            isFieldVisible('colLoose') ? { id: 'looseQty', label: 'Loose Qty', type: 'number', minChars: 6, maxChars: 8, getValue: (item: InventoryItem) => item.stock % getEffectiveFields(item).effectiveUnitsPerPack } : null,
            isFieldVisible('colStock') ? { id: 'totalStock', label: 'Total Stock', type: 'number', minChars: 8, maxChars: 10, getValue: (item: InventoryItem) => item.stock } : null,
            isFieldVisible('colBaseUnit') ? { id: 'baseUnit', label: 'B.Unit', type: 'text', minChars: 6, maxChars: 10, getValue: (item: InventoryItem) => item.baseUnit || '' } : null,
            isFieldVisible('colPtr') ? { id: 'ptr', label: 'PTR', type: 'number', minChars: 7, maxChars: 9, getValue: (item: InventoryItem) => Number(item.ptr || 0).toFixed(2) } : null,
            isFieldVisible('colMrp') ? { id: 'mrp', label: 'MRP', type: 'number', minChars: 7, maxChars: 9, getValue: (item: InventoryItem) => Number(getEffectiveFields(item).effectiveMrp || 0).toFixed(2) } : null,
            isFieldVisible('colRateA') ? { id: 'rateA', label: 'Rate A', type: 'number', minChars: 7, maxChars: 9, getValue: (item: InventoryItem) => Number(getEffectiveFields(item).effectiveRateA || 0).toFixed(2) } : null,
            isFieldVisible('colRateB') ? { id: 'rateB', label: 'Rate B', type: 'number', minChars: 7, maxChars: 9, getValue: (item: InventoryItem) => Number(getEffectiveFields(item).effectiveRateB || 0).toFixed(2) } : null,
            isFieldVisible('colRateC') ? { id: 'rateC', label: 'Rate C', type: 'number', minChars: 7, maxChars: 9, getValue: (item: InventoryItem) => Number(getEffectiveFields(item).effectiveRateC || 0).toFixed(2) } : null,
            isFieldVisible('colExpiry') ? { id: 'expiry', label: 'Expiry', type: 'text', minChars: 8, maxChars: 10, getValue: (item: InventoryItem) => formatExpiryToMMYY(item.expiry) || '-' } : null,
        ].filter(Boolean) as PrintableColumn[];

        const printWindow = window.open('', '_blank', 'width=1280,height=860');
        if (!printWindow) return;

        const estimatedChars = printableColumns.reduce((total, col) => total + col.minChars, 3);
        const orientation = printableColumns.length > 8 || estimatedChars > 96 ? 'landscape' : 'portrait';
        const generatedOn = new Date().toLocaleString();
        const measuredColumnWidths = printableColumns.map((col) => {
            const headerChars = col.label.length + 2;
            const sampleChars = filteredItems.slice(0, 300).reduce((longest, item) => {
                const value = String(col.getValue(item) ?? '');
                return Math.max(longest, value.length);
            }, 0);
            const contentChars = Math.max(headerChars, sampleChars + 1, col.minChars);
            const clampedChars = col.maxChars ? Math.min(contentChars, col.maxChars) : contentChars;
            return {
                ...col,
                widthChars: clampedChars,
            };
        });

        const totalChars = measuredColumnWidths.reduce((sum, col) => sum + col.widthChars, 3);
        const serialWidthPercent = Math.max(3.5, Math.min(5.5, (3 / totalChars) * 100));
        const columnStyles = measuredColumnWidths.map((col) => {
            if (col.id === 'name') {
                return { ...col, width: 'auto' };
            }
            const widthPercent = (col.widthChars / totalChars) * 100;
            const boundedWidth = col.type === 'number'
                ? Math.max(5.5, Math.min(9.5, widthPercent))
                : Math.max(7, Math.min(16, widthPercent));
            return { ...col, width: `${boundedWidth.toFixed(2)}%` };
        });

        const rowsHtml = filteredItems.map((item, idx) => `
            <tr>
                <td class="text-center">${idx + 1}</td>
                ${columnStyles.map(col => `<td class="${col.id === 'name' ? 'text-left wrap-cell' : col.type === 'number' ? 'text-right' : 'text-left'}">${col.getValue(item) ?? ''}</td>`).join('')}
            </tr>
        `).join('');

        printWindow.document.write(`
            <html>
                <head>
                    <title>Inventory Print Preview</title>
                    <style>
                        @page { size: A4 ${orientation}; margin: 10mm; }
                        * { box-sizing: border-box; }
                        body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #111827; }
                        .container { padding: 10px; }
                        .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; border-bottom: 2px solid #111827; padding-bottom: 8px; }
                        h1 { margin: 0 0 4px; font-size: 16px; text-transform: uppercase; letter-spacing: 0.05em; }
                        .meta { font-size: 11px; color: #374151; }
                        table { width: 100%; border-collapse: collapse; table-layout: auto; font-size: 9px; }
                        thead { display: table-header-group; }
                        tr { page-break-inside: avoid; break-inside: avoid; }
                        th, td { border: 1px solid #9ca3af; padding: 4px 6px; vertical-align: top; white-space: nowrap; overflow-wrap: break-word; }
                        th { background: #e5e7eb; text-transform: uppercase; font-size: 8px; letter-spacing: 0.04em; }
                        .wrap-cell { white-space: normal; word-break: break-word; }
                        .text-left { text-align: left; }
                        .text-right { text-align: right; font-variant-numeric: tabular-nums; }
                        .text-center { text-align: center; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <div>
                                <h1>{expiryFilter === 'nearExpiry' ? 'Near Expiry Stock Report' : expiryFilter === 'expired' ? 'Expired Stock Report' : 'Inventory Stock Summary'}</h1>
                                <div class="meta">${currentUser?.pharmacy_name || 'Pharmacy'}</div>
                                <div class="meta">Filters: ${searchTerm ? `Search "${searchTerm}"` : 'None'}${lowStockFilter ? ' · Low Stock Only' : ''}${expiryFilter !== 'all' ? ` · ${expiryFilter === 'nearExpiry' ? `Near Expiry (≤ ${nearExpiryThresholdDays} days)` : 'Expired'}` : ''}</div>
                            </div>
                            <div class="meta">
                                <div>Generated: ${generatedOn}</div>
                                <div>Total Items: ${filteredItems.length}</div>
                            </div>
                        </div>
                        <table>
                            <colgroup>
                                <col style="width: ${serialWidthPercent.toFixed(2)}%">
                                ${columnStyles.map(col => `<col style="${col.width === 'auto' ? '' : `width: ${col.width}`}">`).join('')}
                            </colgroup>
                            <thead>
                                <tr>
                                    <th style="width: 34px">#</th>
                                    ${columnStyles.map(col => `<th class="${col.id === 'name' ? 'text-left wrap-cell' : col.type === 'number' ? 'text-right' : 'text-left'}">${col.label}</th>`).join('')}
                                </tr>
                            </thead>
                            <tbody>
                                ${rowsHtml}
                            </tbody>
                        </table>
                    </div>
                </body>
            </html>
        `);
        printWindow.document.close();
        printWindow.focus();
    };

    const renderPageNumbers = () => {
        const delta = 2;
        const range = [];
        const rangeWithDots = [];
        let l;

        for (let i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || (i >= currentPage - delta && i <= currentPage + delta)) {
                range.push(i);
            }
        }

        for (const i of range) {
            if (l) {
                if (i - l === 2) {
                    rangeWithDots.push(l + 1);
                } else if (i - l !== 1) {
                    rangeWithDots.push('...');
                }
            }
            rangeWithDots.push(i);
            l = i;
        }

        return rangeWithDots.map((p, idx) => (
            <button
                key={idx}
                disabled={p === '...'}
                onClick={() => typeof p === 'number' && (setCurrentPage(p), setSelectedIndex(0))}
                className={`min-w-[32px] h-8 px-2 border border-gray-400 text-[10px] font-black uppercase transition-all ${
                    p === currentPage 
                    ? 'bg-primary text-white border-primary shadow-inner' 
                    : p === '...' 
                    ? 'bg-white text-gray-400 cursor-default border-dashed' 
                    : 'bg-white text-gray-700 hover:bg-gray-50'
                }`}
            >
                {p}
            </button>
        ));
    };

    return (
        <main className="flex-1 page-fade-in bg-app-bg flex flex-col overflow-hidden">
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">Stock Summary (Inventory Master)</span>
                <span className="text-[10px] font-black uppercase text-accent">Total Items: {groupedItems.length}</span>
            </div>

            <div className="p-3 flex-1 flex flex-col gap-3 overflow-hidden">
                <Card className="flex flex-col flex-1 overflow-hidden p-0 tally-border shadow-md bg-white">
                    <div className="px-3 py-2 border-b border-gray-400 flex items-center bg-gray-50 gap-2.5 flex-shrink-0">
                        <div className="relative flex-1 max-w-sm">
                            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                            <input 
                                type="text" 
                                placeholder="Filter by Name, Brand, Batch..." 
                                value={searchTerm} 
                                onChange={(e) => {
                                    setSearchTerm(e.target.value);
                                    setSelectedIndex(0);
                                    setCurrentPage(1);
                                }} 
                                className="w-full pl-9 pr-3 py-1.5 border border-gray-400 rounded-none bg-white text-sm font-normal outline-none focus:bg-yellow-50"
                            />
                        </div>
                        <div className="flex items-center gap-2 ml-auto">
                            <button
                                onClick={() => setIsMrpLogOpen(true)}
                                className="px-3 py-1.5 border border-primary bg-white text-primary text-[10px] font-black uppercase hover:bg-primary hover:text-white transition-colors"
                            >
                                MRP Log
                            </button>
                            <label className="flex items-center gap-2 bg-white px-3 py-1.5 border border-gray-400">
                                <span className="text-[10px] font-black uppercase tracking-wide text-gray-600">Expiry Filter</span>
                                <select
                                    value={expiryFilter}
                                    onChange={(e) => {
                                        setExpiryFilter(e.target.value as 'all' | 'nearExpiry' | 'expired');
                                        setSelectedIndex(0);
                                        setCurrentPage(1);
                                    }}
                                    className="bg-white text-[11px] font-bold text-gray-700 outline-none"
                                >
                                    <option value="all">All Stock</option>
                                    <option value="nearExpiry">Near Expiry</option>
                                    <option value="expired">Expired</option>
                                </select>
                            </label>
                            <label className="flex items-center gap-1.5 cursor-pointer bg-white px-3 py-1.5 border border-gray-400">
                                <input 
                                    type="checkbox" 
                                    checked={lowStockFilter} 
                                    onChange={e => {
                                        setLowStockFilter(e.target.checked);
                                        setSelectedIndex(0);
                                        setCurrentPage(1);
                                    }}
                                    className="w-4 h-4 text-primary"
                                />
                                <span className="text-[11px] font-bold uppercase text-gray-600">Low Stock</span>
                            </label>

                            <label className="flex items-center gap-2 bg-white px-3 py-1.5 border border-gray-400">
                                <span className="text-[10px] font-black uppercase tracking-wide text-gray-600">Rows</span>
                                <select
                                    value={rowsPerPage}
                                    onChange={(e) => {
                                        setRowsPerPage(Number(e.target.value));
                                        setCurrentPage(1);
                                        setSelectedIndex(0);
                                    }}
                                    className="bg-white text-[11px] font-bold text-gray-700 outline-none"
                                >
                                    {ROWS_PER_PAGE_OPTIONS.map((size) => (
                                        <option key={size} value={size}>{size} / page</option>
                                    ))}
                                </select>
                            </label>
                            
                            <div className="relative" ref={columnSelectorRef}>
                                <button 
                                    onClick={() => setIsColumnSelectorOpen(!isColumnSelectorOpen)}
                                    className={`px-4 py-1.5 border border-gray-400 transition-all flex items-center gap-1.5 text-xs font-bold uppercase ${isColumnSelectorOpen ? 'bg-primary text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                                >
                                    <ColumnsIcon className={isColumnSelectorOpen ? 'text-white' : 'text-primary'} />
                                    F7: Columns
                                </button>
                                
                                {isColumnSelectorOpen && (
                                    <div className="absolute right-0 top-full mt-1 w-64 bg-[#fdfdf5] border-2 border-primary shadow-2xl z-[100] animate-in fade-in slide-in-from-top-2 duration-150">
                                        <div className="bg-primary p-2 text-white text-[10px] font-black uppercase tracking-widest text-center">Configure Display</div>
                                        <div className="p-2 max-h-[400px] overflow-y-auto custom-scrollbar">
                                            {inventoryModuleFields.map(field => (
                                                <button
                                                    key={field.id}
                                                    onClick={() => toggleField(field.id)}
                                                    className="w-full flex items-center gap-3 p-2.5 hover:bg-yellow-50 transition-colors group"
                                                >
                                                    <div className={`w-4 h-4 border-2 flex items-center justify-center transition-colors ${isFieldVisible(field.id) ? 'bg-primary border-primary' : 'bg-white border-gray-400'}`}>
                                                        {isFieldVisible(field.id) && (
                                                            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                                        )}
                                                    </div>
                                                    <span className={`text-xs font-bold uppercase tracking-tight ${isFieldVisible(field.id) ? 'text-gray-900' : 'text-gray-400'}`}>{field.name}</span>
                                                </button>
                                            ))}
                                        </div>
                                        <div className="p-2 bg-gray-100 border-t border-gray-300 text-center">
                                            <button onClick={() => setIsColumnSelectorOpen(false)} className="text-[10px] font-black uppercase text-primary hover:underline">Close Selector</button>
                                        </div>
                                    </div>
                                )}
                            </div>

                            <button 
                                onClick={() => setIsExportModalOpen(true)}
                                className="px-4 py-1.5 border border-gray-400 bg-white text-primary font-black uppercase text-xs tracking-widest flex items-center gap-1.5 hover:bg-gray-50 transition-all active:scale-95 shadow-sm"
                            >
                                <ExportIcon />
                                Export (F3)
                            </button>

                            <button
                                onClick={handlePrintInventory}
                                className="px-4 py-1.5 border border-gray-400 bg-white text-primary font-black uppercase text-xs tracking-widest flex items-center gap-1.5 hover:bg-gray-50 transition-all active:scale-95 shadow-sm"
                            >
                                <PrintIcon />
                                PRINT
                            </button>

                            <button
                                onClick={() => setIsSyncMasterModalOpen(true)}
                                className="px-4 py-1.5 border border-gray-400 bg-white text-primary font-black uppercase text-xs tracking-widest hover:bg-gray-50 transition-all active:scale-95 shadow-sm"
                                title="Reconcile inventory rows with Material Master"
                            >
                                Sync to Master
                            </button>

                            <button onClick={() => setIsAddModalOpen(true)} className="px-4 py-1.5 tally-button-accent text-xs font-black uppercase tracking-widest">F2: ADD INVENTORY</button>
                        </div>
                    </div>

                    <div className="flex-1 overflow-auto bg-white" style={{ minHeight: `${rowsPerPage * 42}px` }}>
                        <table className="min-w-full border-collapse whitespace-nowrap">
                            <thead className="bg-[#e1e1e1] sticky top-0 z-10">
                                <tr className={`${uniformTextStyle} text-gray-700 border-b border-gray-400`}>
                                    <th className="py-1.5 px-2 border-r border-gray-400 w-10 text-center">#</th>
                                    {isFieldVisible('colName') && <th className="py-1.5 px-2 border-r border-gray-400 text-left min-w-[360px]">Item Name</th>}
                                    {isFieldVisible('colCategory') && <th className="py-1.5 px-2 border-r border-gray-400 text-left w-20">Category</th>}
                                    {isFieldVisible('colManufacturer') && <th className="py-1.5 px-2 border-r border-gray-400 text-left w-28">Manufacturer</th>}
                                    {isFieldVisible('colHsn') && <th className="py-1.5 px-2 border-r border-gray-400 text-center w-12">HSN</th>}
                                    {isFieldVisible('colBarcode') && <th className="py-1.5 px-2 border-r border-gray-400 text-center w-24">Barcode</th>}
                                    {isFieldVisible('colBatch') && <th className="py-1.5 px-2 border-r border-gray-400 text-center w-20">Batch</th>}
                                    {isFieldVisible('colStrips') && <th className="py-1.5 px-2 border-r border-gray-400 text-center w-12">Pack qty</th>}
                                    {isFieldVisible('colLoose') && <th className="py-1.5 px-2 border-r border-gray-400 text-center w-12">Loose qty</th>}
                                    {isFieldVisible('colStock') && <th className="py-1.5 px-2 border-r border-gray-400 text-right w-20">Total Stock</th>}
                                    {isFieldVisible('colBaseUnit') && <th className="py-1.5 px-2 border-r border-gray-400 text-center w-16">B.Unit</th>}
                                    {isFieldVisible('colPtr') && <th className="py-1.5 px-2 border-r border-gray-400 text-right w-24">PTR</th>}
                                    {isFieldVisible('colMrp') && <th className="py-1.5 px-2 border-r border-gray-400 text-right w-24">MRP</th>}
                                    {isFieldVisible('colRateA') && <th className="py-1.5 px-2 border-r border-gray-400 text-right w-24">Rate A</th>}
                                    {isFieldVisible('colRateB') && <th className="py-1.5 px-2 border-r border-gray-400 text-right w-24">Rate B</th>}
                                    {isFieldVisible('colRateC') && <th className="py-1.5 px-2 border-r border-gray-400 text-right w-24">Rate C</th>}
                                    {isFieldVisible('colValue') && <th className="py-1.5 px-2 border-r border-gray-400 text-right w-24">Value</th>}
                                    {isFieldVisible('colExpiry') && <th className="py-1.5 px-2 border-r border-gray-400 text-center w-16">Expiry</th>}
                                    <th className="py-1.5 px-2 text-right w-16">Actions</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200" ref={tableBodyRef}>
                                {paginatedItems.map((row, idx) => {
                                    const item = row.representative;
                                    const { 
                                        effectivePackType, 
                                        effectiveUnitsPerPack, 
                                        effectiveHsnCode, 
                                        effectiveMrp, 
                                        effectiveGst,
                                        effectiveRateA,
                                        effectiveRateB,
                                        effectiveRateC
                                    } = getEffectiveFields(item);
                                    const uPP = effectiveUnitsPerPack;
                                    const totalStrips = row.totalPackQty;
                                    const freeUnits = Math.min(item.stock, Number(item.purchaseFree || 0));
                                    const freeStrips = Math.floor(freeUnits / uPP);
                                    const paidStrips = totalStrips - freeStrips;
                                    const loose = row.totalLooseQty;
                                    const isLow = row.totalStock <= item.minStockLimit;
                                    const isSelected = idx === selectedIndex;

                                    return (
                                        <tr 
                                            key={item.id} 
                                            data-row-index={idx}
                                            className={`transition-colors group cursor-pointer border-b border-gray-100 hover:bg-primary hover:text-white ${
                                                isSelected 
                                                ? 'bg-primary text-white shadow-md' 
                                                : isLow 
                                                ? 'bg-red-50/20' 
                                                : ''
                                            }`} 
                                            onClick={() => {
                                                setSelectedIndex(idx);
                                            }}
                                        >
                                            <td className={`py-1.5 px-2 border-r border-gray-200 text-center ${isSelected ? 'text-white' : 'group-hover:text-white text-gray-400'} ${uniformTextStyle}`}>{((currentPage - 1) * rowsPerPage) + idx + 1}</td>
                                            
                                            {isFieldVisible('colName') && (
                                                <td className="py-1 px-2 border-r border-gray-200">
                                                    <div className={`${isSelected ? 'text-white' : 'group-hover:text-white text-gray-900'} leading-tight ${uniformTextStyle}`}>{item.name}</div>
                                                </td>
                                            )}

                                            {isFieldVisible('colCategory') && <td className={`py-1 px-2 border-r border-gray-200 ${isSelected ? 'text-white' : 'group-hover:text-white text-gray-600'} ${uniformTextStyle}`}>{item.category}</td>}
                                            {isFieldVisible('colManufacturer') && <td className={`py-1 px-2 border-r border-gray-200 ${isSelected ? 'text-white' : 'group-hover:text-white text-gray-600'} ${uniformTextStyle}`}>{item.manufacturer}</td>}
                                            {isFieldVisible('colHsn') && <td className={`py-1 px-2 border-r border-gray-200 text-center ${isSelected ? 'text-white' : 'group-hover:text-white text-gray-600'} ${uniformTextStyle}`}>{effectiveHsnCode}</td>}
                                            {isFieldVisible('colBarcode') && <td className={`py-1 px-2 border-r border-gray-200 text-center ${isSelected ? 'text-white' : 'group-hover:text-white text-gray-600'} ${uniformTextStyle}`}>{item.barcode}</td>}
                                            {isFieldVisible('colBatch') && <td className={`py-1 px-2 border-r border-gray-200 text-center font-mono ${uniformTextStyle} ${isSelected ? 'text-white' : 'group-hover:text-white text-primary'}`}>{row.batchLabel}</td>}
                                            {isFieldVisible('colStrips') && (
                                                <td className={`py-1 px-2 border-r border-gray-200 text-center ${isSelected ? 'text-white' : 'group-hover:text-white text-gray-600'} ${uniformTextStyle}`}>
                                                    {totalStrips}
                                                </td>
                                            )}
                                            {isFieldVisible('colLoose') && <td className={`py-1 px-2 border-r border-gray-200 text-center ${isSelected ? 'text-white' : 'group-hover:text-white text-gray-600'} ${uniformTextStyle}`}>{loose}</td>}
                                            {isFieldVisible('colStock') && <td className={`py-1 px-2 border-r border-gray-200 text-right ${uniformTextStyle} ${isSelected ? 'text-white' : (isLow ? 'text-red-700 font-bold group-hover:text-white' : 'text-emerald-700 group-hover:text-white')}`}>{row.totalStock}</td>}
                                            {isFieldVisible('colBaseUnit') && <td className={`py-1 px-2 border-r border-gray-200 text-center ${isSelected ? 'text-white' : 'group-hover:text-white text-gray-600'} ${uniformTextStyle}`}>{item.baseUnit}</td>}
                                            {isFieldVisible('colPtr') && <td className={`py-1 px-2 border-r border-gray-200 text-right ${isSelected ? 'text-white' : 'group-hover:text-white text-gray-900'} ${uniformTextStyle}`}>₹{(item.ptr || 0).toFixed(2)}</td>}
                                            {isFieldVisible('colMrp') && <td className={`py-1 px-2 border-r border-gray-200 text-right ${isSelected ? 'text-white' : row.hasMixedMrp ? 'group-hover:text-white text-orange-600 font-bold' : 'group-hover:text-white text-gray-900'} ${uniformTextStyle}`}>{row.mrpLabel}</td>}
                                            {isFieldVisible('colRateA') && <td className={`py-1 px-2 border-r border-gray-200 text-right ${isSelected ? 'text-white' : row.hasMixedRate ? 'group-hover:text-white text-orange-600 font-bold' : 'group-hover:text-white text-gray-900'} ${uniformTextStyle}`}>{row.rateALabel}</td>}
                                            {isFieldVisible('colRateB') && <td className={`py-1 px-2 border-r border-gray-200 text-right ${isSelected ? 'text-white' : row.hasMixedRate ? 'group-hover:text-white text-orange-600 font-bold' : 'group-hover:text-white text-gray-900'} ${uniformTextStyle}`}>{row.rateBLabel}</td>}
                                            {isFieldVisible('colRateC') && <td className={`py-1 px-2 border-r border-gray-200 text-right ${isSelected ? 'text-white' : row.hasMixedRate ? 'group-hover:text-white text-orange-600 font-bold' : 'group-hover:text-white text-gray-900'} ${uniformTextStyle}`}>{row.rateCLabel}</td>}
                                            {isFieldVisible('colValue') && <td className={`py-1 px-2 border-r border-gray-200 text-right ${isSelected ? 'text-white' : 'group-hover:text-white text-gray-900'} ${uniformTextStyle}`}>₹{row.totalValue.toFixed(2)}</td>}
                                            {isFieldVisible('colExpiry') && (
                                                <td className={`py-1 px-2 border-r border-gray-200 text-center ${isSelected ? 'text-white' : 'group-hover:text-white text-gray-900'} ${uniformTextStyle}`}>
                                                    {formatExpiryToMMYY(item.expiry)}
                                                </td>
                                            )}
                                            
                                            <td className="py-1 px-2 text-right">
                                                <button 
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setItemToEdit({
                                                            ...item,
                                                            packType: effectivePackType,
                                                            unitsPerPack: effectiveUnitsPerPack,
                                                            gstPercent: effectiveGst,
                                                            hsnCode: effectiveHsnCode,
                                                            mrp: effectiveMrp,
                                                            rateA: effectiveRateA,
                                                            rateB: effectiveRateB,
                                                            rateC: effectiveRateC,
                                                        });
                                                    }}
                                                    className={`font-black uppercase text-[10px] px-2 py-0.5 border transition-all ${isSelected ? 'bg-white text-primary border-white' : 'bg-primary/5 text-primary border-primary/20 group-hover:bg-white group-hover:text-primary group-hover:border-white'}`}
                                                >
                                                    Alter
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                                {groupedItems.length === 0 && (
                                    <tr>
                                        <td colSpan={25} className="p-20 text-center text-gray-300 font-black uppercase tracking-[0.4em] italic text-sm">
                                            No matching items found
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>

                    {/* Pagination Footer */}
                    {totalPages > 1 && (
                        <div className="p-2 bg-gray-100 border-t border-gray-400 flex justify-between items-center flex-shrink-0">
                            <div className="text-[10px] font-black uppercase text-gray-500 tracking-widest ml-2">
                                Showing {paginatedItems.length} of {groupedItems.length} items · {rowsPerPage} per page
                            </div>
                            <div className="flex items-center gap-1">
                                <button 
                                    disabled={currentPage === 1}
                                    onClick={() => { setCurrentPage(prev => Math.max(1, prev - 1)); setSelectedIndex(0); }}
                                    className="px-4 h-8 border border-gray-400 bg-white text-[10px] font-black uppercase disabled:opacity-30 hover:bg-gray-50 transition-colors shadow-sm"
                                >
                                    Prev
                                </button>
                                
                                <div className="flex items-center gap-1 mx-2">
                                    {renderPageNumbers()}
                                </div>

                                <button 
                                    disabled={currentPage === totalPages}
                                    onClick={() => { setCurrentPage(prev => Math.min(totalPages, prev + 1)); setSelectedIndex(0); }}
                                    className="px-4 h-8 border border-gray-400 bg-white text-[10px] font-black uppercase disabled:opacity-30 hover:bg-gray-50 transition-colors shadow-sm"
                                >
                                    Next
                                </button>
                            </div>
                            <div className="text-[9px] font-bold text-gray-400 uppercase mr-2 italic">
                                Use ← → keys to flip pages
                            </div>
                        </div>
                    )}
                </Card>

                <div className="bg-[#e5f0f0] p-4 tally-border flex justify-between items-center text-base font-normal uppercase flex-shrink-0">
                    <div className="flex gap-12">
                        <span>Total Stock Valuation: <span className="text-blue-900">₹{totalValuation.toLocaleString()}</span></span>
                        <span>Low Stock Alert: <span className="text-red-600">{groupedItems.filter(i => i.totalStock <= i.representative.minStockLimit).length}</span></span>
                    </div>
                    <div className="flex items-center gap-6">
                        <span className="opacity-40">Navigate with ↑ ↓ and press Enter for batch-wise detail</span>
                        <span className="opacity-40">ERP Engine v1.0.8</span>
                    </div>
                </div>
            </div>

            {isAddModalOpen && <AddProductModal isOpen={isAddModalOpen} onClose={() => setIsAddModalOpen(false)} onAddProduct={onAddProduct} organizationId={currentUser?.organization_id || ''} medicines={medicines} />}
            {itemToEdit && (
                <EditProductModal
                    isOpen={!!itemToEdit}
                    onClose={() => setItemToEdit(null)}
                    onSave={onUpdateProduct}
                    productToEdit={itemToEdit}
                    onPrintBarcodeClick={() => {}}
                    onNext={handleNextProduct}
                    onPrevious={handlePreviousProduct}
                    hasNext={selectedIndex < paginatedItems.length - 1 || currentPage < totalPages}
                    hasPrevious={selectedIndex > 0 || currentPage > 1}
                    inventory={inventory}
                    medicines={medicines}
                    currentUser={currentUser}
                    addNotification={addNotification}
                    onRefresh={onRefresh}
                    onAddMedicineMaster={onAddMedicineMaster}
                />
            )}
            {isExportModalOpen && (
                <ExportInventoryModal 
                    isOpen={isExportModalOpen}
                    onClose={() => setIsExportModalOpen(false)}
                    data={filteredItems}
                    pharmacyName={currentUser?.pharmacy_name || 'MDXERA ERP'}
                />
            )}
            <MrpChangeLogModal isOpen={isMrpLogOpen} onClose={() => setIsMrpLogOpen(false)} logs={mrpChangeLogs} />
            {isSyncMasterModalOpen && (
                <SyncMaterialMasterModal
                    isOpen={isSyncMasterModalOpen}
                    onClose={() => setIsSyncMasterModalOpen(false)}
                    inventory={inventory}
                    medicines={medicines}
                    currentUser={currentUser}
                    addNotification={addNotification ?? (() => {})}
                    onRefresh={async () => { await onRefresh?.(); }}
                />
            )}
            <InventoryBatchDetailModal
                isOpen={!!detailRow}
                onClose={() => setDetailRowKey(null)}
                itemName={detailRow?.name || ''}
                rows={detailRow?.items || []}
                onSaveRow={onUpdateProduct}
            />
        </main>
    );
};

export default Inventory;
