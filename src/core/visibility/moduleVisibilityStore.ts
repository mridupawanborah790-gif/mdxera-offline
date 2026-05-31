import { create } from 'zustand';

export interface ModuleVisibilityState {
  hiddenScreens: string[];
  hiddenDashboardFields: string[];
}

interface StoreState {
  userId: string | null;
  hiddenScreens: Set<string>;
  hiddenDashboardFields: Set<string>;

  loadForUser: (userId: string | null) => void;
  setHiddenScreens: (ids: string[]) => void;
  setHiddenDashboardFields: (ids: string[]) => void;
  clear: () => void;
}

const storageKey = (userId: string) => `mdxera:moduleVisibility:${userId}`;

function readFromStorage(userId: string): ModuleVisibilityState {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return { hiddenScreens: [], hiddenDashboardFields: [] };
    const parsed = JSON.parse(raw) as Partial<ModuleVisibilityState>;
    return {
      hiddenScreens: Array.isArray(parsed.hiddenScreens) ? parsed.hiddenScreens : [],
      hiddenDashboardFields: Array.isArray(parsed.hiddenDashboardFields) ? parsed.hiddenDashboardFields : [],
    };
  } catch {
    return { hiddenScreens: [], hiddenDashboardFields: [] };
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

  loadForUser: (userId) => {
    if (!userId) {
      set({ userId: null, hiddenScreens: new Set(), hiddenDashboardFields: new Set() });
      return;
    }
    const data = readFromStorage(userId);
    set({
      userId,
      hiddenScreens: new Set(data.hiddenScreens),
      hiddenDashboardFields: new Set(data.hiddenDashboardFields),
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
      });
    }
  },

  clear: () =>
    set({ userId: null, hiddenScreens: new Set(), hiddenDashboardFields: new Set() }),
}));
