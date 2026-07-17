import { describe, it, expect } from 'vitest';
import { calculateBillingTotals } from '../billing';
import { BillItem, AppConfigurations } from '../../types';

describe('calculateBillingTotals with Customer specific pricing behaviors', () => {
  const item: BillItem = {
    id: 'line-1',
    inventoryItemId: 'material-b',
    name: 'Material B',
    mrp: 100,
    rate: 100,
    quantity: 1,
    looseQuantity: 0,
    gstPercent: 10, // 10% GST
    discountPercent: 0,
    itemFlatDiscount: 0,
    unit: 'pack',
    unitsPerPack: 1,
  };

  it('Case 1: Customer Pricing Disabled / Not Maintained', () => {
    const config: AppConfigurations = {
      organization_id: 'org-1',
      displayOptions: {
        customerPricingMode: 'disabled',
      },
    };

    const totals = calculateBillingTotals({
      items: [item],
      configurations: config,
      isNonGst: false,
      pricingMode: 'rate',
    });

    expect(totals.gross).toBe(100);
    expect(totals.baseTotal).toBe(110); // 100 + 10 GST
  });

  it('Case 2: Customer Pricing in FK Price Mode', () => {
    const config: AppConfigurations = {
      organization_id: 'org-1',
      displayOptions: {
        customerPricingMode: 'fk',
      },
    };

    const fkItem: BillItem = {
      ...item,
      fkPrice: 110, // FK Price maintained as 110
    };

    const totals = calculateBillingTotals({
      items: [fkItem],
      configurations: config,
      isNonGst: false,
      pricingMode: 'rate',
    });

    expect(totals.gross).toBe(110);
    expect(totals.baseTotal).toBe(121);
  });

  it('Case 3: Customer Pricing in FK Price Mode (No FK Price maintained on item)', () => {
    const config: AppConfigurations = {
      organization_id: 'org-1',
      displayOptions: {
        customerPricingMode: 'fk',
      },
    };

    const totals = calculateBillingTotals({
      items: [item],
      configurations: config,
      isNonGst: false,
      pricingMode: 'rate',
    });

    expect(totals.gross).toBe(100);
    expect(totals.baseTotal).toBe(110);
  });
});
