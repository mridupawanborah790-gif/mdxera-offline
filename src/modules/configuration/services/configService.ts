import { db } from '@core/db/client';
import { TABLE } from '@core/db/schema';
import { SyncQueue } from '@core/sync/SyncQueue';
import { supabase } from '@core/db/supabaseClient';
import type { RegisteredPharmacy, AppConfigurations } from '@core/types';

// ── Configurations ─────────────────────────────────────────────────────────

export async function fetchConfigurations(
  user: RegisteredPharmacy
): Promise<AppConfigurations | null> {
  const rows = await db.select<{ id: string; [k: string]: unknown }>(
    `SELECT * FROM ${TABLE.CONFIGURATIONS} WHERE organization_id = ? LIMIT 1`,
    [user.organization_id]
  );

  if (rows.length > 0) return deserializeConfig(rows[0]);

  // Fallback: pull from Supabase and cache
  const { data, error } = await supabase
    .from('configurations')
    .select('*')
    .eq('organization_id', user.organization_id)
    .single();

  if (error || !data) return null;

  await db.upsert(TABLE.CONFIGURATIONS, serialize(data));
  return deserializeConfig(data);
}

export async function saveConfigurations(
  config: Partial<AppConfigurations>,
  user: RegisteredPharmacy
): Promise<void> {
  const existing = await db.select<{ id: string }>(
    `SELECT id FROM ${TABLE.CONFIGURATIONS} WHERE organization_id = ? LIMIT 1`,
    [user.organization_id]
  );

  const id = existing[0]?.id ?? crypto.randomUUID();
  const row = {
    id,
    organization_id: user.organization_id,
    ...serializeConfig(config),
    updated_at: new Date().toISOString(),
  };

  await db.upsert(TABLE.CONFIGURATIONS, row);
  await SyncQueue.enqueue('UPDATE', TABLE.CONFIGURATIONS, id, row, user.organization_id);
}

// ── Team members ───────────────────────────────────────────────────────────

export async function fetchTeamMembers(user: RegisteredPharmacy) {
  const rows = await db.select(
    `SELECT * FROM ${TABLE.TEAM_MEMBERS} WHERE organization_id = ? AND status != 'deleted' ORDER BY name ASC`,
    [user.organization_id]
  );
  if (rows.length > 0) return rows.map(deserializeJsonFields);

  const { data } = await supabase
    .from('team_members')
    .select('*')
    .eq('organization_id', user.organization_id);

  if (data?.length) {
    await db.bulkUpsert(TABLE.TEAM_MEMBERS, data.map(serialize));
  }
  return (data ?? []).map(deserializeJsonFields);
}

export async function saveTeamMember(
  member: Record<string, unknown>,
  user: RegisteredPharmacy
): Promise<void> {
  const row = serialize(member);
  await db.upsert(TABLE.TEAM_MEMBERS, row);
  await SyncQueue.enqueue('INSERT', TABLE.TEAM_MEMBERS, row.id as string, row, user.organization_id);
}

// ── Business roles ─────────────────────────────────────────────────────────

export async function fetchBusinessRoles(user: RegisteredPharmacy) {
  const rows = await db.select(
    `SELECT * FROM ${TABLE.BUSINESS_ROLES} WHERE organization_id = ? AND is_active = 1`,
    [user.organization_id]
  );
  if (rows.length > 0) return rows.map(deserializeJsonFields);

  const { data } = await supabase
    .from('business_roles')
    .select('*')
    .eq('organization_id', user.organization_id)
    .eq('is_active', true);

  if (data?.length) await db.bulkUpsert(TABLE.BUSINESS_ROLES, data.map(serialize));
  return (data ?? []).map(deserializeJsonFields);
}

export async function saveBusinessRole(
  role: Record<string, unknown>,
  user: RegisteredPharmacy
): Promise<void> {
  const row = serialize(role);
  await db.upsert(TABLE.BUSINESS_ROLES, row);
  await SyncQueue.enqueue('INSERT', TABLE.BUSINESS_ROLES, row.id as string, row, user.organization_id);
}

