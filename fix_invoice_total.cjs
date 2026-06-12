const fs = require('fs');
const file = '/Users/my/Office/Krittik/Temp/mdxera-offline/services/storageService.ts';
let code = fs.readFileSync(file, 'utf8');

// Fix getCustomerInvoiceTotal SQLite check
code = code.replace(
    /const sqliteMatch = rows\.find\(\(row\) => \{/g,
    `const sqliteMatch = rows.find((rawRow) => {
                        const row = fromSupabase('sales_bill', decodeSqliteRow('sales_bill', rawRow));`
);
// Fix getSupplierInvoiceTotal SQLite check (which uses PURCHASES)
code = code.replace(
    /const sqliteMatch = rows\.find\(\(row\) => \{/g,
    `const sqliteMatch = rows.find((rawRow) => {
                        const row = fromSupabase('purchases', decodeSqliteRow('purchases', rawRow));`
);

fs.writeFileSync(file, code);
