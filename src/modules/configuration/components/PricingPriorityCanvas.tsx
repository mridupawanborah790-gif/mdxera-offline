import React from 'react';

export type PriorityType = 'customer_price_master' | 'material_price_master' | 'inventory';

export interface PricingPriorityConfig {
  priority1: PriorityType;
  priority2: PriorityType;
  priority3: PriorityType;
}

interface PricingPriorityCanvasProps {
  value?: PricingPriorityConfig;
  onChange: (nextConfig: PricingPriorityConfig) => void;
}

const OPTION_META: Record<PriorityType, { label: string; badgeBg: string; description: string }> = {
  customer_price_master: {
    label: 'Customer Price Master',
    badgeBg: 'bg-emerald-600',
    description: 'Customer-specific selling price maintained in Customer Price Master tab',
  },
  material_price_master: {
    label: 'Material-Wise Price Master',
    badgeBg: 'bg-blue-600',
    description: 'Material-specific selling price applied for walking & registered customers across all batches',
  },
  inventory: {
    label: 'Inventory Batch Price (Default / MRP)',
    badgeBg: 'bg-gray-500',
    description: 'Default selling rate or MRP from the inventory batch record',
  },
};

const PricingPriorityCanvas: React.FC<PricingPriorityCanvasProps> = ({ value, onChange }) => {
  // Migration fallback: map legacy 'fk_price' to 'material_price_master'
  const sanitizePriority = (p?: string, fallback: PriorityType = 'customer_price_master'): PriorityType => {
    if (p === 'customer_price_master' || p === 'material_price_master' || p === 'inventory') return p;
    return fallback;
  };

  const p1 = sanitizePriority(value?.priority1 as string, 'customer_price_master');
  const p2 = sanitizePriority(value?.priority2 as string, 'material_price_master');
  const p3 = sanitizePriority(value?.priority3 as string, 'inventory');

  const allOptions: PriorityType[] = ['customer_price_master', 'material_price_master', 'inventory'];
  const order: PriorityType[] = [];
  [p1, p2, p3].forEach(item => { if (!order.includes(item)) order.push(item); });
  allOptions.forEach(opt => { if (!order.includes(opt)) order.push(opt); });

  const move = (fromIdx: number, toIdx: number) => {
    if (toIdx < 0 || toIdx >= order.length) return;
    const next = [...order];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    onChange({ priority1: next[0], priority2: next[1], priority3: next[2] });
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-[10px] font-black text-primary uppercase tracking-[0.2em]">
          Pricing Priority Canvas
        </h3>
        <p className="text-[9px] font-bold text-gray-400 uppercase leading-tight mt-0.5">
          Adjust the priority order by moving items up or down. Billing resolves line item rates from Priority 1 to Priority 3.
        </p>
      </div>

      {/* FK Price Notice */}
      <div className="bg-gray-50 border border-gray-300 p-2.5 text-[10px] text-gray-700 leading-relaxed">
        <strong className="font-black uppercase text-gray-800">Note — Automatic FK Price:</strong>{' '}
        If FK Price is mapped for a customer &amp; material in Price Master, it is automatically applied for printed invoice
        summary calculations, regardless of the priority hierarchy set below.
      </div>

      {/* Re-orderable Canvas Cards */}
      <div className="space-y-2 bg-gray-50 p-2 border border-gray-300">
        {order.map((key, idx) => {
          const meta = OPTION_META[key];
          const isFirst = idx === 0;
          const isLast = idx === order.length - 1;

          return (
            <div
              key={key}
              className={`bg-white border flex items-center justify-between gap-3 p-2.5 ${
                isFirst ? 'border-primary' : 'border-gray-300'
              }`}
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                {/* Priority Badge */}
                <div className={`w-7 h-7 ${meta.badgeBg} text-white font-black text-[10px] flex items-center justify-center flex-shrink-0`}>
                  P{idx + 1}
                </div>

                <div className="flex flex-col min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-black uppercase text-gray-900 truncate">
                      {meta.label}
                    </span>
                    {isFirst && (
                      <span className="text-[8px] font-black uppercase px-1.5 py-0.5 bg-primary text-white">
                        Active 1st
                      </span>
                    )}
                  </div>
                  <p className="text-[9px] font-bold text-gray-400 uppercase mt-0.5 truncate">
                    {meta.description}
                  </p>
                </div>
              </div>

              {/* Move Buttons */}
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => move(idx, idx - 1)}
                  disabled={isFirst}
                  className={`px-2 py-1 text-[10px] font-black uppercase border transition-colors ${
                    isFirst
                      ? 'bg-gray-100 text-gray-300 border-gray-200 cursor-not-allowed'
                      : 'bg-gray-100 hover:bg-primary hover:text-white text-gray-700 border-gray-300'
                  }`}
                  title="Move Priority Up"
                >
                  ▲ Up
                </button>
                <button
                  type="button"
                  onClick={() => move(idx, idx + 1)}
                  disabled={isLast}
                  className={`px-2 py-1 text-[10px] font-black uppercase border transition-colors ${
                    isLast
                      ? 'bg-gray-100 text-gray-300 border-gray-200 cursor-not-allowed'
                      : 'bg-gray-100 hover:bg-primary hover:text-white text-gray-700 border-gray-300'
                  }`}
                  title="Move Priority Down"
                >
                  ▼ Down
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Resolution Flow Map */}
      <div className="bg-white border border-gray-200 p-2.5">
        <div className="text-[9px] font-black uppercase text-gray-500 tracking-wider mb-1.5">
          Resolution Flow Map
        </div>
        <div className="flex items-center gap-2 flex-wrap text-[10px] font-bold uppercase">
          <span className="px-2 py-1 bg-gray-100 text-gray-800 border border-gray-300">
            1. {OPTION_META[order[0]].label}
          </span>
          <span className="text-gray-400">➔</span>
          <span className="px-2 py-1 bg-gray-100 text-gray-800 border border-gray-300">
            2. {OPTION_META[order[1]].label}
          </span>
          <span className="text-gray-400">➔</span>
          <span className="px-2 py-1 bg-gray-100 text-gray-800 border border-gray-300">
            3. {OPTION_META[order[2]].label}
          </span>
        </div>
      </div>
    </div>
  );
};

export default PricingPriorityCanvas;
