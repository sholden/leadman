import { db, newId, nowIso } from '../db/index.js';
import { sha256, truncate } from './text.js';
import { config } from '../config.js';

const MAX_STORED_CHARS = 200_000;
const FETCH_TIMEOUT_MS = 20_000;

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
  let text = opts.fallbackText ?? '';
  let title = opts.fallbackTitle ?? '';
  let bytes = 0;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': `Leadman/0.1 (${config.geocodeContact})`,
        Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
      },
    });
    clearTimeout(timer);

    const contentType = res.headers.get('content-type') ?? '';
    if (res.ok && /text\/html|text\/plain|application\/xhtml/i.test(contentType)) {
      const body = await res.text();
      bytes = Buffer.byteLength(body);
      const extracted = /html/i.test(contentType) ? htmlToText(body) : body;
      if (extracted.length > 40) {
        text = truncate(extracted, MAX_STORED_CHARS);
        title = title || titleFrom(body);
      }
    } else if (res.ok && /pdf/i.test(contentType)) {
      // Council agendas and RFPs are overwhelmingly PDFs — extracting them is the
      // difference between a real archive and a stored excerpt.
      const buf = Buffer.from(await res.arrayBuffer());
      bytes = buf.byteLength;
      const extracted = await extractPdfText(buf);
      if (extracted) {
        text = truncate(extracted, MAX_STORED_CHARS);
        title = title || opts.fallbackTitle || '';
      } else {
        text = text || `[PDF, ${bytes} bytes — no extractable text layer (likely a scan)]`;
      }
    } else if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      bytes = buf.byteLength;
      text =
        text ||
        `[binary document: ${contentType || 'unknown type'}, ${bytes} bytes — not extracted]`;
    } else {
      text = text || `[fetch failed: HTTP ${res.status}]`;
    }
  } catch (err) {
    text = text || `[fetch failed: ${err instanceof Error ? err.message : String(err)}]`;
  }

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
