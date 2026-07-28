import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, migrate } from '../src/server/db/index.js';
import { archiveUrl, fetchReadable } from '../src/server/lib/archive.js';
import { resetData } from './helpers.js';

migrate();

function stubResponse(body: BodyInit | null, contentType: string, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status, headers: { 'content-type': contentType } })),
  );
}

beforeEach(() => resetData());
afterEach(() => vi.unstubAllGlobals());

describe('fetchReadable', () => {
  it('strips HTML to readable prose', async () => {
    stubResponse(
      '<html><head><title>Agenda</title><style>b{}</style></head><body><script>x()</script>' +
        '<p>Item one</p><p>Item two</p></body></html>',
      'text/html; charset=utf-8',
    );
    const doc = await fetchReadable('https://x.test/a');
    expect(doc.ok).toBe(true);
    expect(doc.title).toBe('Agenda');
    expect(doc.text).toContain('Item one');
    expect(doc.text).toContain('Item two');
    // Script and style content must not leak into the extracted text.
    expect(doc.text).not.toContain('x()');
    expect(doc.text).not.toContain('b{}');
  });

  it('decodes HTML entities', async () => {
    stubResponse('<p>Parks &amp; Recreation &quot;Phase&nbsp;2&quot;</p>', 'text/html');
    const doc = await fetchReadable('https://x.test/e');
    expect(doc.text).toContain('Parks & Recreation');
    expect(doc.text).toContain('"Phase 2"');
  });

  it('reports a non-200 without throwing', async () => {
    stubResponse(null, 'text/html', 500);
    const doc = await fetchReadable('https://x.test/err');
    expect(doc.ok).toBe(false);
    expect(doc.text).toMatch(/HTTP 500/);
  });

  it('survives a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const doc = await fetchReadable('https://x.test/down');
    expect(doc.ok).toBe(false);
    expect(doc.text).toMatch(/fetch failed/i);
  });

  it('labels a binary it cannot extract rather than storing gibberish', async () => {
    stubResponse(new Uint8Array([0, 1, 2, 3]), 'application/octet-stream');
    const doc = await fetchReadable('https://x.test/bin');
    expect(doc.text).toMatch(/binary document/i);
  });

  it('reports a PDF with no text layer instead of failing', async () => {
    // Not a real PDF, so extraction yields nothing — the scanned-document case.
    stubResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'application/pdf');
    const doc = await fetchReadable('https://x.test/scan.pdf');
    expect(doc.ok).toBe(false);
    expect(doc.text).toMatch(/no extractable text layer/i);
  });

  it('truncates very long documents', async () => {
    stubResponse(`<p>${'word '.repeat(50_000)}</p>`, 'text/html');
    const doc = await fetchReadable('https://x.test/long', 500);
    expect(doc.text.length).toBeLessThan(700);
    expect(doc.text).toContain('truncated');
  });
});

describe('archiveUrl', () => {
  it('stores a snapshot and returns its id', async () => {
    stubResponse('<html><body><p>Council approved the design contract.</p></body></html>', 'text/html');
    const id = await archiveUrl({ url: 'https://x.test/agenda' });
    expect(id).toBeTruthy();
    const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id!) as { content_text: string };
    expect(row.content_text).toContain('Council approved');
  });

  it('deduplicates identical content at the same URL', async () => {
    stubResponse('<p>same</p>', 'text/html');
    const a = await archiveUrl({ url: 'https://x.test/same' });
    const b = await archiveUrl({ url: 'https://x.test/same' });
    expect(b).toBe(a);
    const n = db.prepare('SELECT COUNT(*) n FROM artifacts').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('stores a new row when the page content changes', async () => {
    stubResponse('<p>version one</p>', 'text/html');
    await archiveUrl({ url: 'https://x.test/changing' });
    stubResponse('<p>version two</p>', 'text/html');
    await archiveUrl({ url: 'https://x.test/changing' });
    const n = db.prepare('SELECT COUNT(*) n FROM artifacts').get() as { n: number };
    expect(n.n).toBe(2);
  });

  it('falls back to the supplied excerpt when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const id = await archiveUrl({
      url: 'https://x.test/gone',
      fallbackText: 'Quoted evidence from the scan.',
    });
    const row = db.prepare('SELECT content_text FROM artifacts WHERE id = ?').get(id!) as {
      content_text: string;
    };
    // The evidence survives even when the page does not.
    expect(row.content_text).toContain('Quoted evidence');
  });
});
