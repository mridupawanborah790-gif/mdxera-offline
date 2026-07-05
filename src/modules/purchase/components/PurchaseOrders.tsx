import React, { useState, useMemo, useEffect, useRef } from 'react';
import Card from '@core/components/ui/Card';
import Modal from '@core/components/ui/Modal';
import type { Distributor, InventoryItem, PurchaseOrderItem, PurchaseOrder, Medicine, SupplierProductMap, Purchase } from '@core/types';
import { PurchaseOrderStatus } from '@core/types';
import SharePurchaseOrderModal from '../components/SharePurchaseOrderModal';
import { parseNetworkAndApiError } from '@core/utils/error';

interface PurchaseOrdersProps {
  distributors: Distributor[];
  inventory: InventoryItem[];
  medicines: Medicine[];
  mappings: SupplierProductMap[];
  purchaseOrders: PurchaseOrder[];
  onAddPurchaseOrder: (po: Omit<PurchaseOrder, 'id' | 'serialId'>, serialId: string) => void;
  onReservePONumber: () => Promise<string>;
  onUpdatePurchaseOrder: (po: PurchaseOrder) => void;
  onPostReceivedEntry: (po: PurchaseOrder) => void;
  onAdjustReceivedEntry: (po: PurchaseOrder, purchaseBill: Purchase) => Promise<void>;
  onPrintPurchaseOrder: (po: PurchaseOrder) => void;
  onCancelPurchaseOrder: (poId: string) => void;
  purchases: Purchase[];
  addNotification: (message: string, type?: 'success' | 'error' | 'warning') => void;
  draftItems: PurchaseOrderItem[] | null;
  onClearDraft: () => void;
  initialStatusFilter?: PurchaseOrderStatus | 'all';
  setIsDirty: (isDirty: boolean) => void;
  currentUserPharmacyName: string;
  currentUserEmail: string;
  currentUserOrgId?: string;
}

type SearchCatalogItem = {
  id: string;
  name: string;
  code?: string;
  sku?: string;
  supplierItemName?: string;
  source: 'inventory' | 'material';
  inventoryItem?: InventoryItem;
  medicine?: Medicine;
  mappedSupplierIds: string[];
  currentStock?: number;
  minStockLimit?: number;
  shortageQty?: number;
};

type GridColumnKey =
    | 'name'
    | 'itemCode'
    | 'supplierItemName'
    | 'packType'
    | 'unitOfMeasurement'
    | 'quantity'
    | 'freeQuantity'
    | 'estimatedRate'
    | 'discountPercent'
    | 'gstPercent'
    | 'expectedDeliveryDate'
    | 'notes';

const GRID_COLUMN_ORDER: GridColumnKey[] = [
    'name',
    'itemCode',
    'packType',
    'quantity',
    'freeQuantity',
    'estimatedRate',
    'discountPercent',
    'gstPercent',
    'expectedDeliveryDate',
    'notes'
];

const generateSafeUUID = () => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

const getDefaultOrderDate = () => new Date().toISOString().split('T')[0];

const createEmptyLineItem = (): PurchaseOrderItem => ({
  id: generateSafeUUID(),
  name: '',
  brand: '',
  quantity: 0,
  freeQuantity: 0,
  purchasePrice: 0,
  estimatedRate: 0,
  discountPercent: 0,
  gstPercent: 0,
  lineAmount: 0,
  discountAmount: 0,
  gstAmount: 0,
  estimatedAmount: 0,
  expectedDeliveryDate: '',
  notes: ''
});

const isLineItemEmpty = (line: PurchaseOrderItem): boolean => {
    const hasText = [
        line.name,
        line.brand,
        line.itemCode,
        line.sku,
        line.supplierItemName,
        line.packType,
        line.unitOfMeasurement,
        line.expectedDeliveryDate,
        line.notes
    ].some(value => (value || '').toString().trim().length > 0);

    const hasNumbers = [
        Number(line.quantity || 0),
        Number(line.freeQuantity || 0),
        Number(line.estimatedRate ?? line.purchasePrice ?? 0),
        Number(line.discountPercent || 0),
        Number(line.gstPercent || 0),
        Number(line.mrp || 0)
    ].some(value => value > 0);

    return !hasText && !hasNumbers && !line.inventoryItemId && !line.medicineId;
};

const isLineItemComplete = (line: PurchaseOrderItem): boolean => {
    if (!line.name?.trim()) return false;
    if (Number(line.quantity || 0) <= 0) return false;
    const rate = Number(line.estimatedRate ?? line.purchasePrice ?? 0);
    return Number.isFinite(rate) && rate >= 0;
};

const normalizeLineItems = (rows: PurchaseOrderItem[]): PurchaseOrderItem[] => {
    const nonEmptyRows = rows.filter(row => !isLineItemEmpty(row));
    return [...nonEmptyRows, createEmptyLineItem()];
};

