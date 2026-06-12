const fs = require('fs');
const file = '/Users/my/Office/Krittik/Temp/mdxera-offline/services/storageService.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
`                    const sqliteMatch = rows.find((rawRow) => {
                        const row = fromSupabase('sales_bill', decodeSqliteRow('sales_bill', rawRow));
                        if (!row || row.status === 'cancelled') return false;
                        const belongsToCustomer = row.customerId === customer.id || String(row.customerName || '').trim().toLowerCase() === normalizedCustomerName;
                        if (!belongsToCustomer) return false;
                        return row.id === normalizedInvoiceRef || String(row.invoiceNumber || '').trim().toLowerCase() === normalizedInvoiceRefLower;
                    });
                    if (sqliteMatch) {
                        match = sqliteMatch;
                    }`,
`                    let decodedMatch = undefined;
                    for (const rawRow of rows) {
                        const row = fromSupabase('sales_bill', decodeSqliteRow('sales_bill', rawRow));
                        if (!row || row.status === 'cancelled') continue;
                        const belongsToCustomer = row.customerId === customer.id || String(row.customerName || '').trim().toLowerCase() === normalizedCustomerName;
                        if (!belongsToCustomer) continue;
                        if (row.id === normalizedInvoiceRef || String(row.invoiceNumber || '').trim().toLowerCase() === normalizedInvoiceRefLower) {
                            decodedMatch = row;
                            break;
                        }
                    }
                    if (decodedMatch) {
                        match = decodedMatch;
                    }`
);

fs.writeFileSync(file, code);
