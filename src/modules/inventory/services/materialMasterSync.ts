/**
 * Reconcile orphan inventory rows with material_master.
 *
 * Background: inventory and material_master used to be independent. After
 * merging, the link is `inventory.code === medicine.materialCode`. Many
 * legacy inventory rows have no code and no matching master.
 *
 * This service groups inventory by (name+brand) and, for groups that are
 * missing in master, creates one material per group and stamps every batch
 * with the new materialCode.
 */
import * as storage from '@core/services/storageService';
import type { InventoryItem, Medicine, RegisteredPharmacy } from '@core/types';
import { extractPackMultiplier, resolveUnitsPerStrip } from '@core/utils/pack';
import { supabase } from '@core/db/supabaseClient';

/**
 * Make sure the Supabase JS client has a live session before issuing writes.
 * When the app booted from a restored Tauri-persisted session, the JS client
 * can have stale or missing auth; that surfaces as HTTP 401 + RLS 42501 on
 * INSERT. Calling this up-front gives the user a clear "please log in"
 * message instead of an opaque "row violates row-level security policy".
 */
async function ensureLiveAuth(): Promise<void> {
  if (!navigator.onLine) return; // offline writes are queued anyway
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error('Could not read auth session. Please log in again.');
  if (data.session) return;
  const refreshed = await supabase.auth.refreshSession();
  if (refreshed.error || !refreshed.data.session) {
    throw new Error('Your session has expired. Please log out and log in again to continue.');
  }
}

/** Normalize so casing/whitespace differences don't fragment groups. */
export const materialKey = (name: string | null | undefined, brand: string | null | undefined): string =>
  `${(name || '').trim().toLowerCase()}|${(brand || '').trim().toLowerCase()}`;

const normalizedCode = (v: string | null | undefined) => (v || '').trim();

export interface MaterialGroupStatus {
  key: string;
  name: string;
  brand: string;
  batchCount: number;
  /** Stock summed across all batches in this group. */
  totalStock: number;
  /** A representative inventory row — used to seed master fields. */
  representative: InventoryItem;
  /** All inventory rows in this group (so we can relink each batch). */
  members: InventoryItem[];
  /** Matched medicine, if any. */
  master: Medicine | null;
  inMaster: boolean;
}

/**
 * Group inventory rows by name+brand and tag each group with master status.
 * Match is by code when both sides have one; otherwise falls back to name+brand.
 */
