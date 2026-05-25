/**
 * Push-parity regression tests.
 *
 * History (why this file exists):
 *   Two code paths existed in this repo for pushing a row to Supabase:
 *     1. Online direct insert via storageService.getSupabasePayload()
 *     2. Offline-queued push via SyncWorker.normalizeForSupabase()
 *
 *   For months, only path (1) applied the user_id -> created_by_id mapping
 *   that the production Supabase schema expects (and the ownership UI in
 *   the legacy web app reads). Every row created offline on the desktop
 *   arrived at Supabase with created_by_id = NULL. This was only spotted
 *   when a screenshot of public.sales_bill showed mixed NULL / populated
 *   created_by_id depending on which path the row came through.
 *
 *   These tests pin the transformation contract on path (2) so the bug
 *   can't silently regress. They also document the per-table strip-list
 *   and the UUID guard so anyone touching SyncWorker can see what's
 *   expected.
 *
 *   See ARCHITECTURE.md §13 for the four data-flow directions this
 *   parity is part of.
 *
 * What these tests do NOT cover:
 *   - The Supabase RPC behaviour itself (out of scope — no test DB).
 *   - schemaDriftCache TTL behaviour (separate test surface).
 *   - JSON encoding of nested objects (handled by adaptRowForSqlite on
 *     the pull side, not normalizeForSupabase on the push side).
 *
 * Run: `npm test`        (one shot)
 *      `npm run test:watch` (interactive)
 */
import { describe, it, expect } from 'vitest';
import { normalizeForSupabase } from '../SyncWorker';

const SAMPLE_UID = '11111111-1111-1111-1111-111111111111';
const SAMPLE_CUST = '22222222-2222-2222-2222-222222222222';
const SAMPLE_SUP = '33333333-3333-3333-3333-333333333333';
const SAMPLE_PO = '44444444-4444-4444-4444-444444444444';

// ────────────────────────────────────────────────────────────────────────────
// Ownership mapping: user_id -> created_by_id
// ────────────────────────────────────────────────────────────────────────────

