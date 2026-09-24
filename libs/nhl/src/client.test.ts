import { describe, expect, it, vi } from 'vitest';
import { currentTeam, getReport, NhlApiError } from './client.js';

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('currentTeam', () => {
  it('should return the single team when a player was not traded', () => {
    expect(currentTeam('EDM')).toBe('EDM');
  });

  it('should return the last team for a traded player', () => {
    expect(currentTeam('ARI,EDM')).toBe('EDM');
  });

  it('should tolerate whitespace between abbreviations', () => {
    expect(currentTeam('ARI, EDM')).toBe('EDM');
  });

  it('should return UNK rather than throwing when the field is missing', () => {
    expect(currentTeam(undefined)).toBe('UNK');
  });
});

describe('getReport', () => {
  it('should request the regular season with limit=-1 and no pagination', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ data: [{ playerId: 1 }], total: 1 }));
    await getReport('skater/summary', '20252026', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain('limit=-1');
    expect(url).toContain(encodeURIComponent('gameTypeId=2'));
    expect(url).toContain(encodeURIComponent('seasonId=20252026'));
  });

  it('should not retry a 4xx, because a bad request will not fix itself', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 400 }));
    await expect(
      getReport('skater/summary', '20252026', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(NhlApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('should retry a 5xx and succeed on a later attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(ok({ data: [{ playerId: 7 }], total: 1 }));
    const res = await getReport<{ playerId: number }>('skater/summary', '20252026', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attempts: 3,
    });
    expect(res.data[0]?.playerId).toBe(7);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('should fail loudly when the body has no data array, not return empty', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ total: 0 }));
    await expect(
      getReport('skater/summary', '20252026', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        attempts: 1,
      }),
    ).rejects.toThrow(/no data array/);
  });
});
