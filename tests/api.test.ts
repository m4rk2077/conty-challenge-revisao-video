import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { PIECES, type Campaign, type Comment, type DeliveryDetail, type Piece, type VersionDetail } from '../src/domain.js';

const NOW = '2026-10-11T12:00:00.000Z';
let store: Store;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new Store(':memory:', () => new Date(NOW));
  app = createApp(store);
});
afterEach(() => store.close());

async function post<T>(path: string, body?: unknown, status = 200): Promise<T> {
  const response = await app.request(path, {
    method: 'POST',
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
  });
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json() as Promise<T>;
}

async function setup(required: Piece[] = ['video']): Promise<DeliveryDetail> {
  const campaign = await post<Campaign>('/campaigns', { name: 'Campanha', required_pieces: required }, 201);
  return post<DeliveryDetail>(`/campaigns/${campaign.id}/deliveries`, undefined, 201);
}

async function version(delivery: DeliveryDetail, piece: Piece = 'video'): Promise<VersionDetail> {
  return post<VersionDetail>(`/deliveries/${delivery.id}/pieces/${piece}/versions`,
    { asset_url: `https://example.test/${piece}.mp4` }, 201);
}

async function approveVersion(v: VersionDetail): Promise<VersionDetail> {
  return post<VersionDetail>(`/piece-versions/${v.id}/review`, { decision: 'approved' });
}

