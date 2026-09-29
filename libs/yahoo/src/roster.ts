import type { Roster } from '@fha/core';
import { YahooShapeError } from './errors.js';
import { parsePlayer, type PlayerDetail } from './players.js';
import { content, flag, obj, optObj, reqStr, str, unwrap } from './raw.js';

/**
 * A team's roster on a date, as the domain `Roster` plus per-player detail.
 *
 * Every entry must carry a selected position: a roster whose slots we cannot read is not a
 * roster we can reason about, so a missing slot is a shape error rather than a guessed 'BN'.
 */
export interface RosterRead {
  roster: Roster;
  details: Map<string, PlayerDetail>;
  editable: boolean;
}

export function parseRoster(body: unknown, fallbackDate: string): RosterRead {
  const team = obj(content(body).team, 'team');
  const r = optObj(team.roster);
  // `/roster/players;out=…` nests players under roster; tolerate a flat `team.players` too.
  const list = r?.players ?? team.players;
  const details = new Map<string, PlayerDetail>();
  const entries = unwrap(list, 'player').map((raw) => {
    const { player, detail } = parsePlayer(raw);
    const slot = detail.selectedPosition;
    if (slot === undefined) {
      throw new YahooShapeError(`roster entry ${player.playerKey} has no selected_position`);
    }
    details.set(player.playerKey, detail);
    return { player, slot };
  });
  return {
    roster: {
      teamKey: reqStr(team.team_key, 'team.team_key'),
      date: str(r?.date) ?? fallbackDate,
      entries,
    },
    details,
    editable: flag(r?.is_editable),
  };
}
