import type {
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesType,
  ISeriesApi,
} from "lightweight-charts";
import type { CanvasTarget, BitmapCoordinatesRenderingScope } from "./canvas-types.js";
import { computeVpvr, type VpvrBucket } from "../compute-vpvr.js";

const POC_COLOR = "#ffaa00";
const BAR_COLOR = "rgba(255,255,255,0.12)";
const MAX_WIDTH_PCT = 0.12;

interface Bar {
  y: number;
  height: number;
  width: number;
  color: string;
}

class VolumeProfileRenderer implements IPrimitivePaneRenderer {
  private _bars: Bar[];

  constructor(bars: Bar[]) {
    this._bars = bars;
  }

  draw(target: CanvasTarget): void {
    if (this._bars.length === 0) return;
    target.useBitmapCoordinateSpace((scope: BitmapCoordinatesRenderingScope) => {
      const ctx = scope.context;
      const hRatio = scope.horizontalPixelRatio;
      const vRatio = scope.verticalPixelRatio;
      const chartWidth = scope.bitmapSize.width;

      for (const bar of this._bars) {
        const y = Math.round(bar.y * vRatio);
        const h = Math.max(Math.round(bar.height * vRatio), 1);
        const w = Math.round(bar.width * hRatio);
        const x = chartWidth - w;
        ctx.fillStyle = bar.color;
        ctx.fillRect(x, y, w, h);
      }
    });
  }
}

class VolumeProfileView implements IPrimitivePaneView {
  private _bars: Bar[] = [];

  update(bars: Bar[]): void {
    this._bars = bars;
  }

  zOrder(): "normal" {
    return "normal";
  }

  renderer(): IPrimitivePaneRenderer {
    return new VolumeProfileRenderer(this._bars);
  }
}

interface VpvrCandle {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class VolumeProfilePrimitive implements ISeriesPrimitive<Time> {
  private _view = new VolumeProfileView();
  private _requestUpdate: (() => void) | null = null;
  private _series: ISeriesApi<SeriesType, Time> | null = null;
  private _candles: VpvrCandle[] = [];
  private _cachedBuckets: VpvrBucket[] = [];
  private _cacheKey = "";

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this._requestUpdate = param.requestUpdate;
    this._series = param.series;
  }

  detached(): void {
    this._requestUpdate = null;
    this._series = null;
  }

  updateAllViews(): void {
    this._rebuildBars();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._view];
  }

  setCandles(candles: VpvrCandle[]): void {
    this._candles = candles;
    this._cacheKey = ""; // invalidate cache
  }

  recalculate(fromIdx: number, toIdx: number, chartWidth: number): void {
    // Clamp indices
    const start = Math.max(0, Math.floor(fromIdx));
    const end = Math.min(this._candles.length - 1, Math.ceil(toIdx));
    if (start > end) {
      this._view.update([]);
      this._requestUpdate?.();
      return;
    }

    const key = `${start}:${end}`;
    if (key !== this._cacheKey) {
      const visible = this._candles.slice(start, end + 1);
      this._cachedBuckets = computeVpvr(
        visible.map((c) => ({
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        })),
        40,
      );
      this._cacheKey = key;
    }

    this._rebuildBarsFromBuckets(chartWidth);
  }

  private _rebuildBars(): void {
    if (!this._series || this._cachedBuckets.length === 0) {
      this._view.update([]);
      return;
    }
    // Use a reasonable default width
    this._rebuildBarsFromBuckets(800);
  }

  private _rebuildBarsFromBuckets(chartWidth: number): void {
    if (!this._series || this._cachedBuckets.length === 0) {
      this._view.update([]);
      this._requestUpdate?.();
      return;
    }

    const maxVol = Math.max(...this._cachedBuckets.map((b) => b.volume));
    if (maxVol <= 0) {
      this._view.update([]);
      this._requestUpdate?.();
      return;
    }

    const maxBarWidth = chartWidth * MAX_WIDTH_PCT;
    const bars: Bar[] = [];

    for (const bucket of this._cachedBuckets) {
      if (bucket.volume <= 0) continue;
      const yTop = this._series.priceToCoordinate(bucket.priceTo);
      const yBottom = this._series.priceToCoordinate(bucket.priceFrom);
      if (yTop === null || yBottom === null) continue;

      const y = Math.min(yTop, yBottom);
      const height = Math.abs(yBottom - yTop);
      const width = (bucket.volume / maxVol) * maxBarWidth;

      bars.push({
        y,
        height: Math.max(height, 1),
        width,
        color: bucket.isPoc ? POC_COLOR : BAR_COLOR,
      });
    }

    this._view.update(bars);
    this._requestUpdate?.();
  }
}
