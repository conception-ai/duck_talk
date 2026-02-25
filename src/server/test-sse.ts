/**
 * Test POST /api/converse SSE — writes result to /tmp/test-sse-result.txt
 */
import { writeFileSync } from 'node:fs';

const OUT = '/tmp/test-sse-result.txt';
const log: string[] = [];

async function main() {
  const res = await fetch('http://127.0.0.1:8001/api/converse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instruction: 'Say hello in 3 words',
      model: 'claude-sonnet-4-6',
      system_prompt: 'Be concise.',
      permission_mode: 'plan',
    }),
  });

  log.push(`status: ${res.status}`);
  log.push(`content-type: ${res.headers.get('content-type')}`);

  if (!res.ok || !res.body) {
    log.push(`FAIL: ${res.status}`);
    writeFileSync(OUT, log.join('\n') + '\n');
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let fullText = '';
  let nChunks = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const parts = buf.split('\n\n');
    buf = parts.pop()!;

    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data: ')) continue;
      const data = JSON.parse(line.slice(6));
      log.push(`SSE: ${JSON.stringify(data).slice(0, 200)}`);

      if (data.text) {
        nChunks++;
        fullText += data.text;
      }
      if (data.done) {
        log.push(`--- Result ---`);
        log.push(`session_id: ${data.session_id}`);
        log.push(`cost_usd: ${data.cost_usd}`);
        log.push(`duration_ms: ${data.duration_ms}`);
        log.push(`error: ${data.error ?? 'null'}`);
      }
    }
  }

  log.push(`\nFull text: "${fullText}"`);
  log.push(`Summary: ${nChunks} text chunks`);
  log.push(nChunks > 0 ? 'PASS' : 'FAIL: No text chunks');

  writeFileSync(OUT, log.join('\n') + '\n');
}

main().catch((e) => {
  writeFileSync(OUT, `FATAL: ${e}\n`);
});
