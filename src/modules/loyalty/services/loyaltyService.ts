import { db } from '@core/db/client';
import { TABLE } from '@core/db/schema';
import { SyncQueue } from '@core/sync/SyncQueue';
import { supabase } from '@core/db/supabaseClient';
import type { RegisteredPharmacy } from '@core/types';

function serialize(obj: Record<string, unknown>): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    r[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  }
  if (!r.id) r.id = crypto.randomUUID();
  return r;
}

function deserializeJson(row: Record<string, unknown>, jsonFields: string[]): Record<string, unknown> {
  const r = { ...row };
  for (const field of jsonFields) {
    if (typeof r[field] === 'string') {
      try { r[field] = JSON.parse(r[field] as string); } catch { /* keep as-is */ }
    }
  }
  return r;
}

// ── Cards ──────────────────────────────────────────────────────────────────

export async function fetchMbcCards(user: RegisteredPharmacy) {
  const rows = await db.select<Record<string, unknown>>(
    `SELECT * FROM ${TABLE.MBC_CARDS} WHERE organization_id = ? ORDER BY created_at DESC`,
    [user.organization_id]
  );
  if (rows.length > 0) return rows.map((r) => deserializeJson(r, ['transactions']));

  const { data } = await supabase
    .from('mbc_cards')
    .select('*')
    .eq('organization_id', user.organization_id)
    .order('created_at', { ascending: false });

  if (data?.length) await db.bulkUpsert(TABLE.MBC_CARDS, data.map(serialize));
  return (data ?? []).map((r) => deserializeJson(r as Record<string, unknown>, ['transactions']));
}

export async function saveMbcCard(card: Record<string, unknown>, user: RegisteredPharmacy): Promise<string> {
  const row = serialize(card);
  await db.upsert(TABLE.MBC_CARDS, row);
  await SyncQueue.enqueue('INSERT', TABLE.MBC_CARDS, row.id as string, row, user.organization_id);
  return row.id as string;
}

export async function updateMbcCard(card: Record<string, unknown>, user: RegisteredPharmacy): Promise<void> {
  const row = serialize(card);
  await db.upsert(TABLE.MBC_CARDS, row);
  await SyncQueue.enqueue('UPDATE', TABLE.MBC_CARDS, row.id as string, row, user.organization_id);
}

export async function patchMbcCard(
  id: string,
  patch: Record<string, unknown>,
  user: RegisteredPharmacy
): Promise<void> {
  const cols = Object.keys(patch);
  const sets = cols.map((c) => `${c} = ?`).join(', ');
  const vals = Object.values(patch).map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v));
  await db.execute(
    `UPDATE ${TABLE.MBC_CARDS} SET ${sets}, updated_at = ?, _sync_status = 'pending' WHERE id = ?`,
    [...vals, new Date().toISOString(), id]
  );
  await SyncQueue.enqueue('UPDATE', TABLE.MBC_CARDS, id, { id, organization_id: user.organization_id, ...patch }, user.organization_id);

}

// ── Card Types ─────────────────────────────────────────────────────────────

export async function fetchMbcCardTypes(user: RegisteredPharmacy) {
  const rows = await db.select<Record<string, unknown>>(
    `SELECT * FROM ${TABLE.MBC_CARD_TYPES} WHERE organization_id = ? ORDER BY created_at DESC`,
    [user.organization_id]
  );
  if (rows.length > 0) return rows;

  const { data } = await supabase
    .from('mbc_card_types')
    .select('*')
    .eq('organization_id', user.organization_id)
    .order('created_at', { ascending: false });

  if (data?.length) await db.bulkUpsert(TABLE.MBC_CARD_TYPES, data.map(serialize));
  return data ?? [];
}

export async function saveMbcCardType(payload: Record<string, unknown>, user: RegisteredPharmacy): Promise<void> {
  const row = serialize(payload);
  await db.upsert(TABLE.MBC_CARD_TYPES, row);
  await SyncQueue.enqueue('INSERT', TABLE.MBC_CARD_TYPES, row.id as string, row, user.organization_id);
}

// ── Card Templates ─────────────────────────────────────────────────────────

