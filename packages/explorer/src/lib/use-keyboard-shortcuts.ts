import { useEffect } from "react";
import type { IChartApi } from "lightweight-charts";
import type { RefObject } from "react";

export interface UseKeyboardShortcutsOptions {
  chartRef: RefObject<IChartApi | null>;
  coinList?: string[];
  coin?: string;
  onSelectCoin?: (coin: string) => void;
}

export function useKeyboardShortcuts(opts: UseKeyboardShortcutsOptions): void {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ignore when focus is in form elements
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const chart = opts.chartRef.current;
      if (!chart) return;

      switch (e.key) {
        case " ": {
          e.preventDefault();
          chart.timeScale().fitContent();
          break;
        }
        case "Home": {
          e.preventDefault();
          chart.timeScale().scrollToRealTime();
          break;
        }
        case "+" :
        case "=": {
          e.preventDefault();
          const ts = chart.timeScale();
          const range = ts.getVisibleLogicalRange();
          if (range) {
            const span = range.to - range.from;
            const center = (range.from + range.to) / 2;
            const newSpan = span * 0.75;
            ts.setVisibleLogicalRange({
              from: center - newSpan / 2,
              to: center + newSpan / 2,
            });
          }
          break;
        }
        case "-": {
          e.preventDefault();
          const ts = chart.timeScale();
          const range = ts.getVisibleLogicalRange();
          if (range) {
            const span = range.to - range.from;
            const center = (range.from + range.to) / 2;
            const newSpan = span * 1.333;
            ts.setVisibleLogicalRange({
              from: center - newSpan / 2,
              to: center + newSpan / 2,
            });
          }
          break;
        }
        case "ArrowLeft": {
          if (!opts.coinList?.length || !opts.coin || !opts.onSelectCoin) break;
          e.preventDefault();
          const idx = opts.coinList.indexOf(opts.coin);
          if (idx > 0) opts.onSelectCoin(opts.coinList[idx - 1]);
          break;
        }
        case "ArrowRight": {
          if (!opts.coinList?.length || !opts.coin || !opts.onSelectCoin) break;
          e.preventDefault();
          const idx = opts.coinList.indexOf(opts.coin);
          if (idx < opts.coinList.length - 1) opts.onSelectCoin(opts.coinList[idx + 1]);
          break;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [opts.chartRef, opts.coinList, opts.coin, opts.onSelectCoin]);
}
