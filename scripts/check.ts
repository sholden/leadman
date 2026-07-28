import { matchKey, similarity, normalizeUrl, factKey } from '../src/server/lib/text.js';
import { distanceMiles, boundingBox } from '../src/server/lib/geo.js';
import { estimateCost } from '../src/server/ai/budget.js';

const eq = (label: string, got: unknown, want: unknown) =>
  console.log(`${JSON.stringify(got) === JSON.stringify(want) ? 'PASS' : 'FAIL'}  ${label}  → ${JSON.stringify(got)}`);

// Dedupe: the same project named two different ways should collapse.
eq('matchKey collapses noise words',
   matchKey('New Central Fire Station Project'), matchKey('Central Fire Station'));
eq('matchKey is order-insensitive',
   matchKey('Fire Station Central'), matchKey('Central Fire Station'));
console.log(`      similarity("New Central Fire Station","Fire Station No. 3 Replacement") = ${similarity('New Central Fire Station','Fire Station No. 3 Replacement').toFixed(2)}`);
console.log(`      similarity("Zachary High School Addition","Zachary High School Gymnasium") = ${similarity('Zachary High School Addition','Zachary High School Gymnasium').toFixed(2)}`);
console.log(`      similarity("Zachary High School","Central Library Renovation") = ${similarity('Zachary High School','Central Library Renovation').toFixed(2)}`);

eq('normalizeUrl strips tracking + trailing slash',
   normalizeUrl('https://ex.com/agendas/?utm_source=x#top'), 'https://ex.com/agendas');
eq('factKey is stable', factKey('timeline', 'Bid Opening'), 'timeline:bid-opening');

// Geo
const d = distanceMiles(30.4515, -91.1871, 30.2385, -90.9201); // Baton Rouge -> Gonzales
console.log(`${d > 18 && d < 26 ? 'PASS' : 'FAIL'}  Baton Rouge→Gonzales ≈ ${d.toFixed(1)} mi (expect ~21)`);
const box = boundingBox(30.4515, -91.1871, 60);
console.log(`${box.north > box.south && box.east > box.west ? 'PASS' : 'FAIL'}  bounding box well-formed`);

// Cost estimation drives the hard caps, so it needs to be right.
const usage = (over: Partial<Parameters<typeof estimateCost>[1]> = {}) => ({
  inputTokens: 1_000_000, outputTokens: 1_000_000,
  cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0, ...over,
});
const anth = estimateCost('claude-opus-5', usage({ webSearchRequests: 100 }));
console.log(`${Math.abs(anth - 31) < 0.001 ? 'PASS' : 'FAIL'}  anthropic: 1M in + 1M out + 100 searches = $${anth.toFixed(2)} (expect $31.00)`);
const oai = estimateCost('gpt-5.1', usage());
console.log(`${Math.abs(oai - 11.25) < 0.001 ? 'PASS' : 'FAIL'}  openai:    1M in + 1M out = $${oai.toFixed(2)} (expect $11.25)`);
// Cached input must price at 0.1x on either vendor.
const cached = estimateCost('gpt-5.1', usage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }));
console.log(`${Math.abs(cached - 0.125) < 0.001 ? 'PASS' : 'FAIL'}  cached input priced at 0.1x = $${cached.toFixed(3)} (expect $0.125)`);
