/** Placeholder rows shaped like the list that is loading, so the page never sits blank. */
export function SkeletonRows({ rows = 6, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <section className="card p-0" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-line px-3 py-3 last:border-b-0"
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-2/5 animate-pulse rounded bg-well" />
            <div className="h-2.5 w-3/5 animate-pulse rounded bg-well" />
          </div>
          <div className="h-6 w-12 animate-pulse rounded bg-well" />
        </div>
      ))}
    </section>
  );
}
