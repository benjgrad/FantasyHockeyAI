/**
 * Lineup lock (§12.4). The league locks intraday ("Daily - Today", U-09): each player locks
 * at his own game's `startTimeUTC`. A player with no game that date never locks.
 */

/**
 * True once the game has started (`now >= gameStartUtc`). With no game, false.
 * An unparseable start time counts as locked: not moving a player is the least
 * destructive reading (P5).
 */
export function isLocked(gameStartUtc: string | Date | undefined | null, now: Date): boolean {
  if (gameStartUtc === undefined || gameStartUtc === null) return false;
  const start = gameStartUtc instanceof Date ? gameStartUtc.getTime() : Date.parse(gameStartUtc);
  if (Number.isNaN(start)) return true;
  return now.getTime() >= start;
}

/** The player keys whose game has started, for the solver's `locked` flag. */
export function lockedPlayers(
  players: readonly { playerKey: string; gameStartUtc?: string | Date | undefined | null }[],
  now: Date,
): Set<string> {
  return new Set(players.filter((p) => isLocked(p.gameStartUtc, now)).map((p) => p.playerKey));
}
