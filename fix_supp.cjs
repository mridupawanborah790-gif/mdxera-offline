const fs = require('fs');
const file = '/Users/my/Office/Krittik/Temp/mdxera-offline/services/storageService.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
`                const sqliteMatch = rows.find((row) => row?.id === invoiceId && row?.status !== 'cancelled' && String(row?.supplier || '').trim().toLowerCase() === String(supplier.name || '').trim().toLowerCase());
                if (sqliteMatch) {
                    localMatch = sqliteMatch;
                }`,
`                let decodedMatch = undefined;
                for (const rawRow of rows) {
                    const row = fromSupabase('purchases', decodeSqliteRow('purchases', rawRow));
                    if (row?.id === invoiceId && row?.status !== 'cancelled' && String(row?.supplier || '').trim().toLowerCase() === String(supplier.name || '').trim().toLowerCase()) {
                        decodedMatch = row;
                        break;
                    }
                }
                if (decodedMatch) {
                    localMatch = decodedMatch;
                }`
);

fs.writeFileSync(file, code);