async function get<T>(path: string): Promise<T> {
  const response = await app.request(path);
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

describe('peças exigidas e aprovação da entrega', () => {
  it.each(PIECES)('campanha pode exigir somente %s, sem obrigar as demais peças', async piece => {
    const delivery = await setup([piece]);
    const v = await version(delivery, piece);
    expect(delivery.required_pieces).toEqual([piece]);
    await approveVersion(v);
    const approved = await post<DeliveryDetail>(`/deliveries/${delivery.id}/approve`);
    expect(approved).toMatchObject({ approved: true, status: 'approved', approved_at: NOW, pending_pieces: [] });
    expect(approved.approvals[0]?.required_versions).toEqual({ [piece]: v.id });
  });

  it('distingue peça ausente, pendente e com alteração solicitada no erro 409', async () => {
    const delivery = await setup(['video', 'script', 'caption']);
    const script = await version(delivery, 'script');
    const caption = await version(delivery, 'caption');
    await post(`/piece-versions/${caption.id}/review`, { decision: 'changes_requested' });
    const failure = await post<{ error: { code: string; pending_pieces: unknown[] } }>(
      `/deliveries/${delivery.id}/approve`, undefined, 409);
    expect(failure.error).toMatchObject({
      code: 'REQUIRED_PIECES_NOT_APPROVED',
      pending_pieces: [
        { piece: 'video', reason: 'missing', current_version_id: null },
        { piece: 'script', reason: 'pending', current_version_id: script.id },
        { piece: 'caption', reason: 'changes_requested', current_version_id: caption.id },
      ],
    });
    expect((await get<DeliveryDetail>(`/deliveries/${delivery.id}`)).approvals).toEqual([]);
  });

  it('vídeo aprovado não libera entrega que também exige legenda', async () => {
    const delivery = await setup(['video', 'caption']);
    await approveVersion(await version(delivery));
    await post(`/deliveries/${delivery.id}/approve`, undefined, 409);
    await approveVersion(await version(delivery, 'caption'));
    expect((await post<DeliveryDetail>(`/deliveries/${delivery.id}/approve`)).approved).toBe(true);
  });

  it.each(['pending', 'changes_requested'] as const)('capa opcional %s não bloqueia', async decision => {
    const delivery = await setup();
    const cover = await version(delivery, 'cover');
    if (decision === 'changes_requested') {
      await post(`/piece-versions/${cover.id}/review`, { decision });
    }
    await approveVersion(await version(delivery));
    const approved = await post<DeliveryDetail>(`/deliveries/${delivery.id}/approve`);
    expect(approved.approved).toBe(true);
    expect(approved.pieces.cover.required).toBe(false);
    expect(approved.pieces.cover.versions[0]?.status).toBe(decision);
  });

  it('repetir aprovação válida conserva o mesmo registro de auditoria', async () => {
    const delivery = await setup();
    await approveVersion(await version(delivery));
    const first = await post<DeliveryDetail>(`/deliveries/${delivery.id}/approve`);
    const second = await post<DeliveryDetail>(`/deliveries/${delivery.id}/approve`);
    expect(second.approvals).toEqual(first.approvals);
    expect(second.approvals).toHaveLength(1);
  });
});

describe('versões, histórico e invalidação', () => {
  it('duas peças e duas entregas evoluem com numeração independente e preservam histórico', async () => {
    const delivery = await setup(['video', 'script']);
    const video1 = await version(delivery);
    await approveVersion(video1);
    const script1 = await version(delivery, 'script');
    const video2 = await version(delivery);
    const video3 = await version(delivery);
    const script2 = await version(delivery, 'script');
    const other = await post<DeliveryDetail>(`/campaigns/${delivery.campaign_id}/deliveries`, undefined, 201);
    const otherVideo = await version(other);
    const detail = await get<DeliveryDetail>(`/deliveries/${delivery.id}`);
    expect([video1.version, video2.version, video3.version]).toEqual([1, 2, 3]);
    expect([script1.version, script2.version, otherVideo.version]).toEqual([1, 2, 1]);
    expect(detail.pieces.video.current_version_id).toBe(video3.id);
    expect(detail.pieces.script.current_version_id).toBe(script2.id);
    expect(detail.pieces.video.versions.map(v => v.status)).toEqual(['approved', 'pending', 'pending']);
    expect(detail.pieces.video.versions[0]?.reviews).toHaveLength(1);
  });

  it('nova versão obrigatória invalida aprovação e aprovar a histórica não satisfaz o gate', async () => {
    const delivery = await setup();
    const v1 = await version(delivery);
    await approveVersion(v1);
    const before = await post<DeliveryDetail>(`/deliveries/${delivery.id}/approve`);
    const v2 = await version(delivery);
    const invalidated = await get<DeliveryDetail>(`/deliveries/${delivery.id}`);
    expect(invalidated).toMatchObject({ approved: false, status: 'in_production', approved_at: null });
    expect(invalidated.approvals[0]).toMatchObject({
      id: before.approvals[0]?.id, approved_at: NOW, invalidated_at: NOW,
      invalidated_by_version_id: v2.id, invalidation_reason: 'new_version', required_versions: { video: v1.id },
    });
    await approveVersion(v1);
    await post(`/deliveries/${delivery.id}/approve`, undefined, 409);
    await approveVersion(v2);
    expect((await get<DeliveryDetail>(`/deliveries/${delivery.id}`)).approved).toBe(false);
    const after = await post<DeliveryDetail>(`/deliveries/${delivery.id}/approve`);
    expect(after.approved).toBe(true);
    expect(after.approvals).toHaveLength(2);
    expect(after.approvals[1]?.required_versions).toEqual({ video: v2.id });
  });

  it('nova versão opcional invalida, mas permite reaprová-la sem aprovar a peça opcional', async () => {
    const delivery = await setup();
    const v = await version(delivery);
    await approveVersion(v);
    await post(`/deliveries/${delivery.id}/approve`);
    const cover = await version(delivery, 'cover');
    const invalidated = await get<DeliveryDetail>(`/deliveries/${delivery.id}`);
    expect(invalidated.approved).toBe(false);
    expect(invalidated.pending_pieces).toEqual([]);
    expect(invalidated.approvals[0]).toMatchObject({
      invalidated_by_version_id: cover.id, invalidation_reason: 'new_version',
    });
    const after = await post<DeliveryDetail>(`/deliveries/${delivery.id}/approve`);
    expect(after.approved).toBe(true);
    expect(after.pieces.cover.versions[0]?.status).toBe('pending');
    expect(after.approvals[1]?.required_versions).toEqual({ video: v.id });
  });

  it('reverter a revisão atual obrigatória invalida; revisão histórica não afeta a atual', async () => {
    const delivery = await setup();
    const old = await version(delivery);
    await approveVersion(old);
    const current = await version(delivery);
    await approveVersion(current);
    await post(`/deliveries/${delivery.id}/approve`);
    await post(`/piece-versions/${old.id}/review`, { decision: 'changes_requested' });
    expect((await get<DeliveryDetail>(`/deliveries/${delivery.id}`)).approved).toBe(true);
    await post(`/piece-versions/${current.id}/review`, { decision: 'changes_requested' });
    const detail = await get<DeliveryDetail>(`/deliveries/${delivery.id}`);
    expect(detail.approved).toBe(false);
    expect(detail.approvals[0]?.invalidation_reason).toBe('review_changed');
    expect(detail.pieces.video.versions[1]?.reviews.map(r => r.decision)).toEqual(['approved', 'changes_requested']);
    await post(`/deliveries/${delivery.id}/approve`, undefined, 409);
  });

  it('revisão de opcional não cria bloqueio nem muda o snapshot obrigatório', async () => {
    const delivery = await setup();
    await approveVersion(await version(delivery));
    const optional = await version(delivery, 'caption');
    await post(`/deliveries/${delivery.id}/approve`);
    await post(`/piece-versions/${optional.id}/review`, { decision: 'changes_requested' });
    expect((await get<DeliveryDetail>(`/deliveries/${delivery.id}`)).approved).toBe(true);
  });
});

describe('comentários presos ao segundo e à versão', () => {
  it('comentário em 12.5s continua na V1 e não migra para a V2', async () => {
    const delivery = await setup();
    const v1 = await version(delivery);
    const comment = await post<Comment>(`/piece-versions/${v1.id}/comments`,
      { timestamp_seconds: 12.5, body: 'Cortar esta pausa' }, 201);
    const v2 = await version(delivery);
    const first = await get<VersionDetail>(`/piece-versions/${v1.id}`);
    const second = await get<VersionDetail>(`/piece-versions/${v2.id}`);
    expect(comment).toMatchObject({ piece_version_id: v1.id, timestamp_seconds: 12.5, created_at: NOW });
    expect(first.comments).toEqual([comment]);
    expect(second.comments).toEqual([]);
    const detail = await get<DeliveryDetail>(`/deliveries/${delivery.id}`);
    expect(detail.pieces.video.versions[0]?.comments).toEqual([comment]);
    expect(detail.pieces.video.versions[1]?.comments).toEqual([]);
  });

  it.each([-1, null, '12.5', undefined])('recusa timestamp %s para vídeo sem gravar comentário', async timestamp => {
    const v = await version(await setup());
    await post(`/piece-versions/${v.id}/comments`, { timestamp_seconds: timestamp, body: 'Comentário' }, 400);
    expect((await get<VersionDetail>(`/piece-versions/${v.id}`)).comments).toEqual([]);
  });

  it('recusa valores não finitos, inclusive overflow de número JSON', async () => {
    const v = await version(await setup());
    for (const timestamp of [NaN, Infinity, -Infinity]) {
      expect(() => store.addComment(v.id, 'Comentário', timestamp)).toThrow('finito');
    }
    const response = await app.request(`/piece-versions/${v.id}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{"body":"Comentário","timestamp_seconds":1e400}',
    });
    expect(response.status).toBe(400);
    expect(store.getVersion(v.id).comments).toEqual([]);
  });

  it('aceita o segundo zero; comentário em roteiro não tem timestamp', async () => {
    const delivery = await setup();
    const video = await version(delivery);
    const script = await version(delivery, 'script');
    expect((await post<Comment>(`/piece-versions/${video.id}/comments`,
      { body: 'Início', timestamp_seconds: 0 }, 201)).timestamp_seconds).toBe(0);
    expect((await post<Comment>(`/piece-versions/${script.id}/comments`,
      { body: 'Revisar título' }, 201)).timestamp_seconds).toBeNull();
    await post(`/piece-versions/${script.id}/comments`, { body: 'Título', timestamp_seconds: 12.5 }, 400);
    await post(`/piece-versions/${video.id}/comments`, { body: ' ', timestamp_seconds: 0 }, 400);
  });
});

describe('contrato HTTP e validação de entradas', () => {
  it.each([
    { name: '', required_pieces: ['video'] },
    { name: 'Campanha', required_pieces: [] },
    { name: 'Campanha', required_pieces: ['video', 'video'] },
    { name: 'Campanha', required_pieces: ['audio'] },
    { name: 'Campanha', required_pieces: 'video' },
  ])('recusa campanha inválida: %j', async body => {
    await post('/campaigns', body, 400);
  });

  it.each(['{', 'null', '[]', '"texto"'])('recusa corpo JSON inválido: %s', async body => {
    const response = await app.request('/campaigns', { method: 'POST', body });
    expect(response.status).toBe(400);
  });

  it('recusa peça, URL e decisão inválidas sem inserir versão', async () => {
    const delivery = await setup();
    await post(`/deliveries/${delivery.id}/pieces/audio/versions`, { asset_url: 'https://example.test/a' }, 400);
    for (const asset_url of ['', 'javascript:alert(1)', 'arquivo.mp4']) {
      await post(`/deliveries/${delivery.id}/pieces/video/versions`, { asset_url }, 400);
    }
    expect(store.getDelivery(delivery.id).pieces.video.versions).toEqual([]);
    const v = await version(delivery);
    await post(`/piece-versions/${v.id}/review`, { decision: 'pending' }, 400);
    expect(store.getVersion(v.id).status).toBe('pending');
  });

  it('recursos desconhecidos retornam 404, sem criar registros órfãos', async () => {
    await post('/campaigns/absent/deliveries', undefined, 404);
    await post('/deliveries/absent/pieces/video/versions', { asset_url: 'https://example.test/a' }, 404);
    await post('/deliveries/absent/approve', undefined, 404);
    await post('/piece-versions/absent/review', { decision: 'approved' }, 404);
    await post('/piece-versions/absent/comments', { body: 'A', timestamp_seconds: 0 }, 404);
    for (const path of ['/campaigns/absent', '/deliveries/absent', '/piece-versions/absent', '/unknown']) {
      expect((await app.request(path)).status).toBe(404);
    }
    // A transaction that failed rolled back and the connection remains usable.
    expect((await setup()).status).toBe('in_production');
  });
});
