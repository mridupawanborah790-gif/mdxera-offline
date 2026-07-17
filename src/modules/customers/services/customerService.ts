import { db } from '@core/db/client';
import { TABLE } from '@core/db/schema';
import { SyncQueue } from '@core/sync/SyncQueue';
import { supabase } from '@core/db/supabaseClient';
import type { RegisteredPharmacy, Customer } from '@core/types';

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

function deserializePriceListEntry(row: Record<string, unknown>): Record<string, unknown> {
  const r = { ...row };
  if (r.material_id) {
    r.inventoryItemId = r.material_id;
    delete r.material_id;
  }
  if (r.special_price !== undefined) {
    r.price = r.special_price;
    delete r.special_price;
  }
  if (r.discount_percent !== undefined) {
    r.discountPercent = r.discount_percent;
    delete r.discount_percent;
  }
  return r;
}

function serializePriceListEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const r = serialize(entry);
  if (r.inventoryItemId) {
    r.material_id = r.inventoryItemId;
    delete r.inventoryItemId;
  }
  if (r.price !== undefined) {
    r.special_price = r.price;
    delete r.price;
  }
  if (r.discountPercent !== undefined) {
    r.discount_percent = r.discountPercent;
    delete r.discountPercent;
  }
  return r;
}

export async function fetchCustomerPriceList(user: RegisteredPharmacy) {
  const rows = await db.select(
    `SELECT * FROM ${TABLE.CUSTOMER_PRICE_LIST} WHERE organization_id = ?`,
    [user.organization_id]
  );
  if (rows.length > 0) return rows.map(deserializePriceListEntry);

  const { data } = await supabase
    .from('customer_price_list')
    .select('*')
    .eq('organization_id', user.organization_id);

  if (data?.length) {
    await db.bulkUpsert(TABLE.CUSTOMER_PRICE_LIST, data.map(serializePriceListEntry));
  }
  return (data ?? []).map(deserializePriceListEntry);
}

export async function saveCustomerPriceList(
  entry: Record<string, unknown>,
  user: RegisteredPharmacy
): Promise<void> {
  const row = serializePriceListEntry(entry);
  await db.upsert(TABLE.CUSTOMER_PRICE_LIST, row);
  await SyncQueue.enqueue('INSERT', TABLE.CUSTOMER_PRICE_LIST, row.id as string, row, user.organization_id);
}
