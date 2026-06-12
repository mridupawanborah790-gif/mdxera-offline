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
code = code.replace(/let sqliteDb: typeof import\('\.\.\/src\/core\/db\/client'\)\.db \| null = null;/g, '');
code = code.replace(/try {\n\s+const mod = await import\('\.\.\/src\/core\/db\/client'\);\n\s+sqliteDb = mod\.db;\n\s+} catch \(err\) {\n\s+console\.warn\('\[storage\] SQLite client unavailable, skipping hydration:', err\);\n\s+return;\n\s+}/g, '');
code = code.replace(/if \(!sqliteDb\) return;/g, '');
code = code.replace(/const db = sqliteDb;/g, 'const db = sqliteDb;');

// Replace dynamic imports in getCustomerInvoiceTotal
code = code.replace(/const { db } = await import\('\.\.\/src\/core\/db\/client'\);/g, '');
code = code.replace(/const { TABLE } = await import\('\.\.\/src\/core\/db\/schema'\);/g, '');
code = code.replace(/const rows = await db\.select<Transaction>\(`SELECT \* FROM \$\{TABLE\.SALES_BILL\}/g, 'const rows = await sqliteDb.select<Transaction>(`SELECT * FROM ${SCHEMA_TABLE.SALES_BILL}');
code = code.replace(/const rows = await db\.select<Purchase>\(`SELECT \* FROM \$\{TABLE\.PURCHASES\}/g, 'const rows = await sqliteDb.select<Purchase>(`SELECT * FROM ${SCHEMA_TABLE.PURCHASES}');

// Replace dynamic imports in fetchTransactions, etc.
code = code.replace(/const { db: sqliteDb } = await import\('\.\.\/src\/core\/db\/client'\);/g, '');

fs.writeFileSync(file, code);
