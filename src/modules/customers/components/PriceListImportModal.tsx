import React, { useState, useRef } from 'react';
import Modal from '@core/components/ui/Modal';
import { Customer, Medicine, CustomerPriceListEntry } from '@core/types';
import { parseCsvLine } from '@core/utils/csv';

interface PriceListImportModalProps {
    isOpen: boolean;
    onClose: () => void;
    customers: Customer[];
    medicines: Medicine[];
    onSaveEntries: (entries: CustomerPriceListEntry[]) => void;
    organizationId: string;
}

const PriceListImportModal: React.FC<PriceListImportModalProps> = ({ isOpen, onClose, customers, medicines, onSaveEntries, organizationId }) => {
    const [previewData, setPreviewData] = useState<any[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setIsProcessing(true);
        try {
            const text = await file.text();
            const lines = text.split(/\r\n|\n/).filter(line => line.trim() !== '');
            
            if (lines.length < 2) {
                alert("File empty or missing header.");
                setIsProcessing(false);
                return;
            }

            const header = parseCsvLine(lines[0]).map(h => h.toLowerCase().trim());
            const custIdx = header.findIndex(h => h.includes('customer'));
            const prodIdx = header.findIndex(h => h.includes('product') || h.includes('item'));
            const priceIdx = header.findIndex(h => h.includes('price') || h.includes('rate') || h.includes('fk'));
            const discIdx = header.findIndex(h => h.includes('discount') || h.includes('disc'));

            if (custIdx === -1 || prodIdx === -1) {
                alert("CSV must contain columns: 'Customer Name', 'Product Name'. Optional: 'FK Price', 'Discount %'.");
                setIsProcessing(false);
                return;
            }

            const parsed: any[] = [];

            // Build lookups for speed
            const customerMap = new Map<string, Customer>();
            customers.forEach(c => customerMap.set(c.name.toLowerCase(), c));

            const productMap = new Map<string, Medicine>();
            medicines.forEach(m => productMap.set(m.name.toLowerCase(), m));

            for (let i = 1; i < lines.length; i++) {
                const row = parseCsvLine(lines[i]);
                const custName = (row[custIdx] || '').trim();
                const prodName = (row[prodIdx] || '').trim();
                const priceStr = priceIdx !== -1 ? (row[priceIdx] || '').trim().replace(/[^0-9.]/g, '') : '0';
                const discStr = discIdx !== -1 ? (row[discIdx] || '').trim().replace(/[^0-9.]/g, '') : '0';
                
                if (!custName || !prodName) continue;

                const customer = customerMap.get(custName.toLowerCase());
                const product = productMap.get(prodName.toLowerCase());
                const price = parseFloat(priceStr);
                const discount = parseFloat(discStr);

                parsed.push({
                    custName,
                    prodName,
                    price: isNaN(price) ? 0 : price,
                    discount: isNaN(discount) ? 0 : discount,
                    status: (customer && product) ? 'valid' : 'error',
                    errorMsg: !customer ? 'Customer not found' : !product ? 'Product not found' : '',
                    customerId: customer?.id,
                    productId: product?.id,
                    productObj: product
                });
            }
            
            setPreviewData(parsed);

        } catch (err) {
            console.error(err);
            alert("Failed to parse CSV");
        } finally {
            setIsProcessing(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const handleSave = () => {
        const validEntries = previewData.filter(d => d.status === 'valid');
        if (validEntries.length === 0) {
            alert("No valid entries to import.");
            return;
        }

        const entries: CustomerPriceListEntry[] = validEntries.map((d: any) => ({
            id: crypto.randomUUID(),
            organization_id: organizationId,
            customerId: d.customerId,
            inventoryItemId: d.productId,
            price: d.price,
            discountPercent: d.discount,
            updatedAt: new Date().toISOString()
        }));

        onSaveEntries(entries);
        alert(`Successfully imported ${entries.length} FK Price entries.`);
        onClose();
        setPreviewData([]);
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Import FK Price" widthClass="max-w-5xl">
            <div className="p-6 flex flex-col h-[70vh]">
                <div className="mb-4">
                    <p className="text-sm text-gray-600 mb-2">Upload a CSV file with columns: <strong>Customer Name</strong>, <strong>Product Name</strong>, <strong>FK Price</strong>, <strong>Discount %</strong>.</p>
                    <input 
                        type="file" 
                        ref={fileInputRef}
                        accept=".csv"
                        onChange={handleFileChange}
                        className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-primary-light file:text-primary-text hover:file:bg-primary"
                    />
                </div>

                <div className="flex-1 overflow-auto border rounded-md">
                    <table className="min-w-full text-sm divide-y divide-gray-200">
                        <thead className="bg-gray-50 sticky top-0">
                            <tr>
                                <th className="px-4 py-2 text-left">Customer</th>
                                <th className="px-4 py-2 text-left">Product</th>
                                <th className="px-4 py-2 text-right">FK Price</th>
                                <th className="px-4 py-2 text-right">Discount %</th>
                                <th className="px-4 py-2 text-center">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                            {previewData.map((row, idx) => (
                                <tr key={idx} className={row.status === 'error' ? 'bg-red-50' : 'bg-white'}>
                                    <td className="px-4 py-2">{row.custName}</td>
                                    <td className="px-4 py-2">
                                        {row.prodName}
                                        {row.productObj && <div className="text-xs text-gray-500">MRP: {row.productObj.mrp || 'N/A'}</div>}
                                    </td>
                                    <td className="px-4 py-2 text-right">{row.price > 0 ? `₹${row.price}` : '-'}</td>
                                    <td className="px-4 py-2 text-right">{row.discount > 0 ? `${row.discount}%` : '-'}</td>
                                    <td className="px-4 py-2 text-center">
                                        {row.status === 'valid' ? (
                                            <span className="text-green-600 font-medium">Ready</span>
                                        ) : (
                                            <span className="text-red-600 text-xs">{row.errorMsg}</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                            {previewData.length === 0 && (
                                <tr><td colSpan={5} className="text-center py-10 text-gray-500">No data loaded. Upload a file to preview.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
            <div className="flex justify-end p-4 border-t space-x-3">
                <button onClick={onClose} className="px-4 py-2 text-sm border rounded hover:bg-gray-50">Cancel</button>
                <button 
                    onClick={handleSave} 
                    disabled={previewData.filter(d => d.status === 'valid').length === 0}
                    className="px-4 py-2 text-sm bg-primary text-white rounded hover:bg-primary-dark disabled:opacity-50"
                >
                    Import Valid Entries
                </button>
            </div>
        </Modal>
    );
};

export default PriceListImportModal;