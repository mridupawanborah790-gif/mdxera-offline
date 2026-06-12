const fs = require('fs');
const file = '/Users/my/Office/Krittik/Temp/mdxera-offline/App.tsx';
let code = fs.readFileSync(file, 'utf8');

const loadJobsStart = code.indexOf('const loadJobs: Array<[string, Promise<any>]> = [');
const loadJobsEnd = code.indexOf('];', loadJobsStart);

if (loadJobsStart !== -1 && !code.includes(`['bank masters'`)) {
    const originalLoadJobs = code.substring(loadJobsStart, loadJobsEnd + 2);
    const newLoadJobs = originalLoadJobs.replace(
        `['configurations', withTimeout('Configurations', storage.getData('configurations', [{ organization_id: orgId }], user))],`,
        `['configurations', withTimeout('Configurations', storage.getData('configurations', [{ organization_id: orgId }], user))],
                ['bank masters', withTimeout('Bank Masters', storage.fetchBankMasters(user))],`
    );
    code = code.replace(originalLoadJobs, newLoadJobs);
    
    // Also remove the standalone await
    code = code.replace(
        `setBankOptions(await storage.fetchBankMasters(user));`,
        `// setBankOptions replaced by loadJobs`
    );
    
    // Add to settled extraction
    code = code.replace(
        `const configData = readSettled<AppConfigurations[]>(21, [{ organization_id: orgId } as AppConfigurations]);`,
        `const configData = readSettled<AppConfigurations[]>(21, [{ organization_id: orgId } as AppConfigurations]);
            const bankMastersData = readSettled<any[]>(23, []);`
    );
    
    // Set bank options
    code = code.replace(
        `setPurchaseOrders(po || []);`,
        `setPurchaseOrders(po || []);
            setBankOptions(bankMastersData || []);`
    );
    
    fs.writeFileSync(file, code);
}
