const fs = require('fs');
const file = '/Users/my/Office/Krittik/Temp/mdxera-offline/services/storageService.ts';
let code = fs.readFileSync(file, 'utf8');

const oldGetData = `    export const getData = async (tableName: string, defaultValue: any[] = [], user: RegisteredPharmacy | null, forceSync = false): Promise<any[]> => {
        if (!user) return defaultValue;
        const storeKey = tableName.toUpperCase() as keyof typeof STORES;

        // Priority 1: In-memory cache
        // If we are checking the same org and have data, return it immediately.
        // This stops infinite loops where UI re-renders, triggers fetch, which
        // updates state, which triggers re-render. Memory cache is invalidated
        // after offline writes until the user manually reloads.
        if (
            !forceSync &&
            memoryCacheOrgScope[storeKey] === user.organization_id &&
            memoryCache[storeKey] &&
            memoryCache[storeKey].length > 0
        ) {
            return [...memoryCache[storeKey]];
        }

        // Priority 1.5: If we are offline and SQLite has data populated by
        // InitialSync, hydrate the memoryCache on-demand so we don't return
        // empty arrays (which would wipe app state).
        if (!navigator.onLine) {
            try {
                await hydrateMemoryCacheFromSqlite(user.organization_id);
                if (memoryCache[storeKey] && memoryCache[storeKey].length > 0) {
                    return [...memoryCache[storeKey]];
                }
            } catch {
                /* fall through */
            }
        }

        // Priority 2: Local IndexedDB for instant UI
        const cached = await idb.getAll(STORES[storeKey]);

        // If we found data in IDB, populate memory cache to keep them in sync
        if (cached && cached.length > 0) {
            memoryCache[storeKey] = [...cached];
            memoryCacheOrgScope[storeKey] = user.organization_id;
        }

        // Priority 2: Fetch updates in background if online
        if (navigator.onLine) {
            if (cached.length === 0) {
                try {
                    const allData = await fetchAllPagesFromSupabase(tableName, user.organization_id);
                    if (allData.length > 0) {
                        const normalized = allData.map(d => fromSupabase(tableName, d));
                        
                        // Always update memory cache so the session stays consistent
                        memoryCache[storeKey] = [...normalized];
                        memoryCacheOrgScope[storeKey] = user.organization_id;
                        
                        await idb.putBulk(STORES[storeKey], normalized);
                        return normalized;
                    }
                } catch (e) {
                    console.error(\`Initial fetch failed for \${tableName}:\`, e);
                }
            }
            // Note: The else block with setTimeout(fetchAllPagesFromSupabase) was removed.
            // Background polling is now handled correctly by SyncEngine/SyncPuller.
            // Overwriting memoryCache/IDB directly here destroyed local pending changes.
        }
        return cached.length > 0 ? cached : defaultValue;
    };`;

const newGetData = `    export const getData = async (tableName: string, defaultValue: any[] = [], user: RegisteredPharmacy | null, forceSync = false): Promise<any[]> => {
        if (!user) return defaultValue;
        const storeKey = tableName.toUpperCase() as keyof typeof STORES;

        if (
            !forceSync &&
            memoryCacheOrgScope[storeKey] === user.organization_id &&
            memoryCache[storeKey] &&
            memoryCache[storeKey].length > 0
        ) {
            return [...memoryCache[storeKey]];
        }

        try {
            await hydrateMemoryCacheFromSqlite(user.organization_id);
            if (!forceSync && memoryCache[storeKey] && memoryCache[storeKey].length > 0) {
                return [...memoryCache[storeKey]];
            }
        } catch {
            /* fall through */
        }

        const cached = await idb.getAll(STORES[storeKey]);

        if (cached && cached.length > 0) {
            memoryCache[storeKey] = [...cached];
            memoryCacheOrgScope[storeKey] = user.organization_id;
        }

        if (navigator.onLine) {
            if (forceSync) {
                // If forceSync is requested, notify the sync engine to pull updates in the background.
                // We do NOT block and fetch everything manually here, because fetching raw rows 
                // from Supabase directly would overwrite pending local changes.
                syncChannel.postMessage({ action: 'pull_now' });
            }

            if ((memoryCache[storeKey] == null || memoryCache[storeKey].length === 0) && cached.length === 0) {
                try {
                    const allData = await fetchAllPagesFromSupabase(tableName, user.organization_id);
                    if (allData.length > 0) {
                        const normalized = allData.map(d => fromSupabase(tableName, d));
                        memoryCache[storeKey] = [...normalized];
                        memoryCacheOrgScope[storeKey] = user.organization_id;
                        await idb.putBulk(STORES[storeKey], normalized);
                        return normalized;
                    }
                } catch (e) {
                    console.error(\`Initial fetch failed for \${tableName}:\`, e);
                }
            }
        }
        
        if (memoryCache[storeKey] && memoryCache[storeKey].length > 0) {
            return [...memoryCache[storeKey]];
        }

        return cached.length > 0 ? cached : defaultValue;
    };`;

if (!code.includes(oldGetData)) {
    console.error("Old code not found! Proceeding with index fallback...");
    // fallback logic to do targeted replacement
    const startIdx = code.indexOf("export const getData = async (tableName: string");
    const endIdx = code.indexOf("};", startIdx) + 2;
    code = code.substring(0, startIdx) + newGetData + code.substring(endIdx);
} else {
    code = code.replace(oldGetData, newGetData);
}

fs.writeFileSync(file, code);
