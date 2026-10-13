/**
 * The narrative explainer.
 *
 * **The model does not decide anything here.** The pick has already been made by the
 * deterministic board — need, scarcity, category fit, slot urgency — and this is handed the
 * finished decision and asked only to put it into words, including why the runners-up lost.
 * That is P1 of the project's design principles: the LLM handles what is genuinely fuzzy
 * (explaining a trade-off in prose), never what is arithmetic.
 *
 * It is also entirely optional. With no API key, a failed call, a timeout or a truncated
 * response, the board falls back to the deterministic one-line reasons it already shows and
 * nothing is blocked (P5, P9).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { PlayerCard } from './state.js';

export type NarrativeStatus = 'off' | 'idle' | 'generating' | 'ready' | 'failed';

export interface Narrative {
  status: NarrativeStatus;
  text?: string;
  detail?: string;
}

// Short prose about a pick the board already made: Haiku is enough (D-023). Override per run.
const MODEL = process.env.FHA_EXPLAIN_MODEL ?? 'claude-haiku-4-5';
/** Haiku 4.5 takes no effort setting (a 400); the 5.x models take it. */
const takesEffort = (model: string) => !model.startsWith('claude-haiku');
const TIMEOUT_MS = 25_000;

/** The one call we make. Injectable so the request shape and response handling can be tested. */
export type CreateMessage = (
  body: Anthropic.MessageCreateParamsNonStreaming,
  options?: { timeout?: number },
) => Promise<Anthropic.Message>;

const sdk = process.env.ANTHROPIC_API_KEY ? new Anthropic() : undefined;
const defaultCreate: CreateMessage | undefined = sdk
  ? (body, options) => sdk.messages.create(body, options)
  : undefined;

export const explainerEnabled = (): boolean => defaultCreate !== undefined;

/** One entry per pick: the explanation is generated once and reused until the pick changes. */
const cache = new Map<string, Narrative>();
const inFlight = new Set<string>();

export function buildPrompt(
  pick: number,
  rec: PlayerCard,
  alts: PlayerCard[],
  context: { openSlots: string[]; weakest: { cat: string; z: number }[]; roster: string[] },
): string {
  return [
    `Pick ${pick}.`,
    `Our roster so far: ${context.roster.length > 0 ? context.roster.join(', ') : 'empty'}.`,
    `Open starting slots: ${context.openSlots.length > 0 ? context.openSlots.join(', ') : 'none'}.`,
    `Categories we are weakest in: ${context.weakest.map((w) => `${w.cat} ${w.z}`).join(', ')}.`,
    '',
    `THE PICK${rec.isOverride === true ? ' (a human override, not the model\u2019s choice)' : ''}:`,
    describe(rec),
    '',
    'CLOSEST ALTERNATIVES NOT TAKEN:',
    ...alts.slice(0, 3).map(describe),
  ].join('\n');
}

export function cacheKey(pick: number, rec: PlayerCard): string {
  return `${pick}:${rec.nhlId}:${rec.isOverride === true ? 'ov' : 'model'}`;
}

function describe(p: PlayerCard): string {
  const cats = p.cats
    .slice(0, 4)
    .map((c) => {
      const stat = p.stats.find((s) => s.cat === c.cat);
      return `${c.cat} ${stat ? stat.total : '?'} (${c.z >= 0 ? '+' : ''}${c.z}z)`;
    })
    .join(', ');
  const weak = p.cats
    .slice(-2)
    .map((c) => `${c.cat} ${c.z >= 0 ? '+' : ''}${c.z}z`)
    .join(', ');
  return [
    `${p.name} (${p.position}, ${p.team})`,
    `  score ${p.score} = need ${p.need}x on vorp ${p.vorp}, category fit ${p.fit}, urgency ${p.urgency}`,
    `  projected: ${cats}`,
    `  weakest: ${weak}`,
    p.adp === undefined ? '' : `  market ADP ${p.adp}`,
    p.lowConfidence ? '  FLAG: thin data, projection unreliable' : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export const SYSTEM = `You explain fantasy hockey draft picks that have ALREADY been made by a deterministic model. You never choose or second-guess the pick; you explain the one given.

The league is 8-team head-to-head categories scoring: G, A, +/-, PIM, PPP, SHP, GWG, SOG, HIT for skaters and W, GAA (lower better), SV%, SHO for goalies. A category is WON, not accumulated, so a roster that is far ahead in one category is wasting value.

How the score is built:
- vorp: value over a replacement starter at the player's scarcest eligible position
- need: 1.0 if he fills an open starting slot, lower if only bench/Util
- fit: whether his strengths land on categories the roster is currently LOSING (positive) or already winning (negative)
- urgency: pressure to fill remaining starting slots before the picks run out

Write 2 to 4 sentences of plain prose for the manager:
1. Why this player, in terms of what the roster actually needs right now.
2. Why the closest one or two alternatives lost — name them and be concrete about the trade-off.
Reference real numbers where they carry the argument. No headings, no bullet points, no preamble. Never suggest a different pick. If the pick was a human override, explain what it trades away versus the model's choice rather than arguing against it.`;

export async function generate(
  pick: number,
  rec: PlayerCard,
  alts: PlayerCard[],
  context: { openSlots: string[]; weakest: { cat: string; z: number }[]; roster: string[] },
  create: CreateMessage | undefined = defaultCreate,
): Promise<Narrative> {
  if (!create) return { status: 'off' };
  const user = buildPrompt(pick, rec, alts, context);

  const res = await create(
    {
      model: MODEL,
      // Thinking counts against max_tokens on Opus 5; 400 truncated explanations on draft night.
      max_tokens: 2000,
      // Low effort where the model has it: a short piece of prose about a decision already
      // made, not a problem to reason through, and it runs against a draft clock.
      ...(takesEffort(MODEL) ? { output_config: { effort: 'low' as const } } : {}),
      system: SYSTEM,
      messages: [{ role: 'user', content: user }],
    },
    { timeout: TIMEOUT_MS },
  );

  // A truncated answer is a failure, not a short one (P6).
  if (res.stop_reason === 'max_tokens') {
    return { status: 'failed', detail: 'response truncated' };
  }
  if (res.stop_reason === 'refusal') {
    return { status: 'failed', detail: 'model declined' };
  }
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return text === '' ? { status: 'failed', detail: 'empty response' } : { status: 'ready', text };
}

/**
 * Non-blocking: returns whatever is known now and starts generation in the background.
 *
 * The board is polled every few seconds, so the explanation appears on a later poll rather
 * than delaying the pick that the manager needs to see immediately.
 */
export function narrativeFor(
  pick: number,
  rec: PlayerCard,
  alts: PlayerCard[],
  context: { openSlots: string[]; weakest: { cat: string; z: number }[]; roster: string[] },
): Narrative {
  if (!defaultCreate) return { status: 'off' };
  const key = cacheKey(pick, rec);
  const known = cache.get(key);
  if (known) return known;
  if (inFlight.has(key)) return { status: 'generating' };

  inFlight.add(key);
  void generate(pick, rec, alts, context)
    .then((n) => {
      cache.set(key, n);
      console.log(`  narrative ${key}: ${n.status}${n.detail ? ` (${n.detail})` : ''}`);
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      cache.set(key, { status: 'failed', detail });
      console.log(`  narrative ${key} failed: ${detail}`);
    })
    .finally(() => inFlight.delete(key));

  return { status: 'generating' };
}
