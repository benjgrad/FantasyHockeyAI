import { describe, expect, it } from 'vitest';
import { MarketParseError, parseConsensusTable } from './consensus.js';

const table = (rows: string) => `<html><body><table>${rows}</table></body></html>`;
const HEADER =
  '<tr><th>Rank</th><th>Player</th><th>Team</th><th>Pos</th><th>Brock</th><th>Avg Rank</th><th>ADP</th><th>Diff.</th></tr>';

describe('parseConsensusTable', () => {
  it('should parse rank, name, team, positions and ADP', () => {
    const snap = parseConsensusTable(
      table(
        `${HEADER}<tr><td>1</td><td>Nathan MacKinnon</td><td>COL</td><td>C</td><td>1</td><td>1.2</td><td>2.1</td><td>0.9</td></tr>`,
      ),
      'test',
    );
    expect(snap.players).toHaveLength(1);
    expect(snap.players[0]).toMatchObject({
      rank: 1,
      name: 'Nathan MacKinnon',
      team: 'COL',
      positions: ['C'],
      adp: 2.1,
    });
  });

  it('should split multi-position eligibility', () => {
    const snap = parseConsensusTable(
      table(
        `${HEADER}<tr><td>5</td><td>Leon Draisaitl</td><td>EDM</td><td>C,LW</td><td>5</td><td>5.0</td><td>5.8</td><td>0.8</td></tr>`,
      ),
      'test',
    );
    expect(snap.players[0]?.positions).toEqual(['C', 'LW']);
  });

  it('should treat a dash ADP as absent rather than zero', () => {
    const snap = parseConsensusTable(
      table(
        `${HEADER}<tr><td>200</td><td>Anton Forsberg</td><td>LAK</td><td>G</td><td>201</td><td>204.5</td><td>–</td><td>17</td></tr>`,
      ),
      'test',
    );
    expect(snap.players[0]?.adp).toBeUndefined();
  });

  it('should resolve columns from the header, not by position', () => {
    // ADP moved before Pos: a positional assumption would read the wrong field.
    const header = '<tr><th>Rank</th><th>Player</th><th>ADP</th><th>Team</th><th>Pos</th></tr>';
    const snap = parseConsensusTable(
      table(`${header}<tr><td>7</td><td>Cale Makar</td><td>6.4</td><td>COL</td><td>D</td></tr>`),
      'test',
    );
    expect(snap.players[0]).toMatchObject({ team: 'COL', positions: ['D'], adp: 6.4 });
  });

  it('should skip rows that are not player rows', () => {
    const snap = parseConsensusTable(
      table(
        `${HEADER}<tr><td colspan="8">Tier 2</td></tr><tr><td>2</td><td>Connor McDavid</td><td>EDM</td><td>C</td><td>2</td><td>1.8</td><td>1.5</td><td>-0.3</td></tr>`,
      ),
      'test',
    );
    expect(snap.players).toHaveLength(1);
    expect(snap.players[0]?.name).toBe('Connor McDavid');
  });

  it('should decode HTML entities in names', () => {
    const snap = parseConsensusTable(
      table(
        `${HEADER}<tr><td>49</td><td>Tim St&#252;tzle</td><td>OTT</td><td>C</td><td>49</td><td>49</td><td>50</td><td>1</td></tr>`,
      ),
      'test',
    );
    expect(snap.players[0]?.name).toBe('Tim Stützle');
  });

  it('should throw when there are no rows at all', () => {
    expect(() => parseConsensusTable('<html></html>', 'test')).toThrow(MarketParseError);
  });

  it('should throw when the header lacks a required column', () => {
    const header = '<tr><th>Rank</th><th>Player</th><th>ADP</th></tr>';
    expect(() =>
      parseConsensusTable(table(`${header}<tr><td>1</td><td>X</td><td>2</td></tr>`), 'test'),
    ).toThrow(/missing required column: Team/);
  });

  it('should throw rather than return an empty list when no rows match', () => {
    expect(() => parseConsensusTable(table(HEADER), 'test')).toThrow(/no player rows/);
  });
});
