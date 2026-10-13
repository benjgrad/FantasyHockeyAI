import type { AnyToolSpec, ToolContext, ToolResult } from '@fha/llm';
import type { ToolNote } from './assistantHistory.js';

/**
 * Short, stored notes of the tools a run called: what it was asked and what it got back, as the
 * chat shows them. Shared by the chat assistant and (D-027) the background agents, whose runs
 * are recorded in the Background activity conversation.
 */

/**
 * The short result kept with the conversation. A result that opens with a heading or a table's
 * header row ("Our roster on …:", "playerKey | player | …") keeps its first real line too and
 * says how much more there was; the first line alone looked like "no result" (2026-10-01).
 */
export function brief(text: string | undefined): string | undefined {
  const lines = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const first = lines[0];
  if (first === undefined) return undefined;
  const heading = lines.length > 1 && (first.endsWith(':') || first.includes(' | '));
  // "Searched …:" then a table: skip the table's header row to its first real row.
  const headerRow = heading && first.endsWith(':') && (lines[1] ?? '').includes(' | ');
  const row = headerRow && lines.length > 2 ? 2 : 1;
  const kept = heading ? `${first} ${lines[row] ?? ''}` : first;
  const rest = lines.length - (heading ? row + 1 : 1);
  const more = rest > 0 ? ` (+${rest} more)` : '';
  const cap = 240 - more.length;
  return `${kept.length > cap ? `${kept.slice(0, cap - 3)}...` : kept}${more}`;
}

/** The model's arguments as `key: value` lines (arrays joined), capped. */
export function describeInput(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const lines = Object.entries(input as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const text =
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
          ? String(v)
          : Array.isArray(v) && v.every((x) => typeof x !== 'object')
            ? v.join(', ')
            : JSON.stringify(v);
      return `${k}: ${text}`;
    });
  const out = lines.join('\n');
  if (out === '') return undefined;
  return out.length > 800 ? `${out.slice(0, 797)}...` : out;
}

/** Wrap a tool so each call adds a note; changes nothing about the tool, rethrows its errors. */
export function noting<C>(tool: AnyToolSpec<C>, push: (n: ToolNote) => void): AnyToolSpec<C> {
  return {
    ...tool,
    async execute(input: unknown, ctx: ToolContext<C>) {
      const asked = brief(describeInput(input)?.replace(/\n/g, ' · '));
      const note = (ok: boolean, text: string | undefined) => {
        const detail = brief(text);
        push({
          name: tool.name,
          ok,
          ...(detail === undefined ? {} : { detail }),
          ...(asked === undefined ? {} : { input: asked }),
        });
      };
      let r: ToolResult<unknown>;
      try {
        r = await tool.execute(input, ctx);
      } catch (err) {
        note(false, err instanceof Error ? err.message : String(err));
        throw err;
      }
      note(r.ok, r.ok ? r.summary : r.error);
      return r;
    },
  };
}
