const fs = require('fs');
const file = '/Users/my/Office/Krittik/Temp/mdxera-offline/App.tsx';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(/const latestInventory = await storage\.fetchInventory\(user\);/g, "const latestInventory = await storage.fetchInventory(user, mode === 'sync');");
code = code.replace(/const latestMedicines = await storage\.fetchMedicineMaster\(user\);/g, "const latestMedicines = await storage.fetchMedicineMaster(user, mode === 'sync');");
code = code.replace(/setTransactions\(await storage\.fetchTransactions\(user\)\);/g, "setTransactions(await storage.fetchTransactions(user, mode === 'sync'));");
code = code.replace(/setPurchases\(await storage\.fetchPurchases\(user\)\);/g, "setPurchases(await storage.fetchPurchases(user, mode === 'sync'));");
code = code.replace(/setSuppliers\(await storage\.fetchSuppliers\(user\)\);/g, "setSuppliers(await storage.fetchSuppliers(user, mode === 'sync'));");
code = code.replace(/setCustomers\(await storage\.fetchCustomers\(user\)\);/g, "setCustomers(await storage.fetchCustomers(user, mode === 'sync'));");
code = code.replace(/setDoctors\(await storage\.fetchDoctors\(user\)\);/g, "setDoctors(await storage.fetchDoctors(user, mode === 'sync'));");
code = code.replace(/const cfg = await storage\.getData\('configurations', \[\], user\);/g, "const cfg = await storage.getData('configurations', [], user, mode === 'sync');");
code = code.replace(/setDeliveryChallans\(await storage\.getData\('delivery_challans', \[\], user\)\);/g, "setDeliveryChallans(await storage.getData('delivery_challans', [], user, mode === 'sync'));");
code = code.replace(/setSalesChallans\(await storage\.getData\('sales_challans', \[\], user\)\);/g, "setSalesChallans(await storage.getData('sales_challans', [], user, mode === 'sync'));");
code = code.replace(/setSalesReturns\(await storage\.getData\('sales_returns', \[\], user\)\);/g, "setSalesReturns(await storage.getData('sales_returns', [], user, mode === 'sync'));");
code = code.replace(/setPurchaseReturns\(await storage\.getData\('purchase_returns', \[\], user\)\);/g, "setPurchaseReturns(await storage.getData('purchase_returns', [], user, mode === 'sync'));");
code = code.replace(/setPurchaseOrders\(await storage\.fetchPurchaseOrders\(user\)\);/g, "setPurchaseOrders(await storage.fetchPurchaseOrders(user, mode === 'sync'));");
code = code.replace(/setPhysicalInventory\(await storage\.fetchPhysicalInventory\(user\)\);/g, "setPhysicalInventory(await storage.fetchPhysicalInventory(user, mode === 'sync'));");

code = code.replace(/\[\n\s+'inventory',\n\s+storage\.fetchInventory\(user\)\n\s+\],/g, "[\n                                'inventory',\n                                storage.fetchInventory(user, mode === 'sync')\n                            ],");
code = code.replace(/\[\n\s+'material_master',\n\s+storage\.fetchMedicineMaster\(user\)\n\s+\],/g, "[\n                                'material_master',\n                                storage.fetchMedicineMaster(user, mode === 'sync')\n                            ],");

code = code.replace(/\[ 'transactions', storage\.fetchTransactions\(user\) \],/g, "[ 'transactions', storage.fetchTransactions(user, mode === 'sync') ],");
code = code.replace(/\[ 'purchases', storage\.fetchPurchases\(user\) \],/g, "[ 'purchases', storage.fetchPurchases(user, mode === 'sync') ],");
code = code.replace(/\[ 'suppliers', storage\.fetchSuppliers\(user\) \],/g, "[ 'suppliers', storage.fetchSuppliers(user, mode === 'sync') ],");
code = code.replace(/\[ 'customers', storage\.fetchCustomers\(user\) \],/g, "[ 'customers', storage.fetchCustomers(user, mode === 'sync') ],");
code = code.replace(/\[ 'doctors', storage\.fetchDoctors\(user\) \],/g, "[ 'doctors', storage.fetchDoctors(user, mode === 'sync') ],");
code = code.replace(/\[ 'configurations', storage\.getData\('configurations', \[\], user\) \],/g, "[ 'configurations', storage.getData('configurations', [], user, mode === 'sync') ],");
code = code.replace(/\[ 'delivery_challans', storage\.getData\('delivery_challans', \[\], user\) \],/g, "[ 'delivery_challans', storage.getData('delivery_challans', [], user, mode === 'sync') ],");
code = code.replace(/\[ 'sales_challans', storage\.getData\('sales_challans', \[\], user\) \],/g, "[ 'sales_challans', storage.getData('sales_challans', [], user, mode === 'sync') ],");
code = code.replace(/\[ 'sales_returns', storage\.getData\('sales_returns', \[\], user\) \],/g, "[ 'sales_returns', storage.getData('sales_returns', [], user, mode === 'sync') ],");
code = code.replace(/\[ 'purchase_returns', storage\.getData\('purchase_returns', \[\], user\) \],/g, "[ 'purchase_returns', storage.getData('purchase_returns', [], user, mode === 'sync') ],");
code = code.replace(/\[ 'purchase_orders', storage\.fetchPurchaseOrders\(user\) \],/g, "[ 'purchase_orders', storage.fetchPurchaseOrders(user, mode === 'sync') ],");
code = code.replace(/\[ 'physical_inventory', storage\.fetchPhysicalInventory\(user\) \]/g, "[ 'physical_inventory', storage.fetchPhysicalInventory(user, mode === 'sync') ]");

fs.writeFileSync(file, code);
