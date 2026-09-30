import type { GateMode, Permissions, PlanKind, PlanLimits } from '@fha/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type PlayerRefT } from '../api/endpoints';
import { ErrorNote } from '../components/ErrorNote';
import { Toggle } from '../components/Toggle';
import {
  PLAN_LABELS,
  limitsOf,
  modeOf,
  parseLimit,
  parseMinGain,
  toolEnabled,
} from './permissionsDiff';

type Edit = (fn: (draft: Permissions) => void) => void;

const MODES: GateMode[] = ['deny', 'ask', 'allow'];
const MODE_TONE: Record<GateMode, string> = {
  deny: 'bg-bad/20 text-bad border-bad/60',
  ask: 'bg-warn/20 text-warn border-warn/60',
  allow: 'bg-good/20 text-good border-good/60',
};

/** Limits that apply to each plan kind (the rest are meaningless for it). */
const LIMITS_FOR: Record<PlanKind, (keyof PlanLimits)[]> = {
  lineup: ['maxPerWeek'],
  addDrop: ['maxPerWeek'],
  waiverClaim: ['maxPerWeek', 'maxFaabPerClaimPct'],
  tradePropose: ['maxPerWeek', 'minTradeGain'],
  tradeRespond: ['maxPerWeek', 'minTradeGain'],
  draftPick: [],
};

const LIMIT_LABEL: Record<keyof PlanLimits, string> = {
  maxPerWeek: 'Max per week',
  maxFaabPerClaimPct: 'Max FAAB per claim (%)',
  minTradeGain: 'Min trade gain',
};

