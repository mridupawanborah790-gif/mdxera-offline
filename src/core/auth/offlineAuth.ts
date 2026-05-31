import bcrypt from 'bcryptjs';
import { db } from '@core/db/client';
import { TABLE } from '@core/db/schema';
import { invoke } from '@tauri-apps/api/core';
import type { RegisteredPharmacy } from '@core/types';

const BCRYPT_ROUNDS = 12;
// Local sessions never expire on their own — user stays logged in until they
// click logout explicitly.
const SESSION_TTL_DAYS = 365 * 100;

interface LocalAuthRow {
  id: string;
  organization_id: string;
  email: string;
  password_hash: string;
  user_data: string;
  roles_data: string;
  hmac_secret: string;
  created_at: number;
  updated_at: number;
}

export interface LocalSession {
  userId: string;
  organizationId: string;
  email: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

// ── Credential management ──────────────────────────────────────────────────

/** Store (or refresh) offline credentials after a successful online login. */
export async function cacheOfflineCredentials(
  user: RegisteredPharmacy,
  password: string,
  rolesData: unknown = []
): Promise<void> {
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const secret = generateSecret();
  const now = Date.now();

  await db.execute(
    `INSERT OR REPLACE INTO ${TABLE.LOCAL_AUTH}
       (id, organization_id, email, password_hash, user_data, roles_data, hmac_secret, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user.id,
      user.organization_id,
      user.email.toLowerCase(),
      passwordHash,
      JSON.stringify(user),
      JSON.stringify(rolesData),
      secret,
      now,
      now,
    ]
  );
}

/** Verify email + password against locally stored bcrypt hash. */
export async function verifyOfflineCredentials(
  email: string,
  password: string
): Promise<{ user: RegisteredPharmacy; rolesData: unknown } | null> {
  const rows = await db.select<LocalAuthRow>(
    `SELECT * FROM ${TABLE.LOCAL_AUTH} WHERE email = ? LIMIT 1`,
    [email.toLowerCase()]
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  const valid = await bcrypt.compare(password, row.password_hash);
  if (!valid) return null;

  return {
    user: JSON.parse(row.user_data) as RegisteredPharmacy,
    rolesData: JSON.parse(row.roles_data),
  };
}

// ── Local session tokens ───────────────────────────────────────────────────

/** Issue a signed local session after offline login. */
export async function createLocalSession(userId: string, email: string): Promise<LocalSession> {
  const rows = await db.select<{ hmac_secret: string; organization_id: string }>(
    `SELECT hmac_secret, organization_id FROM ${TABLE.LOCAL_AUTH} WHERE id = ? LIMIT 1`,
    [userId]
  );
  if (rows.length === 0) throw new Error('No local credentials found for user');

  const { hmac_secret: secret, organization_id } = rows[0];
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

  const payload = JSON.stringify({ userId, organizationId: organization_id, email, issuedAt: now, expiresAt });
  const signature = await signPayload(payload, secret);

  return { userId, organizationId: organization_id, email, issuedAt: now, expiresAt, signature };
}

/** Verify a previously issued local session. Returns null if expired or tampered. */
export async function verifyLocalSession(session: LocalSession): Promise<boolean> {
  if (Date.now() > session.expiresAt) return false;

  const rows = await db.select<{ hmac_secret: string }>(
    `SELECT hmac_secret FROM ${TABLE.LOCAL_AUTH} WHERE id = ? LIMIT 1`,
    [session.userId]
  );
  if (rows.length === 0) return false;

  const payload = JSON.stringify({
    userId: session.userId,
    organizationId: session.organizationId,
    email: session.email,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
  });
  const expected = await signPayload(payload, rows[0].hmac_secret);
  return expected === session.signature;
}

/** Refresh the cached user_data for a user (called after online sync updates profile). */
export async function refreshCachedUserData(
  userId: string,
  user: RegisteredPharmacy
): Promise<void> {
  await db.execute(
    `UPDATE ${TABLE.LOCAL_AUTH} SET user_data = ?, updated_at = ? WHERE id = ?`,
    [JSON.stringify(user), Date.now(), userId]
  );
}

// ── Internal helpers ───────────────────────────────────────────────────────

function generateSecret(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function signPayload(payload: string, secret: string): Promise<string> {
  try {
    // Prefer Tauri Rust HMAC (constant-time, secure)
    return await invoke<string>('sign_local_token', { payload, secret });
  } catch {
    // Fallback: WebCrypto HMAC-SHA256 (when running in browser / dev mode)
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
  }
}
