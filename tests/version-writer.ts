import { Store } from '../src/store.js';

const [path, deliveryId] = process.argv.slice(2);
if (!path || !deliveryId) throw new Error('Faltam banco e entrega.');
const store = new Store(path);
process.send?.('ready');
process.once('message', () => {
  try {
    for (let i = 0; i < 12; i++) {
      store.createVersion(deliveryId, 'video', 'https://example.test/parallel.mp4');
    }
    store.close();
    process.disconnect?.();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
});
