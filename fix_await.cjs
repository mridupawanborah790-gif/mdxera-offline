const fs = require('fs');
const file = '/Users/my/Office/Krittik/Temp/mdxera-offline/App.tsx';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
    /await storage\.saveData\('configurations', normalizedConfig, user\);/g,
    `storage.saveData('configurations', normalizedConfig, user).catch(console.error);`
);

fs.writeFileSync(file, code);
