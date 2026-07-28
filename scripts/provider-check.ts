import { providerForModel, priceFor } from '../src/server/config.js';
const models = ['claude-opus-5','claude-haiku-4-5','gpt-5.1','gpt-5-mini','o4-mini','some-unknown-model','gpt-9-future'];
for (const m of models) {
  const p = priceFor(m);
  console.log(`  ${m.padEnd(20)} → ${providerForModel(m).padEnd(10)} $${p.input}/$${p.output} per MTok`);
}
