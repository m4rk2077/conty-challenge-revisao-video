import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Uses the production build and real TCP HTTP, with an isolated in-memory database.
const child = spawn(process.execPath, ['dist/server.js'], {
  env: { ...process.env, PORT: '0', DB_PATH: ':memory:' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', data => { stderr += String(data); });
const exited = once(child, 'exit');
try {
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Servidor não iniciou: ${stderr}`)), 10_000);
    child.stdout.on('data', data => {
      output += String(data);
      const match = output.match(/API_READY (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Servidor saiu: ${stderr}`)); });
  });
  let requests = 0;
  async function request(path, body, expected = 200, method = 'POST') {
    const response = await fetch(`${base}${path}`, {
      method, signal: AbortSignal.timeout(5_000),
      ...(body === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    requests++;
    return result;
  }
  await request('/health', undefined, 200, 'GET');
  const campaign = await request('/campaigns', { name: 'Demo', required_pieces: ['video', 'caption'] }, 201);
  const delivery = await request(`/campaigns/${campaign.id}/deliveries`, undefined, 201);
  const video = await request(`/deliveries/${delivery.id}/pieces/video/versions`,
    { asset_url: 'https://example.test/v1.mp4' }, 201);
  const comment = await request(`/piece-versions/${video.id}/comments`,
    { body: 'Cortar esta pausa', timestamp_seconds: 12.5 }, 201);
  await request(`/piece-versions/${video.id}/review`, { decision: 'approved' });
  const failure = await request(`/deliveries/${delivery.id}/approve`, undefined, 409);
  assert.deepEqual(failure.error.pending_pieces.map(p => [p.piece, p.reason]), [['caption', 'missing']]);
  const caption = await request(`/deliveries/${delivery.id}/pieces/caption/versions`,
    { asset_url: 'https://example.test/caption.txt' }, 201);
  await request(`/piece-versions/${caption.id}/review`, { decision: 'approved' });
  assert.equal((await request(`/deliveries/${delivery.id}/approve`)).approved, true);
  const v2 = await request(`/deliveries/${delivery.id}/pieces/video/versions`,
    { asset_url: 'https://example.test/v2.mp4' }, 201);
  let detail = await request(`/deliveries/${delivery.id}`, undefined, 200, 'GET');
  assert.equal(detail.approved, false);
  assert.equal(detail.approvals[0].invalidated_by_version_id, v2.id);
  const old = await request(`/piece-versions/${video.id}`, undefined, 200, 'GET');
  const current = await request(`/piece-versions/${v2.id}`, undefined, 200, 'GET');
  assert.deepEqual(old.comments, [comment]);
  assert.deepEqual(current.comments, []);
  await request(`/deliveries/${delivery.id}/approve`, undefined, 409);
  await request(`/piece-versions/${v2.id}/review`, { decision: 'approved' });
  assert.equal((await request(`/deliveries/${delivery.id}/approve`)).approved, true);
  const cover = await request(`/deliveries/${delivery.id}/pieces/cover/versions`,
    { asset_url: 'https://example.test/cover.jpg' }, 201);
  detail = await request(`/deliveries/${delivery.id}`, undefined, 200, 'GET');
  assert.equal(detail.approved, false);
  assert.deepEqual(detail.pending_pieces, []);
  assert.equal(detail.approvals[1].invalidated_by_version_id, cover.id);
  detail = await request(`/deliveries/${delivery.id}/approve`);
  assert.equal(detail.approved, true);
  assert.equal(detail.pieces.cover.versions[0].status, 'pending');
  assert.equal(detail.approvals.length, 3);
  console.log(`Smoke HTTP OK: ${requests} requests reais; gate, invalidação obrigatória/opcional e comentário versionado.`);
} finally {
  child.kill('SIGTERM');
  await exited;
}