export function PlanRow({ kind, draft, edit }: { kind: PlanKind; draft: Permissions; edit: Edit }) {
  const mode = modeOf(draft, kind);
  const limits = limitsOf(draft, kind);
  const setMode = (m: GateMode) =>
    edit((d) => {
      d.plans[kind] = { mode: m, limits: d.plans[kind]?.limits ?? {} };
    });
  const setLimit = (key: keyof PlanLimits, raw: string) =>
    edit((d) => {
      const plan = (d.plans[kind] ??= { mode: 'deny', limits: {} });
      const value = parseLimit(key, raw);
      // Rebuilt rather than `delete`d: an empty field removes the limit.
      const rest = Object.fromEntries(Object.entries(plan.limits).filter(([k]) => k !== key));
      plan.limits = value === undefined ? rest : { ...rest, [key]: value };
    });

  return (
    <div className="border-b border-line py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{PLAN_LABELS[kind]}</span>
        <div
          className="flex overflow-hidden rounded-lg border border-line"
          role="radiogroup"
          aria-label={PLAN_LABELS[kind]}
        >
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={`border-l border-line px-3 py-1 text-xs capitalize first:border-l-0 ${mode === m ? MODE_TONE[m] : 'text-mut'}`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      {LIMITS_FOR[kind].length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-3">
          {LIMITS_FOR[kind].map((key) => (
            <label key={key} className="flex flex-col gap-0.5 text-xs text-mut">
              {LIMIT_LABEL[key]}
              <LimitInput
                value={limits[key]}
                scale={key === 'maxFaabPerClaimPct' ? 100 : 1}
                onCommit={(raw) => setLimit(key, raw)}
              />
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Auto-grab (D-016): act on a substantial upgrade the moment it appears, instead of waiting for
 * the 08:00 waivers run. Every grab still meets the rules above.
 */
export function AutoGrabSection({ draft, edit }: { draft: Permissions; edit: Edit }) {
  const a = draft.autoGrab;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold">Auto-grab</div>
          <div className="text-xs text-mut">
            {a.enabled
              ? 'When a free agent is back from injury, or another team drops a healthy player, and he is a big upgrade, act at once.'
              : 'Off: upgrades wait for the daily waivers run.'}
          </div>
        </div>
        <Toggle
          label="Auto-grab"
          on={a.enabled}
          onChange={(on) => edit((d) => void (d.autoGrab.enabled = on))}
        />
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-0.5 text-xs text-mut">
          Minimum gain (VORP, rest of season)
          <LimitInput
            value={a.minGain}
            scale={1}
            placeholder="1.5"
            onCommit={(raw) =>
              edit((d) => void (d.autoGrab.minGain = parseMinGain(raw, d.autoGrab.minGain)))
            }
          />
        </label>
        <label className="flex flex-col gap-0.5 text-xs text-mut">
          Max per week
          <LimitInput
            value={a.maxPerWeek}
            scale={1}
            onCommit={(raw) =>
              edit((d) => {
                const n = parseLimit('maxPerWeek', raw);
                if (n === undefined) delete d.autoGrab.maxPerWeek;
                else d.autoGrab.maxPerWeek = n;
              })
            }
          />
        </label>
      </div>
      <p className="text-xs text-mut">
        Gain is the player&rsquo;s value over the rest of the season minus the player dropped, both
        discounted for time out. The ordinary add bar is 0.5; using the week&rsquo;s last add needs
        twice the minimum.
      </p>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium">Act even while dry run is on</div>
          <div className="text-xs text-mut">
            {a.ignoreDryRun
              ? 'Free-agent grabs really execute on Yahoo, even in dry run.'
              : 'In dry run you get an urgent “Grab X now?” push and do it with one tap.'}{' '}
            Waiver claims are always yours to file in Yahoo.
          </div>
        </div>
        <Toggle
          label="Act even while dry run is on"
          on={a.ignoreDryRun}
          tone="warn"
          onChange={(on) => edit((d) => void (d.autoGrab.ignoreDryRun = on))}
        />
      </div>
    </div>
  );
}

/** Commits on blur so typing "1" on the way to "12" is not a change of its own. */
function LimitInput({
  value,
  scale,
  placeholder = 'no limit',
  onCommit,
}: {
  value: number | undefined;
  scale: number;
  placeholder?: string;
  onCommit: (raw: string) => void;
}) {
  const shown = value === undefined ? '' : String(Math.round(value * scale * 100) / 100);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  return (
    <input
      className="input w-28 py-1"
      inputMode="decimal"
      placeholder={placeholder}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(text)}
    />
  );
}

export function PlayerLists({
  draft,
  edit,
  nameOf,
  remember,
}: {
  draft: Permissions;
  edit: Edit;
  nameOf: (key: string) => PlayerRefT | undefined;
  remember: (p: PlayerRefT) => void;
}) {
  const add = (list: 'locked' | 'ask', p: PlayerRefT) => {
    remember(p);
    edit((d) => {
      if (!d.players[list].includes(p.playerKey)) d.players[list].push(p.playerKey);
    });
  };
  const remove = (list: 'locked' | 'ask', key: string) =>
    edit((d) => {
      d.players[list] = d.players[list].filter((k) => k !== key);
    });

  return (
    <div className="flex flex-col gap-3">
      {(['locked', 'ask'] as const).map((list) => (
        <div key={list}>
          <div className="text-sm font-medium">
            {list === 'locked'
              ? 'Locked — never dropped or traded away'
              : 'Always ask — any plan touching them needs approval'}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {draft.players[list].length === 0 ? (
              <span className="text-xs text-mut">Nobody.</span>
            ) : null}
            {draft.players[list].map((key) => {
              const p = nameOf(key);
              return (
                <span key={key} className="pill">
                  {p ? `${p.name} (${p.team} · ${p.positions})` : key}
                  <button
                    type="button"
                    className="ml-1 text-mut hover:text-bad"
                    aria-label={`Remove ${p?.name ?? key}`}
                    onClick={() => remove(list, key)}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      ))}
      <PlayerSearch onAdd={add} />
    </div>
  );
}

/** Shows candidates; nothing is added until an explicit tap on one of them (P3). */
function PlayerSearch({ onAdd }: { onAdd: (list: 'locked' | 'ask', p: PlayerRefT) => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);
  const search = useQuery({
    queryKey: ['playerSearch', debounced],
    queryFn: () => api.searchPlayers(debounced),
    enabled: debounced.length >= 2,
  });

  return (
    <div className="rounded-lg bg-well p-2">
      <input
        className="input"
        placeholder="Search players to lock or ask about…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {search.error ? <ErrorNote error={search.error} /> : null}
      {debounced.length >= 2 && search.data?.players.length === 0 ? (
        <p className="mt-2 text-xs text-mut">No matches.</p>
      ) : null}
      <div className="mt-1 flex flex-col">
        {search.data?.players.map((p) => (
          <div
            key={p.playerKey}
            className="flex items-center gap-2 border-b border-line py-1.5 text-sm last:border-b-0"
          >
            <span className="min-w-0 flex-1 truncate">
              {p.name}{' '}
              <span className="text-xs text-mut">
                {p.team} · {p.positions}
              </span>
            </span>
            <button
              type="button"
              className="btn px-2 py-1 text-xs"
              onClick={() => onAdd('locked', p)}
            >
              Lock
            </button>
            <button type="button" className="btn px-2 py-1 text-xs" onClick={() => onAdd('ask', p)}>
              Ask
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ToolSwitches({
  tools,
  draft,
  edit,
}: {
  tools: { name: string; description: string }[];
  draft: Permissions;
  edit: Edit;
}) {
  if (tools.length === 0)
    return <p className="text-sm text-mut">No propose tools reported by the server.</p>;
  return (
    <div className="flex flex-col">
      {tools.map((t) => (
        <div
          key={t.name}
          className="flex items-center gap-3 border-b border-line py-2 last:border-b-0"
        >
          <div className="min-w-0 flex-1">
            <div className="font-mono text-sm">{t.name}</div>
            <div className="text-xs text-mut">{t.description}</div>
          </div>
          <Toggle
            label={t.name}
            on={toolEnabled(draft, t.name)}
            onChange={(on) =>
              edit((d) => {
                d.tools[t.name] = on;
              })
            }
          />
        </div>
      ))}
    </div>
  );
}
