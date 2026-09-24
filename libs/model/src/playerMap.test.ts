import { describe, expect, it } from 'vitest';
import { buildPlayerMap, type NhlPlayerLike, type YahooPlayerLike } from './playerMap.js';

const nhl: NhlPlayerLike[] = [
  { nhlId: 8478402, name: 'Connor McDavid', team: 'EDM', position: 'C' },
  { nhlId: 8476453, name: 'Nikita Kucherov', team: 'TBL', position: 'R' },
  { nhlId: 8480012, name: 'Elias Pettersson', team: 'VAN', position: 'C' },
  { nhlId: 8483678, name: 'Elias Pettersson', team: 'VAN', position: 'D' },
  { nhlId: 8478550, name: 'Sebastian Aho', team: 'CAR', position: 'C' },
  { nhlId: 8480222, name: 'Sebastian Aho', team: 'NYI', position: 'D' },
  { nhlId: 8482116, name: 'Tim Stützle', team: 'OTT', position: 'C' },
];
const y = (playerKey: string, name: string, team: string): YahooPlayerLike => ({
  playerKey,
  name,
  team,
});

describe('buildPlayerMap', () => {
  it('should map an exact name and team', () => {
    const r = buildPlayerMap([y('477.p.6743', 'Connor McDavid', 'EDM')], nhl);
    expect(r.mapped).toHaveLength(1);
    expect(r.byPlayerKey.get('477.p.6743')).toBe(8478402);
    expect(r.mapped[0]?.method).toBe('exact+team');
  });

  it('should still map an exact name when the team disagrees, because players get traded', () => {
    const r = buildPlayerMap([y('477.p.1', 'Nikita Kucherov', 'FLA')], nhl);
    expect(r.byPlayerKey.get('477.p.1')).toBe(8476453);
    expect(r.mapped[0]?.method).toBe('exact');
  });

  it('should break a same-name tie using the team', () => {
    const r = buildPlayerMap([y('477.p.2', 'Sebastian Aho', 'NYI')], nhl);
    expect(r.byPlayerKey.get('477.p.2')).toBe(8480222);
    expect(r.unmapped).toHaveLength(0);
  });

  it('should leave two players sharing a name AND a team unmapped rather than guessing', () => {
    const r = buildPlayerMap([y('477.p.3', 'Elias Pettersson', 'VAN')], nhl);
    expect(r.mapped).toHaveLength(0);
    expect(r.unmapped[0]?.reason).toBe('ambiguous');
    // The report must name both, so a human can resolve it via overrides.
    expect(r.unmapped[0]?.candidates).toHaveLength(2);
  });

  it('should resolve an ambiguous pair from an override', () => {
    const r = buildPlayerMap([y('477.p.3', 'Elias Pettersson', 'VAN')], nhl, {
      '477.p.3': 8483678,
    });
    expect(r.byPlayerKey.get('477.p.3')).toBe(8483678);
    expect(r.mapped[0]?.method).toBe('override');
    expect(r.unmapped).toHaveLength(0);
  });

  it('should ignore an override pointing at an NHL id that does not exist', () => {
    const r = buildPlayerMap([y('477.p.1', 'Connor McDavid', 'EDM')], nhl, { '477.p.1': 999 });
    expect(r.byPlayerKey.get('477.p.1')).toBe(8478402);
  });

  it('should match a diacritic name written in plain ASCII', () => {
    const r = buildPlayerMap([y('477.p.4', 'Tim Stutzle', 'OTT')], nhl);
    expect(r.byPlayerKey.get('477.p.4')).toBe(8482116);
  });

  it('should leave an unknown player unmapped with suggestions', () => {
    const r = buildPlayerMap([y('477.p.5', 'Wayne Gretzky', 'EDM')], nhl);
    expect(r.mapped).toHaveLength(0);
    expect(r.unmapped[0]?.reason).toBe('noMatch');
    expect(r.unmapped[0]?.candidates.length).toBeGreaterThan(0);
  });

  it('should refuse a fuzzy match whose team disagrees', () => {
    // A near-miss name on the wrong team is far more likely a different player.
    const r = buildPlayerMap([y('477.p.6', 'Conor McDavid', 'FLA')], nhl);
    expect(r.mapped).toHaveLength(0);
    expect(r.unmapped[0]?.reason).toBe('teamMismatch');
  });

  it('should accept a fuzzy match when the team agrees', () => {
    const r = buildPlayerMap([y('477.p.7', 'Conor McDavid', 'EDM')], nhl);
    expect(r.byPlayerKey.get('477.p.7')).toBe(8478402);
    expect(r.mapped[0]?.method).toBe('fuzzy+team');
  });

  it('should provide a reverse index for draft-result lookups', () => {
    const r = buildPlayerMap([y('477.p.6743', 'Connor McDavid', 'EDM')], nhl);
    expect(r.byNhlId.get(8478402)).toBe('477.p.6743');
  });
});
