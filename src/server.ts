import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './app.js';
import { Store } from './store.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error('PORT deve ser um inteiro entre 0 e 65535.');
}
const path = process.env.DB_PATH ?? 'data/reviews.sqlite';
if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
const store = new Store(path);
const app = createApp(store);
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, info => {
  console.log(`API_READY http://127.0.0.1:${info.port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
