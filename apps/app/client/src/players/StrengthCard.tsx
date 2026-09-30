import { useQuery } from '@tanstack/react-query';
import { ErrorNote } from '../components/ErrorNote';
import { playersApi, type StrengthT } from './api';
import { strengthBar } from './helpers';

/**
 * Category strength, weakest first: the draft board panel Ben used most, because it says what
 * to target. Each bar is our roster's summed z (injuries discounted), with our league rank.
 */
const LABEL_TONE: Record<StrengthT['categories'][number]['label'], string> = {
  weak: 'text-bad',
  average: 'text-warn',
  strong: 'text-good',
  saturated: 'text-acc',
};

export function StrengthCard() {
  const s = useQuery({ queryKey: ['strength'], queryFn: playersApi.strength, staleTime: 60_000 });
  if (s.error) return <ErrorNote error={s.error} />;
  if (!s.data) return null;
  const { categories, targets } = s.data;
  return (
    <section className="card p-0">
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
        <span className="tag mr-1">Category strength · weakest first</span>
        <span className="text-xs text-mut">targeting:</span>
        {targets.map((t) => (
          <span key={t} className="pill border-acc/70 text-acc">
            {t}
          </span>
        ))}
      </div>
      {categories.map((c) => {
        const bar = strengthBar(c.z);
        return (
          <div
            key={c.cat}
            className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-sm last:border-b-0"
          >
            <span className="w-10 shrink-0">{c.cat}</span>
            <div className="relative h-2 flex-1 rounded bg-well">
              <span className="absolute inset-y-0 left-1/2 w-px bg-line" />
              <i
                className={`absolute inset-y-0 rounded ${c.z >= 0 ? 'bg-good' : 'bg-bad'}`}
                style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
              />
            </div>
            <span className="w-12 text-right text-xs tabular-nums">
              {c.z >= 0 ? '+' : ''}
              {c.z.toFixed(1)}
            </span>
            <span className={`w-16 text-right text-xs ${LABEL_TONE[c.label]}`}>
              {ordinal(c.rank)} · {c.label}
            </span>
            <span className="hidden w-12 text-right text-xs text-mut sm:inline">
              {c.winProb === null ? '' : `${Math.round(c.winProb * 100)}% wk`}
            </span>
          </div>
        );
      })}
    </section>
  );
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}
