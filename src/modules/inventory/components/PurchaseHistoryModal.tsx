import React from 'react';
import Modal from '@core/components/ui/Modal';
import type { Purchase } from '@core/types';

interface PurchaseHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  productName: string;
  representativeCode?: string;
  brandName?: string;
  purchases: Purchase[];
}

const PurchaseHistoryModal: React.FC<PurchaseHistoryModalProps> = ({
  isOpen,
  onClose,
  productName,
  representativeCode,
  brandName,
  purchases = [],
}) => {
  const history = React.useMemo(() => {
    if (!productName) return [];

    const normalizedName = productName.trim().toLowerCase();
    const normalizedBrand = (brandName || '').trim().toLowerCase();
    const normalizedCode = (representativeCode || '').trim().toLowerCase();

    const list: Array<{
      invoiceNumber: string;
      date: string;
      supplier: string;
      batch: string;
      quantity: number;
      looseQuantity: number;
      freeQuantity: number;
      purchasePrice: number;
      mrp: number;
      purchaseId: string;
    }> = [];

    purchases.forEach((purchase) => {
      if (!purchase.items || !Array.isArray(purchase.items)) return;

      purchase.items.forEach((item) => {
        const itemCode = (item.materialCode || '').trim().toLowerCase();
        const itemName = (item.name || '').trim().toLowerCase();
        const itemBrand = (item.brand || '').trim().toLowerCase();

        const codeMatches = normalizedCode && itemCode && itemCode === normalizedCode;
        const nameBrandMatches = itemName === normalizedName && itemBrand === normalizedBrand;

        if (codeMatches || nameBrandMatches) {
          list.push({
            invoiceNumber: purchase.invoiceNumber || purchase.purchaseSerialId || 'N/A',
            date: purchase.date,
            supplier: purchase.supplier || 'N/A',
            batch: item.batch || '-',
            quantity: item.quantity || 0,
            looseQuantity: item.looseQuantity || 0,
            freeQuantity: item.freeQuantity || 0,
            purchasePrice: item.purchasePrice || 0,
            mrp: item.mrp || 0,
            purchaseId: purchase.id,
          });
        }
      });
    });

    // Sort by date descending (newest first)
    return list.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [productName, brandName, representativeCode, purchases]);

  const formatQuantity = (item: typeof history[0]) => {
    const parts = [];
    if (item.quantity > 0) parts.push(`${item.quantity} PAC`);
    if (item.looseQuantity > 0) parts.push(`${item.looseQuantity} LSE`);
    if (item.freeQuantity > 0) parts.push(`${item.freeQuantity} FREE`);
    return parts.join(' + ') || '0';
  };

  const titleText = `Purchase History: ${productName} ${representativeCode ? `(${representativeCode})` : ''}`;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={titleText} widthClass="max-w-6xl">
      <div className="p-3 bg-gray-50 border-b border-gray-300 flex items-center justify-between">
        <p className="text-[10px] font-black uppercase tracking-widest text-gray-600">
          Showing complete purchase history
        </p>
        <p className="text-[10px] font-black uppercase tracking-widest text-primary">
          Total Records: {history.length}
        </p>
      </div>
      <div className="flex-1 overflow-auto bg-white min-h-[300px]">
        <table className="min-w-full border-collapse text-[11px]">
          <thead className="sticky top-0 bg-[#e1e1e1] border-b border-gray-400 z-10 uppercase">
            <tr>
              <th className="p-2 border-r border-gray-400 text-left">Invoice No / ID</th>
              <th className="p-2 border-r border-gray-400 text-left">Purchase Date</th>
              <th className="p-2 border-r border-gray-400 text-left">Supplier Name</th>
              <th className="p-2 border-r border-gray-400 text-left">Batch Number</th>
              <th className="p-2 border-r border-gray-400 text-center">Purchased Qty</th>
              <th className="p-2 border-r border-gray-400 text-right">Purchase Rate</th>
              <th className="p-2 text-right">MRP</th>
            </tr>
          </thead>
          <tbody>
            {history.map((record, idx) => (
              <tr key={`${record.purchaseId}-${idx}`} className="border-b border-gray-200 hover:bg-yellow-50">
                <td className="p-2 border-r border-gray-200 font-mono font-bold whitespace-nowrap">
                  {record.invoiceNumber}
                </td>
                <td className="p-2 border-r border-gray-200 font-semibold whitespace-nowrap">
                  {record.date ? new Date(record.date).toLocaleDateString() : '-'}
                </td>
                <td className="p-2 border-r border-gray-200 font-bold uppercase">
                  {record.supplier}
                </td>
                <td className="p-2 border-r border-gray-200 font-mono font-semibold">
                  {record.batch}
                </td>
                <td className="p-2 border-r border-gray-200 text-center font-bold text-gray-700 whitespace-nowrap">
                  {formatQuantity(record)}
                </td>
                <td className="p-2 border-r border-gray-200 text-right font-bold text-primary">
                  ₹{Number(record.purchasePrice || 0).toFixed(2)}
                </td>
                <td className="p-2 text-right font-bold text-gray-900">
                  ₹{Number(record.mrp || 0).toFixed(2)}
                </td>
              </tr>
            ))}
            {history.length === 0 && (
              <tr>
                <td colSpan={7} className="p-16 text-center text-gray-400 font-black uppercase tracking-[0.2em]">
                  No purchase history found for this product
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Modal>
  );
};

export default PurchaseHistoryModal;
