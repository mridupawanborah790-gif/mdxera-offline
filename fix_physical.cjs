const fs = require('fs');
const file = '/Users/my/Office/Krittik/Temp/mdxera-offline/services/storageService.ts';
let code = fs.readFileSync(file, 'utf8');
code = code.replace(/export const fetchPhysicalInventory = \(user: RegisteredPharmacy\) => getData\('physical_inventory', \[\], user\);/g, "export const fetchPhysicalInventory = (user: RegisteredPharmacy, forceSync = false) => getData('physical_inventory', [], user, forceSync);");
fs.writeFileSync(file, code);
