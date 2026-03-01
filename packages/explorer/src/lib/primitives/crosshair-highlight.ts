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

class CrosshairHighlightRenderer implements IPrimitivePaneRenderer {
  private _x: number | null = null;
  private _barWidth: number = 0;
  private _color: string;

  constructor(x: number | null, barWidth: number, color: string) {
    this._x = x;
    this._barWidth = barWidth;
    this._color = color;
  }

  draw(target: CanvasTarget): void {
    if (this._x === null) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const ratio = scope.horizontalPixelRatio;
      const x = Math.round(this._x! * ratio);
      const w = Math.max(Math.round(this._barWidth * ratio), 1);
      ctx.fillStyle = this._color;
      ctx.fillRect(x - Math.floor(w / 2), 0, w, scope.bitmapSize.height);
    });
  }
}

class CrosshairHighlightView implements IPrimitivePaneView {
  private _x: number | null = null;
  private _barWidth: number = 0;
  private _color: string;

  constructor(color: string) {
    this._color = color;
  }

  update(x: number | null, barWidth: number): void {
    this._x = x;
    this._barWidth = barWidth;
  }

  zOrder(): "bottom" {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer {
    return new CrosshairHighlightRenderer(this._x, this._barWidth, this._color);
  }
}

export class CrosshairHighlightPrimitive implements ISeriesPrimitive<Time> {
  private _view: CrosshairHighlightView;
  private _requestUpdate: (() => void) | null = null;
  private _chart: IChartApiBase<Time> | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;

  constructor(color = "rgba(255,255,255,0.05)") {
    this._view = new CrosshairHighlightView(color);
  }

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

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._view];
  }

  setHighlightTime(time: Time | null): void {
    if (!this._chart || !this._series || !time) {
      this._view.update(null, 0);
      this._requestUpdate?.();
      return;
    }

    const x = this._chart.timeScale().timeToCoordinate(time);
    if (x === null) {
      this._view.update(null, 0);
      this._requestUpdate?.();
      return;
    }

    // Estimate bar width from logical range
    const logicalRange = this._chart.timeScale().getVisibleLogicalRange();
    const chartWidth = (this._chart as unknown as { width?: () => number }).width?.() ?? 800;
    let barWidth = 8;
    if (logicalRange) {
      const barsVisible = logicalRange.to - logicalRange.from;
      if (barsVisible > 0) {
        barWidth = chartWidth / barsVisible;
      }
    }

    this._view.update(x, barWidth);
    this._requestUpdate?.();
  }
}
