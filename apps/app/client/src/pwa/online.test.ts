import { describe, expect, it } from 'vitest';
import { RequestError, describeError } from '../api/client';
import { OFFLINE_MUTATION_MESSAGE, offlineMutationError } from './online';

describe('offlineMutationError', () => {
  it('lets a mutation run while online', () => {
    expect(offlineMutationError(true)).toBeNull();
  });

  it('fails an offline mutation at once with a clear message', () => {
    const error = offlineMutationError(false);
    expect(error).toBeInstanceOf(RequestError);
    expect(error?.code).toBe('offline');
    expect(describeError(error)).toBe(OFFLINE_MUTATION_MESSAGE);
    expect(OFFLINE_MUTATION_MESSAGE).toMatch(/offline/i);
  });
});
