import { useEffect, useRef } from "react";
import { LineStyle, type ISeriesApi, type SeriesType, type Time } from "lightweight-charts";
import type { RefObject } from "react";
import type { LivePosition } from "../types/api.js";
import { parseUtc } from "./parse-utc.js";
import { PartialPriceLinesPrimitive, type PartialLine } from "./primitives/partial-price-lines.js";

export interface UseChartPriceLinesOptions {
  positions: LivePosition[];
  seriesRef: RefObject<ISeriesApi<SeriesType> | null>;
}

export function useChartPriceLines(opts: UseChartPriceLinesOptions): void {
  const primitiveRef = useRef<PartialPriceLinesPrimitive | null>(null);

  // Attach/detach primitive
  useEffect(() => {
    if (!opts.seriesRef.current) return;
    const prim = new PartialPriceLinesPrimitive();
    opts.seriesRef.current.attachPrimitive(prim);
    primitiveRef.current = prim;
    return () => {
      opts.seriesRef.current?.detachPrimitive(prim);
      primitiveRef.current = null;
    };
  }, [opts.seriesRef]);

  useEffect(() => {
    if (!opts.seriesRef.current) return;

    for (const line of opts.seriesRef.current.priceLines()) {
      opts.seriesRef.current.removePriceLine(line);
    }

    if (opts.positions.length === 0) {
      primitiveRef.current?.setLines([]);
      return;
    }

    const pos = opts.positions[0];
    const openedAt = (parseUtc(pos.openedAt).getTime() / 1000) as Time;

    // P&L calculation for entry line title
    const pnl = pos.unrealizedPnl;
    const pnlPct = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * (pos.direction === "long" ? 1 : -1);
    const pnlSign = pnl >= 0 ? "▲" : "▼";
    const pnlStr = `Entry ${pnlSign}$${Math.abs(pnl).toFixed(2)} (${pnl >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`;

    const partialLines: PartialLine[] = [];

    // Entry — invisible createPriceLine (for axis label only), visual via primitive
    opts.seriesRef.current.createPriceLine({
      price: pos.entryPrice,
      color: "#ffaa00",
      lineWidth: 0 as 1, // invisible line, label only
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: pnlStr,
      lineVisible: false,
    });
    partialLines.push({
      price: pos.entryPrice,
      startTime: openedAt,
      color: "#ffaa00",
      lineWidth: 1,
      dash: [2, 2],
    });

    if (pos.stopLoss > 0) {
      opts.seriesRef.current.createPriceLine({
        price: pos.stopLoss,
        color: "#ff3366",
        lineWidth: 0 as 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "SL",
        lineVisible: false,
      });
      partialLines.push({
        price: pos.stopLoss,
        startTime: openedAt,
        color: "#ff3366",
        lineWidth: 1,
        dash: [4, 4],
      });
    }

    if (pos.takeProfits) {
      for (let i = 0; i < pos.takeProfits.length; i++) {
        const tp = pos.takeProfits[i];
        if (tp.price > 0) {
          opts.seriesRef.current.createPriceLine({
            price: tp.price,
            color: "#00ff88",
            lineWidth: 0 as 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `TP${i + 1}`,
            lineVisible: false,
          });
          partialLines.push({
            price: tp.price,
            startTime: openedAt,
            color: "#00ff88",
            lineWidth: 1,
            dash: [4, 4],
          });
        }
      }
    }

    if (pos.trailingStopLoss != null && pos.trailingStopLoss > 0) {
      opts.seriesRef.current.createPriceLine({
        price: pos.trailingStopLoss,
        color: "#ff9900",
        lineWidth: 0 as 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "TSL",
        lineVisible: false,
      });
      partialLines.push({
        price: pos.trailingStopLoss,
        startTime: openedAt,
        color: "#ff9900",
        lineWidth: 1,
        dash: [4, 4],
      });
    }

    if (pos.liquidationPx != null && pos.liquidationPx > 0) {
      opts.seriesRef.current.createPriceLine({
        price: pos.liquidationPx,
        color: "#ff3366",
        lineWidth: 0 as 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: "Liq",
        lineVisible: false,
      });
      partialLines.push({
        price: pos.liquidationPx,
        startTime: openedAt,
        color: "#ff3366",
        lineWidth: 2,
        dash: [],
      });
    }

    primitiveRef.current?.setLines(partialLines);
  }, [opts.positions]);
}
