import { useEffect } from "react";
import { useStore } from "../store/use-store.js";
import { selectSelectedPrices } from "../store/selectors.js";

export function PriceDisplay() {
  const selectedPrices = useStore(selectSelectedPrices);
  const priceFlash = useStore((s) => s.priceFlash);
  const clearPriceFlash = useStore((s) => s.clearPriceFlash);

  useEffect(() => {
    if (!priceFlash) return;
    const id = setTimeout(clearPriceFlash, 700);
    return () => clearTimeout(id);
  }, [priceFlash, clearPriceFlash]);

  if (!selectedPrices || (selectedPrices.hlMidPrice == null && selectedPrices.dataSourcePrice == null)) {
    return null;
  }

  return (
    <div className={`relative flex items-center gap-3 ${priceFlash === "up" ? "price-flash-up" : priceFlash === "down" ? "price-flash-down" : ""}`}>
      {selectedPrices.hlMidPrice != null && (
        <span className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-txt-secondary/60">HL</span>
          <span className="font-mono text-sm font-medium text-txt-primary">{selectedPrices.hlMidPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </span>
      )}
      {selectedPrices.hlMidPrice != null && selectedPrices.dataSourcePrice != null && (
        <span className="text-txt-secondary/30 text-xs">{"\u00b7"}</span>
      )}
      {selectedPrices.dataSourcePrice != null && (
        <span className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-txt-secondary/60">BIN</span>
          <span className="font-mono text-sm font-medium text-txt-primary">{selectedPrices.dataSourcePrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </span>
      )}
    </div>
  );
}
