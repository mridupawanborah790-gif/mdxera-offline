/**
 * Smart Fuzzy Match utility for Medimart Retail.
 * Supports token-based matching to allow searching across separators.
 * e.g., "MYOTOPSR" matches "MYOTOP 450 SR TAB"
 */
let lastQuery: string | null = null;
let cachedQ: string = '';
let cachedQClean: string = '';
let cachedTokens: string[] = [];
let cachedCleanTokens: string[] = [];

export const fuzzyMatch = (target: string | undefined | null, query: string | undefined | null): boolean => {
    // If query is null or undefined, treat it as an empty string.
    // An empty query matches everything, so return true.
    if (!query || String(query).trim() === '') return true;
    
    // If target is null or undefined, it cannot match any non-empty query.
    if (!target) return false;

    const targetStr = String(target);
    const queryStr = String(query);

    const t = targetStr.toLowerCase();
    
    // Cache preprocessing of the query string if it changes
    if (queryStr !== lastQuery) {
        lastQuery = queryStr;
        cachedQ = queryStr.toLowerCase().trim();
        cachedQClean = cachedQ.replace(/[^a-z0-9]/g, '');
        cachedTokens = cachedQ.split(/\s+/).filter(Boolean);
        cachedCleanTokens = cachedTokens.map(token => token.replace(/[^a-z0-9]/g, ''));
    }

    // 1. Direct substring match (Fastest)
    if (t.includes(cachedQ)) return true;

    // 2. Compact match (Ignore spaces and special chars)
    const tClean = t.replace(/[^a-z0-9]/g, '');
    if (tClean.includes(cachedQClean)) return true;

    // 3. Token-based match: Split query into chunks of letters and numbers
    if (cachedTokens.length > 0) {
        // Every token in the search query must be present in the cleaned target string
        const match = cachedCleanTokens.every(cleanToken => tClean.includes(cleanToken));
        if (match) return true;
    }

    // 4. Reverse compact match for tokens (e.g., "MYOTOPSR" typed as one word matching "MYOTOP SR")
    // We try to see if the query (cleaned) is a partial match of the target (cleaned)
    // or if the query can be found by skipping characters
    if (cachedQClean.length > 2) {
        let i = 0;
        let j = 0;
        const tLen = tClean.length;
        const qLen = cachedQClean.length;
        while (i < tLen && j < qLen) {
            if (tClean[i] === cachedQClean[j]) {
                j++;
            }
            i++;
        }
        if (j === qLen) return true;
    }

    return false;
};