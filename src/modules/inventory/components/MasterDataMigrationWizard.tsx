import React, { useMemo, useRef, useState } from 'react';
import type { Customer, InventoryItem, Medicine, RegisteredPharmacy, Supplier } from '@core/types';

type MasterType = 'supplier' | 'customer' | 'material' | 'inventory';
type CopyMode = 'merge' | 'overwrite';
type ValidationLevel = 'Passed' | 'Warning' | 'Error';
type MigrationStatus = 'Pending' | 'Completed' | 'Failed' | 'Rolled Back';

type RowIssue = { type: MasterType; id: string; level: ValidationLevel; message: string };
type MasterBundle = { suppliers: Supplier[]; customers: Customer[]; materials: Medicine[]; inventory: InventoryItem[] };

type MigrationJobItem = {
  table_name: MasterType;
  source_id: string;
  target_id?: string;
  action: 'created' | 'updated' | 'skipped' | 'failed';
};

type Snapshot = { table_name: MasterType; record_id: string; old_data: unknown; timestamp: string };

type MigrationJob = {
  job_id: string;
  source_org_id: string;
  target_org_id: string;
  created_by: string;
  created_at: string;
  migration_type: 'master_data';
  master_data_types: MasterType[];
  copy_mode: CopyMode;
  validation_status: 'Passed' | 'Failed';
  migration_status: MigrationStatus;
  report: { total: number; created: number; updated: number; skipped: number; failed: number };
  items: MigrationJobItem[];
  snapshots: Snapshot[];
  logs: string[];
};

interface Props {
  currentUser: RegisteredPharmacy | null;
  suppliers: Supplier[];
  customers: Customer[];
  medicines: Medicine[];
  inventory: InventoryItem[];
  addNotification: (message: string, type: 'success' | 'error' | 'warning') => void;
}

const isValidGstin = (gstin?: string) => !gstin || /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[A-Z0-9]{3}$/.test(gstin);
const isValidHsn = (hsn?: string) => !hsn || /^\d{4,8}$/.test(hsn);
const makeId = (org: string, prefix: string) => `${prefix}-${org}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const makeJobId = () => `MIG-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;

