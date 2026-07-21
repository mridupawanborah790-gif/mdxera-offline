import React from 'react';

export type PriorityType = 'customer_price_master' | 'fk_price' | 'inventory';

export interface PricingPriorityConfig {
  priority1: PriorityType;
  priority2: PriorityType;
  priority3: PriorityType;
}

interface PricingPriorityCanvasProps {
  value?: PricingPriorityConfig;
  onChange: (nextConfig: PricingPriorityConfig) => void;
}

const OPTION_META: Record<PriorityType, { label: string; icon: string; badgeBg: string; badgeText: string; description: string }> = {
  customer_price_master: {
    label: 'Customer Price Master (Actual Price)',
    icon: '🏷️',
    badgeBg: 'bg-emerald-500',
    badgeText: 'text-emerald-700',
    description: 'Customer-specific selling price maintained in Price Master module',
  },
  fk_price: {
    label: 'FK Price (Print-Only Shadow Price)',
    icon: '⚑',
    badgeBg: 'bg-purple-500',
    badgeText: 'text-purple-700',
    description: 'Special shadow price used ONLY for printed bill summary total',
  },
  inventory: {
    label: 'Inventory Price (Default / MRP)',
    icon: '📦',
    badgeBg: 'bg-blue-500',
    badgeText: 'text-blue-700',
    description: 'Default selling price or MRP from Inventory & Material Master',
  },
};

const PricingPriorityCanvas: React.FC<PricingPriorityCanvasProps> = ({ value, onChange }) => {
  const currentOrder: PriorityType[] = [
    value?.priority1 || 'customer_price_master',
    value?.priority2 || 'fk_price',
    value?.priority3 || 'inventory',
  ];

  const move = (fromIdx: number, toIdx: number) => {
    if (toIdx < 0 || toIdx >= currentOrder.length) return;
    const next = [...currentOrder];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    onChange({
      priority1: next[0],
      priority2: next[1],
      priority3: next[2],
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[10px] font-black text-primary uppercase tracking-[0.2em]">
            Pricing Priority Canvas
          </h3>
          <p className="text-[9px] font-bold text-gray-400 uppercase leading-tight mt-0.5">
            Adjust the priority order below by moving items up or down. Billing resolves prices from Priority 1 to Priority 3.
          </p>
        </div>
      </div>

      {/* Re-orderable Canvas Cards */}
      <div className="space-y-2.5 bg-gray-50/80 p-3 border-2 border-dashed border-gray-300 rounded-sm">
        {currentOrder.map((key, idx) => {
          const meta = OPTION_META[key];
          const isFirst = idx === 0;
          const isLast = idx === currentOrder.length - 1;

          return (
            <div
              key={key}
              className={`p-3 bg-white border-2 transition-all flex items-center justify-between gap-3 shadow-sm hover:shadow-md ${
                isFirst
                  ? 'border-emerald-500 ring-1 ring-emerald-500/20'
                  : idx === 1
                  ? 'border-purple-300'
                  : 'border-gray-200'
              }`}
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                {/* Priority Rank Indicator */}
                <div
                  className={`w-8 h-8 rounded-full ${meta.badgeBg} text-white font-black text-xs flex items-center justify-center flex-shrink-0 shadow-sm`}
                >
                  P{idx + 1}
                </div>

                <div className="flex flex-col min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{meta.icon}</span>
                    <span className="text-xs font-black uppercase text-gray-900 truncate">
                      {meta.label}
                    </span>
                    {isFirst && (
                      <span className="text-[8px] font-black uppercase px-2 py-0.5 bg-emerald-100 text-emerald-800 border border-emerald-300 rounded-xs">
                        Active 1st Choice
                      </span>
                    )}
                  </div>
                  <p className="text-[9px] font-bold text-gray-400 uppercase mt-0.5 truncate">
                    {meta.description}
                  </p>
                </div>
              </div>

              {/* Action Move Buttons */}
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => move(idx, idx - 1)}
                  disabled={isFirst}
                  className={`px-2 py-1 text-[10px] font-black uppercase border transition-colors flex items-center gap-1 ${
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
                  className={`px-2 py-1 text-[10px] font-black uppercase border transition-colors flex items-center gap-1 ${
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

      {/* Visual Resolution Flow Map */}
      <div className="bg-white border border-gray-200 p-3 flex flex-col gap-1.5">
        <div className="text-[9px] font-black uppercase text-gray-500 tracking-wider">
          Resolution Flow Map
        </div>
        <div className="flex items-center gap-2 flex-wrap text-[10px] font-bold uppercase">
          <span className="px-2 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200">
            1. {OPTION_META[currentOrder[0]].label}
          </span>
          <span className="text-gray-400">➔</span>
          <span className="px-2 py-1 bg-purple-50 text-purple-700 border border-purple-200">
            2. {OPTION_META[currentOrder[1]].label}
          </span>
          <span className="text-gray-400">➔</span>
          <span className="px-2 py-1 bg-blue-50 text-blue-700 border border-blue-200">
            3. {OPTION_META[currentOrder[2]].label}
          </span>
        </div>
      </div>
    </div>
  );
};

export default PricingPriorityCanvas;
