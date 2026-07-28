/**
 * Plain HTTP reachability check. Costs no tokens.
 *
 * The model is told to verify every URL it proposes and mostly does, but not
 * reliably — in testing 1 in 10 proposed sources was a 404. Checking here is
 * free, so we do it rather than discovering the problem on the first scan.
 */

/** Some public sites (BoardDocs, Cloudflare-fronted portals) reject non-browser agents. */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type Reachability = 'ok' | 'protected' | 'missing' | 'error';

export interface UrlCheck {
  url: string;
  reachability: Reachability;
  status: number | null;
  note: string;
}

async function attempt(url: string, method: 'HEAD' | 'GET', timeoutMs: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method,
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,*/*' },
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function checkUrl(url: string, timeoutMs = 20_000): Promise<UrlCheck> {
  try {
    // Many sites mishandle HEAD; fall back to GET before believing a failure.
    let res = await attempt(url, 'HEAD', timeoutMs);
    if (res.status === 405 || res.status === 501 || res.status >= 400) {
      res = await attempt(url, 'GET', timeoutMs);
    }
    if (res.ok) return { url, reachability: 'ok', status: res.status, note: '' };
    if (res.status === 403 || res.status === 401 || res.status === 429) {
      // Reachable, but shielded from automated agents. The model's web_fetch may
      // still succeed, so keep it rather than discarding a good source.
      return {
        url,
        reachability: 'protected',
        status: res.status,
        note: `Returned HTTP ${res.status} to an automated request; may still work via the model's fetch tool.`,
      };
    }
    return { url, reachability: 'missing', status: res.status, note: `Returned HTTP ${res.status}.` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      url,
      reachability: 'error',
      status: null,
      note: /abort/i.test(message) ? 'Timed out.' : message.slice(0, 200),
    };
  }
}

/** Checks many URLs with bounded concurrency. */
export async function checkUrls(urls: string[], concurrency = 5): Promise<Map<string, UrlCheck>> {
  const out = new Map<string, UrlCheck>();
  const queue = [...urls];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      out.set(next, await checkUrl(next));
    }
  });
  await Promise.all(workers);
  return out;
}
