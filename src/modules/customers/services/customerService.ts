import { db } from '@core/db/client';
import { TABLE } from '@core/db/schema';
import { SyncQueue } from '@core/sync/SyncQueue';
import { supabase } from '@core/db/supabaseClient';
import type { RegisteredPharmacy, Customer, CustomerPriceMasterEntry, MaterialPriceMasterEntry } from '@core/types';

function serialize(obj: Record<string, unknown>): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    r[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  }
  if (!r.id) r.id = crypto.randomUUID();
  return r;
}

function deserialize(row: Record<string, unknown>): Record<string, unknown> {
  const r = { ...row };
  if (typeof r.ledger === 'string') {
    try { r.ledger = JSON.parse(r.ledger as string); } catch { r.ledger = []; }
  }
  return r;
}

export async function fetchCustomers(user: RegisteredPharmacy): Promise<Customer[]> {
  const rows = await db.select<Record<string, unknown>>(
    `SELECT * FROM ${TABLE.CUSTOMERS} WHERE organization_id = ? AND is_active = 1 ORDER BY name ASC`,
    [user.organization_id]
  );
  if (rows.length > 0) return rows.map(deserialize) as unknown as Customer[];

  const { data } = await supabase
    .from('customers')
    .select('*')
    .eq('organization_id', user.organization_id)
    .eq('is_active', true);

  if (data?.length) await db.bulkUpsert(TABLE.CUSTOMERS, data.map(serialize));
  return ((data ?? []).map(deserialize)) as unknown as Customer[];
}

export async function saveCustomer(customer: Customer, user: RegisteredPharmacy): Promise<void> {
  const row = serialize(customer as unknown as Record<string, unknown>);
  await db.upsert(TABLE.CUSTOMERS, row);
  await SyncQueue.enqueue('INSERT', TABLE.CUSTOMERS, customer.id, row, user.organization_id);
}

export async function updateCustomer(customer: Customer, user: RegisteredPharmacy): Promise<void> {
  const row = serialize(customer as unknown as Record<string, unknown>);
  await db.upsert(TABLE.CUSTOMERS, row);
  await SyncQueue.enqueue('UPDATE', TABLE.CUSTOMERS, customer.id, row, user.organization_id);
}

export async function deleteCustomer(id: string, user: RegisteredPharmacy): Promise<void> {
  const now = new Date().toISOString();
  await db.execute(
    `UPDATE ${TABLE.CUSTOMERS} SET is_active = 0, updated_at = ? WHERE id = ?`,
    [now, id]
  );
  await SyncQueue.enqueue('UPDATE', TABLE.CUSTOMERS, id, { id, is_active: 0 }, user.organization_id);
}

export async function fetchCustomerPriceList(user: RegisteredPharmacy) {
  const rows = await db.select(
    `SELECT * FROM ${TABLE.CUSTOMER_PRICE_LIST} WHERE organization_id = ?`,
    [user.organization_id]
  );
  if (rows.length > 0) return rows;

  const { data } = await supabase
    .from('customer_price_list')
    .select('*')
    .eq('organization_id', user.organization_id);

  if (data?.length) await db.bulkUpsert(TABLE.CUSTOMER_PRICE_LIST, data.map(serialize));
  return data ?? [];
}

export async function saveCustomerPriceList(
  entry: Record<string, unknown>,
  user: RegisteredPharmacy
): Promise<void> {
  const row = serialize(entry);
  await db.upsert(TABLE.CUSTOMER_PRICE_LIST, row);
  await SyncQueue.enqueue('INSERT', TABLE.CUSTOMER_PRICE_LIST, row.id as string, row, user.organization_id);
}

export async function fetchPriceMaster(user: RegisteredPharmacy): Promise<CustomerPriceMasterEntry[]> {
  const rows = await db.select(
    `SELECT * FROM ${TABLE.CUSTOMER_PRICE_LIST} WHERE organization_id = ? ORDER BY updated_at DESC`,
    [user.organization_id]
  );
  if (rows.length > 0) return rows as unknown as CustomerPriceMasterEntry[];

  const { data } = await supabase
    .from('customer_price_list')
    .select('*')
    .eq('organization_id', user.organization_id);

  if (data?.length) await db.bulkUpsert(TABLE.CUSTOMER_PRICE_LIST, data.map(serialize));
  return (data ?? []) as unknown as CustomerPriceMasterEntry[];
}

export async function fetchPriceForCustomerItem(
  customerId: string,
  inventoryItemId: string,
  user: RegisteredPharmacy
): Promise<CustomerPriceMasterEntry | null> {
  const rows = await db.select(
    `SELECT * FROM ${TABLE.CUSTOMER_PRICE_LIST} WHERE organization_id = ? AND customer_id = ? AND material_id = ? AND status = 'active' LIMIT 1`,
    [user.organization_id, customerId, inventoryItemId]
  );
  return (rows[0] as unknown as CustomerPriceMasterEntry) ?? null;
}

