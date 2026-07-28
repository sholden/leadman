import { db, newId, nowIso } from '../db/index.js';
import { sha256, truncate } from './text.js';
import { config } from '../config.js';

const MAX_STORED_CHARS = 200_000;
const FETCH_TIMEOUT_MS = 20_000;
/** Some public sites (BoardDocs, Cloudflare-fronted portals) reject non-browser agents. */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/**
 * Extracts a PDF's text layer. Returns '' for scanned/image-only PDFs (no OCR)
 * and never throws — a malformed PDF must not take down an archive write.
 */
async function extractPdfText(buf: Buffer): Promise<string> {
  try {
    // pdf-parse is CommonJS and runs a debug harness on import of its index;
    // importing the implementation module directly avoids that.
    const mod = await import('pdf-parse/lib/pdf-parse.js');
    const pdfParse = (mod.default ?? mod) as (b: Buffer) => Promise<{ text: string }>;
    const { text } = await pdfParse(buf);
    return text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  } catch (err) {
    console.warn('[archive] PDF extraction failed:', err instanceof Error ? err.message : err);
    return '';
  }
}

function titleFrom(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 300) : '';
}

export interface ReadableDocument {
  url: string;
  title: string;
  text: string;
  bytes: number;
  contentType: string;
  ok: boolean;
}

/**
 * Fetches a URL and returns readable text — HTML stripped to prose, PDFs text-
 * extracted. Costs no model tokens.
 *
 * This is also what backs the `fetch_url` tool given to providers that have no
 * hosted fetch of their own, so their document handling matches Anthropic's.
 */
export async function fetchReadable(url: string, maxChars = MAX_STORED_CHARS): Promise<ReadableDocument> {
  const out: ReadableDocument = { url, title: '', text: '', bytes: 0, contentType: '', ok: false };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain,*/*',
      },
    });
    clearTimeout(timer);
    out.contentType = res.headers.get('content-type') ?? '';

    if (!res.ok) {
      out.text = `[fetch failed: HTTP ${res.status}]`;
      return out;
    }
    if (/pdf/i.test(out.contentType)) {
      const buf = Buffer.from(await res.arrayBuffer());
      out.bytes = buf.byteLength;
      const extracted = await extractPdfText(buf);
      out.text = extracted
        ? truncate(extracted, maxChars)
        : `[PDF, ${out.bytes} bytes — no extractable text layer (likely a scan)]`;
      out.ok = Boolean(extracted);
      return out;
    }
    if (/text\/html|text\/plain|application\/xhtml|json|xml/i.test(out.contentType)) {
      const body = await res.text();
      out.bytes = Buffer.byteLength(body);
      out.text = truncate(/html/i.test(out.contentType) ? htmlToText(body) : body, maxChars);
      out.title = titleFrom(body);
      // "ok" means we extracted readable content. A short page is still readable —
      // only genuinely empty extraction (JS-rendered shell, error page) is not.
      out.ok = out.text.trim().length > 0;
      return out;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    out.bytes = buf.byteLength;
    out.text = `[binary document: ${out.contentType || 'unknown type'}, ${out.bytes} bytes — not extracted]`;
    return out;
  } catch (err) {
    out.text = `[fetch failed: ${err instanceof Error ? err.message : String(err)}]`;
    return out;
  }
}

/**
 * Stores a snapshot of a URL so the evidence survives the source page changing.
 * This is a plain HTTP fetch — no model tokens are spent here.
 */
export async function archiveUrl(opts: {
  url: string;
  projectId?: string | null;
  projectSourceId?: string | null;
  sourceId?: string | null;
  fallbackTitle?: string;
  fallbackText?: string;
}): Promise<string | null> {
  const { url } = opts;

  // One fetch/extract implementation, shared with the `fetch_url` tool. Keeping
  // a second copy here previously let the two drift apart.
  const doc = await fetchReadable(url);

  // Prefer extracted content; fall back to the excerpt the model quoted so the
  // evidence survives even when the page does not.
  const text = doc.ok ? doc.text : opts.fallbackText || doc.text;
  const title = opts.fallbackTitle || doc.title;
  const bytes = doc.bytes;

  if (!text) return null;

  const hash = sha256(`${url}\n${text}`);
  const dupe = db
    .prepare(
      "SELECT id FROM artifacts WHERE content_hash = ? AND url = ? AND IFNULL(project_id, '') = ?",
    )
    .get(hash, url, opts.projectId ?? '') as { id: string } | undefined;
  if (dupe) return dupe.id;

  const id = newId();
  db.prepare(
    `INSERT INTO artifacts
       (id, project_id, project_source_id, source_id, url, title, content_text, content_hash, byte_size, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.projectId ?? null,
    opts.projectSourceId ?? null,
    opts.sourceId ?? null,
    url,
    title.slice(0, 300),
    text,
    hash,
    bytes,
    nowIso(),
  );
  return id;
}