export function groupInventoryByMaterial(
  inventory: InventoryItem[],
  medicines: Medicine[],
): MaterialGroupStatus[] {
  const masterByCode = new Map<string, Medicine>();
  const masterByKey = new Map<string, Medicine>();
  for (const m of medicines) {
    const code = normalizedCode(m.materialCode);
    if (code) masterByCode.set(code, m);
    masterByKey.set(materialKey(m.name, m.brand), m);
  }

  const groups = new Map<string, MaterialGroupStatus>();
  for (const item of inventory) {
    const key = materialKey(item.name, item.brand);
    let group = groups.get(key);
    if (!group) {
      const itemCode = normalizedCode(item.code);
      const master =
        (itemCode && masterByCode.get(itemCode)) ||
        masterByKey.get(key) ||
        null;
      group = {
        key,
        name: item.name || '',
        brand: item.brand || '',
        batchCount: 0,
        totalStock: 0,
        representative: item,
        members: [],
        master,
        inMaster: !!master,
      };
      groups.set(key, group);
    }
    group.batchCount += 1;
    group.totalStock += Number(item.stock || 0);
    group.members.push(item);
  }

  return Array.from(groups.values()).sort((a, b) => {
    // Missing first, then alphabetical
    if (a.inMaster !== b.inMaster) return a.inMaster ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

/** Build the master payload from a representative inventory row. */
function buildMasterPayload(
  group: MaterialGroupStatus,
  organizationId: string,
): Omit<Medicine, 'id' | 'materialCode' | 'created_at' | 'updated_at'> {
  const rep = group.representative;
  const pack = (rep.packType || '').trim();
  const inferredUnits = resolveUnitsPerStrip(extractPackMultiplier(pack) ?? rep.unitsPerPack ?? 1, pack);
  return {
    organization_id: organizationId,
    name: group.name,
    brand: group.brand || '',
    manufacturer: rep.manufacturer || '',
    composition: rep.composition || '',
    pack: pack || undefined,
    barcode: rep.barcode || undefined,
    hsnCode: rep.hsnCode || '',
    gstRate: Number(rep.gstPercent ?? 0),
    mrp: rep.mrp != null ? String(rep.mrp) : undefined,
    description: rep.description || '',
    is_active: true,
    materialMasterType: 'trading_goods',
    isInventorised: true,
    isSalesEnabled: true,
    isPurchaseEnabled: true,
    isProductionEnabled: false,
    isInternalIssueEnabled: false,
    valuationMethod: 'standard',
    standardPriceRate: Number(rep.purchasePrice ?? 0) || 0,
    movingAverageRate: 0,
  } as any; // unitsPerPack isn't part of Medicine; we keep it on inventory only.
}

/**
 * Create a master record for a group and stamp every batch with the new code.
 * All writes go through storage.saveData so online/offline + sync are handled.
 */
export async function createMasterFromGroup(
  group: MaterialGroupStatus,
  user: RegisteredPharmacy,
): Promise<{ medicine: Medicine; updatedBatches: number }> {
  await ensureLiveAuth();
  const payload = buildMasterPayload(group, user.organization_id);
  const saved = (await storage.saveData('material_master', payload, user)) as Medicine;
  const newCode = saved.materialCode;
  if (!newCode) throw new Error(`Material master created without a code (id=${saved.id}).`);

  // Stamp the code onto every inventory batch in this group. saveData with
  // isUpdate=true triggers the existing sync path.
  let updated = 0;
  for (const item of group.members) {
    if (normalizedCode(item.code) === newCode) continue; // already linked
    await storage.saveData(
      'inventory',
      { ...item, code: newCode },
      user,
      true,
    );
    updated += 1;
  }
  return { medicine: saved, updatedBatches: updated };
}

/**
 * Sequentially create masters for many groups. Sequential (not Promise.all)
 * because getNextMaterialCode is shared state — racing would cause duplicate
 * code collisions and noisy retries.
 */
export async function bulkCreateFromInventory(
  groups: MaterialGroupStatus[],
  user: RegisteredPharmacy,
  onProgress?: (done: number, total: number, currentName: string) => void,
): Promise<{ created: number; updatedBatches: number; failed: { key: string; name: string; error: string }[] }> {
  // Fail fast if auth is dead — better one clear message than N opaque RLS errors.
  await ensureLiveAuth();
  const failed: { key: string; name: string; error: string }[] = [];
  let created = 0;
  let updatedBatches = 0;

  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i];
    onProgress?.(i, groups.length, g.name);
    try {
      const result = await createMasterFromGroup(g, user);
      created += 1;
      updatedBatches += result.updatedBatches;
    } catch (err: any) {
      failed.push({ key: g.key, name: g.name, error: err?.message || String(err) });
    }
  }
  onProgress?.(groups.length, groups.length, '');
  return { created, updatedBatches, failed };
}

/**
 * After a master is created elsewhere (e.g. AddMedicineModal), link any
 * inventory rows whose name+brand matches and which currently have no code.
 * Returns the count of inventory rows updated.
 */
export async function linkInventoryToNewMaster(
  medicine: Medicine,
  inventory: InventoryItem[],
  user: RegisteredPharmacy,
): Promise<number> {
  const code = normalizedCode(medicine.materialCode);
  if (!code) return 0;
  const targetKey = materialKey(medicine.name, medicine.brand);
  const targets = inventory.filter(
    (i) => !normalizedCode(i.code) && materialKey(i.name, i.brand) === targetKey,
  );
  for (const item of targets) {
    await storage.saveData('inventory', { ...item, code }, user, true);
  }
  return targets.length;
}