export async function savePriceMasterEntry(
  entry: CustomerPriceMasterEntry,
  user: RegisteredPharmacy
): Promise<void> {
  const now = new Date().toISOString();
  // Find all existing active records for this org + customer + material
  const existingActiveRows = await db.select(
    `SELECT id FROM ${TABLE.CUSTOMER_PRICE_LIST} WHERE organization_id = ? AND customer_id = ? AND material_id = ? AND status = 'active' AND id != ?`,
    [user.organization_id, entry.customer_id, entry.material_id, entry.id]
  );

  // Deactivate them locally
  await db.execute(
    `UPDATE ${TABLE.CUSTOMER_PRICE_LIST} SET status = 'inactive', modified_at = ? WHERE organization_id = ? AND customer_id = ? AND material_id = ? AND status = 'active' AND id != ?`,
    [now, user.organization_id, entry.customer_id, entry.material_id, entry.id]
  );

  // Enqueue UPDATE queue items so old active entries are marked inactive in cloud DB
  for (const oldRow of (existingActiveRows || [])) {
    const oldId = (oldRow as any).id;
    if (oldId) {
      await SyncQueue.enqueue('UPDATE', TABLE.CUSTOMER_PRICE_LIST, oldId, { id: oldId, organization_id: user.organization_id, status: 'inactive', modified_at: now }, user.organization_id);
    }
  }

  const row = serialize(entry as unknown as Record<string, unknown>);
  await db.upsert(TABLE.CUSTOMER_PRICE_LIST, row);
  await SyncQueue.enqueue('INSERT', TABLE.CUSTOMER_PRICE_LIST, row.id as string, row, user.organization_id);
}

export async function updatePriceMasterStatus(
  id: string,
  status: 'active' | 'inactive',
  user: RegisteredPharmacy
): Promise<void> {
  const now = new Date().toISOString();
  await db.execute(
    `UPDATE ${TABLE.CUSTOMER_PRICE_LIST} SET status = ?, modified_at = ? WHERE id = ? AND organization_id = ?`,
    [status, now, id, user.organization_id]
  );
  await SyncQueue.enqueue('UPDATE', TABLE.CUSTOMER_PRICE_LIST, id, { id, organization_id: user.organization_id, status, modified_at: now }, user.organization_id);
}

export async function fetchMaterialPriceMaster(user: RegisteredPharmacy): Promise<MaterialPriceMasterEntry[]> {
  const rows = await db.select(
    `SELECT * FROM ${TABLE.MATERIAL_PRICE_LIST} WHERE organization_id = ? ORDER BY updated_at DESC`,
    [user.organization_id]
  );
  if (rows.length > 0) return rows as unknown as MaterialPriceMasterEntry[];

  const { data } = await supabase
    .from('material_price_list')
    .select('*')
    .eq('organization_id', user.organization_id);

  if (data?.length) await db.bulkUpsert(TABLE.MATERIAL_PRICE_LIST, data.map(serialize));
  return (data ?? []) as unknown as MaterialPriceMasterEntry[];
}

export async function saveMaterialPriceMasterEntry(
  entry: MaterialPriceMasterEntry,
  user: RegisteredPharmacy
): Promise<void> {
  const now = new Date().toISOString();
  const existingActiveRows = await db.select(
    `SELECT id FROM ${TABLE.MATERIAL_PRICE_LIST} WHERE organization_id = ? AND material_id = ? AND status = 'active' AND id != ?`,
    [user.organization_id, entry.material_id, entry.id]
  );

  await db.execute(
    `UPDATE ${TABLE.MATERIAL_PRICE_LIST} SET status = 'inactive', modified_at = ? WHERE organization_id = ? AND material_id = ? AND status = 'active' AND id != ?`,
    [now, user.organization_id, entry.material_id, entry.id]
  );

  for (const oldRow of (existingActiveRows || [])) {
    const oldId = (oldRow as any).id;
    if (oldId) {
      await SyncQueue.enqueue('UPDATE', TABLE.MATERIAL_PRICE_LIST, oldId, { id: oldId, organization_id: user.organization_id, status: 'inactive', modified_at: now }, user.organization_id);
    }
  }

  const row = serialize(entry as unknown as Record<string, unknown>);
  await db.upsert(TABLE.MATERIAL_PRICE_LIST, row);
  await SyncQueue.enqueue('INSERT', TABLE.MATERIAL_PRICE_LIST, row.id as string, row, user.organization_id);
}

export async function updateMaterialPriceMasterStatus(
  id: string,
  status: 'active' | 'inactive',
  user: RegisteredPharmacy
): Promise<void> {
  const now = new Date().toISOString();
  await db.execute(
    `UPDATE ${TABLE.MATERIAL_PRICE_LIST} SET status = ?, modified_at = ? WHERE id = ? AND organization_id = ?`,
    [status, now, id, user.organization_id]
  );
  await SyncQueue.enqueue('UPDATE', TABLE.MATERIAL_PRICE_LIST, id, { id, organization_id: user.organization_id, status, modified_at: now }, user.organization_id);
}
