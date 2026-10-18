import { describe, expect, it } from 'vitest';
import { FetchError } from '../src/fetch.js';
import { findArchivedSnapshot, isDeadLinkError } from '../src/archive.js';

const fetchError = (cause?: Error): Error => {
  const error = new TypeError('fetch failed');
  if (cause !== undefined) (error as { cause?: Error }).cause = cause;
  return error;
};

const guardRefusal = new Error(
  'Refusing to fetch "localhost": it resolves to a private or reserved address (127.0.0.1).',
);

describe('isDeadLinkError', () => {
  it('classifies HTTP statuses and timeouts', () => {
    expect(isDeadLinkError(new FetchError('Failed to fetch https://gone.test/: HTTP 404.'))).toBe(
      true,
    );
    expect(isDeadLinkError(new FetchError('Failed to fetch https://gone.test/: HTTP 410.'))).toBe(
      true,
    );
    expect(isDeadLinkError(new FetchError('Failed to fetch https://err.test/: HTTP 500.'))).toBe(
      true,
    );
    expect(isDeadLinkError(new FetchError('Failed to fetch https://denied.test/: HTTP 403.'))).toBe(
      false,
    );
    expect(
      isDeadLinkError(new FetchError('Timed out after 5 ms while fetching https://slow.test/.')),
    ).toBe(true);
  });

  it('treats bare network failures as dead links', () => {
    expect(isDeadLinkError(new TypeError('fetch failed'))).toBe(true);
    expect(
      isDeadLinkError(
        new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND gone.test') }),
      ),
    ).toBe(true);
  });

  it('never classifies a guard refusal wrapped by undici as a dead link', () => {
    expect(isDeadLinkError(new TypeError('fetch failed', { cause: guardRefusal }))).toBe(false);
    // Deeper undici wrapping chains are followed too (2 cause levels).
    expect(
      isDeadLinkError(
        new TypeError('fetch failed', {
          cause: new Error('connect failed', { cause: guardRefusal }),
        }),
      ),
    ).toBe(false);
    expect(
      isDeadLinkError(
        new TypeError('fetch failed', {
          cause: new Error('URLs with embedded credentials are not allowed.'),
        }),
      ),
    ).toBe(false);
  });
});

describe('findArchivedSnapshot', () => {
  it('returns undefined when the availability endpoint answers non-ok', async () => {
    const result = await findArchivedSnapshot(
      'https://x.test',
      async () => new Response('busy', { status: 503 }),
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined on a non-JSON availability body', async () => {
    const result = await findArchivedSnapshot(
      'https://x.test',
      async () =>
        new Response('garbage', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when the availability request itself fails', async () => {
    const result = await findArchivedSnapshot('https://x.test', async () => {
      throw fetchError(new Error('ENOTFOUND lookup x.test'));
    });
    expect(result).toBeUndefined();
  });
});