describe('SyncWorker.normalizeForSupabase — ownership audit mapping', () => {
  const ownerTrackedTables = [
    'sales_bill',
    'purchases',
    'customers',
    'suppliers',
    'inventory',
    'material_master',
    'purchase_orders',
    'sales_challans',
    'delivery_challans',
    'doctor_master',
  ];

  for (const table of ownerTrackedTables) {
    it(`${table}: maps user_id -> created_by_id and drops user_id`, () => {
      const out = normalizeForSupabase(
        {
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          organization_id: 'org-123',
          user_id: SAMPLE_UID,
          name: 'Test',
        },
        table,
      );
      expect(out.created_by_id).toBe(SAMPLE_UID);
      expect(out).not.toHaveProperty('user_id');
      // organization_id MUST always survive — that's the tenant isolation key.
      expect(out.organization_id).toBe('org-123');
    });

    it(`${table}: doesn't clobber an explicitly-set created_by_id`, () => {
      const out = normalizeForSupabase(
        {
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          organization_id: 'org-123',
          user_id: SAMPLE_UID,
          created_by_id: SAMPLE_CUST,
        },
        table,
      );
      expect(out.created_by_id).toBe(SAMPLE_CUST);
      expect(out).not.toHaveProperty('user_id');
    });

    it(`${table}: ignores user_id that isn't a valid UUID`, () => {
      const out = normalizeForSupabase(
        {
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          organization_id: 'org-123',
          user_id: 'not-a-uuid',
        },
        table,
      );
      // user_id is not stripped because it never became valid created_by_id,
      // but the generic UUID guard below should null it out via reaching the
      // *_id catch (it doesn't end in _id in this snake_case form, so it
      // stays as the original string — that's the documented current
      // behaviour). The key assertion: we did NOT invent a bogus
      // created_by_id from an invalid uuid.
      expect(out).not.toHaveProperty('created_by_id');
    });
  }

  it('physical_inventory: keeps user_id as a real FK column, no created_by_id mapping', () => {
    const out = normalizeForSupabase(
      {
        id: 'PHY-001',
        organization_id: 'org-123',
        user_id: SAMPLE_UID,
      },
      'physical_inventory',
    );
    expect(out.user_id).toBe(SAMPLE_UID);
    expect(out).not.toHaveProperty('created_by_id');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// purchases.sourcePurchaseOrderId remap
// ────────────────────────────────────────────────────────────────────────────

describe('SyncWorker.normalizeForSupabase — purchases PO linkage', () => {
  it('maps sourcePurchaseOrderId -> reference_doc_number and drops the source field', () => {
    const out = normalizeForSupabase(
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        organization_id: 'org-123',
        sourcePurchaseOrderId: 'PO-2026-001',
      },
      'purchases',
    );
    expect(out.reference_doc_number).toBe('PO-2026-001');
    expect(out).not.toHaveProperty('source_purchase_order_id');
    expect(out).not.toHaveProperty('sourcePurchaseOrderId');
  });

  it('preserves an explicitly-set reference_doc_number', () => {
    const out = normalizeForSupabase(
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        organization_id: 'org-123',
        sourcePurchaseOrderId: 'PO-2026-001',
        reference_doc_number: 'PRE-EXISTING-REF',
      },
      'purchases',
    );
    expect(out.reference_doc_number).toBe('PRE-EXISTING-REF');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// purchase_orders supplier→distributor remap (added 2026-05 after live audit)
// ────────────────────────────────────────────────────────────────────────────

describe('SyncWorker.normalizeForSupabase — purchase_orders counterparty remap', () => {
  it('maps supplier → distributor_name and supplier_id → distributor_id', () => {
    const out = normalizeForSupabase(
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        organization_id: 'org-123',
        supplier: 'ACME Pharma',
        supplier_id: SAMPLE_SUP,
      },
      'purchase_orders',
    );
    expect(out.distributor_name).toBe('ACME Pharma');
    expect(out.distributor_id).toBe(SAMPLE_SUP);
    expect(out).not.toHaveProperty('supplier');
    expect(out).not.toHaveProperty('supplier_id');
  });

  it('preserves an explicitly-set distributor_name', () => {
    const out = normalizeForSupabase(
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        organization_id: 'org-123',
        supplier: 'Legacy Name',
        distributor_name: 'Canonical Name',
      },
      'purchase_orders',
    );
    expect(out.distributor_name).toBe('Canonical Name');
  });

  it('maps po_serial_id → serial_id if only the legacy form is present', () => {
    const out = normalizeForSupabase(
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        organization_id: 'org-123',
        po_serial_id: 'PO-2026-001',
      },
      'purchase_orders',
    );
    expect(out.serial_id).toBe('PO-2026-001');
    expect(out).not.toHaveProperty('po_serial_id');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// journal_entry_lines amount remap (added 2026-05 after live audit)
// ────────────────────────────────────────────────────────────────────────────

describe('SyncWorker.normalizeForSupabase — journal_entry_lines amount columns', () => {
  it('mirrors debit → debit_amount and credit → credit_amount', () => {
    const out = normalizeForSupabase(
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        organization_id: 'org-123',
        debit: 100.5,
        credit: 0,
      },
      'journal_entry_lines',
    );
    expect(out.debit_amount).toBe(100.5);
    expect(out.credit_amount).toBe(0);
  });

  it('preserves explicit *_amount values when both are passed', () => {
    const out = normalizeForSupabase(
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        organization_id: 'org-123',
        debit: 100,
        debit_amount: 200,
      },
      'journal_entry_lines',
    );
    expect(out.debit_amount).toBe(200);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Bookkeeping stripping
// ────────────────────────────────────────────────────────────────────────────

describe('SyncWorker.normalizeForSupabase — bookkeeping fields', () => {
  it('strips _sync_status, _local_only, and other underscore-prefixed fields', () => {
    const out = normalizeForSupabase(
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        organization_id: 'org-123',
        _sync_status: 'pending',
        _local_only: 0,
        sync_status: 'pending',
        syncStatus: 'pending',
        record_uuid: 'legacy',
      },
      'customers',
    );
    expect(out).not.toHaveProperty('_sync_status');
    expect(out).not.toHaveProperty('_local_only');
    expect(out).not.toHaveProperty('sync_status');
    expect(out).not.toHaveProperty('syncStatus');
    expect(out).not.toHaveProperty('record_uuid');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// LOCAL_ONLY_COLUMNS per-table strip lists
// ────────────────────────────────────────────────────────────────────────────

describe('SyncWorker.normalizeForSupabase — table-specific local-only stripping', () => {
  it('sales_bill: strips company_code_id, set_of_books_id, balance_after_bill, etc.', () => {
    const out = normalizeForSupabase(
      {
        id: 'INV-001',
        organization_id: 'org-123',
        balanceAfterBill: 100,
        balance_after_bill: 100,
        previousBalanceBeforeBill: 0,
        previous_balance_before_bill: 0,
        companyCodeId: SAMPLE_CUST,
        company_code_id: SAMPLE_CUST,
        setOfBooksId: SAMPLE_SUP,
        set_of_books_id: SAMPLE_SUP,
        billedById: SAMPLE_UID,
        billed_by_id: SAMPLE_UID,
        billedByName: 'Cashier',
        billed_by_name: 'Cashier',
        taxCalculationType: 'inclusive',
        tax_calculation_type: 'inclusive',
        eWayBillNo: 'EWB-1',
        e_way_bill_no: 'EWB-1',
        doctorId: SAMPLE_PO,
        doctor_id: SAMPLE_PO,
      },
      'sales_bill',
    );
    for (const key of [
      'balanceAfterBill', 'balance_after_bill',
      'previousBalanceBeforeBill', 'previous_balance_before_bill',
      'companyCodeId', 'company_code_id',
      'setOfBooksId', 'set_of_books_id',
      'billedById', 'billed_by_id',
      'billedByName', 'billed_by_name',
      'taxCalculationType', 'tax_calculation_type',
      'eWayBillNo', 'e_way_bill_no',
      'doctorId', 'doctor_id',
    ]) {
      expect(out, `sales_bill should strip ${key}`).not.toHaveProperty(key);
    }
  });

  it('customers / suppliers: strips currentBalance + control_gl_id (server-managed via trigger)', () => {
    for (const table of ['customers', 'suppliers']) {
      const out = normalizeForSupabase(
        {
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          organization_id: 'org-123',
          currentBalance: 500,
          current_balance: 500,
          controlGlId: SAMPLE_CUST,
          control_gl_id: SAMPLE_CUST,
        },
        table,
      );
      expect(out, `${table} should strip currentBalance`).not.toHaveProperty('current_balance');
      expect(out, `${table} should strip controlGlId`).not.toHaveProperty('control_gl_id');
    }
  });

  it('configurations: strips medicine_master_config + fiscal_year_config (older Supabase versions lack them)', () => {
    const out = normalizeForSupabase(
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        organization_id: 'org-123',
        medicineMasterConfig: { prefix: 'SKU' },
        medicine_master_config: { prefix: 'SKU' },
        fiscalYearConfig: { current: '2026-27' },
        fiscal_year_config: { current: '2026-27' },
      },
      'configurations',
    );
    expect(out).not.toHaveProperty('medicine_master_config');
    expect(out).not.toHaveProperty('fiscal_year_config');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// CamelCase -> snake_case conversion
// ────────────────────────────────────────────────────────────────────────────

describe('SyncWorker.normalizeForSupabase — case conversion', () => {
  it('converts camelCase keys to snake_case', () => {
    const out = normalizeForSupabase(
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        organization_id: 'org-123',
        defaultDiscount: 10,
        defaultRateTier: 'rateA',
        creditLimit: 5000,
        creditDays: 30,
      },
      'customers',
    );
    expect(out.default_discount).toBe(10);
    expect(out.default_rate_tier).toBe('rateA');
    expect(out.credit_limit).toBe(5000);
    expect(out.credit_days).toBe(30);
  });

  it('leaves already-snake_case keys alone', () => {
    const out = normalizeForSupabase(
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        organization_id: 'org-123',
        gst_number: 'GSTIN',
      },
      'customers',
    );
    expect(out.gst_number).toBe('GSTIN');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// UUID guard on FK columns
// ────────────────────────────────────────────────────────────────────────────

describe('SyncWorker.normalizeForSupabase — UUID guard', () => {
  it('null-ifies *_id fields that are not valid UUIDs', () => {
    const out = normalizeForSupabase(
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        organization_id: 'org-123',
        customer_id: 'NOT-A-UUID',
        supplier_id: '',
        doctor_id: 'also-invalid',
      },
      'sales_bill',
    );
    expect(out.customer_id).toBeNull();
    expect(out.supplier_id).toBeNull();
    // doctor_id is in sales_bill's LOCAL_ONLY_COLUMNS strip list so it
    // should be dropped entirely, not null-ified.
    expect(out).not.toHaveProperty('doctor_id');
  });

  it('preserves valid UUIDs on *_id fields', () => {
    const out = normalizeForSupabase(
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        organization_id: 'org-123',
        customer_id: SAMPLE_CUST,
      },
      'sales_bill',
    );
    expect(out.customer_id).toBe(SAMPLE_CUST);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Auto-code carriage for material_master / doctor_master
// (regression for the 23505 collision recovery in pushCodedRecordsIndividually)
// ────────────────────────────────────────────────────────────────────────────

describe('SyncWorker.normalizeForSupabase — material_master / doctor_master codes', () => {
  it('material_master: material_code is preserved through normalisation', () => {
    const out = normalizeForSupabase(
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        organization_id: 'org-123',
        name: 'Paracetamol 500mg',
        materialCode: '10000123',
      },
      'material_master',
    );
    expect(out.material_code).toBe('10000123');
  });

  it('doctor_master: doctor_code is preserved through normalisation', () => {
    const out = normalizeForSupabase(
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        organization_id: 'org-123',
        name: 'Dr. House',
        doctorCode: 'DOC-000042',
      },
      'doctor_master',
    );
    expect(out.doctor_code).toBe('DOC-000042');
  });

  // The actual collision-recovery logic (pushCodedRecordsIndividually) lives
  // in SyncWorker and calls supabase.from(...).select(...) to find the
  // current max. That's the integration boundary we can't unit-test without
  // a Supabase mock; the contract we lock in here is that the code field
  // survives normalisation so the recovery loop has something to mutate.
});

// ────────────────────────────────────────────────────────────────────────────
// Organization isolation — the single most-important invariant
// ────────────────────────────────────────────────────────────────────────────

describe('SyncWorker.normalizeForSupabase — multi-tenant isolation', () => {
  // The whole multi-tenant model depends on every row carrying its
  // organization_id all the way to Supabase. RLS policies on every table
  // use this column to filter. If we ever strip it accidentally, rows
  // either fail the RLS check on push OR (worse) leak across tenants.
  const allTables = [
    'sales_bill', 'sales_returns', 'sales_challans', 'delivery_challans',
    'purchases', 'purchase_returns', 'purchase_orders',
    'inventory', 'material_master', 'customers', 'suppliers', 'distributors',
    'doctor_master', 'supplier_product_map', 'customer_price_list',
    'mbc_cards', 'mbc_card_types', 'mbc_card_templates', 'mbc_card_history',
    'physical_inventory', 'mrp_change_log', 'ewaybills', 'promotions',
    'configurations', 'business_roles', 'team_members', 'categories',
    'sub_categories', 'gl_master', 'gl_assignments', 'company_codes',
    'set_of_books', 'journal_entry_header', 'journal_entry_lines',
  ];

  for (const table of allTables) {
    it(`${table}: organization_id always survives normalization`, () => {
      const out = normalizeForSupabase(
        {
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          organization_id: 'tenant-org-uuid-xyz',
          name: 'whatever',
        },
        table,
      );
      expect(out.organization_id).toBe('tenant-org-uuid-xyz');
    });
  }
});
