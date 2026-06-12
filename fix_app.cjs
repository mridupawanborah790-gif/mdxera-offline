const fs = require('fs');
const file = '/Users/my/Office/Krittik/Temp/mdxera-offline/App.tsx';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(/const latestInventory = await storage\.fetchInventory\(user, mode === 'sync'\);/g, "const latestInventory = await storage.fetchInventory(user, true);");
code = code.replace(/const latestMedicines = await storage\.fetchMedicineMaster\(user, mode === 'sync'\);/g, "const latestMedicines = await storage.fetchMedicineMaster(user, true);");
code = code.replace(/setTransactions\(await storage\.fetchTransactions\(user, mode === 'sync'\)\);/g, "setTransactions(await storage.fetchTransactions(user, true));");
code = code.replace(/setPurchases\(await storage\.fetchPurchases\(user, mode === 'sync'\)\);/g, "setPurchases(await storage.fetchPurchases(user, true));");
code = code.replace(/setSuppliers\(await storage\.fetchSuppliers\(user, mode === 'sync'\)\);/g, "setSuppliers(await storage.fetchSuppliers(user, true));");
code = code.replace(/setCustomers\(await storage\.fetchCustomers\(user, mode === 'sync'\)\);/g, "setCustomers(await storage.fetchCustomers(user, true));");
code = code.replace(/setDoctors\(await storage\.fetchDoctors\(user, mode === 'sync'\)\);/g, "setDoctors(await storage.fetchDoctors(user, true));");
code = code.replace(/const cfg = await storage\.getData\('configurations', \[\], user, mode === 'sync'\);/g, "const cfg = await storage.getData('configurations', [], user, true);");
code = code.replace(/setDeliveryChallans\(await storage\.getData\('delivery_challans', \[\], user, mode === 'sync'\)\);/g, "setDeliveryChallans(await storage.getData('delivery_challans', [], user, true));");
code = code.replace(/setSalesChallans\(await storage\.getData\('sales_challans', \[\], user, mode === 'sync'\)\);/g, "setSalesChallans(await storage.getData('sales_challans', [], user, true));");
code = code.replace(/setSalesReturns\(await storage\.getData\('sales_returns', \[\], user, mode === 'sync'\)\);/g, "setSalesReturns(await storage.getData('sales_returns', [], user, true));");
code = code.replace(/setPurchaseReturns\(await storage\.getData\('purchase_returns', \[\], user, mode === 'sync'\)\);/g, "setPurchaseReturns(await storage.getData('purchase_returns', [], user, true));");
code = code.replace(/setPurchaseOrders\(await storage\.fetchPurchaseOrders\(user, mode === 'sync'\)\);/g, "setPurchaseOrders(await storage.fetchPurchaseOrders(user, true));");
code = code.replace(/setPhysicalInventory\(await storage\.fetchPhysicalInventory\(user, mode === 'sync'\)\);/g, "setPhysicalInventory(await storage.fetchPhysicalInventory(user, true));");

fs.writeFileSync(file, code);
