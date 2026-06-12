const fs = require('fs');
const file = '/Users/my/Office/Krittik/Temp/mdxera-offline/services/storageService.ts';
let code = fs.readFileSync(file, 'utf8');

const newGetData = `        export const getData = async (tableName: string, defaultValue: any[] = [], user: RegisteredPharmacy | null, forceSync = false): Promise<any[]> => {
        if (!user) return defaultValue;
        const storeKey = tableName.toUpperCase() as keyof typeof STORES;

        if (forceSync && navigator.onLine) {
            syncChannel.postMessage({ action: 'pull_now' });
        }

        if (
            memoryCacheOrgScope[storeKey] === user.organization_id &&
            memoryCache[storeKey] &&
            memoryCache[storeKey].length > 0
        ) {
            return [...memoryCache[storeKey]];
        }

        try {
            await hydrateMemoryCacheFromSqlite(user.organization_id);
            if (memoryCache[storeKey] && memoryCache[storeKey].length > 0) {
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

const startIdx = code.indexOf("export const getData = async (tableName: string");
const endIdx = code.indexOf("};", startIdx) + 2;
code = code.substring(0, startIdx) + newGetData + code.substring(endIdx);

fs.writeFileSync(file, code);
