import type {
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesType,
  IChartApiBase,
  ISeriesApi,
} from "lightweight-charts";
import type { CanvasTarget } from "./canvas-types.js";

export interface PartialLine {
  price: number;
  startTime: Time;
  color: string;
  lineWidth: number;
  dash: number[];
}

class PartialPriceLinesRenderer implements IPrimitivePaneRenderer {
  private _lines: { startX: number; y: number; color: string; lineWidth: number; dash: number[] }[];

  constructor(lines: { startX: number; y: number; color: string; lineWidth: number; dash: number[] }[]) {
    this._lines = lines;
  }

  draw(target: CanvasTarget): void {
    if (this._lines.length === 0) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hRatio = scope.horizontalPixelRatio;
      const vRatio = scope.verticalPixelRatio;
      const width = scope.bitmapSize.width;

      for (const line of this._lines) {
        const startX = Math.round(line.startX * hRatio);
        const y = Math.round(line.y * vRatio);
        ctx.save();
        ctx.strokeStyle = line.color;
        ctx.lineWidth = Math.max(line.lineWidth, 1) * vRatio;
        if (line.dash.length > 0) {
          ctx.setLineDash(line.dash.map((d) => d * hRatio));
        }
        ctx.beginPath();
        ctx.moveTo(Math.max(0, startX), y);
        ctx.lineTo(width, y);
        ctx.stroke();
        ctx.restore();
      }
    });
  }
}

class PartialPriceLinesView implements IPrimitivePaneView {
  private _lines: { startX: number; y: number; color: string; lineWidth: number; dash: number[] }[] = [];

  update(lines: { startX: number; y: number; color: string; lineWidth: number; dash: number[] }[]): void {
    this._lines = lines;
  }

  zOrder(): "normal" {
    return "normal";
  }

  renderer(): IPrimitivePaneRenderer {
    return new PartialPriceLinesRenderer(this._lines);
  }
}

export class PartialPriceLinesPrimitive implements ISeriesPrimitive<Time> {
  private _view = new PartialPriceLinesView();
  private _requestUpdate: (() => void) | null = null;
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _partialLines: PartialLine[] = [];

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this._requestUpdate = param.requestUpdate;
    this._chart = param.chart;
    this._series = param.series;
  }

  detached(): void {
    this._requestUpdate = null;
    this._chart = null;
    this._series = null;
  }

  updateAllViews(): void {
    if (!this._chart || !this._series) return;
    const ts = this._chart.timeScale();
    const resolved: { startX: number; y: number; color: string; lineWidth: number; dash: number[] }[] = [];

    for (const pl of this._partialLines) {
      const startX = ts.timeToCoordinate(pl.startTime);
      const y = this._series.priceToCoordinate(pl.price);
      if (startX !== null && y !== null) {
        resolved.push({
          startX,
          y,
          color: pl.color,
          lineWidth: pl.lineWidth,
          dash: pl.dash,
        });
      }
    }
    this._view.update(resolved);
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._view];
  }

  setLines(lines: PartialLine[]): void {
    this._partialLines = lines;
    this.updateAllViews();
    this._requestUpdate?.();
  }
}
