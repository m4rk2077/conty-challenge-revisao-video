import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

describe('SQLite em arquivo', () => {
  it('reabrir banco preserva versões, revisões, comentários e invalidações', () => {
    const directory = mkdtempSync(join(process.cwd(), '.test-data-'));
    const path = join(directory, 'reviews.sqlite');
    let store = new Store(path);
    try {
      const campaign = store.createCampaign('Persistência', ['video', 'caption']);
      const delivery = store.createDelivery(campaign.id);
      const v1 = store.createVersion(delivery.id, 'video', 'https://example.test/v1.mp4');
      const caption = store.createVersion(delivery.id, 'caption', 'https://example.test/caption.txt');
      store.addComment(v1.id, 'Pausa em 12.5s', 12.5);
      store.reviewVersion(v1.id, 'approved');
      store.reviewVersion(caption.id, 'approved');
      store.approveDelivery(delivery.id);
      const v2 = store.createVersion(delivery.id, 'video', 'https://example.test/v2.mp4');
      const expected = store.getDelivery(delivery.id);
      store.close();
      store = new Store(path);
      expect(store.getDelivery(delivery.id)).toEqual(expected);
      expect(store.getVersion(v1.id).comments[0]?.timestamp_seconds).toBe(12.5);
      expect(store.getVersion(v2.id).comments).toEqual([]);
      expect(store.getDelivery(delivery.id).approved).toBe(false);
      store.reviewVersion(v2.id, 'approved');
      store.approveDelivery(delivery.id);
      const approved = store.getDelivery(delivery.id);
      store.close();
      store = new Store(path);
      expect(store.getDelivery(delivery.id)).toEqual(approved);
      expect(approved.approved).toBe(true);
      expect(approved.approvals).toHaveLength(2);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('4 processos concorrentes criam 48 versões sem colisões nem perda de histórico', async () => {
    const directory = mkdtempSync(join(process.cwd(), '.test-data-'));
    const path = join(directory, 'parallel.sqlite');
    const store = new Store(path);
    const children: ChildProcess[] = [];
    try {
      const campaign = store.createCampaign('Concorrência', ['video']);
      const delivery = store.createDelivery(campaign.id);
      const first = store.createVersion(delivery.id, 'video', 'https://example.test/first.mp4');
      store.reviewVersion(first.id, 'approved');
      store.approveDelivery(delivery.id);
      const worker = fileURLToPath(new URL('./version-writer.ts', import.meta.url));
      const ready: Promise<void>[] = [];
      const done: Promise<void>[] = [];
      for (let i = 0; i < 4; i++) {
        const child = fork(worker, [path, delivery.id], {
          execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        children.push(child);
        let stderr = '';
        child.stderr?.on('data', data => { stderr += String(data); });
        ready.push(new Promise((resolve, reject) => {
          child.once('message', () => resolve());
          child.once('error', reject);
          child.once('exit', () => reject(new Error(`Worker saiu antes de ready: ${stderr}`)));
        }));
        done.push(new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
        }));
      }
      await Promise.all(ready);
      for (const child of children) child.send('start');
      await Promise.all(done);
      const detail = store.getDelivery(delivery.id);
      expect(detail.pieces.video.versions.map(v => v.version)).toEqual(
        Array.from({ length: 49 }, (_, index) => index + 1));
      expect(detail.pieces.video.current_version_id).toBe(detail.pieces.video.versions[48]?.id);
      expect(new Set(detail.pieces.video.versions.map(v => v.id)).size).toBe(49);
      expect(detail.approved).toBe(false);
      expect(detail.approvals).toHaveLength(1);
      expect(detail.approvals[0]?.invalidated_by_version_id).toBe(detail.pieces.video.versions[1]?.id);
    } finally {
      for (const child of children) { if (child.exitCode === null) child.kill(); }
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
