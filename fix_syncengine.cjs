const fs = require('fs');
const file = '/Users/my/Office/Krittik/Temp/mdxera-offline/src/core/sync/SyncEngine.ts';
let code = fs.readFileSync(file, 'utf8');

if (!code.includes("const syncChannel = new BroadcastChannel('mdxera-sync-channel');")) {
    const importIdx = code.lastIndexOf("import ");
    const endOfImports = code.indexOf('\n', importIdx) + 1;
    code = code.substring(0, endOfImports) + "\nconst syncChannel = new BroadcastChannel('mdxera-sync-channel');\n" + code.substring(endOfImports);
    
    code = code.replace(
        `  start(organizationId: string, supabaseUrl: string): void {`,
        `  start(organizationId: string, supabaseUrl: string): void {
    syncChannel.onmessage = (event) => {
        if (event.data?.action === 'pull_now') {
            this.forceSync().catch(console.warn);
        }
    };`
    );
    fs.writeFileSync(file, code);
}
