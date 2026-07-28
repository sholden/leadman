// Re-archives the two real agenda PDFs the live scan cited, to prove extraction works.
import { archiveUrl } from '../src/server/lib/archive.js';
import { db, migrate } from '../src/server/db/index.js';
migrate();
const urls = db.prepare('SELECT DISTINCT url FROM project_sources').all() as { url: string }[];
for (const { url } of urls) {
  const id = await archiveUrl({ url, fallbackTitle: 'agenda' });
  const row = db.prepare('SELECT byte_size, length(content_text) AS chars, substr(content_text,1,220) AS head FROM artifacts WHERE id=?').get(id) as any;
  console.log(`${row.byte_size} bytes → ${row.chars} chars of text`);
  console.log('   ' + (row.head || '').replace(/\s+/g, ' ').slice(0, 200));
  console.log();
}
