import { supabase } from '@core/db/supabaseClient';
import type { RegisteredPharmacy } from '@core/types';

export interface SupabaseSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix seconds
  userId: string;
}

export async function supabaseLogin(
  email: string,
  password: string
): Promise<{ user: RegisteredPharmacy; session: SupabaseSession }> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user) {
    throw new Error(error?.message ?? 'Login failed');
  }

  // Fetch the user's profile row (contains org data, name, etc.)
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', data.user.id)
    .single();

  if (profileError || !profile) {
    throw new Error(profileError?.message ?? 'Could not load user profile');
  }

  const user: RegisteredPharmacy = {
    id: data.user.id,
    user_id: data.user.id,
    organization_id: profile.organization_id,
    email: data.user.email ?? email,
    is_active: profile.is_active ?? true,
    full_name: profile.full_name ?? '',
    pharmacy_name: profile.pharmacy_name ?? '',
    manager_name: profile.manager_name ?? '',
    role: profile.role ?? 'clerk',
    address: profile.address ?? '',
    address_line2: profile.address_line2 ?? '',
    pincode: profile.pincode ?? '',
    state: profile.state ?? '',
    district: profile.district ?? '',
    mobile: profile.mobile ?? '',
    gstin: profile.gstin ?? '',
    retailer_gstin: profile.retailer_gstin ?? '',
    drug_license: profile.drug_license ?? null,
    dl_valid_to: profile.dl_valid_to ?? null,
    food_license: profile.food_license ?? null,
    pan_number: profile.pan_number ?? '',
    bank_account_name: profile.bank_account_name ?? '',
    bank_account_number: profile.bank_account_number ?? '',
    bank_ifsc_code: profile.bank_ifsc_code ?? '',
    bank_upi_id: profile.bank_upi_id ?? '',
    authorized_signatory: profile.authorized_signatory ?? '',
    pharmacy_logo_url: profile.pharmacy_logo_url ?? '',
    dashboard_logo_url: profile.dashboard_logo_url ?? '',
    terms_and_conditions: profile.terms_and_conditions ?? '',
    purchase_order_terms: profile.purchase_order_terms ?? '',
    organization_type: profile.organization_type ?? null,
    subscription_plan: profile.subscription_plan ?? 'starter',
    subscription_status: profile.subscription_status ?? 'active',
    subscription_id: profile.subscription_id ?? '',
    watermark_type: profile.watermark_type ?? 'none',
    watermark_opacity: profile.watermark_opacity !== undefined && profile.watermark_opacity !== null ? Number(profile.watermark_opacity) : 0.2,
    created_at: profile.created_at ?? undefined,
    updated_at: profile.updated_at ?? undefined,
  };

  const session: SupabaseSession = {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at ?? 0,
    userId: data.user.id,
  };

  return { user, session };
}

export async function supabaseLogout(): Promise<void> {
  await supabase.auth.signOut();
}

export async function supabaseRefreshSession(): Promise<SupabaseSession | null> {
  const { data, error } = await supabase.auth.refreshSession();
  if (error || !data.session) return null;
  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at ?? 0,
    userId: data.session.user.id,
  };
}

export async function supabaseRestoreSession(): Promise<SupabaseSession | null> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) return null;
  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at ?? 0,
    userId: data.session.user.id,
  };
}

export async function supabaseRequestPasswordReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email);
  if (error) throw new Error(error.message);
}
