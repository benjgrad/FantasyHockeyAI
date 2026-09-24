import { describe, expect, it } from 'vitest';
import {
  applyFrame,
  emptyBoard,
  ourSeat,
  type DraftBoard,
  type ProtocolConfig,
} from '../tools/draft-protocol.js';

const cfg: ProtocolConfig = { leagueKey: '477.l.48535', teamId: '6', numTeams: 8 };
const feed = (board: DraftBoard, frames: string[]) => frames.map((f) => applyFrame(board, cfg, f));

describe('applyFrame', () => {
  it('should stay silent on a clock tick', () => {
    expect(applyFrame(emptyBoard(), cfg, 'C|42')).toEqual({ type: 'none' });
  });

  it('should record seconds per pick from the header', () => {
    const b = emptyBoard();
    applyFrame(b, cfg, 'H|S|90|0|0|1');
    expect(b.secsPerPick).toBe(90);
  });

  it('should replay the whole board from a single P frame', () => {
    const b = emptyBoard();
    const effect = applyFrame(b, cfg, 'P|1=5980,1,0|2=5425,2,0|3=6743,3,0');
    expect(effect).toEqual({ type: 'boardChanged' });
    expect(b.picks.size).toBe(3);
    expect(b.picks.get(2)).toEqual({
      pick: 2,
      round: 1,
      teamKey: '477.l.48535.t.2',
      playerKey: '477.p.5425',
    });
  });

  it('should compute the round from the pick number and team count', () => {
    const b = emptyBoard();
    applyFrame(b, cfg, 'P|9=1,1,0|17=2,1,0');
    expect(b.picks.get(9)?.round).toBe(2);
    expect(b.picks.get(17)?.round).toBe(3);
  });

  it('should record a pick from a 0 frame', () => {
    const b = emptyBoard();
    // Captured shape: 0|{pick}|{playerId}|{teamId}|{pos}|0
    expect(applyFrame(b, cfg, '0|6|7908|6|D|0')).toEqual({ type: 'boardChanged' });
    expect(b.picks.get(6)?.playerKey).toBe('477.p.7908');
    expect(b.picks.get(6)?.teamKey).toBe('477.l.48535.t.6');
  });

  it('should raise ourTurn only when the clock is on our team', () => {
    const b = emptyBoard();
    expect(applyFrame(b, cfg, 'D|13|6|90')).toEqual({ type: 'ourTurn', pick: 13, secs: 90 });
    expect(applyFrame(b, cfg, 'D|14|7|90')).toEqual({ type: 'boardChanged' });
  });

  it('should treat a server-forced autopick on our team as something to undo', () => {
    const b = emptyBoard();
    expect(applyFrame(b, cfg, '5|6')).toEqual({ type: 'autopickForcedOn' });
    expect(b.autopickOn.has('6')).toBe(true);
  });

  it('should only log autopick on another team', () => {
    const b = emptyBoard();
    const e = applyFrame(b, cfg, '5|3');
    expect(e.type).toBe('log');
    expect(b.autopickOn.has('3')).toBe(true);
  });

  it('should clear autopick on a 6 frame', () => {
    const b = emptyBoard();
    applyFrame(b, cfg, '5|6');
    applyFrame(b, cfg, '6|6');
    expect(b.autopickOn.has('6')).toBe(false);
  });

  it('should not confuse a 5-field pick frame with an autopick frame', () => {
    // Both start with a digit; only field count separates them.
    const b = emptyBoard();
    expect(applyFrame(b, cfg, '0|84|7626|1|G|0').type).toBe('boardChanged');
    expect(applyFrame(b, cfg, '5|1').type).toBe('log');
  });

  it('should surface a rejection rather than swallowing it', () => {
    const e = applyFrame(emptyBoard(), cfg, 'X|29');
    expect(e.type).toBe('log');
    expect(e.type === 'log' && e.message).toContain('29');
  });

  it('should report an unrecognised frame instead of ignoring it', () => {
    const e = applyFrame(emptyBoard(), cfg, 'w|3600|20');
    expect(e.type).toBe('log');
    expect(e.type === 'log' && e.message).toContain('unrecognised');
  });

  it('should ignore a malformed P entry without losing the good ones', () => {
    const b = emptyBoard();
    applyFrame(b, cfg, 'P|1=5980,1,0|garbage|3=6743,3,0');
    expect(b.picks.size).toBe(2);
  });
});

describe('ourSeat', () => {
  it('should be unknown until the pick order arrives', () => {
    expect(ourSeat(emptyBoard(), cfg)).toBeUndefined();
  });

  it('should find our seat in the order', () => {
    const b = emptyBoard();
    applyFrame(b, cfg, 'R|3|1|6|8|2|7|4|5');
    expect(ourSeat(b, cfg)).toBe(3);
  });

  it('should be undefined when our team is absent from the order', () => {
    const b = emptyBoard();
    applyFrame(b, cfg, 'R|1|2|3|4');
    expect(ourSeat(b, cfg)).toBeUndefined();
  });
});

describe('the captured mock-draft sequence', () => {
  it('should reach our turn with the board correct', () => {
    // Shape taken from the confirmed headless run in the investigation write-up.
    const b = emptyBoard();
    const effects = feed(b, [
      'H|S|30|0|0|1',
      'R|1|2|3|4|5|6|7|8',
      'Q',
      'A|1=0|6=1',
      'J|6',
      'P|1=5980,1,0|2=5425,2,0|3=6743,3,0|4=7908,4,0|5=5699,5,0',
      'C|29',
      'D|6|6|30',
    ]);
    expect(b.picks.size).toBe(5);
    expect(ourSeat(b, cfg)).toBe(6);
    expect(effects.at(-1)).toEqual({ type: 'ourTurn', pick: 6, secs: 30 });
  });

  it('should handle a missed pick followed by forced autopick', () => {
    const b = emptyBoard();
    const effects = feed(b, ['D|15|6|30', '5|6', '0|15|7527|6|RW|0']);
    expect(effects[0]?.type).toBe('ourTurn');
    expect(effects[1]).toEqual({ type: 'autopickForcedOn' });
    expect(effects[2]?.type).toBe('boardChanged');
    // Yahoo's autopick still lands on our roster, so the board must record it as ours.
    expect(b.picks.get(15)?.teamKey).toBe('477.l.48535.t.6');
  });
});