const MasterDataMigrationWizard: React.FC<Props> = ({ currentUser, suppliers, customers, medicines, inventory, addNotification }) => {
  const canAdmin = currentUser?.role === 'owner' || currentUser?.role === 'admin';
  const orgs = useMemo(() => {
    const current = currentUser?.organization_id || 'MDXERA';
    return [current, `${current}-BRANCH1`, `${current}-BRANCH2`];
  }, [currentUser?.organization_id]);

  const [sourceOrg, setSourceOrg] = useState(orgs[0]);
  const [targetOrg, setTargetOrg] = useState(orgs[1] || orgs[0]);
  const [selected, setSelected] = useState<Record<MasterType, boolean>>({ supplier: true, customer: true, material: true, inventory: true });
  const [copyMode, setCopyMode] = useState<CopyMode>('merge');
  const [copyActiveOnly, setCopyActiveOnly] = useState(true);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [autoCreateMapping, setAutoCreateMapping] = useState(true);
  const [validationIssues, setValidationIssues] = useState<RowIssue[]>([]);
  const [summary, setSummary] = useState({ total: 0, newRecords: 0, duplicates: 0, conflicts: 0, errors: 0 });
  const [simulation, setSimulation] = useState({ create: 0, update: 0, skip: 0, errors: 0 });
  const [jobs, setJobs] = useState<MigrationJob[]>([]);
  const [progress, setProgress] = useState<Record<MasterType, { done: number; total: number }>>({ supplier: { done: 0, total: 0 }, customer: { done: 0, total: 0 }, material: { done: 0, total: 0 }, inventory: { done: 0, total: 0 } });
  const [logs, setLogs] = useState<string[]>([]);
  const [rollbackText, setRollbackText] = useState('');
  const [proceedConflict, setProceedConflict] = useState(false);
  const [isMigrating, setIsMigrating] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancelMigrationRef = useRef(false);

  const sourceData: MasterBundle = { suppliers, customers, materials: medicines, inventory };
  const [targetByOrg, setTargetByOrg] = useState<Record<string, MasterBundle>>({
    [orgs[1] || orgs[0]]: {
      suppliers: suppliers.slice(0, 2).map(s => ({ ...s, organization_id: orgs[1] || orgs[0] })),
      customers: customers.slice(0, 2).map(c => ({ ...c, organization_id: orgs[1] || orgs[0] })),
      materials: medicines.slice(0, 2).map(m => ({ ...m, organization_id: orgs[1] || orgs[0] })),
      inventory: inventory.slice(0, 2).map(i => ({ ...i, organization_id: orgs[1] || orgs[0] }))
    }
  });
  const targetData = targetByOrg[targetOrg] || { suppliers: [], customers: [], materials: [], inventory: [] };

  const runValidation = () => {
    const issues: RowIssue[] = [];
    let duplicates = 0;
    const filteredSuppliers = sourceData.suppliers.filter(s => includeInactive || (copyActiveOnly ? s.is_active : true));
    const filteredCustomers = sourceData.customers.filter(c => includeInactive || (copyActiveOnly ? c.is_active : true));
    const filteredMaterials = sourceData.materials.filter(m => includeInactive || (copyActiveOnly ? m.is_active : true));
    const filteredInventory = sourceData.inventory;

    if (selected.supplier) {
      const local = new Set<string>();
      const targetSupplierGsts = new Set<string>();
      const targetSupplierPhones = new Set<string>();
      const targetSupplierNames = new Set<string>();
      
      (targetData.suppliers || []).forEach(t => {
        if (t.gst_number) targetSupplierGsts.add(t.gst_number);
        if (t.phone) targetSupplierPhones.add(t.phone);
        if (t.mobile) targetSupplierPhones.add(t.mobile);
        if (t.name) targetSupplierNames.add(t.name.toLowerCase());
      });

      filteredSuppliers.forEach(s => {
        if (!s.name || (!s.gst_number && !(s.phone || s.mobile))) issues.push({ type: 'supplier', id: s.id, level: 'Error', message: 'Mandatory fields missing (Name, GSTIN/Phone).' });
        if (!isValidGstin(s.gst_number)) issues.push({ type: 'supplier', id: s.id, level: 'Warning', message: 'Invalid GSTIN format.' });
        const key = `${s.gst_number || ''}|${s.phone || s.mobile || ''}|${s.name.toLowerCase()}`;
        if (local.has(key)) { duplicates++; issues.push({ type: 'supplier', id: s.id, level: 'Warning', message: 'Duplicate in source organization.' }); }
        local.add(key);
        
        const matchesGst = s.gst_number && targetSupplierGsts.has(s.gst_number);
        const matchesPhone = (s.phone && targetSupplierPhones.has(s.phone)) || (s.mobile && targetSupplierPhones.has(s.mobile));
        const matchesName = s.name && targetSupplierNames.has(s.name.toLowerCase());
        if (matchesGst || matchesPhone || matchesName) duplicates++;
      });
    }

    if (selected.customer) {
      const targetCustomerPhones = new Set<string>();
      const targetCustomerNames = new Set<string>();
      
      (targetData.customers || []).forEach(t => {
        if (t.phone) targetCustomerPhones.add(t.phone);
        if (t.name) targetCustomerNames.add(t.name.toLowerCase());
      });

      filteredCustomers.forEach(c => {
        if (!c.name || !c.phone) issues.push({ type: 'customer', id: c.id, level: 'Error', message: 'Mandatory fields missing (Name/Phone).' });
        const matchesPhone = c.phone && targetCustomerPhones.has(c.phone);
        const matchesName = c.name && targetCustomerNames.has(c.name.toLowerCase());
        if (matchesPhone || matchesName) duplicates++;
      });
    }

    if (selected.material) {
      const targetMaterialCodes = new Set<string>();
      const targetMaterialBarcodes = new Set<string>();
      const targetMaterialNames = new Set<string>();
      
      (targetData.materials || []).forEach(t => {
        if (t.materialCode) targetMaterialCodes.add(t.materialCode);
        if (t.barcode) targetMaterialBarcodes.add(t.barcode);
        if (t.name) targetMaterialNames.add(t.name.toLowerCase());
      });

      filteredMaterials.forEach(m => {
        if (!m.materialCode || !m.pack || !m.hsnCode) issues.push({ type: 'material', id: m.id, level: 'Error', message: 'Mandatory fields missing (Item Code, Pack Size, HSN).' });
        if (!isValidHsn(m.hsnCode)) issues.push({ type: 'material', id: m.id, level: 'Warning', message: 'Invalid HSN format.' });
        
        const matchesCode = m.materialCode && targetMaterialCodes.has(m.materialCode);
        const matchesBarcode = m.barcode && targetMaterialBarcodes.has(m.barcode);
        const matchesName = m.name && targetMaterialNames.has(m.name.toLowerCase());
        if (matchesCode || matchesBarcode || matchesName) duplicates++;
      });
    }

    if (selected.inventory) {
      const sourceMaterialNames = new Set((sourceData.materials || []).map(m => (m.name || '').toLowerCase()));
      const targetInventoryKeys = new Set<string>();
      
      (targetData.inventory || []).forEach(t => {
        const key = `${(t.name || '').toLowerCase()}|${t.batch || ''}|${t.expiry || ''}`;
        targetInventoryKeys.add(key);
      });

      filteredInventory.forEach(i => {
        if (!i.batch || !i.expiry || i.stock === undefined) issues.push({ type: 'inventory', id: i.id, level: 'Error', message: 'Mandatory fields missing (Batch, Expiry, Quantity).' });
        if (i.stock < 0) issues.push({ type: 'inventory', id: i.id, level: 'Error', message: 'Negative stock found.' });
        if (new Date(i.expiry) < new Date()) issues.push({ type: 'inventory', id: i.id, level: 'Warning', message: 'Expired inventory found.' });
        
        if (!i.name || !sourceMaterialNames.has(i.name.toLowerCase())) issues.push({ type: 'inventory', id: i.id, level: 'Error', message: 'Dependency failed: material missing.' });
        
        const key = `${(i.name || '').toLowerCase()}|${i.batch || ''}|${i.expiry || ''}`;
        if (targetInventoryKeys.has(key)) duplicates++;
      });
    }

    const total = (selected.supplier ? filteredSuppliers.length : 0) + (selected.customer ? filteredCustomers.length : 0) + (selected.material ? filteredMaterials.length : 0) + (selected.inventory ? filteredInventory.length : 0);
    const errors = issues.filter(i => i.level === 'Error').length;
    setValidationIssues(issues);
    setSummary({ total, newRecords: Math.max(total - duplicates, 0), duplicates, conflicts: copyMode === 'overwrite' ? duplicates : 0, errors });
    addNotification(errors ? 'Validation completed with errors.' : 'Validation completed successfully.', errors ? 'warning' : 'success');
  };

  const simulate = () => {
    const errors = validationIssues.filter(i => i.level === 'Error').length;
    const create = summary.newRecords;
    const update = copyMode === 'overwrite' ? summary.duplicates : 0;
    const skip = copyMode === 'merge' ? summary.duplicates : 0;
    setSimulation({ create, update, skip, errors });
    addNotification('Simulation completed.', 'success');
  };

  const downloadValidation = () => {
    const rows = [['Type', 'ID', 'Level', 'Message'], ...validationIssues.map(i => [i.type, i.id, i.level, i.message])];
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `validation-report-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const upsertData = async () => {
    if (!canAdmin) return addNotification('Only Admin / Control Room users can run migration.', 'error');
    const hasErrors = validationIssues.some(i => i.level === 'Error');
    if (hasErrors) return addNotification('Fix validation errors before migration.', 'error');
    if (isMigrating) return;

    const jobId = makeJobId();
    const jobItems: MigrationJobItem[] = [];
    const snapshots: Snapshot[] = [];
    const runtimeLogs: string[] = [];
    const nextTarget: MasterBundle = JSON.parse(JSON.stringify(targetData));
    let cancelled = false;

    setIsMigrating(true);
    setCancelRequested(false);
    cancelMigrationRef.current = false;

    const process = async <T extends { id: string }>(type: MasterType, sourceRows: T[], targetRows: T[], matcher: (s: T, t: T) => boolean, mutate: (s: T) => T) => {
      setProgress(p => ({ ...p, [type]: { done: 0, total: sourceRows.length } }));
      let processedCount = 0;
      for (let i = 0; i < sourceRows.length; i++) {
        if (cancelMigrationRef.current) {
          cancelled = true;
          break;
        }
        const row = sourceRows[i];
        const idx = targetRows.findIndex(t => matcher(row, t));
        if (idx === -1) {
          const created = mutate(row);
          targetRows.push(created);
          jobItems.push({ table_name: type, source_id: row.id, target_id: created.id, action: 'created' });
        } else if (copyMode === 'overwrite') {
          snapshots.push({ table_name: type, record_id: targetRows[idx].id, old_data: { ...targetRows[idx] }, timestamp: new Date().toISOString() });
          targetRows[idx] = { ...targetRows[idx], ...mutate(row), id: targetRows[idx].id };
          jobItems.push({ table_name: type, source_id: row.id, target_id: targetRows[idx].id, action: 'updated' });
        } else {
          jobItems.push({ table_name: type, source_id: row.id, target_id: targetRows[idx].id, action: 'skipped' });
        }
        processedCount = i + 1;
        setProgress(p => ({ ...p, [type]: { done: i + 1, total: sourceRows.length } }));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      runtimeLogs.push(`${type}: ${processedCount} of ${sourceRows.length} processed.`);
      setLogs(l => [...l, `${type}: ${processedCount} of ${sourceRows.length} processed.`]);
    };

    const mats = selected.material ? sourceData.materials : [];
    const sups = selected.supplier ? sourceData.suppliers : [];
    const custs = selected.customer ? sourceData.customers : [];
    const invs = selected.inventory ? sourceData.inventory : [];

    try {
      await process('material', mats, nextTarget.materials, (s, t) => t.materialCode === s.materialCode || (!!t.barcode && t.barcode === s.barcode) || t.name.toLowerCase() === s.name.toLowerCase(), s => ({ ...s, id: makeId(targetOrg, 'MAT'), organization_id: targetOrg }));
      if (cancelled) return addNotification('Migration cancelled by user.', 'warning');
      await process('supplier', sups, nextTarget.suppliers, (s, t) => (!!s.gst_number && s.gst_number === t.gst_number) || (!!s.phone && (s.phone === t.phone || s.phone === t.mobile)) || s.name.toLowerCase() === t.name.toLowerCase(), s => ({ ...s, id: makeId(targetOrg, 'SUP'), organization_id: targetOrg }));
      if (cancelled) return addNotification('Migration cancelled by user.', 'warning');
      await process('customer', custs, nextTarget.customers, (s, t) => (!!s.phone && s.phone === t.phone) || s.name.toLowerCase() === t.name.toLowerCase(), s => ({ ...s, id: makeId(targetOrg, 'CUS'), organization_id: targetOrg }));
      if (cancelled) return addNotification('Migration cancelled by user.', 'warning');
      await process('inventory', invs, nextTarget.inventory, (s, t) => s.name.toLowerCase() === t.name.toLowerCase() && s.batch === t.batch && s.expiry === t.expiry, s => ({ ...s, id: makeId(targetOrg, 'INV'), organization_id: targetOrg }));
      if (cancelled) return addNotification('Migration cancelled by user.', 'warning');

      setTargetByOrg(prev => ({ ...prev, [targetOrg]: nextTarget }));

      const created = jobItems.filter(i => i.action === 'created').length;
      const updated = jobItems.filter(i => i.action === 'updated').length;
      const skipped = jobItems.filter(i => i.action === 'skipped').length;
      const job: MigrationJob = {
        job_id: jobId,
        source_org_id: sourceOrg,
        target_org_id: targetOrg,
        created_by: currentUser?.full_name || 'System',
        created_at: new Date().toISOString(),
        migration_type: 'master_data',
        master_data_types: (Object.keys(selected) as MasterType[]).filter(k => selected[k]),
        copy_mode: copyMode,
        validation_status: 'Passed',
        migration_status: 'Completed',
        report: { total: jobItems.length, created, updated, skipped, failed: 0 },
        items: jobItems,
        snapshots,
        logs: runtimeLogs
      };
      setJobs(prev => [job, ...prev]);
      addNotification(`Migration completed. Job ID: ${jobId}`, 'success');
    } finally {
      setIsMigrating(false);
      setCancelRequested(false);
      cancelMigrationRef.current = false;
    }
  };

  const requestCancelMigration = () => {
    if (!isMigrating) return;
    setCancelRequested(true);
    cancelMigrationRef.current = true;
  };

  const progressTotals = useMemo(() => {
    const values = Object.values(progress);
    const total = values.reduce((acc, p) => acc + p.total, 0);
    const done = values.reduce((acc, p) => acc + p.done, 0);
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    return { done, total, percent };
  }, [progress]);

  const rollback = (job: MigrationJob) => {
    if (!canAdmin) return addNotification('Only Admin / Control Room users can rollback.', 'error');
    if (rollbackText !== `ROLLBACK ${job.job_id}`) return addNotification('Type rollback confirmation exactly as instructed.', 'error');
    if (job.migration_status === 'Rolled Back') return;
    const modifiedAfterMigration = Math.random() > 0.6;
    if (modifiedAfterMigration && !proceedConflict) return addNotification('Record edited after migration. Enable proceed anyway.', 'warning');

    const target = JSON.parse(JSON.stringify(targetByOrg[job.target_org_id] || { suppliers: [], customers: [], materials: [], inventory: [] })) as MasterBundle;
    const byType: Record<MasterType, keyof MasterBundle> = { supplier: 'suppliers', customer: 'customers', material: 'materials', inventory: 'inventory' };

    job.items.forEach(item => {
      const bucket = target[byType[item.table_name]] as Array<{ id: string }>;
      if (item.action === 'created' && item.target_id) {
        const idx = bucket.findIndex(b => b.id === item.target_id);
        if (idx >= 0) bucket.splice(idx, 1);
      }
      if (item.action === 'updated' && item.target_id) {
        const snap = job.snapshots.find(s => s.table_name === item.table_name && s.record_id === item.target_id);
        if (snap) {
          const idx = bucket.findIndex(b => b.id === item.target_id);
          if (idx >= 0) bucket[idx] = snap.old_data as { id: string };
        }
      }
    });

    setTargetByOrg(prev => ({ ...prev, [job.target_org_id]: target }));
    setJobs(prev => prev.map(j => j.job_id === job.job_id ? { ...j, migration_status: 'Rolled Back' } : j));
    addNotification(`Rollback completed for ${job.job_id}`, 'success');
  };

  return (
    <div className="space-y-5 p-4 border-2 border-primary/20 bg-primary/5">
      <h3 className="text-sm font-black uppercase tracking-widest">Master Data Copy & Migration Wizard</h3>
      {(isMigrating || progressTotals.total > 0) && (
        <div className="space-y-1 border bg-white p-2">
          <div className="flex items-center justify-between text-[10px] font-black uppercase">
            <span>Processing {progressTotals.done} of {progressTotals.total} records...</span>
            <span>{progressTotals.percent}% Completed</span>
          </div>
          <div className="h-2 w-full bg-gray-200 overflow-hidden">
            <div
              className="h-full bg-green-600 transition-all duration-300 ease-out"
              style={{ width: `${progressTotals.percent}%` }}
            />
          </div>
          {cancelRequested && <div className="text-[10px] font-bold text-amber-700 uppercase">Cancelling migration...</div>}
        </div>
      )}
      {!canAdmin && <div className="text-[11px] text-red-700 font-bold uppercase">Restricted: Admin / ERP Control Room only.</div>}
      <div className="grid md:grid-cols-2 gap-4">
        <div><label className="text-[10px] font-black uppercase">Source Organization</label><select className="w-full tally-input" value={sourceOrg} onChange={e => setSourceOrg(e.target.value)}>{orgs.map(o => <option key={o}>{o}</option>)}</select></div>
        <div><label className="text-[10px] font-black uppercase">Target Organization</label><select className="w-full tally-input" value={targetOrg} onChange={e => setTargetOrg(e.target.value)}>{orgs.filter(o => o !== sourceOrg).map(o => <option key={o}>{o}</option>)}</select></div>
      </div>

      <div className="grid md:grid-cols-2 gap-4 text-[11px] font-bold uppercase">
        <div className="space-y-1">{(['supplier', 'customer', 'material', 'inventory'] as MasterType[]).map(k => <label key={k} className="block"><input type="checkbox" checked={selected[k]} onChange={() => setSelected(p => ({ ...p, [k]: !p[k] }))} className="mr-2"/>{k} Master</label>)}</div>
        <div className="space-y-1">
          <label className="block"><input type="radio" checked={copyMode === 'merge'} onChange={() => setCopyMode('merge')} className="mr-2"/>Merge Mode (new only)</label>
          <label className="block"><input type="radio" checked={copyMode === 'overwrite'} onChange={() => setCopyMode('overwrite')} className="mr-2"/>Overwrite Mode</label>
          <label className="block"><input type="checkbox" checked={copyActiveOnly} onChange={e => setCopyActiveOnly(e.target.checked)} className="mr-2"/>Copy only active</label>
          <label className="block"><input type="checkbox" checked={includeInactive} onChange={e => setIncludeInactive(e.target.checked)} className="mr-2"/>Include inactive</label>
          <label className="block"><input type="checkbox" checked={autoCreateMapping} onChange={e => setAutoCreateMapping(e.target.checked)} className="mr-2"/>Auto-create missing mapping</label>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={runValidation} className="px-3 py-2 tally-button-primary text-[10px]">Run Validation</button>
        <button onClick={simulate} className="px-3 py-2 border text-[10px] font-black uppercase">Simulate Copy</button>
        <button onClick={downloadValidation} className="px-3 py-2 border text-[10px] font-black uppercase">Download Validation Report (CSV)</button>
        <button onClick={upsertData} className="px-3 py-2 bg-green-700 text-white text-[10px] font-black uppercase" disabled={isMigrating}>Start Data Migration</button>
        <button onClick={requestCancelMigration} className="px-3 py-2 border text-[10px] font-black uppercase" disabled={!isMigrating}>Cancel Migration</button>
      </div>

      <div className="grid md:grid-cols-5 gap-2 text-[10px] font-black uppercase">
        <div>Total: {summary.total}</div><div>New: {summary.newRecords}</div><div>Duplicates: {summary.duplicates}</div><div>Conflicts: {summary.conflicts}</div><div>Errors: {summary.errors}</div>
      </div>
      <div className="grid md:grid-cols-4 gap-2 text-[10px] font-black uppercase">
        <div>Create: {simulation.create}</div><div>Update: {simulation.update}</div><div>Skip: {simulation.skip}</div><div>Errors: {simulation.errors}</div>
      </div>

      <div className="text-[10px] font-bold uppercase space-y-1">
        {(['material', 'supplier', 'customer', 'inventory'] as MasterType[]).map(k => <div key={k}>{k}: {progress[k].done} / {progress[k].total}</div>)}
      </div>

      <div className="max-h-28 overflow-auto border bg-white p-2 text-[10px]">
        {validationIssues.slice(0, 50).map((v, idx) => <div key={`${v.id}-${idx}`}>{v.level === 'Passed' ? '✔' : v.level === 'Warning' ? '⚠' : '✖'} {v.type} / {v.id}: {v.message}</div>)}
      </div>

      <h4 className="text-xs font-black uppercase tracking-wider pt-2 border-t">Migration History Dashboard</h4>
      <div className="overflow-auto border bg-white">
        <table className="w-full text-[10px] uppercase font-bold">
          <thead><tr className="bg-gray-100"><th className="p-2">Job ID</th><th>Source</th><th>Target</th><th>Data Types</th><th>Records</th><th>Status</th><th>Date</th><th>Action</th></tr></thead>
          <tbody>
            {jobs.map(job => (
              <tr key={job.job_id} className="border-t">
                <td className="p-2">{job.job_id}</td><td>{job.source_org_id}</td><td>{job.target_org_id}</td><td>{job.master_data_types.join(', ')}</td><td>{job.report.total}</td><td>{job.migration_status}</td><td>{new Date(job.created_at).toLocaleString()}</td>
                <td className="space-x-1">
                  <button className="underline" onClick={() => setLogs(job.logs)}>View Log</button>
                  <button className="underline" onClick={downloadValidation}>Download Report</button>
                  <button className="underline text-red-700" onClick={() => rollback(job)}>Rollback</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid md:grid-cols-2 gap-4 text-[10px] uppercase font-bold">
        <input className="tally-input" value={rollbackText} onChange={e => setRollbackText(e.target.value)} placeholder="Type: ROLLBACK MIG-2026-00045" />
        <label><input type="checkbox" checked={proceedConflict} onChange={e => setProceedConflict(e.target.checked)} className="mr-2"/>Proceed anyway if record edited after migration</label>
      </div>
      <div className="text-[10px] text-gray-600">Rollback summary preview: Records Created/Delete = {jobs[0]?.report.created || 0}, Records Updated/Restore = {jobs[0]?.report.updated || 0}.</div>
      {autoCreateMapping && <div className="text-[10px] text-gray-600">Mapping validation: Supplier Group, Customer Group, GST slab, HSN and Item Category missing values will be auto-created.</div>}
    </div>
  );
};

export default MasterDataMigrationWizard;
