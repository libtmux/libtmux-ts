import type { Pane } from "libtmux";

/** tmux stores at most this many UTF-8 bytes in one grid cell. */
const MAX_GRID_CELL_BYTES = 32;

export interface CaptureRange {
  readonly clamped: boolean;
  readonly end: number | undefined;
  readonly start: number | undefined;
}

export interface BoundedGridCapture {
  readonly byteClamped: boolean;
  readonly lines: readonly string[];
  readonly range: CaptureRange;
}

/** Preserve the tail of a requested range without asking tmux for an unbounded grid. */
export function boundedCaptureRange(
  paneHeight: number | null,
  start: number | undefined,
  end: number | undefined,
  limit: number,
): CaptureRange {
  const first = start ?? 0;
  const knownHeight =
    paneHeight !== null && Number.isSafeInteger(paneHeight) && paneHeight > 0
      ? paneHeight
      : undefined;
  const unknownEnd = end === undefined && knownHeight === undefined;
  const last = end ?? (knownHeight === undefined ? Math.max(first, 0) : knownHeight - 1);
  if (last < first || last - first < limit) {
    return unknownEnd ? { clamped: true, end: last, start: first } : { clamped: false, end, start };
  }
  return { clamped: true, end: last, start: last - limit + 1 };
}

/** Bound rows before tmux serializes a grid into the command response. */
export function captureRowLimit(
  paneWidth: number | null,
  lineLimit: number,
  byteLimit: number,
): number {
  if (
    paneWidth === null ||
    !Number.isSafeInteger(paneWidth) ||
    paneWidth <= 0 ||
    !Number.isSafeInteger(lineLimit) ||
    lineLimit <= 0 ||
    !Number.isSafeInteger(byteLimit) ||
    byteLimit <= 0
  ) {
    return 0;
  }
  const rowBytes = paneWidth * MAX_GRID_CELL_BYTES + 1;
  if (!Number.isSafeInteger(rowBytes) || rowBytes > byteLimit) return 0;
  return Math.min(lineLimit, Math.floor(byteLimit / rowBytes));
}

/** Capture only rows that can fit both the line and UTF-8 byte ceilings. */
export async function captureGridBounded(
  pane: Pick<Pane, "capture" | "height" | "width">,
  options: {
    readonly byteLimit: number;
    readonly end?: number;
    readonly joinWrapped?: boolean;
    readonly lineLimit: number;
    readonly start?: number;
  },
): Promise<BoundedGridCapture> {
  const requested = boundedCaptureRange(pane.height, options.start, options.end, options.lineLimit);
  const rowLimit = captureRowLimit(pane.width, options.lineLimit, options.byteLimit);
  const range =
    rowLimit === 0
      ? { clamped: true, end: undefined, start: undefined }
      : boundedCaptureRange(pane.height, options.start, options.end, rowLimit);
  const byteClamped =
    rowLimit === 0 || range.end !== requested.end || range.start !== requested.start;
  const lines =
    rowLimit === 0
      ? []
      : await pane.capture({
          ...(range.end === undefined ? {} : { end: range.end }),
          ...(options.joinWrapped === undefined ? {} : { joinWrapped: options.joinWrapped }),
          ...(range.start === undefined ? {} : { start: range.start }),
        });
  return { byteClamped, lines, range };
}