export async function fetchMbcCardTemplates(user: RegisteredPharmacy) {
  const rows = await db.select<Record<string, unknown>>(
    `SELECT * FROM ${TABLE.MBC_CARD_TEMPLATES} WHERE organization_id = ? ORDER BY created_at DESC`,
    [user.organization_id]
  );
  if (rows.length > 0) return rows.map((r) => deserializeJson(r, ['template_json']));

  const { data } = await supabase
    .from('mbc_card_templates')
    .select('*')
    .eq('organization_id', user.organization_id)
    .order('created_at', { ascending: false });

  if (data?.length) await db.bulkUpsert(TABLE.MBC_CARD_TEMPLATES, data.map(serialize));
  return (data ?? []).map((r) => deserializeJson(r as Record<string, unknown>, ['template_json']));
}

export async function saveMbcCardTemplate(payload: Record<string, unknown>, user: RegisteredPharmacy): Promise<void> {
  const row = serialize(payload);
  await db.upsert(TABLE.MBC_CARD_TEMPLATES, row);
  await SyncQueue.enqueue('INSERT', TABLE.MBC_CARD_TEMPLATES, row.id as string, row, user.organization_id);
}

// ── History ────────────────────────────────────────────────────────────────

export async function fetchMbcCardHistory(user: RegisteredPharmacy) {
  const rows = await db.select<Record<string, unknown>>(
    `SELECT * FROM ${TABLE.MBC_CARD_HISTORY} WHERE organization_id = ? ORDER BY action_date DESC`,
    [user.organization_id]
  );
  if (rows.length > 0) return rows;

  const { data } = await supabase
    .from('mbc_card_history')
    .select('*')
    .eq('organization_id', user.organization_id)
    .order('action_date', { ascending: false });

  if (data?.length) await db.bulkUpsert(TABLE.MBC_CARD_HISTORY, data.map(serialize));
  return data ?? [];
}

export async function addMbcCardHistory(entry: Record<string, unknown>, user: RegisteredPharmacy): Promise<void> {
  const row = serialize(entry);
  if (!row.action_date) row.action_date = new Date().toISOString();
  await db.upsert(TABLE.MBC_CARD_HISTORY, row);
  await SyncQueue.enqueue('INSERT', TABLE.MBC_CARD_HISTORY, row.id as string, row, user.organization_id);
}

// ── Card Value History ─────────────────────────────────────────────────────

/**
 * Fetch all value-history rows for a specific card, most recent first.
 * Tries SQLite first; falls back to Supabase and caches results locally.
 */
export async function fetchMbcCardValueHistory(
  cardId: string,
  user: RegisteredPharmacy
): Promise<Record<string, unknown>[]> {
  // Try SQLite first (offline-first). Filter by both card_id and organization_id.
  const rows = await db.select<Record<string, unknown>>(
    `SELECT * FROM ${TABLE.MBC_CARD_VALUE_HISTORY}
     WHERE card_id = ? AND (organization_id = ? OR organization_id IS NULL)
     ORDER BY created_at DESC`,
    [cardId, user.organization_id]
  );
  if (rows.length > 0) return rows;

  // Supabase fallback: organization_id is now a proper column on the server.
  const { data } = await supabase
    .from('mbc_card_value_history')
    .select('*')
    .eq('organization_id', user.organization_id)
    .eq('card_id', cardId)
    .order('created_at', { ascending: false });

  if (data?.length) {
    await db.bulkUpsert(TABLE.MBC_CARD_VALUE_HISTORY, data.map(serialize));
    return data;
  }
  return [];
}


/**
 * Write a single value-history entry to SQLite and enqueue it for Supabase push.
 * Call this from saveAddedCardValue after patching card_value on the card itself.
 */
export async function saveMbcCardValueHistory(
  entry: Record<string, unknown>,
  user: RegisteredPharmacy
): Promise<void> {
  const row = serialize(entry);
  if (!row.organization_id) row.organization_id = user.organization_id;
  if (!row.created_at) row.created_at = new Date().toISOString();
  await db.upsert(TABLE.MBC_CARD_VALUE_HISTORY, row);
  await SyncQueue.enqueue(
    'INSERT',
    TABLE.MBC_CARD_VALUE_HISTORY,
    row.id as string,
    row,
    user.organization_id
  );
}

