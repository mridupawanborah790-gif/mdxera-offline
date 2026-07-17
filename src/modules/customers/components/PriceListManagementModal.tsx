import React, { useState, useEffect, useMemo } from 'react';
import Modal from '@core/components/ui/Modal';
import { Customer, Medicine, CustomerPriceListEntry, RegisteredPharmacy } from '@core/types';
import { downloadCsv } from '@core/utils/csv';
import { fuzzyMatch } from '@core/utils/search';

interface PriceListManagementModalProps {
    isOpen: boolean;
    onClose: () => void;
    customers: Customer[];
    medicines: Medicine[];
    priceListEntries: CustomerPriceListEntry[];
    onSaveEntries: (entries: CustomerPriceListEntry[]) => void;
    onImportClick: () => void;
    currentUser: RegisteredPharmacy | null;
}

const PriceListManagementModal: React.FC<PriceListManagementModalProps> = ({ 
    isOpen, onClose, customers, medicines, priceListEntries, onSaveEntries, onImportClick, currentUser
}) => {
    const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
    const [searchTerm, setSearchTerm] = useState('');
    const [editedPrices, setEditedPrices] = useState<Record<string, number>>({});
    const [editedDiscounts, setEditedDiscounts] = useState<Record<string, number>>({});
    const [downloadStatus, setDownloadStatus] = useState('');
    
    // Reset state when modal opens
    useEffect(() => {
        if (isOpen) {
            setSelectedCustomerId('');
            setSearchTerm('');
            setEditedPrices({});
            setEditedDiscounts({});
            setDownloadStatus('');
        }
    }, [isOpen]);

    // Load existing prices into state when customer changes
    useEffect(() => {
        if (selectedCustomerId) {
            const customerPrices: Record<string, number> = {};
            const customerDiscounts: Record<string, number> = {};
            
            priceListEntries
                .filter(entry => entry.customerId === selectedCustomerId)
                .forEach(entry => {
                    customerPrices[entry.inventoryItemId] = entry.price;
                    customerDiscounts[entry.inventoryItemId] = entry.discountPercent || 0;
                });
            setEditedPrices(customerPrices);
            setEditedDiscounts(customerDiscounts);
        } else {
            setEditedPrices({});
            setEditedDiscounts({});
        }
    }, [selectedCustomerId, priceListEntries]);

    const handlePriceChange = (itemId: string, val: string) => {
        const numVal = parseFloat(val);
        setEditedPrices(prev => ({
            ...prev,
            [itemId]: isNaN(numVal) ? 0 : numVal
        }));
    };

    const handleDiscountChange = (itemId: string, val: string) => {
        const numVal = parseFloat(val);
        setEditedDiscounts(prev => ({
            ...prev,
            [itemId]: isNaN(numVal) ? 0 : numVal
        }));
    };

    const handleSave = () => {
        if (!selectedCustomerId) return;

        // Merge item IDs from both prices and discounts
        const itemIds = new Set([...Object.keys(editedPrices), ...Object.keys(editedDiscounts)]);

        const entriesToSave: CustomerPriceListEntry[] = Array.from(itemIds).map((itemId) => {
            const existingEntry = priceListEntries.find(p => p.customerId === selectedCustomerId && p.inventoryItemId === itemId);
            const price = editedPrices[itemId] || 0;
            const discountPercent = editedDiscounts[itemId] || 0;

            return {
                id: existingEntry ? existingEntry.id : crypto.randomUUID(),
                organization_id: currentUser?.organization_id || '',
                customerId: selectedCustomerId,
                inventoryItemId: itemId,
                price: Number(price),
                discountPercent: Number(discountPercent),
                updatedAt: new Date().toISOString()
            };
        }).filter(e => e.price > 0 || (e.discountPercent !== undefined && e.discountPercent > 0));

        onSaveEntries(entriesToSave);
        alert("FK Price list updated successfully.");
    };

    const handleDownloadTemplate = () => {
        setDownloadStatus('Downloading...');
        const headers = ['Customer Name', 'Product Name', 'FK Price', 'Discount %'];
        const sampleRow1 = ['John Doe Pharmacy', 'Dolo 650', '28.50', '0'];
        const sampleRow2 = ['City Hospital', 'Azithromycin 500', '', '10'];
        const csvContent = [headers.join(','), sampleRow1.join(','), sampleRow2.join(',')].join('\n');
        downloadCsv(csvContent, 'price_list_template.csv');
        setTimeout(() => setDownloadStatus('Template downloaded!'), 1000);
        setTimeout(() => setDownloadStatus(''), 4000);
    };

    const filteredMedicines = useMemo(() => {
        let filtered = (medicines || []).filter(m => m.is_active !== false);

        if (searchTerm) {
            filtered = filtered.filter(m => 
                fuzzyMatch(m.name, searchTerm) || 
                fuzzyMatch(m.brand, searchTerm) ||
                fuzzyMatch(m.materialCode, searchTerm)
            );
        }
        
        return filtered.slice(0, 100); // Limit to 100 for performance
    }, [medicines, searchTerm]);

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="FK Price" widthClass="max-w-5xl">
            <div className="flex flex-col h-[80vh]">
                
                {/* Header Controls */}
                <div className="p-4 border-b border-app-border flex flex-col md:flex-row gap-4 justify-between bg-gray-50 dark:bg-gray-800/50">
                    <div className="flex-1 space-y-4 md:space-y-0 md:space-x-4 flex flex-col md:flex-row items-center">
                        <div className="w-full md:w-64">
                            <label className="block text-xs font-medium text-app-text-secondary mb-1">Select Customer</label>
                            <select 
                                value={selectedCustomerId} 
                                onChange={e => setSelectedCustomerId(e.target.value)}
                                className="w-full p-2 border border-app-border rounded-md bg-input-bg text-sm"
                            >
                                <option value="">-- Choose Customer --</option>
                                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                            {customers.length === 0 && <p className="text-[10px] text-red-500 mt-1">No customers found.</p>}
                        </div>
                        
                        <div className="w-full md:w-64 relative">
                            <label className="block text-xs font-medium text-app-text-secondary mb-1">Search Product</label>
                            <input 
                                type="text" 
                                placeholder="Type name (e.g. Dolo)..." 
                                value={searchTerm}
                                onChange={e => setSearchTerm(e.target.value)}
                                className="w-full p-2 border border-app-border rounded-md bg-input-bg text-sm"
                            />
                        </div>

                        {downloadStatus && (
                            <div className="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded border border-blue-200 animate-pulse font-medium">
                                {downloadStatus}
                            </div>
                        )}
                    </div>

                    <div className="flex items-end space-x-2">
                        <button 
                            onClick={handleDownloadTemplate}
                            className="px-3 py-2 text-xs font-medium bg-white border border-gray-300 rounded hover:bg-gray-50 text-gray-700"
                        >
                            Template
                        </button>
                        <button 
                            onClick={onImportClick}
                            className="px-3 py-2 text-xs font-medium bg-white border border-gray-300 rounded hover:bg-gray-50 text-gray-700 flex items-center"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-1"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                            Bulk Upload
                        </button>
                    </div>
                </div>

                {/* Data Table */}
                <div className="flex-1 overflow-auto p-0">
                    {!selectedCustomerId ? (
                        <div className="flex h-full items-center justify-center text-app-text-tertiary">
                            <p>Please select a customer to view or edit their FK Price list.</p>
                        </div>
                    ) : (
                        <table className="min-w-full text-sm divide-y divide-app-border">
                            <thead className="bg-hover sticky top-0 z-10">
                                <tr>
                                    <th className="px-4 py-3 text-left font-medium text-app-text-secondary">Product Name</th>
                                    <th className="px-4 py-3 text-left font-medium text-app-text-secondary">Brand</th>
                                    <th className="px-4 py-3 text-left font-medium text-app-text-secondary">Manufacturer</th>
                                    <th className="px-4 py-3 text-right font-medium text-app-text-secondary">MRP</th>
                                    <th className="px-4 py-3 text-right font-medium text-app-text-primary w-32">FK Price</th>
                                    <th className="px-4 py-3 text-right font-medium text-app-text-primary w-32">Discount %</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-app-border bg-card-bg">
                                {filteredMedicines.map(item => {
                                    const customPrice = editedPrices[item.id];
                                    const hasCustomPrice = customPrice !== undefined && customPrice !== null && customPrice > 0;
                                    const discount = editedDiscounts[item.id];
                                    const hasDiscount = discount !== undefined && discount !== null && discount > 0;
                                    
                                    return (
                                        <tr key={item.id} className={hasCustomPrice || hasDiscount ? "bg-blue-50/50 dark:bg-blue-900/10" : ""}>
                                            <td className="px-4 py-2 font-medium">{item.name}</td>
                                            <td className="px-4 py-2 text-app-text-secondary">{item.brand || 'N/A'}</td>
                                            <td className="px-4 py-2 text-app-text-secondary">{item.manufacturer || 'N/A'}</td>
                                            <td className="px-4 py-2 text-right text-app-text-secondary">{item.mrp ? `₹${item.mrp}` : 'N/A'}</td>
                                            <td className="px-4 py-2 text-right">
                                                <input 
                                                    type="number"
                                                    value={customPrice || ''}
                                                    placeholder={item.mrp ? String(item.mrp) : '0'}
                                                    onChange={(e) => handlePriceChange(item.id, e.target.value)}
                                                    className={`w-full p-1.5 text-right border rounded bg-input-bg focus:ring-primary focus:border-primary ${hasCustomPrice ? 'border-blue-300 font-bold text-blue-700' : 'border-app-border'}`}
                                                />
                                            </td>
                                            <td className="px-4 py-2 text-right">
                                                <input 
                                                    type="number"
                                                    value={discount || ''}
                                                    placeholder="0"
                                                    onChange={(e) => handleDiscountChange(item.id, e.target.value)}
                                                    className={`w-full p-1.5 text-right border rounded bg-input-bg focus:ring-primary focus:border-primary ${hasDiscount ? 'border-green-300 font-bold text-green-700' : 'border-app-border'}`}
                                                />
                                            </td>
                                        </tr>
                                    );
                                })}
                                {filteredMedicines.length === 0 && (
                                    <tr><td colSpan={6} className="text-center py-8 text-app-text-secondary">No products found matching your search.</td></tr>
                                )}
                            </tbody>
                        </table>
                    )}
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-app-border flex justify-between items-center bg-gray-50 dark:bg-gray-800/50">
                    <span className="text-xs text-app-text-tertiary">
                        Showing top 100 matches. Refine search if needed.
                    </span>
                    <div className="flex space-x-3">
                        <button onClick={onClose} className="px-4 py-2 text-sm font-semibold bg-white border border-gray-300 rounded-lg shadow-sm hover:bg-gray-50 text-gray-700">
                            Close
                        </button>
                        <button 
                            onClick={handleSave} 
                            disabled={!selectedCustomerId}
                            className="px-4 py-2 text-sm font-semibold text-white bg-primary rounded-lg shadow-sm hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Save Changes
                        </button>
                    </div>
                </div>
            </div>
        </Modal>
    );
};

export default PriceListManagementModal;