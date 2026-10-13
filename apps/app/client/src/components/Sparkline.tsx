import { sparkPath } from './sparkline';

/**
 * A small line of recent values (inline SVG, colours from role tokens via `currentColor`), with
 * a dashed line at the baseline it is compared against. Purely visual: the numbers beside it
 * carry the meaning, and the accessible label states them.
 */
export function Sparkline({
  points,
  baseline,
  label,
  width = 96,
  height = 24,
}: {
  points: readonly number[];
  baseline: number;
  label: string;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return <span className="text-2xs text-mut">—</span>;
  const { line, base } = sparkPath(points, baseline, width, height);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      <line
        x1={0}
        x2={width}
        y1={base}
        y2={base}
        className="text-mut"
        stroke="currentColor"
        strokeDasharray="2 3"
        strokeWidth={1}
      />
      <polyline
        points={line}
        fill="none"
        className="text-acc"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
