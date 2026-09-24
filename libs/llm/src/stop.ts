/**
 * Every API stop reason gets a name (P6).
 *
 * The bundled reference documents six. The SDK's type (0.128) also lists
 * `model_context_window_exceeded`, so it is named here as a failure too. Anything else — a value
 * added after this was written — becomes `unknown_stop`, a failure, rather than falling through
 * to whatever branch happens to be the default.
 */
export type ApiStop =
  | 'end_turn'
  | 'tool_use'
  | 'pause_turn'
  | 'stop_sequence'
  | 'max_tokens'
  | 'refusal'
  | 'context_window_exceeded'
  | 'unknown_stop';

export function classifyStop(raw: string | null | undefined): ApiStop {
  switch (raw) {
    case 'end_turn':
    case 'tool_use':
    case 'pause_turn':
    case 'stop_sequence':
    case 'max_tokens':
    case 'refusal':
      return raw;
    case 'model_context_window_exceeded':
      return 'context_window_exceeded';
    default:
      return 'unknown_stop';
  }
}
