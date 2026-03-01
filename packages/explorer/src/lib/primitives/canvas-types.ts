/** Inline types for the canvas rendering scope used by lightweight-charts primitives. */

export interface BitmapCoordinatesRenderingScope {
  readonly context: CanvasRenderingContext2D;
  readonly mediaSize: { width: number; height: number };
  readonly bitmapSize: { width: number; height: number };
  readonly horizontalPixelRatio: number;
  readonly verticalPixelRatio: number;
}

export interface CanvasTarget {
  useBitmapCoordinateSpace<T>(f: (scope: BitmapCoordinatesRenderingScope) => T): T;
}
