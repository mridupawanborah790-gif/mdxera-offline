/**
 * Org roster sync — pulls all team members for the organization into local
 * SQLite so we can show informative login errors offline:
 *   - "Account exists but hasn't logged in on this device yet" (in team_members)
 *   - "Account not found"                                       (not in team_members)
 *
 * NB: Password hashes are never synced from the server (Supabase doesn't
 * expose them). The `_local_auth` table only gets populated when each user
 * does their FIRST online login on this device. The roster is purely for UX.
 */
import { db } from '@core/db/client';
import { supabase } from '@core/db/supabaseClient';
import { TABLE } from '@core/db/schema';
import { isOnline } from '@core/sync/networkMonitor';
import type { RegisteredPharmacy } from '@core/types';

/** Sync the org's team_members + the owner's profile into local SQLite. */
export async function syncOrgRoster(user: RegisteredPharmacy): Promise<void> {
  if (!isOnline()) return;

  try {
    const orgId = user.organization_id;

    // 1. Fetch team_members for this org
    const { data: teamRows, error: teamErr } = await supabase
      .from('team_members')
      .select('*')
      .eq('organization_id', orgId);
    if (teamErr) throw teamErr;

    // Insert one at a time (no wrapping transaction). Tauri's plugin-sql uses a
    // single connection, so two parallel `db.transaction()` calls interleave
    // their BEGIN/COMMIT and break with "cannot commit - no transaction is active".
    if (teamRows && teamRows.length > 0) {
      for (const row of teamRows) {
        try {
          const serialized: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(row)) {
            serialized[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
          }
          const cols = Object.keys(serialized);
          const placeholders = cols.map(() => '?').join(', ');
          await db.execute(
            `INSERT OR REPLACE INTO ${TABLE.TEAM_MEMBERS} (${cols.join(', ')}) VALUES (${placeholders})`,
            Object.values(serialized)
          );
        } catch (rowErr) {
          console.debug('[rosterSync] team_member row skipped:', (rowErr as Error)?.message);
        }
      }
    }

    // 2. Also fetch the owner profile (sometimes not in team_members)
    const { data: profileRow } = await supabase
      .from('profiles')
      .select('*')
      .eq('organization_id', orgId)
      .eq('user_id', user.id);

    if (profileRow && profileRow.length > 0) {
      const { adaptRowForSqlite } = await import('@core/sync/columnFilter');
      for (const row of profileRow) {
        try {
          const adapted = await adaptRowForSqlite('profiles', row, { syncStatus: 'synced' });
          if (adapted) {
            await db.upsert('profiles', adapted);
          }
        } catch (rowErr) {
          console.debug('[rosterSync] profile row skipped:', (rowErr as Error)?.message);
        }
      }
    }
  } catch (err) {
    // Non-fatal: roster sync is best-effort
    console.warn('[rosterSync] failed:', err);
  }
}

/**
 * Check whether an email is known to belong to the same org as any user who
 * has previously logged in on this device. Returns:
 *   - 'cached'     → email is in _local_auth (full offline login available)
 *   - 'roster'     → email is in team_members or profiles (needs first online login)
 *   - 'unknown'    → email is nowhere in local cache
 */
export async function checkEmailKnown(email: string): Promise<'cached' | 'roster' | 'unknown'> {
  const lowered = email.toLowerCase().trim();
  if (!lowered) return 'unknown';

  // 1. Already has bcrypt hash → can log in offline
  const auth = await db.select<{ id: string }>(
    `SELECT id FROM ${TABLE.LOCAL_AUTH} WHERE email = ? LIMIT 1`,
    [lowered]
  );
  if (auth.length > 0) return 'cached';

  // 2. In team_members → org membership known but no offline credential yet
  const team = await db.select<{ id: string }>(
    `SELECT id FROM ${TABLE.TEAM_MEMBERS} WHERE lower(email) = ? LIMIT 1`,
    [lowered]
  );
  if (team.length > 0) return 'roster';

  // 3. In profiles (org owner case)
  const profile = await db.select<{ user_id: string }>(
    `SELECT user_id FROM ${TABLE.PROFILES} WHERE lower(email) = ? LIMIT 1`,
    [lowered]
  );
  if (profile.length > 0) return 'roster';

  return 'unknown';
}
