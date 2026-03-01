import type {
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesType,
  IChartApiBase,
} from "lightweight-charts";
import type { CanvasTarget } from "./canvas-types.js";

export interface SignalLine {
  time: Time;
  color: string;
}

class SignalVerticalLinesRenderer implements IPrimitivePaneRenderer {
  private _lines: { x: number; color: string }[];

  constructor(lines: { x: number; color: string }[]) {
    this._lines = lines;
  }

  draw(target: CanvasTarget): void {
    if (this._lines.length === 0) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const ratio = scope.horizontalPixelRatio;
      const height = scope.bitmapSize.height;

      for (const line of this._lines) {
        const x = Math.round(line.x * ratio);
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.strokeStyle = line.color;
        ctx.lineWidth = Math.max(1, ratio);
        ctx.setLineDash([4 * ratio, 4 * ratio]);
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        ctx.restore();
      }
    });
  }
}

class SignalVerticalLinesView implements IPrimitivePaneView {
  private _lines: { x: number; color: string }[] = [];

  update(lines: { x: number; color: string }[]): void {
    this._lines = lines;
  }

  zOrder(): "bottom" {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer {
    return new SignalVerticalLinesRenderer(this._lines);
  }
}

export class SignalVerticalLinesPrimitive implements ISeriesPrimitive<Time> {
  private _view = new SignalVerticalLinesView();
  private _requestUpdate: (() => void) | null = null;
  private _chart: IChartApiBase<Time> | null = null;
  private _signalLines: SignalLine[] = [];

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this._requestUpdate = param.requestUpdate;
    this._chart = param.chart;
  }

  detached(): void {
    this._requestUpdate = null;
    this._chart = null;
  }

  updateAllViews(): void {
    if (!this._chart) return;
    const ts = this._chart.timeScale();
    const resolved: { x: number; color: string }[] = [];
    for (const sl of this._signalLines) {
      const x = ts.timeToCoordinate(sl.time);
      if (x !== null) {
        resolved.push({ x, color: sl.color });
      }
    }
    this._view.update(resolved);
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._view];
  }

  setLines(lines: SignalLine[]): void {
    this._signalLines = lines;
    this.updateAllViews();
    this._requestUpdate?.();
  }
}
