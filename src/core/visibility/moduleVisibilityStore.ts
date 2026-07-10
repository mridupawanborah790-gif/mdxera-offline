import { create } from 'zustand';

export interface ModuleVisibilityState {
  hiddenScreens: string[];
  hiddenDashboardFields: string[];
  hiddenFeatures: string[];
}

interface StoreState {
  userId: string | null;
  hiddenScreens: Set<string>;
  hiddenDashboardFields: Set<string>;
  hiddenFeatures: Set<string>;

  loadForUser: (userId: string | null) => void;
  setHiddenScreens: (ids: string[]) => void;
  setHiddenDashboardFields: (ids: string[]) => void;
  setHiddenFeatures: (ids: string[]) => void;
  clear: () => void;
}

const storageKey = (userId: string) => `mdxera:moduleVisibility:${userId}`;

function readFromStorage(userId: string): ModuleVisibilityState {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return { hiddenScreens: [], hiddenDashboardFields: [], hiddenFeatures: [] };
    const parsed = JSON.parse(raw) as Partial<ModuleVisibilityState>;
    return {
      hiddenScreens: Array.isArray(parsed.hiddenScreens) ? parsed.hiddenScreens : [],
      hiddenDashboardFields: Array.isArray(parsed.hiddenDashboardFields) ? parsed.hiddenDashboardFields : [],
      hiddenFeatures: Array.isArray(parsed.hiddenFeatures) ? parsed.hiddenFeatures : [],
    };
  } catch {
    return { hiddenScreens: [], hiddenDashboardFields: [], hiddenFeatures: [] };
  }
}

function writeToStorage(userId: string, state: ModuleVisibilityState) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(state));
  } catch {
    /* quota or privacy mode — fall back to in-memory only */
  }
}

export const useModuleVisibilityStore = create<StoreState>((set, get) => ({
  userId: null,
  hiddenScreens: new Set<string>(),
  hiddenDashboardFields: new Set<string>(),
  hiddenFeatures: new Set<string>(),

  loadForUser: (userId) => {
    if (!userId) {
      set({ userId: null, hiddenScreens: new Set(), hiddenDashboardFields: new Set(), hiddenFeatures: new Set() });
      return;
    }
    const data = readFromStorage(userId);
    set({
      userId,
      hiddenScreens: new Set(data.hiddenScreens),
      hiddenDashboardFields: new Set(data.hiddenDashboardFields),
      hiddenFeatures: new Set(data.hiddenFeatures),
    });
  },

  setHiddenScreens: (ids) => {
    const { userId } = get();
    const next = new Set(ids);
    set({ hiddenScreens: next });
    if (userId) {
      writeToStorage(userId, {
        hiddenScreens: Array.from(next),
        hiddenDashboardFields: Array.from(get().hiddenDashboardFields),
        hiddenFeatures: Array.from(get().hiddenFeatures),
      });
    }
  },

  setHiddenDashboardFields: (ids) => {
    const { userId } = get();
    const next = new Set(ids);
    set({ hiddenDashboardFields: next });
    if (userId) {
      writeToStorage(userId, {
        hiddenScreens: Array.from(get().hiddenScreens),
        hiddenDashboardFields: Array.from(next),
        hiddenFeatures: Array.from(get().hiddenFeatures),
      });
    }
  },

  setHiddenFeatures: (ids) => {
    const { userId } = get();
    const next = new Set(ids);
    set({ hiddenFeatures: next });
    if (userId) {
      writeToStorage(userId, {
        hiddenScreens: Array.from(get().hiddenScreens),
        hiddenDashboardFields: Array.from(get().hiddenDashboardFields),
        hiddenFeatures: Array.from(next),
      });
    }
  },

  clear: () =>
    set({ userId: null, hiddenScreens: new Set(), hiddenDashboardFields: new Set(), hiddenFeatures: new Set() }),
}));
