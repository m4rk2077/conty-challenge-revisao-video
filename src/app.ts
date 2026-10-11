import { Hono, type Context } from 'hono';
import { ApiError, PIECES, type Decision, type Piece } from './domain.js';
import type { Store } from './store.js';

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await c.req.json<unknown>();
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Envie um objeto JSON válido.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'INVALID_JSON', 'Envie um objeto JSON válido.');
  }
  return value as Record<string, unknown>;
}

function textField(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new ApiError(400, 'INVALID_INPUT', `${field} deve ser texto não vazio de até ${maxLength} caracteres.`);
  }
  return value.trim();
}

function pieceField(value: unknown): Piece {
  if (typeof value !== 'string' || !PIECES.includes(value as Piece)) {
    throw new ApiError(400, 'INVALID_PIECE', `Peça inválida. Use: ${PIECES.join(', ')}.`);
  }
  return value as Piece;
}

export function createApp(store: Store): Hono {
  const app = new Hono();
  app.get('/health', c => c.json({ status: 'ok' }));
  app.post('/campaigns', async c => {
    const body = await jsonBody(c);
    const name = textField(body.name, 'name', 200);
    if (!Array.isArray(body.required_pieces) || body.required_pieces.length === 0) {
      throw new ApiError(400, 'INVALID_INPUT', 'required_pieces deve conter ao menos uma peça.');
    }
    const required = body.required_pieces.map(pieceField);
    if (new Set(required).size !== required.length) {
      throw new ApiError(400, 'INVALID_INPUT', 'required_pieces não aceita peças repetidas.');
    }
    return c.json(store.createCampaign(name, required), 201);
  });
  app.get('/campaigns/:campaignId', c => c.json(store.getCampaign(c.req.param('campaignId'))));
  app.post('/campaigns/:campaignId/deliveries', c =>
    c.json(store.createDelivery(c.req.param('campaignId')), 201));
  app.post('/deliveries/:deliveryId/pieces/:piece/versions', async c => {
    const piece = pieceField(c.req.param('piece'));
    const body = await jsonBody(c);
    const assetUrl = textField(body.asset_url, 'asset_url', 2_048);
    let validUrl = false;
    try {
      const url = new URL(assetUrl);
      validUrl = ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname);
    } catch { /* handled below */ }
    if (!validUrl) throw new ApiError(400, 'INVALID_INPUT', 'asset_url deve ser uma URL HTTP ou HTTPS.');
    return c.json(store.createVersion(c.req.param('deliveryId'), piece, assetUrl), 201);
  });
  app.post('/piece-versions/:versionId/review', async c => {
    const body = await jsonBody(c);
    if (body.decision !== 'approved' && body.decision !== 'changes_requested') {
      throw new ApiError(400, 'INVALID_INPUT', 'decision deve ser approved ou changes_requested.');
    }
    return c.json(store.reviewVersion(c.req.param('versionId'), body.decision as Decision));
  });
  app.post('/piece-versions/:versionId/comments', async c => {
    const body = await jsonBody(c);
    return c.json(store.addComment(c.req.param('versionId'),
      textField(body.body, 'body', 5_000), body.timestamp_seconds), 201);
  });
  app.get('/piece-versions/:versionId', c => c.json(store.getVersion(c.req.param('versionId'))));
  app.post('/deliveries/:deliveryId/approve', c => c.json(store.approveDelivery(c.req.param('deliveryId'))));
  app.get('/deliveries/:deliveryId', c => c.json(store.getDelivery(c.req.param('deliveryId'))));
  app.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } }, 404));
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: {
        code: error.code, message: error.message,
        ...(error.pendingPieces ? { pending_pieces: error.pendingPieces } : {}),
      } }, error.status);
    }
    console.error(error);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Erro interno.' } }, 500);
  });
  return app;
}
