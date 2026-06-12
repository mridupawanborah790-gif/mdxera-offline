const fs = require('fs');
const file = '/Users/my/Office/Krittik/Temp/mdxera-offline/services/storageService.ts';
let code = fs.readFileSync(file, 'utf8');

// Add static imports at the top
const importsToAdd = `
import { db as sqliteDb } from '../src/core/db/client';
import { TABLE as SCHEMA_TABLE } from '../src/core/db/schema';
`;
code = code.replace("import { supabase } from './supabaseClient';", importsToAdd + "import { supabase } from './supabaseClient';");

// Replace dynamic imports in hydrateMemoryCacheFromSqlite
code = code.replace(/let sqliteDb: typeof import\('\.\.\/src\/core\/db\/client'\)\.db \| null = null;\n\s+try {\n\s+const mod = await import\('\.\.\/src\/core\/db\/client'\);\n\s+sqliteDb = mod\.db;\n\s+} catch \(err\) {\n\s+console\.warn\('\[storage\] SQLite client unavailable, skipping hydration:', err\);\n\s+return;\n\s+}\n\s+if \(!sqliteDb\) return;\n\s+const db = sqliteDb;/g, 'const db = sqliteDb;');

// Replace dynamic imports in getCustomerInvoiceTotal
code = code.replace(/const { db } = await import\('\.\.\/src\/core\/db\/client'\);\n\s+const { TABLE } = await import\('\.\.\/src\/core\/db\/schema'\);\n\s+const rows = await db\.select<Transaction>\(`SELECT \* FROM \$\{TABLE\.SALES_BILL\}/g, 'const rows = await sqliteDb.select<Transaction>(`SELECT * FROM ${SCHEMA_TABLE.SALES_BILL}');

// Replace dynamic imports in getSupplierInvoiceTotal
code = code.replace(/const { db } = await import\('\.\.\/src\/core\/db\/client'\);\n\s+const { TABLE } = await import\('\.\.\/src\/core\/db\/schema'\);\n\s+const rows = await db\.select<Purchase>\(`SELECT \* FROM \$\{TABLE\.PURCHASES\}/g, 'const rows = await sqliteDb.select<Purchase>(`SELECT * FROM ${SCHEMA_TABLE.PURCHASES}');

// Fix getData
code = code.replace(/export const getData = async \(tableName: string, defaultValue: any\[\] = \[\], user: RegisteredPharmacy \| null\): Promise<any\[\]> => \{/g, "export const getData = async (tableName: string, defaultValue: any[] = [], user: RegisteredPharmacy | null, forceSync = false): Promise<any[]> => {");

code = code.replace(/if \(\n\s+memoryCacheOrgScope\[storeKey\] === user\.organization_id &&\n\s+memoryCache\[storeKey\] &&\n\s+memoryCache\[storeKey\]\.length > 0\n\s+\) {/g, "if (\n            !forceSync &&\n            memoryCacheOrgScope[storeKey] === user.organization_id &&\n            memoryCache[storeKey] &&\n            memoryCache[storeKey].length > 0\n        ) {");

fs.writeFileSync(file, code);
