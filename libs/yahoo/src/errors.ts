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
  constructor(
    message: string,
    /**
     * `consent`: the session is fine but Yahoo's website sends every page to its consent screen
     * (guce.yahoo.com) until it is accepted in a browser, seen 2026-10-17. Only Ben can accept
     * Yahoo's terms, so it is handled like an expiry: pause, push, reconnect.
     */
    readonly reason: 'session' | 'consent' = 'session',
  ) {
    super(message);
  }
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

/**
 * A write whose endpoint has never been observed (U-12). Thrown instead of guessing a URL or a
 * form field: an adapter built on a guess would look implemented and fail silently (§24.11).
 */
export class NotObservedError extends Error {
  override readonly name = 'NotObservedError';
}

/** Yahoo's add/drop page did not have the form we observed, or it named the wrong team (P8). */
export class YahooFormError extends Error {
  override readonly name = 'YahooFormError';
}

/**
 * The POST was (or may have been) sent, then something failed. Whether Yahoo applied it is
 * unknown, so this is never retried (P7): the caller verifies by re-reading the roster.
 */
export class WriteOutcomeUnknownError extends Error {
  override readonly name = 'WriteOutcomeUnknownError';
}
