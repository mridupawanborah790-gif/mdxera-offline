import type { InventoryItem, Medicine } from '@core/types';

export type MaterialMasterType = NonNullable<Medicine['materialMasterType']>;

interface MaterialTypeRule {
  label: string;
  inventorised: boolean;
  salesEnabled: boolean;
  purchaseEnabled: boolean;
  productionEnabled: boolean;
  internalIssueEnabled: boolean;
}

export const MATERIAL_TYPE_RULES: Record<MaterialMasterType, MaterialTypeRule> = {
  trading_goods: {
    label: 'Trading Goods',
    inventorised: true,
    salesEnabled: true,
    purchaseEnabled: true,
    productionEnabled: false,
    internalIssueEnabled: false,
  },
  finished_goods: {
    label: 'Finished Goods',
    inventorised: true,
    salesEnabled: true,
    purchaseEnabled: true,
    productionEnabled: true,
    internalIssueEnabled: false,
  },
  consumables: {
    label: 'Consumables',
    inventorised: true,
    salesEnabled: false,
    purchaseEnabled: true,
    productionEnabled: false,
    internalIssueEnabled: true,
  },
  service_material: {
    label: 'Service Material',
    inventorised: false,
    salesEnabled: true,
    purchaseEnabled: true,
    productionEnabled: false,
    internalIssueEnabled: false,
  },
  packaging: {
    label: 'Packaging',
    inventorised: true,
    salesEnabled: false,
    purchaseEnabled: true,
    productionEnabled: false,
    internalIssueEnabled: true,
  },
};

const DEFAULT_TYPE: MaterialMasterType = 'trading_goods';

export const getMaterialTypeRule = (type?: Medicine['materialMasterType']) => {
  return MATERIAL_TYPE_RULES[type || DEFAULT_TYPE] || MATERIAL_TYPE_RULES[DEFAULT_TYPE];
};

export const getResolvedMedicinePolicy = (medicine?: Partial<Medicine> | null) => {
  const type = (medicine?.materialMasterType || DEFAULT_TYPE) as MaterialMasterType;
  const base = getMaterialTypeRule(type);
  const isActive = medicine?.is_active === undefined ? true : !!medicine?.is_active;

  return {
    type,
    label: base.label,
    inventorised: medicine?.isInventorised ?? base.inventorised,
    salesEnabled: (medicine?.isSalesEnabled ?? base.salesEnabled) && isActive,
    purchaseEnabled: (medicine?.isPurchaseEnabled ?? base.purchaseEnabled) && isActive,
    productionEnabled: (medicine?.isProductionEnabled ?? base.productionEnabled) && isActive,
    internalIssueEnabled: (medicine?.isInternalIssueEnabled ?? base.internalIssueEnabled) && isActive,
  };
};

const policyCache = new WeakMap<
  Medicine[],
  {
    byCode: Map<string, Medicine>;
    byNameBrand: Map<string, Medicine>;
  }
>();

export const getInventoryPolicy = (item: InventoryItem, medicines: Medicine[]) => {
  if (!medicines || !Array.isArray(medicines)) {
    return getResolvedMedicinePolicy(null);
  }

  let cache = policyCache.get(medicines);
  if (!cache) {
    const byCode = new Map<string, Medicine>();
    const byNameBrand = new Map<string, Medicine>();

    medicines.forEach(m => {
      const code = (m.materialCode || '').toLowerCase().trim();
      const name = (m.name || '').toLowerCase().trim();
      const brand = (m.brand || '').toLowerCase().trim();

      if (code) {
        byCode.set(code, m);
      }
      byNameBrand.set(`${name}|${brand}`, m);
    });

    cache = { byCode, byNameBrand };
    policyCache.set(medicines, cache);
  }

  const normalizedCode = (item.code || '').toLowerCase().trim();
  const normalizedName = (item.name || '').toLowerCase().trim();
  const normalizedBrand = (item.brand || '').toLowerCase().trim();

  let linkedMedicine: Medicine | undefined = undefined;
  if (normalizedCode) {
    linkedMedicine = cache.byCode.get(normalizedCode);
  }
  if (!linkedMedicine) {
    linkedMedicine = cache.byNameBrand.get(`${normalizedName}|${normalizedBrand}`);
  }

  return getResolvedMedicinePolicy(linkedMedicine);
};

export const getTypeLabel = (type?: Medicine['materialMasterType']) => getMaterialTypeRule(type).label;
