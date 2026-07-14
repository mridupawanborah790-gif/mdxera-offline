
import React, { useEffect, useRef, useState } from 'react';
import Modal from '@core/components/ui/Modal';
import { InventoryItem } from '@core/types';
import { checkIsExpired } from '@core/utils/helpers';
import { resolveUnitsPerStrip } from '@core/utils/pack';

interface BatchSelectionModalProps {
    isOpen: boolean;
    onClose: () => void;
    productName: string;
    batches: InventoryItem[];
    onSelect: (batch: InventoryItem) => void;
}

const BatchSelectionModal: React.FC<BatchSelectionModalProps> = ({ isOpen, onClose, productName, batches, onSelect }) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (isOpen) {
            setSelectedIndex(0);
            // Small delay to ensure modal is rendered before focusing
            setTimeout(() => containerRef.current?.focus(), 150);
        }
    }, [isOpen]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex(prev => (prev + 1) % batches.length);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex(prev => (prev - 1 + batches.length) % batches.length);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            onSelect(batches[selectedIndex]);
        } else if (e.key === 'Escape') {
            onClose();
        }
    };

    if (!isOpen) return null;

    return (
        <Modal 
            isOpen={isOpen} 
            onClose={onClose} 
            title="Select Batch"
            widthClass="max-w-3xl"
        >
            <div 
                ref={containerRef}
                tabIndex={0}
                onKeyDown={handleKeyDown}
                className="flex flex-col h-full bg-white dark:bg-zinc-950 outline-none"
            >
                {/* Header */}
                <div className="bg-primary/5 p-4 border-b border-app-border">
                    <h3 className="text-primary font-black uppercase text-sm tracking-widest">
                        {productName}
                    </h3>
                    <p className="text-[10px] text-gray-500 font-bold uppercase mt-1">
                        Use ↑ ↓ to navigate | Enter to select | Esc to cancel
                    </p>
                </div>

                {/* Table */}
                <div className="overflow-y-auto max-h-[50vh] custom-scrollbar">
                    <table className="min-w-full border-collapse">
                        <thead className="bg-gray-100 dark:bg-zinc-800 text-gray-600 sticky top-0 z-10">
                            <tr className="uppercase font-black text-[11px] tracking-widest border-b border-app-border">
                                <th className="p-4 text-left w-12">#</th>
                                <th className="p-4 text-left">Batch Number</th>
                                <th className="p-4 text-center">Expiry Date</th>
                                <th className="p-4 text-right">Avail. Qty</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-zinc-800">
                            {batches.map((batch, idx) => {
                                const isSelected = idx === selectedIndex;
                                const isExpired = checkIsExpired(batch.expiry ? String(batch.expiry) : '');
                                
                                return (
                                    <tr 
                                        key={batch.id} 
                                        onClick={() => onSelect(batch)}
                                        onMouseEnter={() => setSelectedIndex(idx)}
                                        className={`
                                            cursor-pointer transition-colors
                                            ${isSelected ? 'bg-primary/10' : 'hover:bg-gray-50 dark:hover:bg-zinc-900'}
                                            ${isExpired ? 'opacity-60 grayscale-[0.5]' : ''}
                                        `}
                                    >
                                        <td className="p-4 text-[11px] font-black text-gray-400">
                                            {idx + 1}
                                        </td>
                                        <td className="p-4">
                                            <div className="flex items-center gap-2">
                                                <span className={`text-xs font-black uppercase ${isSelected ? 'text-primary' : 'text-gray-900 dark:text-gray-100'}`}>
                                                    {batch.batch}
                                                </span>
                                                {isExpired && (
                                                    <span className="bg-red-100 text-red-600 text-[8px] px-1.5 py-0.5 rounded-none font-black uppercase">
                                                        Expired
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="p-4 text-center">
                                            <span className={`text-xs font-mono font-bold ${isExpired ? 'text-red-500' : 'text-gray-600 dark:text-gray-400'}`}>
                                                {batch.expiry}
                                            </span>
                                        </td>
                                        <td className="p-4 text-right">
                                            <div className="inline-flex flex-col items-end">
                                                <span className={`text-xs font-black ${batch.stock > 10 ? 'text-emerald-600' : 'text-red-600'}`}>
                                                    {batch.stock}
                                                </span>
                                                {resolveUnitsPerStrip(batch.unitsPerPack, batch.packType) > 1 && (
                                                    <span className="text-[10px] text-gray-500 font-bold mt-0.5 whitespace-nowrap">
                                                        {(() => {
                                                            const uPP = resolveUnitsPerStrip(batch.unitsPerPack, batch.packType);
                                                            const strips = Math.floor(batch.stock / uPP);
                                                            const loose = batch.stock % uPP;
                                                            if (strips > 0 && loose > 0) {
                                                                return `${strips} Strip${strips > 1 ? 's' : ''} + ${loose} L`;
                                                            } else if (strips > 0) {
                                                                return `${strips} Strip${strips > 1 ? 's' : ''}`;
                                                            } else {
                                                                return `${loose} L`;
                                                            }
                                                        })()}
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>

                {/* Footer */}
                <div className="p-4 bg-gray-50 dark:bg-zinc-900 border-t border-app-border flex justify-end gap-3">
                    <button 
                        onClick={onClose}
                        className="text-[10px] font-black uppercase tracking-widest text-gray-500 hover:bg-red-50 px-3 py-1.5 transition-colors"
                    >
                        Cancel (Esc)
                    </button>
                </div>
            </div>
        </Modal>
    );
};

export default BatchSelectionModal;

