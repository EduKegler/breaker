import type {
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesType,
  IChartApiBase,
} from "lightweight-charts";
import type { CanvasTarget, BitmapCoordinatesRenderingScope } from "./canvas-types.js";

interface SessionDef {
  name: string;
  startHour: number;
  endHour: number;
  color: string;
}

const SESSIONS: SessionDef[] = [
  { name: "Asia",    startHour: 0,  endHour: 8,  color: "rgba(59,130,246,0.03)" },
  { name: "Europe",  startHour: 7,  endHour: 16, color: "rgba(0,255,136,0.025)" },
  { name: "America", startHour: 13, endHour: 22, color: "rgba(255,170,0,0.025)" },
];

interface Block {
  startX: number;
  endX: number;
  color: string;
}

class SessionHighlightRenderer implements IPrimitivePaneRenderer {
  private _blocks: Block[];

  constructor(blocks: Block[]) {
    this._blocks = blocks;
  }

  draw(target: CanvasTarget): void {
    if (this._blocks.length === 0) return;
    target.useBitmapCoordinateSpace((scope: BitmapCoordinatesRenderingScope) => {
      const ctx = scope.context;
      const ratio = scope.horizontalPixelRatio;
      const height = scope.bitmapSize.height;

      for (const block of this._blocks) {
        const x1 = Math.round(block.startX * ratio);
        const x2 = Math.round(block.endX * ratio);
        const w = x2 - x1;
        if (w <= 0) continue;
        ctx.fillStyle = block.color;
        ctx.fillRect(x1, 0, w, height);
      }
    });
  }
}

class SessionHighlightView implements IPrimitivePaneView {
  private _blocks: Block[] = [];

  update(blocks: Block[]): void {
    this._blocks = blocks;
  }

  zOrder(): "bottom" {
    return "bottom";
  }

  renderer(): IPrimitivePaneRenderer {
    return new SessionHighlightRenderer(this._blocks);
  }
}

export class SessionHighlightPrimitive implements ISeriesPrimitive<Time> {
  private _view = new SessionHighlightView();
  private _requestUpdate: (() => void) | null = null;
  private _chart: IChartApiBase<Time> | null = null;
  private _candleTimes: number[] = [];

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this._requestUpdate = param.requestUpdate;
    this._chart = param.chart;
  }

  detached(): void {
    this._requestUpdate = null;
    this._chart = null;
  }

  updateAllViews(): void {
    if (!this._chart || this._candleTimes.length === 0) {
      this._view.update([]);
      return;
    }

    const ts = this._chart.timeScale();
    const blocks: Block[] = [];

    // Group contiguous candles by session and create blocks
    for (const session of SESSIONS) {
      let blockStart: number | null = null;
      let blockEnd: number | null = null;

      for (const t of this._candleTimes) {
        const date = new Date(t * 1000);
        const hour = date.getUTCHours();
        const inSession = session.startHour < session.endHour
          ? hour >= session.startHour && hour < session.endHour
          : hour >= session.startHour || hour < session.endHour;

        if (inSession) {
          const x = ts.timeToCoordinate(t as Time);
          if (x !== null) {
            if (blockStart === null) {
              blockStart = x;
              blockEnd = x;
            } else {
              blockEnd = x;
            }
          }
        } else if (blockStart !== null && blockEnd !== null) {
          // Add bar-width padding to end
          blocks.push({ startX: blockStart - 4, endX: blockEnd + 4, color: session.color });
          blockStart = null;
          blockEnd = null;
        }
      }

      if (blockStart !== null && blockEnd !== null) {
        blocks.push({ startX: blockStart - 4, endX: blockEnd + 4, color: session.color });
      }
    }

    this._view.update(blocks);
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._view];
  }

  setCandleTimes(times: number[]): void {
    this._candleTimes = times;
    this.updateAllViews();
    this._requestUpdate?.();
  }
}
