/**
 * Yahoo failure modes, each with a name (P6), because the right response differs per kind.
 *
 * An auth failure means the stored session is dead: retrying cannot help and the UI must ask
 * the user to reconnect. A throttle means back off. Anything else is an HTTP error to log.
 */
export class YahooAuthError extends Error {
  /** Stable code the UI keys on to show "reconnect Yahoo" rather than a generic failure. */
  readonly code = 'yahoo_reconnect_required' as const;
  override readonly name = 'YahooAuthError';
}

export class YahooThrottledError extends Error {
  override readonly name = 'YahooThrottledError';
}

export class YahooHttpError extends Error {
  override readonly name = 'YahooHttpError';
  constructor(
    readonly status: number,
    readonly path: string,
    readonly bodySnippet: string,
  ) {
    super(`Yahoo ${status} for ${path}: ${bodySnippet}`);
  }
}

/** A response that parsed as JSON but not into the shape we rely on. */
export class YahooShapeError extends Error {
  override readonly name = 'YahooShapeError';
}
