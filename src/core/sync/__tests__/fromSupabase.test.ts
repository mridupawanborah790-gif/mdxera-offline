import { describe, it, expect } from 'vitest';
import { fromSupabase } from '../../../../services/storageService';

describe('storageService.fromSupabase — Boolean Safety Normalization', () => {
  it('correctly normalizes team_members boolean fields from multiple formats (boolean, number, string)', () => {
    const raw = {
      id: 'member-123',
      organization_id: 'org-abc',
      is_locked: 'false', // stringified falsy
      password_locked: 1,  // numeric truthy
    };

    const out = fromSupabase('team_members', raw);

    // key mapping from snake to camel
    expect(out.isLocked).toBe(false);
    expect(out.passwordLocked).toBe(true);
  });

  it('correctly normalizes business_roles and its nested permissionsMatrix', () => {
    const raw = {
      id: 'role-123',
      organization_id: 'org-abc',
      is_system_role: 'true', // stringified truthy
      is_active: 0,           // numeric falsy
      permissions_matrix: {
        salesChallans: {
          view: 'true',
          entry: 1,
          edit: '0',
          delete: false,
        },
        inventory: {
          view: true,
          entry: 'false',
        }
      }
    };

    const out = fromSupabase('business_roles', raw);

    expect(out.isSystemRole).toBe(true);
    expect(out.is_active).toBe(false);

    expect(out.permissionsMatrix.salesChallans.view).toBe(true);
    expect(out.permissionsMatrix.salesChallans.entry).toBe(true);
    expect(out.permissionsMatrix.salesChallans.edit).toBe(false);
    expect(out.permissionsMatrix.salesChallans.delete).toBe(false);

    expect(out.permissionsMatrix.inventory.view).toBe(true);
    expect(out.permissionsMatrix.inventory.entry).toBe(false);
  });

  it('correctly normalizes customers and suppliers boolean fields', () => {
    const rawCustomer = {
      id: 'cust-123',
      organization_id: 'org-abc',
      is_active: '1',
      is_blocked: 'false',
    };

    const outCust = fromSupabase('customers', rawCustomer);
    expect(outCust.is_active).toBe(true);
    expect(outCust.is_blocked).toBe(false);

    const rawSupplier = {
      id: 'sup-123',
      organization_id: 'org-abc',
      is_active: false,
      is_blocked: 'TRUE',
    };

    const outSup = fromSupabase('suppliers', rawSupplier);
    expect(outSup.is_active).toBe(false);
    expect(outSup.is_blocked).toBe(true);
  });
});
