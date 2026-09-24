/**
 * Yahoo draft-room protocol, as a pure state machine.
 *
 * Extracted from the socket client so it can be tested against the frame sequences actually
 * captured in mock drafts (see docs/investigations/2026-09-24-yahoo-writes-and-draft-room.md).
 * The socket client owns I/O; everything that decides anything lives here.
 */

export interface Pick {
  pick: number;
  round: number;
  teamKey: string;
  playerKey: string;
}

export interface DraftBoard {
  picks: Map<number, Pick>;
  pickOrder?: string[];
  onClock?: { pick: number; teamId: string; secs: number };
  secsPerPick?: number;
  autopickOn: Set<string>;
}

export interface ProtocolConfig {
  leagueKey: string;
  teamId: string;
  numTeams: number;
}

/** What the caller should do after a frame. Deciding is separate from doing. */
export type Effect =
  | { type: 'none' }
  | { type: 'log'; message: string }
  | { type: 'boardChanged' }
  /** We are on the clock: ask for a recommendation and possibly submit. */
  | { type: 'ourTurn'; pick: number; secs: number }
  /** The server forced us into autopick; it should be turned back off. */
  | { type: 'autopickForcedOn' };

export function emptyBoard(): DraftBoard {
  return { picks: new Map(), autopickOn: new Set() };
}

export function newPick(
  cfg: ProtocolConfig,
  pick: number,
  playerId: string,
  teamId: string,
): Pick {
  const gameKey = cfg.leagueKey.split('.')[0] ?? '';
  return {
    pick,
    round: Math.max(1, Math.ceil(pick / cfg.numTeams)),
    teamKey: `${cfg.leagueKey}.t.${teamId}`,
    playerKey: `${gameKey}.p.${playerId}`,
  };
}

/**
 * Apply one frame to the board and report what it implies.
 *
 * Unknown frames are reported, never guessed at: the protocol is only partly decoded, and
 * silently ignoring a frame we do not understand is how a client misses a state change.
 */
export function applyFrame(board: DraftBoard, cfg: ProtocolConfig, raw: string): Effect {
  const fields = raw.split('|');
  const kind = fields[0];

  switch (kind) {
    case 'C':
      // Clock tick, once a second. Deliberately silent.
      return { type: 'none' };

    case 'H': {
      const secs = Number(fields[2]);
      if (Number.isFinite(secs)) board.secsPerPick = secs;
      return { type: 'log', message: `header: ${fields[2]}s per pick` };
    }

    case 'R': {
      const order = fields.slice(1).filter((f) => f !== '');
      if (order.length === 0) return { type: 'none' };
      board.pickOrder = order;
      const seat = order.indexOf(cfg.teamId) + 1;
      return {
        type: 'log',
        message: `pick order: ${order.length} entries; team ${cfg.teamId} is seat ${seat || '?'}`,
      };
    }

    case 'P': {
      // Whole board replayed in one frame on join.
      let added = 0;
      for (const entry of fields.slice(1)) {
        const [pickStr, rest] = entry.split('=');
        const parts = rest?.split(',') ?? [];
        const playerId = parts[0];
        const teamId = parts[1];
        const pick = Number(pickStr);
        if (playerId && teamId && Number.isInteger(pick) && pick > 0) {
          board.picks.set(pick, newPick(cfg, pick, playerId, teamId));
          added++;
        }
      }
      return added > 0 ? { type: 'boardChanged' } : { type: 'none' };
    }

    case '0': {
      // A pick was made. Five or more fields distinguishes it from other 0-prefixed frames.
      if (fields.length < 5) return { type: 'log', message: `unparsed 0-frame: ${raw}` };
      const pick = Number(fields[1]);
      const playerId = fields[2];
      const teamId = fields[3];
      if (!playerId || !teamId || !Number.isInteger(pick)) {
        return { type: 'log', message: `unparsed 0-frame: ${raw}` };
      }
      board.picks.set(pick, newPick(cfg, pick, playerId, teamId));
      return { type: 'boardChanged' };
    }

    case 'D': {
      const pick = Number(fields[1]);
      const teamId = fields[2] ?? '';
      const secs = Number(fields[3] ?? 0);
      if (!Number.isInteger(pick)) return { type: 'log', message: `unparsed D-frame: ${raw}` };
      board.onClock = { pick, teamId, secs };
      return teamId === cfg.teamId
        ? { type: 'ourTurn', pick, secs }
        : { type: 'boardChanged' };
    }

    case '5': {
      // Autopick on. Sent by the server after a missed pick, and echoed when requested.
      const teamId = fields[1] ?? '';
      if (fields.length !== 2) return { type: 'log', message: `unparsed 5-frame: ${raw}` };
      board.autopickOn.add(teamId);
      return teamId === cfg.teamId
        ? { type: 'autopickForcedOn' }
        : { type: 'log', message: `autopick on for team ${teamId}` };
    }

    case '6': {
      const teamId = fields[1] ?? '';
      if (fields.length !== 2) return { type: 'log', message: `unparsed 6-frame: ${raw}` };
      board.autopickOn.delete(teamId);
      return { type: 'log', message: `autopick off for team ${teamId}` };
    }

    case 'X':
      return { type: 'log', message: `server rejected a request: code ${fields[1]}` };

    default:
      return { type: 'log', message: `unrecognised frame: ${raw.slice(0, 160)}` };
  }
}

/** Our own seat, from Yahoo's order. Undefined when the order has not arrived. */
export function ourSeat(board: DraftBoard, cfg: ProtocolConfig): number | undefined {
  if (!board.pickOrder) return undefined;
  const seat = board.pickOrder.indexOf(cfg.teamId) + 1;
  return seat > 0 ? seat : undefined;
}
