import type { CategoryT, PlayerCardT } from './api';
import { TONE_CLASS, fmtCat, signed, zBar, type Tone } from './helpers';

/** Small shared pieces of the card and the compare view. */

const BAR_BG: Record<Tone, string> = { up: 'bg-good', down: 'bg-bad', flat: 'bg-mut' };

export function ZBar({ z }: { z: number | null }) {
  const { pct, tone } = zBar(z);
  return (
    <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded bg-well">
      <i className={`block h-full ${BAR_BG[tone]}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** One category tile: total, z and the bar. A target category is outlined. */
export function CatTile({ c, target = false }: { c: CategoryT; target?: boolean }) {
  return (
    <div
      className={`rounded-lg border bg-raised px-2 py-1.5 ${target ? 'border-acc/70' : 'border-line'}`}
    >
      <div className="flex items-baseline justify-between gap-1 text-xs">
        <span className="text-mut">{c.cat}</span>
        <span className={`tabular-nums ${TONE_CLASS[zBar(c.z).tone]}`}>{signed(c.z)}z</span>
      </div>
      <div className="font-semibold tabular-nums">{fmtCat(c.cat, c.total)}</div>
      <ZBar z={c.z} />
    </div>
  );
}

const AVAIL_TONE = (p: number): string =>
  p >= 0.85
    ? 'border-good/50 text-good'
    : p >= 0.4
      ? 'border-warn/60 text-warn'
      : 'border-bad/60 text-bad';

export function AvailabilityBadge({ a }: { a: PlayerCardT['availability'] }) {
  return (
    <span className={`pill ${AVAIL_TONE(a.playProb)}`} title={a.note ?? undefined}>
      {a.source === 'healthy' ? 'healthy' : (a.status ?? a.label)}
      {a.expectedReturn ? ` · back ~${a.expectedReturn}` : ''}
    </span>
  );
}

export function OwnerBadge({ owner }: { owner: PlayerCardT['owner'] }) {
  const tone =
    owner.kind === 'us'
      ? 'border-acc/60 text-acc'
      : owner.kind === 'team'
        ? 'text-mut'
        : 'border-good/50 text-good';
  const text = owner.kind === 'us' ? 'our team' : owner.kind === 'team' ? owner.name : owner.name;
  return <span className={`pill ${tone}`}>{text}</span>;
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-well px-2 py-1" title={hint}>
      <div className="text-[11px] text-mut">{label}</div>
      <div className="font-semibold tabular-nums">{value}</div>
    </div>
  );
}
