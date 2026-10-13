import { useParamSheet } from '../players/sheet';

/** `?team=<teamKey>` on any page: a team's sheet over it (a team name tapped in chat). */
export const TEAM_PARAM = 'team';

export function useTeamSheet() {
  return useParamSheet(TEAM_PARAM);
}
