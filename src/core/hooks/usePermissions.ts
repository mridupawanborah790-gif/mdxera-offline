import { useAuthStore } from '@core/auth/authStore';
import { canAccessScreen } from '@core/utils/rbac';

/** Returns a permission-check function scoped to the current user. */
export function usePermissions() {
  const { currentUser } = useAuthStore();

  return {
    can: (screen: string) =>
      currentUser ? canAccessScreen(screen, currentUser, [], []) : false,
    currentUser,
  };
}
