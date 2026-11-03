import { type CSSProperties, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryResponse } from '../../src/api.ts';
import { formatAge, formatPrice, formatTime } from '../format.ts';

const HEIGHT = 320;
const PAD = { left: 12, right: 76, top: 12, bottom: 28 };
// Roughly the widest tooltip; used only to decide which side of the crosshair it goes.
const TOOLTIP_WIDTH = 300;
// API3 blue first, then the reference dark categorical order. Checked with the dataviz palette validator against
// the card surface (#0c1143): lightness band, chroma floor, colour-blind separation and contrast all pass.
// Index by the provider's fixed slot from the API, never by its position in the response.
const COLORS = ['#3e7aff', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

// Index of the last time at or before t in an ascending list, or -1.
function lastAtOrBefore(times: readonly number[], t: number) {
  let low = 0;
  let high = times.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((times[middle] ?? Number.POSITIVE_INFINITY) <= t) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

interface ChartProps {
  data: HistoryResponse;
  label: string;
  // Dims the chart while a new range loads, keeping the old frame instead of flashing empty.
  stale?: boolean;
  onPick: (time: number) => void;
}

export function Chart({ data, label, stale = false, onPick }: ChartProps) {
  const [ref, width] = useWidth();
  const [cursor, setCursor] = useState<number | null>(null);
  // A legend entry highlights its line while hovered or focused, and stays highlighted once clicked.
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const focused = hovered ?? pinned;

  const geometry = useMemo(() => {
    const series = data.providers.map(({ provider, slot, points }) => ({
      provider,
      color: COLORS[slot % COLORS.length] ?? COLORS[0],
      points: points.map(({ timestamp, price }) => ({ t: timestamp, v: Number(price), price })),
    }));
    const all = series.flatMap(({ points }) => points);
    if (all.length === 0 || width === 0) return null;

    const t0 = Math.min(...all.map(({ t }) => t));
    // A trailing gap (archiver down until now) stays visible past the last point.
    const t1 = Math.max(t0 + 1, ...all.map(({ t }) => t), ...data.gaps.map(({ to }) => to));
    const low = Math.min(...all.map(({ v }) => v));
    const high = Math.max(...all.map(({ v }) => v));
    const margin = (high - low) * 0.08 || Math.abs(high) * 0.001 || 1;
    const v0 = low - margin;
    const v1 = high + margin;
    const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * (width - PAD.left - PAD.right);
    const y = (v: number) => PAD.top + (1 - (v - v0) / (v1 - v0)) * (HEIGHT - PAD.top - PAD.bottom);

    const tickCount = Math.max(2, Math.floor(width / 180));
    const dateOnly = t1 - t0 > 2 * 86_400;
    const timeTicks = Array.from({ length: tickCount + 1 }, (_, i) => {
      const t = t0 + ((t1 - t0) * i) / tickCount;
      const options: Intl.DateTimeFormatOptions = dateOnly
        ? { month: 'short', day: 'numeric' }
        : { hour: '2-digit', minute: '2-digit' };
      const anchor: 'start' | 'end' | 'middle' = i === 0 ? 'start' : i === tickCount ? 'end' : 'middle';
      return { x: x(t), label: new Date(t * 1000).toLocaleString(undefined, options), anchor };
    });
    // Enough decimals to tell neighbouring ticks apart, however close the prices are.
    const step = (v1 - v0) / 4;
    const decimals = Math.min(20, Math.max(0, Math.ceil(-Math.log10(step))));
    const priceTicks = Array.from({ length: 5 }, (_, i) => {
      const v = v0 + step * i;
      return {
        y: y(v),
        label: v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
      };
    });
    // A line across a gap would claim the price held steady while nobody was watching, so break it there.
    const crossesGap = (a: number, b: number) => data.gaps.some((gap) => a < gap.to && b > gap.from);
    const paths = series.map(({ provider, color, points }) => {
      const breaks = points.map(({ t }, i) => i === 0 || crossesGap(points[i - 1]?.t ?? t, t));
      const d = points
        .map(({ t, v }, i) => {
          const at = `${x(t).toFixed(1)},${y(v).toFixed(1)}`;
          if (!breaks[i]) return `L${at}`;
          // A point alone between breaks has no line; a zero-length stroke with round caps draws it as a dot.
          return breaks[i + 1] === false ? `M${at}` : `M${at}h0`;
        })
        .join('');
      return { provider, color, points, times: points.map(({ t }) => t), d };
    });
    const gaps = data.gaps
      .filter((gap) => gap.to > t0 && gap.from < t1)
      .map((gap) => ({
        key: gap.from,
        x: x(Math.max(gap.from, t0)),
        width: x(Math.min(gap.to, t1)) - x(Math.max(gap.from, t0)),
      }));
    // Every record time, so the crosshair can snap to real data instead of an arbitrary pixel.
    const times = [...new Set(all.map(({ t }) => t))].sort((a, b) => a - b);
    return { t0, t1, x, y, timeTicks, priceTicks, paths, gaps, times, crossesGap };
  }, [data, width]);

  // Each provider's latest record at the cursor, unless a gap lies between that record and the cursor.
  const readout = useMemo(() => {
    if (!geometry || cursor === null) return [];
    return geometry.paths
      .flatMap(({ provider, color, points, times }) => {
        const point = points[lastAtOrBefore(times, cursor)];
        return point && !geometry.crossesGap(point.t, cursor) ? [{ provider, color, ...point }] : [];
      })
      .sort((a, b) => b.v - a.v);
  }, [geometry, cursor]);

  const snap = (t: number) => {
    if (!geometry) return t;
    const { times } = geometry;
    const index = lastAtOrBefore(times, t);
    const before = times[index];
    const after = times[index + 1];
    if (before === undefined) return after ?? t;
    if (after === undefined) return before;
    return t - before <= after - t ? before : after;
  };

  const timeAt = (clientX: number, element: HTMLElement) => {
    if (!geometry) return null;
    const ratio = (clientX - element.getBoundingClientRect().left - PAD.left) / (width - PAD.left - PAD.right);
    return snap(geometry.t0 + Math.min(1, Math.max(0, ratio)) * (geometry.t1 - geometry.t0));
  };

  // The chart is a time slider: arrow keys step from record to record, Enter picks that moment, like a click.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!geometry) return;
    const { times } = geometry;
    const current = cursor ?? geometry.t1;
    const index = times.indexOf(snap(current));
    const step = Math.max(1, Math.round(times.length / 50));
    const moves: Record<string, number | undefined> = {
      ArrowLeft: times[Math.max(0, index - (event.shiftKey ? step : 1))],
      ArrowRight: times[Math.min(times.length - 1, index + (event.shiftKey ? step : 1))],
      Home: times[0],
      End: times.at(-1),
    };
    const next = moves[event.key];
    if (next !== undefined) {
      event.preventDefault();
      setCursor(next);
    } else if (event.key === 'Enter') {
      onPick(current);
    }
  };

  const cursorX = geometry && cursor !== null ? geometry.x(cursor) : null;
  const median = readout.length > 0 ? medianOf(readout.map(({ v }) => v)) : null;

  return (
    <>
      <div className={stale ? 'chart stale' : 'chart'} ref={ref}>
        {geometry ? (
          <div
            className="slider"
            role="slider"
            tabIndex={0}
            aria-label={label}
            aria-valuemin={geometry.t0}
            aria-valuemax={geometry.t1}
            aria-valuenow={cursor ?? geometry.t1}
            aria-valuetext={formatTime(cursor ?? geometry.t1)}
            onKeyDown={onKeyDown}
            onFocus={() => setCursor((current) => current ?? geometry.times.at(-1) ?? null)}
            onBlur={() => setCursor(null)}
            onMouseMove={(event) => setCursor(timeAt(event.clientX, event.currentTarget))}
            onMouseLeave={() => setCursor(null)}
            onClick={(event) => {
              const time = timeAt(event.clientX, event.currentTarget);
              if (time !== null) onPick(time);
            }}
          >
            <svg viewBox={`0 0 ${width} ${HEIGHT}`} aria-hidden="true">
              {geometry.priceTicks.map(({ y, label: text }) => (
                // Keyed by position: labels can repeat when rounded, positions are evenly spaced and distinct.
                <g key={y}>
                  <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={y} y2={y} />
                  <text className="axis" x={width - PAD.right + 8} y={y + 4}>
                    {text}
                  </text>
                </g>
              ))}
              {geometry.timeTicks.map(({ x, label: text, anchor }) => (
                <text key={x} className="axis" x={x} y={HEIGHT - 6} textAnchor={anchor}>
                  {text}
                </text>
              ))}
              {geometry.gaps.map(({ key, x, width: gapWidth }) => (
                <rect
                  key={key}
                  className="gap"
                  x={x}
                  width={gapWidth}
                  y={PAD.top}
                  height={HEIGHT - PAD.top - PAD.bottom}
                />
              ))}
              {geometry.paths.map(({ provider, color, d }) => (
                <path
                  key={provider}
                  className={focused !== null && focused !== provider ? 'series dimmed' : 'series'}
                  d={d}
                  stroke={color}
                />
              ))}
              {cursorX === null ? null : (
                <line className="cursor" x1={cursorX} x2={cursorX} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
              )}
              {readout.map(({ provider, color, t, v }) => (
                <circle key={provider} className="dot" cx={geometry.x(t)} cy={geometry.y(v)} r={4} fill={color} />
              ))}
            </svg>
          </div>
        ) : (
          <div className="empty">No records in this range yet.</div>
        )}
        {cursor !== null && cursorX !== null && readout.length > 0 ? (
          <div
            className="tooltip"
            aria-hidden="true"
            style={cursorX + 16 + TOOLTIP_WIDTH > width ? { right: width - cursorX + 16 } : { left: cursorX + 16 }}
          >
            <p className="tooltip-time">{formatTime(cursor)}</p>
            <table>
              <tbody>
                {readout.map(({ provider, color, t, price }) => (
                  <tr key={provider} className={focused === provider ? 'focused' : undefined}>
                    <td>
                      <span className="key" style={{ '--swatch': color } as CSSProperties} />
                    </td>
                    <td className="tooltip-value">{formatPrice(price)}</td>
                    <td className="tooltip-name">
                      {provider}
                      {t < cursor ? <span className="tooltip-age"> · {formatAge(cursor - t)} earlier</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {median !== null && readout.length > 1 ? (
              <p className="tooltip-median">
                <span>median</span> <strong>{formatPrice(median)}</strong>
              </p>
            ) : null}
            <p className="tooltip-hint">Click for the signed records</p>
          </div>
        ) : null}
      </div>
      <ul className="legend">
        {geometry?.paths.map(({ provider, color }) => (
          <li key={provider}>
            <button
              type="button"
              style={{ '--swatch': color } as CSSProperties}
              aria-pressed={pinned === provider}
              onMouseEnter={() => setHovered(provider)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(provider)}
              onBlur={() => setHovered(null)}
              onClick={() => setPinned((current) => (current === provider ? null : provider))}
            >
              {provider}
            </button>
          </li>
        ))}
        {geometry && geometry.gaps.length > 0 ? (
          <li className="gap-key">
            <span>archiver offline</span>
          </li>
        ) : null}
      </ul>
    </>
  );
}

function medianOf(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