const PurchaseOrdersPage = React.forwardRef<any, PurchaseOrdersProps>(({ 
    distributors, 
    inventory,
    medicines,
    mappings,
    purchaseOrders, 
    onAddPurchaseOrder, 
    onReservePONumber,
    onUpdatePurchaseOrder, 
    onPostReceivedEntry,
    onAdjustReceivedEntry,
    onPrintPurchaseOrder, 
    onCancelPurchaseOrder, 
    purchases,
    addNotification,
    draftItems, 
    onClearDraft, 
    initialStatusFilter = 'all', 
    setIsDirty, 
    currentUserPharmacyName, 
    currentUserEmail,
    currentUserOrgId
}, ref) => {
    const [view, setView] = useState<'list' | 'create'>('list');

    const [statusFilter, setStatusFilter] = useState<PurchaseOrderStatus | 'all'>(initialStatusFilter);
    const [selectedPO, setSelectedPO] = useState<PurchaseOrder | null>(null);
    const [isShareModalOpen, setIsShareModalOpen] = useState(false);
    const [receiveFlowPO, setReceiveFlowPO] = useState<PurchaseOrder | null>(null);
    const [isAdjustModalOpen, setIsAdjustModalOpen] = useState(false);
    const [adjustSearchSystemId, setAdjustSearchSystemId] = useState('');
    const [adjustSearchSupplierBillId, setAdjustSearchSupplierBillId] = useState('');
    const [selectedAdjustBillId, setSelectedAdjustBillId] = useState<string | null>(null);
    const [isAdjusting, setIsAdjusting] = useState(false);

    const [selectedDistributorId, setSelectedDistributorId] = useState('');
    const [orderDate, setOrderDate] = useState(getDefaultOrderDate());
    const [items, setItems] = useState<PurchaseOrderItem[]>([]);
    const [remarks, setRemarks] = useState('');
    const [poSerialId, setPoSerialId] = useState('NO.NEW');
    const [editingPO, setEditingPO] = useState<PurchaseOrder | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [isMatrixOpen, setIsMatrixOpen] = useState(false);
    const [matrixMode, setMatrixMode] = useState<'all' | 'lowStock'>('all');
    const [matrixSearchTerm, setMatrixSearchTerm] = useState('');
    const [selectedMatrixIndex, setSelectedMatrixIndex] = useState(0);
    const [selectedMatrixItemIds, setSelectedMatrixItemIds] = useState<string[]>([]);
    const [activeMatrixRowId, setActiveMatrixRowId] = useState<string | null>(null);
    const [activeCell, setActiveCell] = useState<{ rowId: string; column: GridColumnKey } | null>(null);

    const supplierSelectRef = useRef<HTMLSelectElement>(null);
    const matrixSearchRef = useRef<HTMLInputElement>(null);
    const cellInputRefs = useRef<Record<string, Partial<Record<GridColumnKey, HTMLInputElement | null>>>>({});

    const setCellRef = (rowId: string, column: GridColumnKey, node: HTMLInputElement | null) => {
        if (!cellInputRefs.current[rowId]) cellInputRefs.current[rowId] = {};
        cellInputRefs.current[rowId][column] = node;
    };

    const isEditableCell = (node: HTMLInputElement | null | undefined) => Boolean(node && !node.disabled && !node.readOnly);

    const focusCell = (rowId: string, column: GridColumnKey): boolean => {
        const node = cellInputRefs.current[rowId]?.[column];
        if (!isEditableCell(node)) return false;
        node!.focus();
        node!.select?.();
        return true;
    };

    const focusFirstEditableCellInRow = (rowId: string): boolean => {
        for (const column of GRID_COLUMN_ORDER) {
            if (focusCell(rowId, column)) return true;
        }
        return false;
    };

    const getCellClassName = (rowId: string, column: GridColumnKey, base: string) =>
        `${base} ${activeCell?.rowId === rowId && activeCell.column === column ? 'bg-blue-50 ring-2 ring-blue-500 ring-inset' : ''}`;

    const resetCreateForm = () => {
        setSelectedDistributorId('');
        setOrderDate(getDefaultOrderDate());
        setItems([createEmptyLineItem()]);
        setRemarks('');
        setPoSerialId('NO.NEW');
        setEditingPO(null);
        onClearDraft();
    };

    const ensurePONumber = async (): Promise<string> => {
        if (poSerialId && poSerialId !== 'NO.NEW') return poSerialId;
        const nextNumber = (await onReservePONumber())?.trim();
        if (!nextNumber) throw new Error('PO number / serial id could not be generated.');
        setPoSerialId(nextNumber);
        return nextNumber;
    };

    const filteredPOList = useMemo(() => {
        const list = Array.isArray(purchaseOrders) ? [...purchaseOrders] : [];
        const filtered = statusFilter === 'all' 
            ? list 
            : list.filter(po => po && po.status === statusFilter);

        return filtered.sort((a, b) => {
            const dateA = a?.date ? new Date(a.date).getTime() : 0;
            const dateB = b?.date ? new Date(b.date).getTime() : 0;
            if (isNaN(dateA)) return 1;
            if (isNaN(dateB)) return -1;
            return dateB - dateA;
        });
    }, [purchaseOrders, statusFilter]);

    const adjustCandidates = useMemo(() => {
        const systemTerm = (adjustSearchSystemId || '').trim().toLowerCase();
        const supplierBillTerm = (adjustSearchSupplierBillId || '').trim().toLowerCase();
        const list = Array.isArray(purchases) ? purchases : [];

        return list
            .filter(p => p && p.status !== 'cancelled')
            .filter(p => {
                const systemIdMatch = !systemTerm || (p.purchaseSerialId || '').toLowerCase().includes(systemTerm);
                const supplierBillMatch = !supplierBillTerm || (p.invoiceNumber || '').toLowerCase().includes(supplierBillTerm);
                return systemIdMatch && supplierBillMatch;
            })
            .sort((a, b) => {
                const dateA = a?.date ? new Date(a.date).getTime() : 0;
                const dateB = b?.date ? new Date(b.date).getTime() : 0;
                if (isNaN(dateA)) return 1;
                if (isNaN(dateB)) return -1;
                return dateB - dateA;
            })
            .slice(0, 30);
    }, [purchases, adjustSearchSystemId, adjustSearchSupplierBillId]);

    useEffect(() => {
        if (Array.isArray(draftItems) && draftItems.length > 0) {
            setItems(normalizeLineItems(draftItems.map(item => ({
                ...createEmptyLineItem(),
                ...item,
                freeQuantity: Number((item as any).freeQuantity ?? (item as any).freeQty ?? 0),
                id: item.id || generateSafeUUID()
            }))));
            setView('create');
        }
    }, [draftItems]);

    useEffect(() => {
        if (view === 'create' && (!items || items.length === 0)) {
            setItems([createEmptyLineItem()]);
        }
    }, [view, items]);

    useEffect(() => {
        if (view !== 'create') return;
        if (poSerialId !== 'NO.NEW') return;
        ensurePONumber().catch((error) => {
            console.error('Failed to pre-generate PO number.', error);
        });
    }, [view, poSerialId]);

    useEffect(() => {
        if (view === 'create') {
            setTimeout(() => supplierSelectRef.current?.focus(), 120);
        }
    }, [view]);

    const catalog = useMemo(() => {
        const byKey = new Map<string, SearchCatalogItem>();
        const mappedByMedicine = new Map<string, SupplierProductMap[]>();
        
        const safeMappings = Array.isArray(mappings) ? mappings : [];
        const safeInventory = Array.isArray(inventory) ? inventory : [];
        const safeMedicines = Array.isArray(medicines) ? medicines : [];

        for (const map of safeMappings) {
            if (!map?.master_medicine_id) continue;
            if (!mappedByMedicine.has(map.master_medicine_id)) mappedByMedicine.set(map.master_medicine_id, []);
            mappedByMedicine.get(map.master_medicine_id)!.push(map);
        }

        for (const inv of safeInventory) {
            if (!inv) continue;
            const key = (inv.code || inv.name || '').trim().toUpperCase();
            if (!key) continue;
            
            const existing = byKey.get(key);
            const mappedSupplierIds = safeMappings
              .filter(m => m && (m.supplier_product_name || '').trim().toUpperCase() === (inv.name || '').trim().toUpperCase())
              .map(m => m.supplier_id);

            if (existing) {
                existing.inventoryItem = inv;
                existing.mappedSupplierIds = [...new Set([...(existing.mappedSupplierIds || []), ...mappedSupplierIds])];
                continue;
            }

            byKey.set(key, {
                id: key,
                name: inv.name || 'Unnamed Item',
                code: inv.code,
                sku: inv.code,
                source: 'inventory',
                inventoryItem: inv,
                mappedSupplierIds,
                currentStock: Number(inv.stock || 0),
                minStockLimit: Number(inv.minStockLimit || 0),
                shortageQty: Math.max(0, Number(inv.minStockLimit || 0) - Number(inv.stock || 0))
            });
        }

        for (const med of safeMedicines) {
            if (!med) continue;
            const key = (med.materialCode || med.name || '').trim().toUpperCase();
            if (!key) continue;

            const medMappings = mappedByMedicine.get(med.id) || [];
            const mappedSupplierIds = medMappings.map(m => m.supplier_id);
            const supplierItemName = medMappings[0]?.supplier_product_name;
            const existing = byKey.get(key);
            if (existing) {
                existing.medicine = med;
                existing.mappedSupplierIds = [...new Set([...(existing.mappedSupplierIds || []), ...mappedSupplierIds])];
                if (!existing.supplierItemName && supplierItemName) existing.supplierItemName = supplierItemName;
                continue;
            }

            byKey.set(key, {
                id: key,
                name: med.name || 'Unnamed Material',
                code: med.materialCode,
                sku: med.materialCode,
                supplierItemName,
                source: 'material',
                medicine: med,
                mappedSupplierIds
            });
        }

        return Array.from(byKey.values());
    }, [inventory, medicines, mappings]);

    const matrixResults = useMemo(() => {
        const lower = matrixSearchTerm.trim().toLowerCase();
        const baseSource = matrixMode === 'lowStock'
            ? catalog.filter(c => {
                const min = Number(c.minStockLimit || c.inventoryItem?.minStockLimit || 0);
                const stock = Number(c.currentStock ?? c.inventoryItem?.stock ?? 0);
                return min > 0 && stock <= min;
            })
            : catalog;

        const source = lower
            ? baseSource.filter(c =>
                c.name.toLowerCase().includes(lower) ||
                (c.code || '').toLowerCase().includes(lower) ||
                (c.sku || '').toLowerCase().includes(lower) ||
                (c.supplierItemName || '').toLowerCase().includes(lower)
            )
            : baseSource;

        return source
            .map(c => ({
                ...c,
                supplierBoost: selectedDistributorId && c.mappedSupplierIds.includes(selectedDistributorId) ? 100 : 0
            }))
            .sort((a, b) => b.supplierBoost - a.supplierBoost || a.name.localeCompare(b.name))
            .slice(0, 50);
    }, [catalog, matrixSearchTerm, selectedDistributorId, matrixMode]);

    const recalculateLine = (line: PurchaseOrderItem): PurchaseOrderItem => {
        const qty = Number(line.quantity || 0);
        const freeQty = Number((line as any).freeQuantity ?? (line as any).freeQty ?? 0);
        const rate = Number(line.estimatedRate ?? line.purchasePrice ?? 0);
        const discPct = Number(line.discountPercent || 0);
        const gstPct = Number(line.gstPercent || 0);

        const lineAmount = qty * rate;
        const discountAmount = lineAmount * (discPct / 100);
        const taxable = lineAmount - discountAmount;
        const gstAmount = taxable * (gstPct / 100);
        const estimatedAmount = taxable + gstAmount;

        return {
            ...line,
            freeQuantity: freeQty,
            purchasePrice: rate,
            lineAmount,
            discountAmount,
            gstAmount,
            estimatedAmount
        };
    };

    const pickCatalogItemForRow = (picked: SearchCatalogItem, rowId: string) => {
        const inv = picked.inventoryItem;
        const med = picked.medicine;
        setItems(prev => {
            const updated = prev.map(line => {
                if (line.id !== rowId) return line;
                return recalculateLine({
                    ...line,
                    inventoryItemId: inv?.id,
                    medicineId: med?.id,
                    name: picked.name,
                    itemCode: picked.code || inv?.code || med?.materialCode || line.itemCode,
                    sku: picked.sku || inv?.code || med?.materialCode || line.sku,
                    supplierItemName: picked.supplierItemName || line.supplierItemName,
                    brand: inv?.brand || med?.brand || line.brand || '',
                    quantity: line.quantity > 0
                        ? line.quantity
                        : (matrixMode === 'lowStock'
                            ? Math.max(1, Number(picked.shortageQty || 0))
                            : 1),
                    estimatedRate: Number(inv?.purchasePrice || med?.rateA || line.estimatedRate || line.purchasePrice || 0),
                    purchasePrice: Number(inv?.purchasePrice || med?.rateA || line.purchasePrice || 0),
                    packType: inv?.packType || med?.pack || line.packType || '',
                    unitOfMeasurement: inv?.unitOfMeasurement || inv?.packUnit || line.unitOfMeasurement || 'Unit',
                    manufacturer: inv?.manufacturer || med?.manufacturer || line.manufacturer,
                    hsnCode: inv?.hsnCode || med?.hsnCode || line.hsnCode || '',
                    mrp: Number(inv?.mrp || med?.mrp || line.mrp || 0),
                    gstPercent: Number(inv?.gstPercent || med?.gstRate || line.gstPercent || 0),
                    expectedDeliveryDate: line.expectedDeliveryDate || orderDate,
                });
            });
            return normalizeLineItems(updated);
        });
        setIsMatrixOpen(false);
        setSelectedMatrixIndex(0);
        setActiveMatrixRowId(null);
        requestAnimationFrame(() => {
            const currentColIndex = GRID_COLUMN_ORDER.indexOf('name');
            let moved = false;
            for (let col = currentColIndex + 1; col < GRID_COLUMN_ORDER.length; col++) {
                if (focusCell(rowId, GRID_COLUMN_ORDER[col])) {
                    moved = true;
                    break;
                }
            }
            if (!moved) {
                focusFirstEditableCellInRow(rowId);
            }
        });
    };

    const toggleMatrixSelection = (itemId: string) => {
        setSelectedMatrixItemIds(prev => prev.includes(itemId) ? prev.filter(id => id !== itemId) : [...prev, itemId]);
    };

    const handleAddSelectedMatrixItems = () => {
        if (matrixMode !== 'lowStock') return;
        const selectedItems = matrixResults.filter(item => selectedMatrixItemIds.includes(item.id));
        if (selectedItems.length === 0) return;

        const normalizeToken = (value?: string) => (value || '').trim().toUpperCase();
        let mergedCount = 0;

        setItems(prev => {
            const nextRows = [...prev];

            selectedItems.forEach(picked => {
                const inv = picked.inventoryItem;
                const med = picked.medicine;
                const suggestedQty = Math.max(0, Number(picked.shortageQty ?? 0));
                const defaultQty = suggestedQty > 0 ? suggestedQty : 1;
                const pickCode = normalizeToken(picked.code || picked.sku || inv?.code || med?.materialCode);
                const pickName = normalizeToken(picked.name);

                const existingIdx = nextRows.findIndex(line => {
                    if (isLineItemEmpty(line)) return false;
                    if (inv?.id && line.inventoryItemId === inv.id) return true;
                    if (med?.id && line.medicineId === med.id) return true;
                    const lineCode = normalizeToken(line.itemCode || line.sku);
                    const lineName = normalizeToken(line.name);
                    return (pickCode && lineCode === pickCode) || (pickName && lineName === pickName);
                });

                if (existingIdx >= 0) {
                    const existingRow = nextRows[existingIdx];
                    nextRows[existingIdx] = recalculateLine({
                        ...existingRow,
                        quantity: Number(existingRow.quantity || 0) + defaultQty
                    });
                    mergedCount += 1;
                    return;
                }

                const blankIdx = nextRows.findIndex(line => isLineItemEmpty(line));
                const targetIdx = blankIdx >= 0 ? blankIdx : nextRows.length;
                const baseLine = blankIdx >= 0 ? nextRows[blankIdx] : createEmptyLineItem();

                nextRows[targetIdx] = recalculateLine({
                    ...baseLine,
                    inventoryItemId: inv?.id,
                    medicineId: med?.id,
                    name: picked.name,
                    itemCode: picked.code || inv?.code || med?.materialCode || baseLine.itemCode,
                    sku: picked.sku || inv?.code || med?.materialCode || baseLine.sku,
                    supplierItemName: picked.supplierItemName || baseLine.supplierItemName,
                    brand: inv?.brand || med?.brand || baseLine.brand || '',
                    quantity: defaultQty,
                    estimatedRate: Number(inv?.purchasePrice || med?.rateA || baseLine.estimatedRate || baseLine.purchasePrice || 0),
                    purchasePrice: Number(inv?.purchasePrice || med?.rateA || baseLine.purchasePrice || 0),
                    packType: inv?.packType || med?.pack || baseLine.packType || '',
                    unitOfMeasurement: inv?.unitOfMeasurement || inv?.packUnit || baseLine.unitOfMeasurement || 'Unit',
                    manufacturer: inv?.manufacturer || med?.manufacturer || baseLine.manufacturer,
                    hsnCode: inv?.hsnCode || med?.hsnCode || baseLine.hsnCode || '',
                    mrp: Number(inv?.mrp || med?.mrp || baseLine.mrp || 0),
                    gstPercent: Number(inv?.gstPercent || med?.gstRate || baseLine.gstPercent || 0),
                    expectedDeliveryDate: baseLine.expectedDeliveryDate || orderDate
                });
            });
            return normalizeLineItems(nextRows);
        });

        if (mergedCount > 0) {
            alert(`${mergedCount} selected item(s) already existed in this order, so quantity was increased instead of adding duplicate rows.`);
        }

        setIsMatrixOpen(false);
        setSelectedMatrixIndex(0);
        setSelectedMatrixItemIds([]);
        requestAnimationFrame(() => {
            const trailingBlank = items.find(line => isLineItemEmpty(line)) || items[items.length - 1];
            if (trailingBlank?.id) {
                focusCell(trailingBlank.id, 'name');
            }
        });
    };

    const openMatrixForRow = (rowId: string, initialTerm = '', mode: 'all' | 'lowStock' = 'all') => {
        setActiveMatrixRowId(rowId);
        setMatrixSearchTerm(initialTerm);
        setMatrixMode(mode);
        setSelectedMatrixIndex(0);
        setSelectedMatrixItemIds([]);
        setIsMatrixOpen(true);
        requestAnimationFrame(() => matrixSearchRef.current?.focus());
    };

    const handleUpdateItem = (id: string, field: keyof PurchaseOrderItem, value: any) => {
        setItems(prev => {
            const updated = prev.map(i => i.id === id ? recalculateLine({ ...i, [field]: value }) : i);
            return normalizeLineItems(updated);
        });
    };

    const handleRemoveItem = (id: string, preferredColumn?: GridColumnKey) => {
        const currentRows = [...items];
        const removedIndex = currentRows.findIndex(row => row.id === id);
        setItems(prev => normalizeLineItems(prev.filter(i => i.id !== id)));
        requestAnimationFrame(() => {
            const nextRow = currentRows[removedIndex + 1] || currentRows[Math.max(removedIndex - 1, 0)];
            const targetRowId = nextRow?.id;
            if (!targetRowId) return;
            if (preferredColumn && focusCell(targetRowId, preferredColumn)) return;
            focusFirstEditableCellInRow(targetRowId);
        });
    };

    const handleInsertBlankRow = (_afterIndex?: number) => {
        let focusRowId: string | null = null;
        setItems(prev => {
            const trailingBlank = prev.find(line => isLineItemEmpty(line)) || prev[prev.length - 1];
            focusRowId = trailingBlank?.id || null;
            return normalizeLineItems(prev);
        });
        if (focusRowId) {
            requestAnimationFrame(() => focusFirstEditableCellInRow(focusRowId!));
        }
    };

    const handleGridNavigation = (
        e: React.KeyboardEvent<HTMLInputElement>,
        rowId: string,
        column: GridColumnKey
    ) => {
        const rowIndex = items.findIndex(r => r.id === rowId);
        if (rowIndex < 0) return;
        const colIndex = GRID_COLUMN_ORDER.indexOf(column);
        if (colIndex < 0) return;

        const focusByLinearStep = (step: 1 | -1) => {
            const maxIndex = items.length * GRID_COLUMN_ORDER.length - 1;
            let linearIndex = rowIndex * GRID_COLUMN_ORDER.length + colIndex;
            while (true) {
                linearIndex += step;
                if (linearIndex < 0 || linearIndex > maxIndex) break;
                const targetRow = items[Math.floor(linearIndex / GRID_COLUMN_ORDER.length)];
                const targetColumn = GRID_COLUMN_ORDER[linearIndex % GRID_COLUMN_ORDER.length];
                if (targetRow && focusCell(targetRow.id, targetColumn)) break;
            }
        };

        const focusVertical = (direction: 1 | -1) => {
            let targetRowIndex = rowIndex + direction;
            while (targetRowIndex >= 0 && targetRowIndex < items.length) {
                if (focusCell(items[targetRowIndex].id, column)) return;
                targetRowIndex += direction;
            }
        };

        if (e.key === 'ArrowUp') {
            e.preventDefault();
            focusVertical(-1);
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            focusVertical(1);
            return;
        }
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            focusByLinearStep(-1);
            return;
        }
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            focusByLinearStep(1);
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            if (column === 'name') {
                openMatrixForRow(rowId, items[rowIndex]?.name || '');
                return;
            }
            focusByLinearStep(1);
        }
    };

    const estimatedSubtotal = useMemo(() => items.reduce((sum, item) => sum + Number(item.lineAmount || 0), 0), [items]);
    const estimatedDiscount = useMemo(() => items.reduce((sum, item) => sum + Number(item.discountAmount || 0), 0), [items]);
    const estimatedTax = useMemo(() => items.reduce((sum, item) => sum + Number(item.gstAmount || 0), 0), [items]);
    const totalAmount = useMemo(() => items.reduce((sum, item) => sum + Number(item.estimatedAmount || 0), 0), [items]);

    const isValidUuid = (value?: string) =>
        typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

    const isPlaceholderDate = (value?: string) => {
        if (!value) return false;
        const normalized = value.trim().toLowerCase();
        return normalized === 'dd-mm-yyyy' || normalized === 'dd/mm/yyyy' || normalized === 'mm/dd/yyyy';
    };

    const isParsableDate = (value?: string) => {
        if (!value || isPlaceholderDate(value)) return false;
        const parsed = new Date(value);
        return !Number.isNaN(parsed.getTime());
    };

    const validateBeforeSave = (reservedSerialId: string, enteredItems: PurchaseOrderItem[]) => {
        if (!selectedDistributorId) return 'Supplier is required.';
        if (!isValidUuid(selectedDistributorId)) return 'Invalid supplier/distributor id. Please reselect supplier.';
        if (!isParsableDate(orderDate)) return 'Invalid PO date.';
        if (!currentUserOrgId?.trim()) return 'Organization id is missing.';
        if (!reservedSerialId?.trim() || reservedSerialId === 'NO.NEW') return 'PO number / serial id is not generated.';
        if (enteredItems.length === 0) return 'Please add at least one item.';

        for (let i = 0; i < enteredItems.length; i++) {
            const row = enteredItems[i];
            if (!row.name?.trim()) return `Item name is missing in row ${i + 1}.`;
            if (!row.quantity || Number(row.quantity) <= 0) return `Quantity should be greater than zero in row ${i + 1}.`;
            const rate = Number(row.estimatedRate ?? row.purchasePrice ?? 0);
            if (!Number.isFinite(rate) || rate < 0) return `Estimated rate should be zero or greater in row ${i + 1}.`;
            if (isPlaceholderDate(row.expectedDeliveryDate)) return `Expected date is placeholder only in row ${i + 1}.`;
            if (row.expectedDeliveryDate && !isParsableDate(row.expectedDeliveryDate)) return `Expected date is invalid in row ${i + 1}.`;
        }

        return null;
    };

    const handleSavePO = async () => {
        setIsSaving(true);
        try {
            const resolvedSerialId = editingPO?.serialId || await ensurePONumber();
            const distributor = distributors.find(d => d.id === selectedDistributorId);
            if (!distributor) {
                throw new Error('Invalid supplier/distributor id: selected supplier was not found.');
            }

            const cleanItems = items
                .filter(item => !isLineItemEmpty(item))
                .map(recalculateLine)
                .filter(item => isLineItemComplete(item));

            const validationError = validateBeforeSave(resolvedSerialId, cleanItems);
            if (validationError) {
                console.warn('PO validation failed.', { validationError, selectedDistributorId, orderDate, poSerialId: resolvedSerialId, cleanItems });
                alert(validationError);
                return;
            }

            const normalizedItems = cleanItems.map(item => ({
                ...item,
                expectedDeliveryDate: isParsableDate(item.expectedDeliveryDate)
                    ? new Date(item.expectedDeliveryDate as string).toISOString()
                    : undefined
            }));

            const computedSubtotal = normalizedItems.reduce((sum, item) => sum + Number(item.lineAmount || 0), 0);
            const computedDiscount = normalizedItems.reduce((sum, item) => sum + Number(item.discountAmount || 0), 0);
            const computedTax = normalizedItems.reduce((sum, item) => sum + Number(item.gstAmount || 0), 0);
            const computedTotalAmount = normalizedItems.reduce((sum, item) => sum + Number(item.estimatedAmount || 0), 0);

            const poPayload: Omit<PurchaseOrder, 'id' | 'serialId'> = {
                organization_id: currentUserOrgId || '',
                date: new Date(orderDate).toISOString(),
                distributorId: distributor.id,
                distributorName: distributor.name,
                senderEmail: currentUserEmail,
                items: normalizedItems,
                status: PurchaseOrderStatus.ORDERED,
                totalItems: normalizedItems.length,
                totalAmount: computedTotalAmount,
                remarks: remarks
            };

            console.info('PO save payload prepared.', {
                serialId: resolvedSerialId,
                payload: { ...poPayload, serialId: resolvedSerialId },
                totals: {
                    subtotal: computedSubtotal,
                    discount: computedDiscount,
                    tax: computedTax,
                    totalAmount: computedTotalAmount,
                    totalItems: normalizedItems.length
                }
            });

            if (editingPO) {
                await onUpdatePurchaseOrder({
                    ...editingPO,
                    ...poPayload,
                    serialId: editingPO.serialId,
                    status: editingPO.status
                });
            } else {
                await onAddPurchaseOrder(poPayload, resolvedSerialId);
            }
            console.info('PO save completed successfully.', { serialId: resolvedSerialId, mode: editingPO ? 'update' : 'create' });
            setIsDirty(false);
            resetCreateForm();
            setView('list');
        } catch (e: any) {
            const parsedError = parseNetworkAndApiError(e);
            const exactMessage = e?.message || parsedError || 'Unknown save error.';
            console.error('PO save failed.', {
                error: e,
                exactMessage,
                selectedDistributorId,
                orderDate,
                poSerialId
            });
            alert(`Failed to save PO: ${exactMessage}`);
        } finally {
            setIsSaving(false);
        }
    };

    const handleEditPO = (po: PurchaseOrder) => {
        setEditingPO(po);
        setPoSerialId(po.serialId);
        setSelectedDistributorId(po.distributorId);
        setOrderDate(po.date ? new Date(po.date).toISOString().split('T')[0] : getDefaultOrderDate());
        setItems(normalizeLineItems(
            (po.items || []).map(item => ({
                ...createEmptyLineItem(),
                ...item,
                freeQuantity: Number((item as any).freeQuantity ?? (item as any).freeQty ?? 0),
                id: item.id || crypto.randomUUID(),
                expectedDeliveryDate: item.expectedDeliveryDate
                    ? new Date(item.expectedDeliveryDate).toISOString().split('T')[0]
                    : ''
            }))
        ));
        setRemarks(po.remarks || '');
        setView('create');
    };

    React.useImperativeHandle(ref, () => ({
        handleSubmit: handleSavePO,
        resetForm: () => {
            resetCreateForm();
            setView('create');
        },
        isDirty: view === 'create' && (items.length > 0 || selectedDistributorId !== '' || remarks !== '')
    }), [view, items, selectedDistributorId, remarks]);

    const handleMatrixKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            setIsMatrixOpen(false);
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            if (matrixResults.length === 0 && activeMatrixRowId) {
                if (matrixMode === 'lowStock') return;
                const pendingName = matrixSearchTerm.trim();
                if (pendingName) {
                    handleUpdateItem(activeMatrixRowId, 'name', pendingName);
                }
                alert('No item found. Please register a new Material Master record from the Material Master screen.');
                setIsMatrixOpen(false);
                requestAnimationFrame(() => focusCell(activeMatrixRowId, 'name'));
            }
            return;
        }

        if (matrixResults.length === 0) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedMatrixIndex(prev => (prev + 1) % matrixResults.length);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedMatrixIndex(prev => (prev - 1 + matrixResults.length) % matrixResults.length);
        } else if (e.key === ' ') {
            if (matrixMode !== 'lowStock') return;
            e.preventDefault();
            const target = matrixResults[selectedMatrixIndex];
            if (target) toggleMatrixSelection(target.id);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (matrixMode === 'lowStock') {
                handleAddSelectedMatrixItems();
                return;
            }
            if (activeMatrixRowId && matrixResults[selectedMatrixIndex]) {
                pickCatalogItemForRow(matrixResults[selectedMatrixIndex], activeMatrixRowId);
            }
        }
    };

    const getStatusClass = (status: PurchaseOrderStatus) => {
        switch (status) {
            case PurchaseOrderStatus.ORDERED: return 'bg-blue-100 text-blue-800 border-blue-200';
            case PurchaseOrderStatus.PARTIALLY_RECEIVED: return 'bg-amber-100 text-amber-800 border-amber-200';
            case PurchaseOrderStatus.RECEIVED: return 'bg-green-100 text-green-800 border-green-200';
            case PurchaseOrderStatus.CANCELLED: return 'bg-red-100 text-red-800 border-red-200';
            default: return 'bg-gray-100 text-gray-800';
        }
    };

    const openReceiveFlow = (po: PurchaseOrder) => {
        setReceiveFlowPO(po);
        setIsAdjustModalOpen(false);
        setAdjustSearchSystemId('');
        setAdjustSearchSupplierBillId('');
        setSelectedAdjustBillId(null);
    };

    const closeReceiveFlow = () => {
        setIsAdjustModalOpen(false);
        setReceiveFlowPO(null);
        setSelectedAdjustBillId(null);
    };

    const handleAdjustSelection = (purchaseBill: Purchase) => {
        setSelectedAdjustBillId(purchaseBill.id);
    };

    const handleSaveAdjustReference = async () => {
        if (!receiveFlowPO || isAdjusting) return;
        const purchaseBill = adjustCandidates.find(bill => bill.id === selectedAdjustBillId);
        if (!purchaseBill) {
            addNotification('Please select an Invoice ID to link.', 'warning');
            return;
        }

        const supplierMatches = (receiveFlowPO.distributorName || '').trim().toLowerCase() === (purchaseBill.supplier || '').trim().toLowerCase();
        if (!supplierMatches) {
            const shouldContinue = window.confirm('Supplier mismatch detected between PO and selected invoice. Do you still want to save this reference?');
            if (!shouldContinue) return;
        }
        setIsAdjusting(true);
        try {
            await onAdjustReceivedEntry(receiveFlowPO, purchaseBill);
            addNotification('Invoice reference linked successfully', 'success');
            closeReceiveFlow();
        } catch (error) {
            addNotification(parseNetworkAndApiError(error), 'error');
        } finally {
            setIsAdjusting(false);
        }
    };

    const resolveLinkedInvoiceIds = (po: PurchaseOrder): string[] => {
        if (!po) return [];
        const receiveLinks = Array.isArray(po.receiveLinks) ? po.receiveLinks : [];
        const sourcePurchaseBillIds = Array.isArray(po.sourcePurchaseBillIds) ? po.sourcePurchaseBillIds : [];
        const safePurchases = Array.isArray(purchases) ? purchases : [];

        const linkedByReceiveLog = receiveLinks
            .map(link => link?.purchaseSystemId)
            .filter((value): value is string => Boolean(value));

        const linkedBySourceId = sourcePurchaseBillIds
            .map(purchaseId => safePurchases.find(purchase => purchase?.id === purchaseId)?.purchaseSerialId)
            .filter((value): value is string => Boolean(value));

        return Array.from(new Set([...linkedByReceiveLog, ...linkedBySourceId]));
    };

    return (
        <main className="h-full overflow-hidden flex flex-col page-fade-in bg-app-bg">
            <div className="bg-primary text-white h-7 flex items-center px-4 justify-between border-b border-gray-600 shadow-md flex-shrink-0">
                <span className="text-[10px] font-black uppercase tracking-widest">
                    {view === 'create' ? 'Purchase Order Voucher Creation' : 'Purchase Order Register'}
                </span>
                <span className="text-[10px] font-black uppercase text-accent">
                    {view === 'create' ? `No. ${poSerialId}` : `Total Orders: ${purchaseOrders.length}`}
                </span>
            </div>

            <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex justify-between items-center px-4 pt-4 pb-2 flex-shrink-0">
                    <div className="flex items-center space-x-2 bg-white dark:bg-gray-800 p-1 border border-app-border shadow-sm">
                        <button
                            onClick={() => setView('list')}
                            className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${view === 'list' ? 'bg-primary text-white shadow-md' : 'text-app-text-secondary hover:bg-hover'}`}
                        >
                            History
                        </button>
                        <button
                            onClick={() => { resetCreateForm(); setView('create'); }}
                            className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${view === 'create' ? 'bg-primary text-white shadow-md' : 'text-app-text-secondary hover:bg-hover'}`}
                        >
                            New Order
                        </button>
                    </div>
                </div>

                {view === 'create' ? (
                    <div className="flex-1 flex flex-col overflow-hidden">
                        <div className="px-4 pb-3 flex-1 flex flex-col gap-3 overflow-hidden">
                            <Card className="p-3 bg-white dark:bg-card-bg border border-app-border rounded-none grid grid-cols-1 md:grid-cols-4 gap-4 items-end flex-shrink-0">
                            <div className="md:col-span-2">
                                <label className="text-[10px] font-bold text-gray-500 uppercase block mb-1">Particulars (Supplier Name)</label>
                                <select
                                    ref={supplierSelectRef}
                                    value={selectedDistributorId}
                                    onChange={e => setSelectedDistributorId(e.target.value)}
                                    className="w-full p-2 border border-gray-400 rounded-none bg-input-bg font-bold text-sm focus:bg-yellow-50 outline-none uppercase"
                                >
                                    <option value="">— Select Ledger —</option>
                                    {distributors.filter(d => d.is_blocked !== true).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className="text-[10px] font-bold text-gray-500 uppercase block mb-1">Date</label>
                                <input
                                    type="date"
                                    value={orderDate}
                                    onChange={e => setOrderDate(e.target.value)}
                                    className="w-full border border-gray-400 p-2 text-sm font-bold outline-none"
                                />
                            </div>
                            <div className="flex justify-end">
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => {
                                            const targetRow = items.find(line => isLineItemEmpty(line)) || items[items.length - 1];
                                            if (!targetRow) return;
                                            openMatrixForRow(targetRow.id, '', 'lowStock');
                                        }}
                                        className="px-4 py-2 text-[10px] font-black uppercase bg-red-50 text-red-700 border border-red-300"
                                    >
                                        Low Stock
                                    </button>
                                    <button onClick={() => handleInsertBlankRow()} className="px-4 py-2 text-[10px] font-black uppercase bg-slate-100 border border-slate-300">+ Add Row</button>
                                </div>
                            </div>
                        </Card>

                        <Card className="flex-1 flex flex-col p-0 tally-border !rounded-none overflow-hidden shadow-inner bg-white dark:bg-zinc-800">
                            <div className="flex-1 overflow-auto">
                                <table className="min-w-[1700px] border-collapse text-sm">
                                    <thead className="sticky top-0 bg-gray-100 dark:bg-zinc-900 border-b border-gray-400">
                                        <tr className="text-[10px] font-black uppercase text-gray-600">
                                            <th className="p-2 border-r border-gray-400">Sl.</th>
                                            <th className="p-2 border-r border-gray-400 text-left">Item Name</th>
                                            <th className="p-2 border-r border-gray-400">Item Code / SKU</th>
                                            <th className="p-2 border-r border-gray-400">Pack</th>
                                            <th className="p-2 border-r border-gray-400">Qty</th>
                                            <th className="p-2 border-r border-gray-400">F.Qty</th>
                                            <th className="p-2 border-r border-gray-400">Est. Rate</th>
                                            <th className="p-2 border-r border-gray-400">Disc %</th>
                                            <th className="p-2 border-r border-gray-400">GST %</th>
                                            <th className="p-2 border-r border-gray-400">Est. Amount</th>
                                            <th className="p-2 border-r border-gray-400">Expected Date</th>
                                            <th className="p-2 border-r border-gray-400">Remarks</th>
                                            <th className="p-2">Action</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {items.map((item, idx) => (
                                            <tr key={item.id} className="border-b border-gray-200 hover:bg-gray-50 focus-within:bg-blue-50/40">
                                                <td className="p-1 border-r text-center text-xs font-bold">{idx + 1}</td>
                                                <td className="p-1 border-r">
                                                    <input
                                                        ref={el => setCellRef(item.id, 'name', el)}
                                                        value={item.name || ''}
                                                        onChange={e => handleUpdateItem(item.id, 'name', e.target.value)}
                                                        onFocus={() => setActiveCell({ rowId: item.id, column: 'name' })}
                                                        onKeyDown={e => handleGridNavigation(e, item.id, 'name')}
                                                        className={getCellClassName(item.id, 'name', 'w-full bg-transparent p-1 outline-none font-semibold')}
                                                    />
                                                </td>
                                                <td className="p-1 border-r">
                                                    <input
                                                        ref={el => setCellRef(item.id, 'itemCode', el)}
                                                        value={item.itemCode || item.sku || ''}
                                                        readOnly={true}
                                                        tabIndex={-1}
                                                        onFocus={() => setActiveCell({ rowId: item.id, column: 'itemCode' })}
                                                        onKeyDown={e => handleGridNavigation(e, item.id, 'itemCode')}
                                                        className={getCellClassName(item.id, 'itemCode', 'w-full bg-transparent p-1 outline-none opacity-70 cursor-not-allowed')}
                                                    />
                                                </td>
                                                <td className="p-1 border-r">
                                                    <input
                                                        ref={el => setCellRef(item.id, 'packType', el)}
                                                        value={item.packType || ''}
                                                        onFocus={() => setActiveCell({ rowId: item.id, column: 'packType' })}
                                                        onKeyDown={e => handleGridNavigation(e, item.id, 'packType')}
                                                        onChange={e => handleUpdateItem(item.id, 'packType', e.target.value)}
                                                        className={getCellClassName(item.id, 'packType', 'w-full bg-transparent p-1 outline-none')}
                                                    />
                                                </td>
                                                <td className="p-1 border-r"><input ref={el => setCellRef(item.id, 'quantity', el)} type="number" min={0} value={item.quantity} onFocus={() => setActiveCell({ rowId: item.id, column: 'quantity' })} onKeyDown={e => handleGridNavigation(e, item.id, 'quantity')} onChange={e => handleUpdateItem(item.id, 'quantity', Number(e.target.value) || 0)} className={getCellClassName(item.id, 'quantity', 'w-24 bg-transparent p-1 outline-none text-right')} /></td>
                                                <td className="p-1 border-r"><input ref={el => setCellRef(item.id, 'freeQuantity', el)} type="number" min={0} value={item.freeQuantity || 0} onFocus={() => setActiveCell({ rowId: item.id, column: 'freeQuantity' })} onKeyDown={e => handleGridNavigation(e, item.id, 'freeQuantity')} onChange={e => handleUpdateItem(item.id, 'freeQuantity', Number(e.target.value) || 0)} className={getCellClassName(item.id, 'freeQuantity', 'w-24 bg-transparent p-1 outline-none text-right')} /></td>
                                                <td className="p-1 border-r"><input ref={el => setCellRef(item.id, 'estimatedRate', el)} type="number" min={0} value={item.estimatedRate ?? item.purchasePrice ?? 0} onFocus={() => setActiveCell({ rowId: item.id, column: 'estimatedRate' })} onKeyDown={e => handleGridNavigation(e, item.id, 'estimatedRate')} onChange={e => handleUpdateItem(item.id, 'estimatedRate', Number(e.target.value) || 0)} className={getCellClassName(item.id, 'estimatedRate', 'w-28 bg-transparent p-1 outline-none text-right')} /></td>
                                                <td className="p-1 border-r"><input ref={el => setCellRef(item.id, 'discountPercent', el)} type="number" min={0} value={item.discountPercent || 0} onFocus={() => setActiveCell({ rowId: item.id, column: 'discountPercent' })} onKeyDown={e => handleGridNavigation(e, item.id, 'discountPercent')} onChange={e => handleUpdateItem(item.id, 'discountPercent', Number(e.target.value) || 0)} className={getCellClassName(item.id, 'discountPercent', 'w-20 bg-transparent p-1 outline-none text-right')} /></td>
                                                <td className="p-1 border-r"><input ref={el => setCellRef(item.id, 'gstPercent', el)} type="number" min={0} value={item.gstPercent || 0} onFocus={() => setActiveCell({ rowId: item.id, column: 'gstPercent' })} onKeyDown={e => handleGridNavigation(e, item.id, 'gstPercent')} onChange={e => handleUpdateItem(item.id, 'gstPercent', Number(e.target.value) || 0)} className={getCellClassName(item.id, 'gstPercent', 'w-20 bg-transparent p-1 outline-none text-right')} /></td>
                                                <td className="p-1 border-r text-right font-bold">₹{Number(item.estimatedAmount || 0).toFixed(2)}</td>
                                                <td className="p-1 border-r"><input ref={el => setCellRef(item.id, 'expectedDeliveryDate', el)} type="date" value={item.expectedDeliveryDate || ''} onFocus={() => setActiveCell({ rowId: item.id, column: 'expectedDeliveryDate' })} onKeyDown={e => handleGridNavigation(e, item.id, 'expectedDeliveryDate')} onChange={e => handleUpdateItem(item.id, 'expectedDeliveryDate', e.target.value)} className={getCellClassName(item.id, 'expectedDeliveryDate', 'w-36 bg-transparent p-1 outline-none')} /></td>
                                                <td className="p-1 border-r"><input ref={el => setCellRef(item.id, 'notes', el)} value={item.notes || ''} onFocus={() => setActiveCell({ rowId: item.id, column: 'notes' })} onKeyDown={e => handleGridNavigation(e, item.id, 'notes')} onChange={e => handleUpdateItem(item.id, 'notes', e.target.value)} className={getCellClassName(item.id, 'notes', 'w-full bg-transparent p-1 outline-none')} /></td>
                                                <td className="p-1 text-center">
                                                    <button onClick={() => handleInsertBlankRow(idx)} className="mr-2 text-xs text-blue-700">+row</button>
                                                    <button onClick={() => handleRemoveItem(item.id, activeCell?.column)} className="text-xs text-red-600">del</button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </Card>
                        </div>

                        <div className="bg-slate-50 dark:bg-zinc-900 border-t border-gray-300 dark:border-zinc-700 p-4 flex justify-between items-stretch flex-shrink-0 gap-8 min-h-[140px]">
                            <div className="flex-1 bg-white p-4 tally-border !rounded-none shadow-sm flex flex-col">
                                <label className="text-[10px] font-bold text-gray-500 uppercase block mb-1.5 ml-1">Order Narration / Remarks</label>
                                <textarea
                                    value={remarks}
                                    onChange={e => setRemarks(e.target.value)}
                                    rows={3}
                                    placeholder="Enter special instructions for the supplier..."
                                    className="flex-1 w-full p-2 border border-gray-400 rounded-none bg-slate-50 text-xs font-bold uppercase resize-none outline-none focus:bg-white"
                                />
                            </div>

                            <div className="w-96 bg-[#e5f0f0] p-5 tally-border !rounded-none shadow-md flex flex-col justify-center">
                                <div className="space-y-2 font-bold text-xs uppercase tracking-tight">
                                    <div className="flex justify-between text-gray-500"><span>Estimated Subtotal</span> <span>₹{estimatedSubtotal.toFixed(2)}</span></div>
                                    <div className="flex justify-between text-gray-500"><span>Discount</span> <span>-₹{estimatedDiscount.toFixed(2)}</span></div>
                                    <div className="flex justify-between text-blue-700"><span>Tax (Estimated GST)</span> <span>+₹{estimatedTax.toFixed(2)}</span></div>
                                    <div className="border-t border-gray-400 pt-2 flex justify-between text-xl font-black text-primary">
                                        <span>TOTAL VALUE</span>
                                        <span>₹{totalAmount.toFixed(2)}</span>
                                    </div>
                                </div>
                            </div>

                            <div className="flex flex-col gap-3 w-56 self-stretch justify-end">
                                <button
                                    onClick={() => { if (confirm('Discard order draft?')) { resetCreateForm(); setView('list'); } }}
                                    className="w-full py-3 tally-border bg-white font-black text-[11px] hover:bg-red-50 text-red-600 transition-colors uppercase tracking-[0.2em] shadow-sm"
                                >
                                    Discard
                                </button>
                                <button
                                    onClick={handleSavePO}
                                    disabled={isSaving}
                                    className="w-full py-6 tally-button-primary shadow-2xl active:translate-y-1 uppercase tracking-[0.3em] text-[12px] flex items-center justify-center gap-2"
                                >
                                    {isSaving ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> : (editingPO ? 'Update Order' : 'Accept Order')}
                                </button>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="px-4 pb-4 flex-1 flex flex-col overflow-hidden">
                        <Card className="flex-1 p-0 border-app-border overflow-hidden shadow-md bg-white">
                        <div className="p-4 border-b border-gray-400 bg-slate-50 flex justify-between items-center">
                            <div className="flex bg-white p-1 tally-border !rounded-none">
                                {['all', PurchaseOrderStatus.ORDERED, PurchaseOrderStatus.PARTIALLY_RECEIVED, PurchaseOrderStatus.RECEIVED, PurchaseOrderStatus.CANCELLED].map(status => (
                                    <button
                                        key={status}
                                        onClick={() => setStatusFilter(status as any)}
                                        className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-tighter transition-all ${statusFilter === status ? 'bg-primary text-white shadow-md' : 'text-gray-400 hover:bg-hover'}`}
                                    >
                                        {status}
                                    </button>
                                ))}
                            </div>

                            <div className="flex gap-2">
                                <button
                                    disabled={!selectedPO}
                                    onClick={() => selectedPO && onPrintPurchaseOrder(selectedPO)}
                                    className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50 hover:bg-slate-50"
                                >
                                    Print
                                </button>
                                <button
                                    disabled={!selectedPO || selectedPO.status !== PurchaseOrderStatus.ORDERED}
                                    onClick={() => selectedPO && handleEditPO(selectedPO)}
                                    className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50 hover:bg-slate-50"
                                >
                                    Edit
                                </button>
                                <button
                                    disabled={!selectedPO || (selectedPO.status !== PurchaseOrderStatus.ORDERED && selectedPO.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED)}
                                    onClick={() => selectedPO && openReceiveFlow(selectedPO)}
                                    className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase disabled:opacity-50 hover:bg-slate-50"
                                >
                                    Receive
                                </button>
                                <button
                                    disabled={!selectedPO || (selectedPO.status !== PurchaseOrderStatus.ORDERED && selectedPO.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED)}
                                    onClick={() => selectedPO && onCancelPurchaseOrder(selectedPO.id)}
                                    className="px-3 py-1.5 tally-border bg-white text-[10px] font-black uppercase text-red-700 disabled:opacity-50 hover:bg-red-50"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>

                        <div className="overflow-x-auto">
                            <table className="min-w-full border-collapse">
                                <thead className="bg-gray-100 border-b border-gray-400">
                                    <tr>
                                        <th className="p-3 text-left text-[10px] font-black text-gray-600 uppercase border-r border-gray-400">PO Number</th>
                                        <th className="p-3 text-left text-[10px] font-black text-gray-600 uppercase border-r border-gray-400">Date</th>
                                        <th className="p-3 text-left text-[10px] font-black text-gray-600 uppercase border-r border-gray-400">Distributor</th>
                                        <th className="p-3 text-left text-[10px] font-black text-gray-600 uppercase border-r border-gray-400">Received Invoice ID</th>
                                        <th className="p-3 text-center text-[10px] font-black text-gray-600 uppercase border-r border-gray-400">Status</th>
                                        <th className="p-3 text-right text-[10px] font-black text-gray-600 uppercase">Amount</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-200 text-xs font-bold">
                                    {filteredPOList.map(po => {
                                        const isSelected = selectedPO?.id === po.id;
                                        const linkedInvoiceIds = resolveLinkedInvoiceIds(po);
                                        const linkedInvoiceDisplay = linkedInvoiceIds.length > 0 ? linkedInvoiceIds.join(', ') : '--';
                                        return (
                                            <tr
                                                key={po.id}
                                                className={`transition-colors group cursor-pointer hover:bg-primary hover:text-white ${isSelected ? 'bg-primary text-white shadow-md' : ''}`}
                                                onClick={() => setSelectedPO(po)}
                                            >
                                                <td className={`p-3 border-r border-gray-200 font-mono font-black uppercase ${isSelected ? 'text-white' : 'group-hover:text-white text-primary'}`}>{po.serialId}</td>
                                                <td className={`p-3 border-r border-gray-200 ${isSelected ? 'text-white' : 'group-hover:text-white'}`}>{new Date(po.date).toLocaleDateString('en-GB')}</td>
                                                <td className={`p-3 border-r border-gray-200 font-black uppercase ${isSelected ? 'text-white' : 'group-hover:text-white text-gray-900'}`}>{po.distributorName}</td>
                                                <td className={`p-3 border-r border-gray-200 font-mono ${isSelected ? 'text-white' : 'group-hover:text-white text-gray-700'}`} title={linkedInvoiceDisplay}>{linkedInvoiceDisplay}</td>
                                                <td className="p-3 border-r border-gray-200 text-center">
                                                    <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase border ${isSelected ? 'bg-white/20 text-white border-white/30' : getStatusClass(po.status)}`}>
                                                        {po.status}
                                                    </span>
                                                </td>
                                                <td className={`p-3 text-right font-black ${isSelected ? 'text-white' : 'group-hover:text-white'}`}>₹{po.totalAmount.toLocaleString('en-IN')}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </Card>
                    </div>
                )}
            </div>

            {selectedPO && (
                <SharePurchaseOrderModal
                    isOpen={isShareModalOpen}
                    onClose={() => { setIsShareModalOpen(false); setSelectedPO(null); }}
                    purchaseOrder={selectedPO}
                    distributor={distributors.find(d => d.id === selectedPO.distributorId) || null}
                    pharmacyName={currentUserPharmacyName}
                    senderEmail={currentUserEmail}
                    senderOrgId={currentUserOrgId}
                />
            )}

            <Modal
                isOpen={!!receiveFlowPO}
                onClose={closeReceiveFlow}
                title="Receive Purchase Order"
                widthClass="max-w-lg"
            >
                <div className="p-5 flex flex-col gap-3">
                    <div className="text-[11px] font-black uppercase tracking-widest text-gray-600">
                        {receiveFlowPO ? `${receiveFlowPO.serialId} · ${receiveFlowPO.distributorName}` : ''}
                    </div>
                    <button
                        onClick={() => receiveFlowPO && onPostReceivedEntry(receiveFlowPO)}
                        className="w-full text-left px-4 py-3 border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 text-xs font-black uppercase tracking-wider"
                    >
                        1. Post Received Entry
                    </button>
                    <button
                        onClick={() => setIsAdjustModalOpen(true)}
                        className="w-full text-left px-4 py-3 border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900 text-xs font-black uppercase tracking-wider"
                    >
                        2. Adjust Received Entry
                    </button>
                    <button
                        onClick={closeReceiveFlow}
                        className="w-full text-left px-4 py-3 border border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-700 text-xs font-black uppercase tracking-wider"
                    >
                        3. Cancel / Close
                    </button>
                </div>
            </Modal>

            <Modal
                isOpen={!!receiveFlowPO && isAdjustModalOpen}
                onClose={() => setIsAdjustModalOpen(false)}
                title="Adjust Received Entry (Reference Only)"
                widthClass="max-w-4xl"
            >
                <div className="p-4 flex flex-col h-full min-h-[420px]">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                        <input
                            value={adjustSearchSystemId}
                            onChange={(e) => setAdjustSearchSystemId(e.target.value)}
                            placeholder="Search by System ID"
                            className="border border-gray-400 px-3 py-2 text-xs font-black uppercase outline-none focus:bg-yellow-50"
                        />
                        <input
                            value={adjustSearchSupplierBillId}
                            onChange={(e) => setAdjustSearchSupplierBillId(e.target.value)}
                            placeholder="Search by Supplier Bill ID"
                            className="border border-gray-400 px-3 py-2 text-xs font-black uppercase outline-none focus:bg-yellow-50"
                        />
                    </div>
                    <div className="flex-1 overflow-auto border border-gray-300">
                        <table className="min-w-full border-collapse">
                            <thead className="bg-gray-100">
                                <tr>
                                    <th className="p-2 text-left text-[10px] font-black uppercase border-b border-gray-300">System ID</th>
                                    <th className="p-2 text-left text-[10px] font-black uppercase border-b border-gray-300">Supplier Bill ID</th>
                                    <th className="p-2 text-left text-[10px] font-black uppercase border-b border-gray-300">Date</th>
                                    <th className="p-2 text-left text-[10px] font-black uppercase border-b border-gray-300">Supplier</th>
                                    <th className="p-2 text-right text-[10px] font-black uppercase border-b border-gray-300">Amount</th>
                                    <th className="p-2 text-center text-[10px] font-black uppercase border-b border-gray-300">Status</th>
                                    <th className="p-2 text-right text-[10px] font-black uppercase border-b border-gray-300">Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {adjustCandidates.map((bill) => (
                                    <tr key={bill.id} className="border-b border-gray-200 text-xs font-bold">
                                        <td className="p-2">{bill.purchaseSerialId}</td>
                                        <td className="p-2">{bill.invoiceNumber}</td>
                                        <td className="p-2">{new Date(bill.date).toLocaleDateString('en-GB')}</td>
                                        <td className="p-2 uppercase">{bill.supplier}</td>
                                        <td className="p-2 text-right">₹{Number(bill.totalAmount || 0).toFixed(2)}</td>
                                        <td className="p-2 text-center">{bill.status}</td>
                                        <td className="p-2 text-right">
                                            <button
                                                disabled={isAdjusting}
                                                onClick={() => handleAdjustSelection(bill)}
                                                className={`px-2 py-1 text-[10px] font-black uppercase disabled:opacity-50 ${
                                                    selectedAdjustBillId === bill.id
                                                        ? 'bg-emerald-700 text-white'
                                                        : 'bg-primary text-white'
                                                }`}
                                            >
                                                {selectedAdjustBillId === bill.id ? 'Selected' : 'Select'}
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                                {adjustCandidates.length === 0 && (
                                    <tr>
                                        <td colSpan={7} className="p-6 text-center text-xs font-bold text-gray-500 uppercase">No purchase bills found for current filters.</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                    <div className="pt-3 flex justify-end gap-2">
                        <button
                            onClick={handleSaveAdjustReference}
                            disabled={isAdjusting || !selectedAdjustBillId}
                            className="px-4 py-2 bg-primary text-white text-xs font-black uppercase disabled:opacity-50"
                        >
                            {isAdjusting ? 'Saving...' : 'Save Invoice Reference'}
                        </button>
                        <button onClick={() => setIsAdjustModalOpen(false)} className="px-4 py-2 border border-gray-400 text-xs font-black uppercase">Cancel</button>
                    </div>
                </div>
            </Modal>

            <Modal
                isOpen={isMatrixOpen}
                onClose={() => {
                    setIsMatrixOpen(false);
                    if (activeMatrixRowId) {
                        requestAnimationFrame(() => focusCell(activeMatrixRowId, 'name'));
                    }
                }}
                title="Product Selection Matrix"
            >
                <div className="flex flex-col h-full bg-[#fffde7]" onKeyDown={handleMatrixKeyDown}>
                    <div className="py-1.5 px-4 bg-primary text-white flex justify-between items-center">
                        <span className="text-xs font-black uppercase tracking-[0.2em]">
                            {matrixMode === 'lowStock' ? 'Material / Inventory Lookup · Low Stock Only' : 'Material / Inventory Lookup'}
                        </span>
                        <span className="text-[10px] font-bold uppercase opacity-80">
                            {matrixMode === 'lowStock'
                                ? '↑/↓ Navigate | Space Toggle | Enter Add Selected | Esc Close'
                                : '↑/↓ Navigate | Enter Select | Ctrl+Enter Register Material'}
                        </span>
                    </div>
                    <div className="p-2 border-b border-gray-300 bg-white">
                        <input
                            ref={matrixSearchRef}
                            type="text"
                            value={matrixSearchTerm}
                            onChange={e => {
                                setMatrixSearchTerm(e.target.value);
                                setSelectedMatrixIndex(0);
                            }}
                            placeholder="Search item name, code, SKU, supplier item..."
                            className="w-full border border-gray-400 p-2 text-sm font-black uppercase outline-none focus:bg-yellow-50"
                        />
                        {matrixResults.length === 0 && (
                            <p className="mt-2 text-[10px] font-black uppercase text-amber-700">
                                {matrixMode === 'lowStock'
                                    ? 'No low stock items found.'
                                    : 'No item found. Press Ctrl + Enter to register new Material Master record.'}
                            </p>
                        )}
                    </div>
                    <div className="flex-1 overflow-auto bg-white">
                        <table className="min-w-full border-collapse text-xs">
                            <thead className="sticky top-0 bg-gray-100 border-b border-gray-400">
                                <tr className="text-[10px] font-black uppercase text-gray-500">
                                    {matrixMode === 'lowStock' && (
                                        <th className="p-2 text-center border-r border-gray-300">
                                            <input
                                                type="checkbox"
                                                aria-label="Select all low stock items"
                                                checked={matrixResults.length > 0 && selectedMatrixItemIds.length === matrixResults.length}
                                                onChange={(e) => setSelectedMatrixItemIds(e.target.checked ? matrixResults.map(item => item.id) : [])}
                                            />
                                        </th>
                                    )}
                                    <th className="p-2 text-left border-r border-gray-300">Item Name</th>
                                    <th className="p-2 text-left border-r border-gray-300">Item Code / SKU</th>
                                    <th className="p-2 text-left border-r border-gray-300">Pack</th>
                                    <th className="p-2 text-right border-r border-gray-300">Current Stock</th>
                                    <th className="p-2 text-right border-r border-gray-300">Minimum Stock Limit</th>
                                    <th className="p-2 text-right border-r border-gray-300">Shortage Qty</th>
                                    <th className="p-2 text-left border-r border-gray-300">Est. Rate</th>
                                    <th className="p-2 text-left">GST %</th>
                                </tr>
                            </thead>
                            <tbody>
                                {matrixResults.map((result, idx) => {
                                    const inv = result.inventoryItem;
                                    const med = result.medicine;
                                    const isSelected = idx === selectedMatrixIndex;
                                    const currentStock = Number(result.currentStock ?? inv?.stock ?? 0);
                                    const minStock = Number(result.minStockLimit ?? inv?.minStockLimit ?? 0);
                                    const shortageQty = Math.max(0, Number(result.shortageQty ?? (minStock - currentStock)));
                                    const isLowStock = minStock > 0 && currentStock <= minStock;
                                    return (
                                        <tr
                                            key={`${result.id}-${idx}`}
                                            onMouseEnter={() => setSelectedMatrixIndex(idx)}
                                            onClick={() => {
                                                if (matrixMode === 'lowStock') {
                                                    toggleMatrixSelection(result.id);
                                                    return;
                                                }
                                                if (activeMatrixRowId) pickCatalogItemForRow(result, activeMatrixRowId);
                                            }}
                                            className={`cursor-pointer border-b border-gray-100 ${isSelected ? 'bg-primary text-white' : 'hover:bg-yellow-50'}`}
                                        >
                                            {matrixMode === 'lowStock' && (
                                                <td className="p-2 text-center border-r border-gray-200" onClick={(e) => e.stopPropagation()}>
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedMatrixItemIds.includes(result.id)}
                                                        onChange={() => toggleMatrixSelection(result.id)}
                                                        aria-label={`Select ${result.name}`}
                                                    />
                                                </td>
                                            )}
                                            <td className="p-2 border-r border-gray-200 font-bold uppercase">{result.name}</td>
                                            <td className="p-2 border-r border-gray-200 font-mono">{result.code || result.sku || '-'}</td>
                                            <td className="p-2 border-r border-gray-200 uppercase">{inv?.packType || med?.pack || '-'}</td>
                                            <td className={`p-2 border-r border-gray-200 text-right font-bold ${isLowStock && !isSelected ? 'text-red-600' : ''}`}>{currentStock.toFixed(2)}</td>
                                            <td className="p-2 border-r border-gray-200 text-right">{minStock > 0 ? minStock.toFixed(2) : '-'}</td>
                                            <td className={`p-2 border-r border-gray-200 text-right font-bold ${shortageQty > 0 && !isSelected ? 'text-orange-600' : ''}`}>
                                                {shortageQty > 0 ? shortageQty.toFixed(2) : '-'}
                                                {shortageQty > 0 && (
                                                    <span className={`ml-2 px-1.5 py-0.5 rounded text-[9px] font-black uppercase ${isSelected ? 'bg-white/20 text-white' : 'bg-red-100 text-red-700'}`}>
                                                        Low Stock
                                                    </span>
                                                )}
                                            </td>
                                            <td className="p-2 border-r border-gray-200 text-right">₹{Number(inv?.purchasePrice || med?.rateA || 0).toFixed(2)}</td>
                                            <td className="p-2 text-right">{Number(inv?.gstPercent || med?.gstRate || 0).toFixed(2)}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    {matrixMode === 'lowStock' && (
                        <div className="flex items-center justify-between gap-3 p-3 border-t border-gray-300 bg-[#fff9c4]">
                            <span className="text-[11px] font-black uppercase text-gray-700">
                                Selected: {selectedMatrixItemIds.length} item{selectedMatrixItemIds.length === 1 ? '' : 's'}
                            </span>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => setIsMatrixOpen(false)}
                                    className="px-3 py-2 text-[10px] font-black uppercase border border-gray-400 bg-white text-gray-700"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleAddSelectedMatrixItems}
                                    disabled={selectedMatrixItemIds.length === 0}
                                    className="px-4 py-2 text-[10px] font-black uppercase border border-emerald-700 bg-emerald-600 text-white disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    Add Selected Items
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </Modal>
        </main>
    );
});

export default PurchaseOrdersPage;
