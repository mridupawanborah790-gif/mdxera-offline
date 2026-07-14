import { useMemo } from 'react';
import { useModuleVisibilityStore } from './moduleVisibilityStore';
import type { NavItem } from '@core/types';

/** Reactive read-only access to the current user's module/dashboard visibility. */
export function useModuleVisibility() {
  const hiddenScreens = useModuleVisibilityStore((s) => s.hiddenScreens);
  const hiddenDashboardFields = useModuleVisibilityStore((s) => s.hiddenDashboardFields);
  const hiddenFeatures = useModuleVisibilityStore((s) => s.hiddenFeatures);

  return useMemo(
    () => ({
      isScreenHidden: (screenId: string) => hiddenScreens.has(screenId),
      isDashboardFieldHidden: (fieldId: string) => hiddenDashboardFields.has(fieldId),
      isFeatureHidden: (featureId: string) => {
        if (hiddenFeatures.has(featureId)) return true;
        const profitSubFeatures = [
          'salesHistoryTotalProfit',
          'salesHistorySelectedBillProfit',
          'posTotalProfit',
          'posItemProfit',
          'posProfitQuotient',
          'posProductInsightsProfit',
        ];
        if (profitSubFeatures.includes(featureId) && hiddenFeatures.has('profitVisibility')) {
          return true;
        }
        return false;
      },
      hiddenScreens,
      hiddenDashboardFields,
      hiddenFeatures,
    }),
    [hiddenScreens, hiddenDashboardFields, hiddenFeatures]
  );
}

/** Prune a NavItem tree, removing items whose id is in the hidden set.
 *  A parent with no remaining visible children is also removed. */
export function filterNavByVisibility(
  items: NavItem[],
  hiddenScreens: Set<string>
): NavItem[] {
  const prune = (node: NavItem): NavItem | null => {
    if (hiddenScreens.has(node.id)) return null;
    if (node.children && node.children.length > 0) {
      const children = node.children
        .map(prune)
        .filter((c): c is NavItem => c !== null);
      if (children.length === 0) return null;
      return { ...node, children };
    }
    return node;
  };
  return items.map(prune).filter((n): n is NavItem => n !== null);
}
