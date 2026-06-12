const fs = require('fs');
const file = '/Users/my/Office/Krittik/Temp/mdxera-offline/services/storageService.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
`        if (navigator.onLine) {
            const { data: invoices } = await supabase
                .from('sales_bill')
                .select('id, invoiceNumber, customerId, customerName, total, status')
                .eq('organization_id', user.organization_id)
                .or(\`id.eq.\${normalizedInvoiceRef},invoiceNumber.eq.\${normalizedInvoiceRef}\`);

            const remoteMatch = (invoices || []).find((row: { id?: string; invoiceNumber?: string; customerId?: string; customerName?: string; total?: number; status?: string; }) => {`,
`        if (navigator.onLine) {
            const { data: rawInvoices, error } = await supabase
                .from('sales_bill')
                .select('*')
                .eq('organization_id', user.organization_id)
                .or(\`id.ilike.\${invoiceRef.trim()},invoice_number.ilike.\${invoiceRef.trim()}\`);
            if (error) console.warn('[getCustomerInvoiceTotal] Supabase error:', error);
            
            const invoices = (rawInvoices || []).map(r => fromSupabase('sales_bill', r));
            const remoteMatch = invoices.find((row: any) => {`
);

code = code.replace(
`        if (navigator.onLine) {
            const { data: purchases } = await supabase
                .from('purchases')
                .select('id, supplier, totalAmount, status')
                .eq('organization_id', user.organization_id)
                .eq('id', invoiceId);

            const remoteMatch = (purchases || []).find((row: { id?: string; supplier?: string; totalAmount?: number; status?: string; }) => `,
`        if (navigator.onLine) {
            const { data: rawPurchases, error } = await supabase
                .from('purchases')
                .select('*')
                .eq('organization_id', user.organization_id)
                .eq('id', invoiceId);
            if (error) console.warn('[getSupplierInvoiceTotal] Supabase error:', error);
            
            const purchases = (rawPurchases || []).map(r => fromSupabase('purchases', r));
            const remoteMatch = purchases.find((row: any) => `
);

fs.writeFileSync(file, code);