// ── Promotions ─────────────────────────────────────────────────────────────

export async function fetchPromotions(user: RegisteredPharmacy) {
  const rows = await db.select(
    `SELECT * FROM ${TABLE.PROMOTIONS} WHERE organization_id = ? AND is_active = 1`,
    [user.organization_id]
  );
  if (rows.length > 0) return rows.map(deserializeJsonFields);

  const { data } = await supabase
    .from('promotions')
    .select('*')
    .eq('organization_id', user.organization_id);

  if (data?.length) await db.bulkUpsert(TABLE.PROMOTIONS, data.map(serialize));
  return (data ?? []).map(deserializeJsonFields);
}

export async function savePromotion(
  promo: Record<string, unknown>,
  user: RegisteredPharmacy
): Promise<void> {
  const row = serialize(promo);
  await db.upsert(TABLE.PROMOTIONS, row);
  await SyncQueue.enqueue('INSERT', TABLE.PROMOTIONS, row.id as string, row, user.organization_id);
}

// ── Categories ─────────────────────────────────────────────────────────────

export async function fetchCategories(user: RegisteredPharmacy) {
  const rows = await db.select(
    `SELECT * FROM ${TABLE.CATEGORIES} WHERE organization_id = ? ORDER BY name ASC`,
    [user.organization_id]
  );
  if (rows.length > 0) return rows;

  const { data } = await supabase
    .from('categories')
    .select('*')
    .eq('organization_id', user.organization_id);

  if (data?.length) await db.bulkUpsert(TABLE.CATEGORIES, data.map(serialize));
  return data ?? [];
}

export async function fetchSubCategories(user: RegisteredPharmacy) {
  const rows = await db.select(
    `SELECT * FROM ${TABLE.SUB_CATEGORIES} WHERE organization_id = ? ORDER BY name ASC`,
    [user.organization_id]
  );
  if (rows.length > 0) return rows;

  const { data } = await supabase
    .from('sub_categories')
    .select('*')
    .eq('organization_id', user.organization_id);

  if (data?.length) await db.bulkUpsert(TABLE.SUB_CATEGORIES, data.map(serialize));
  return data ?? [];
}

// ── Serialization helpers ──────────────────────────────────────────────────

function serialize(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  }
  if (!result.id) result.id = crypto.randomUUID();
  return result;
}

function deserializeJsonFields(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...row };
  const jsonFields = ['work_centers', 'permissions_matrix', 'assigned_roles', 'rules', 'payment_details'];
  for (const field of jsonFields) {
    if (typeof result[field] === 'string') {
      try { result[field] = JSON.parse(result[field] as string); } catch { /* keep as string */ }
    }
  }
  return result;
}

function serializeConfig(config: Partial<AppConfigurations>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const jsonFields = [
    'invoice_config', 'purchase_config', 'purchase_order_config',
    'medicine_master_config', 'physical_inventory_config', 'delivery_challan_config',
    'sales_challan_config', 'display_options', 'modules', 'sidebar',
    'pricing_priority', 'fiscal_year_config', 'pos_config', 'purchase_entry_config'
  ];

  for (const [k, v] of Object.entries(config)) {
    const snakeKey = k.replace(/([A-Z])/g, '_$1').toLowerCase();
    result[snakeKey] = jsonFields.includes(snakeKey) && v !== null && typeof v === 'object'
      ? JSON.stringify(v)
      : v;
  }
  return result;
}

function deserializeConfig(row: Record<string, unknown>): AppConfigurations {
  const parsed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    let val = v;
    if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
      try { val = JSON.parse(v); } catch { val = v; }
    }
    parsed[k] = val;
    const camelKey = k.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    parsed[camelKey] = val;
  }
  return parsed as unknown as AppConfigurations;
}
