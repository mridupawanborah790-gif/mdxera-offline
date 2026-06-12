const fs = require('fs');
const file = '/Users/my/Office/Krittik/Temp/mdxera-offline/services/storageService.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(/export const fetchInventory = \(user: RegisteredPharmacy\) => getData\('inventory', \[\], user\);/g, "export const fetchInventory = (user: RegisteredPharmacy, forceSync = false) => getData('inventory', [], user, forceSync);");
code = code.replace(/export const fetchMedicineMaster = \(user: RegisteredPharmacy\) => getData\('material_master', \[\], user\);/g, "export const fetchMedicineMaster = (user: RegisteredPharmacy, forceSync = false) => getData('material_master', [], user, forceSync);");
code = code.replace(/export const fetchTransactions = \(user: RegisteredPharmacy\) => getData\('sales_bill', \[\], user\);/g, "export const fetchTransactions = (user: RegisteredPharmacy, forceSync = false) => getData('sales_bill', [], user, forceSync);");
code = code.replace(/export const fetchPurchases = \(user: RegisteredPharmacy\) => getData\('purchases', \[\], user\);/g, "export const fetchPurchases = (user: RegisteredPharmacy, forceSync = false) => getData('purchases', [], user, forceSync);");
code = code.replace(/export const fetchSuppliers = \(user: RegisteredPharmacy\) => getData\('suppliers', \[\], user\);/g, "export const fetchSuppliers = (user: RegisteredPharmacy, forceSync = false) => getData('suppliers', [], user, forceSync);");
code = code.replace(/export const fetchCustomers = \(user: RegisteredPharmacy\) => getData\('customers', \[\], user\);/g, "export const fetchCustomers = (user: RegisteredPharmacy, forceSync = false) => getData('customers', [], user, forceSync);");
code = code.replace(/export const fetchPurchaseOrders = \(user: RegisteredPharmacy\) => getData\('purchase_orders', \[\], user\);/g, "export const fetchPurchaseOrders = (user: RegisteredPharmacy, forceSync = false) => getData('purchase_orders', [], user, forceSync);");
code = code.replace(/export const fetchTeamMembers = \(user: RegisteredPharmacy\) => getData\('team_members', \[\], user\);/g, "export const fetchTeamMembers = (user: RegisteredPharmacy, forceSync = false) => getData('team_members', [], user, forceSync);");
code = code.replace(/export const fetchSupplierProductMaps = \(user: RegisteredPharmacy\) => getData\('supplier_product_map', \[\], user\);/g, "export const fetchSupplierProductMaps = (user: RegisteredPharmacy, forceSync = false) => getData('supplier_product_map', [], user, forceSync);");
code = code.replace(/export const fetchCustomerPriceList = \(user: RegisteredPharmacy\) => getData\('customer_price_list', \[\], user\);/g, "export const fetchCustomerPriceList = (user: RegisteredPharmacy, forceSync = false) => getData('customer_price_list', [], user, forceSync);");

code = code.replace(/export const fetchDoctors = async \(user: RegisteredPharmacy\): Promise<DoctorMaster\[\]> => \{/g, "export const fetchDoctors = async (user: RegisteredPharmacy, forceSync = false): Promise<DoctorMaster[]> => {");
code = code.replace(/const data = await getData\('doctor_master', \[\], user\);/g, "const data = await getData('doctor_master', [], user, forceSync);");

code = code.replace(/export const fetchPhysicalInventory = async \(user: RegisteredPharmacy\): Promise<PhysicalInventory\[\]> => \{/g, "export const fetchPhysicalInventory = async (user: RegisteredPharmacy, forceSync = false): Promise<PhysicalInventory[]> => {");
code = code.replace(/const data = await getData\('physical_inventory', \[\], user\);/g, "const data = await getData('physical_inventory', [], user, forceSync);");

fs.writeFileSync(file, code);
