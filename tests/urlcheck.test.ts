import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkUrl, checkUrls } from '../src/server/lib/urlcheck.js';

/** Stubs fetch to answer per-URL with a status, or throw for network failure. */
function stubFetch(map: Record<string, number | 'throw' | 'timeout'>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const outcome = map[url] ?? 404;
      if (outcome === 'throw') throw new Error('ENOTFOUND');
      if (outcome === 'timeout') throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      return new Response(null, { status: outcome });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('classifying a URL', () => {
  it('marks a 200 reachable', async () => {
    stubFetch({ 'https://ok.test/': 200 });
    const r = await checkUrl('https://ok.test/');
    expect(r.reachability).toBe('ok');
    expect(r.status).toBe(200);
  });

  it('marks a 404 missing so it is never activated', async () => {
    stubFetch({ 'https://gone.test/': 404 });
    const r = await checkUrl('https://gone.test/');
    expect(r.reachability).toBe('missing');
  });

  it('treats a 403 as protected, not dead', async () => {
    // BoardDocs and Cloudflare-fronted portals reject automated agents but are
    // perfectly good sources — discarding them would lose real coverage.
    stubFetch({ 'https://shielded.test/': 403 });
    const r = await checkUrl('https://shielded.test/');
    expect(r.reachability).toBe('protected');
  });

  it('treats a 429 as protected rather than missing', async () => {
    stubFetch({ 'https://busy.test/': 429 });
    expect((await checkUrl('https://busy.test/')).reachability).toBe('protected');
  });

  it('reports a DNS failure as an error with no status', async () => {
    stubFetch({ 'https://nowhere.test/': 'throw' });
    const r = await checkUrl('https://nowhere.test/');
    expect(r.reachability).toBe('error');
    expect(r.status).toBeNull();
  });

  it('reports a timeout distinctly', async () => {
    stubFetch({ 'https://slow.test/': 'timeout' });
    const r = await checkUrl('https://slow.test/');
    expect(r.reachability).toBe('error');
    expect(r.note).toMatch(/timed out/i);
  });

  it('retries with GET when HEAD is rejected', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(init?.method ?? 'GET');
        // Many sites 405 a HEAD but serve the page fine on GET.
        return new Response(null, { status: calls.length === 1 ? 405 : 200 });
      }),
    );
    const r = await checkUrl('https://headless.test/');
    expect(calls).toEqual(['HEAD', 'GET']);
    expect(r.reachability).toBe('ok');
  });

  it('sends a browser user agent so bot filters do not fire', async () => {
    const seen: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
        Object.assign(seen, init?.headers as Record<string, string>);
        return new Response(null, { status: 200 });
      }),
    );
    await checkUrl('https://ua.test/');
    expect(seen['User-Agent']).toMatch(/Mozilla/);
  });
});

describe('checking many URLs', () => {
  it('returns a verdict for every URL', async () => {
    stubFetch({
      'https://a.test/': 200,
      'https://b.test/': 404,
      'https://c.test/': 403,
    });
    const out = await checkUrls(['https://a.test/', 'https://b.test/', 'https://c.test/']);
    expect(out.size).toBe(3);
    expect(out.get('https://a.test/')!.reachability).toBe('ok');
    expect(out.get('https://b.test/')!.reachability).toBe('missing');
    expect(out.get('https://c.test/')!.reachability).toBe('protected');
  });

  it('handles an empty list without hanging', async () => {
    stubFetch({});
    await expect(checkUrls([])).resolves.toEqual(new Map());
  });

  it('does not let one failure abort the batch', async () => {
    stubFetch({ 'https://a.test/': 'throw', 'https://b.test/': 200 });
    const out = await checkUrls(['https://a.test/', 'https://b.test/']);
    expect(out.get('https://b.test/')!.reachability).toBe('ok');
  });
});
