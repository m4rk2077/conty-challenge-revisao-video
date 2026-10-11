import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  ApiError, PIECES,
  type Approval, type Campaign, type Comment, type Decision, type Delivery,
  type DeliveryDetail, type PendingPiece, type Piece, type PieceVersion,
  type Review, type VersionDetail,
} from './domain.js';

type CampaignRow = Omit<Campaign, 'required_pieces'> & { required_pieces: string };
type ApprovalRow = Omit<Approval, 'required_versions'> & { required_versions: string };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    required_pieces TEXT NOT NULL CHECK (json_valid(required_pieces)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS piece_versions (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES deliveries(id),
    piece TEXT NOT NULL CHECK (piece IN ('script','video','cover','caption')),
    version INTEGER NOT NULL CHECK (version > 0),
    asset_url TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','approved','changes_requested')),
    created_at TEXT NOT NULL,
    reviewed_at TEXT,
    UNIQUE (delivery_id, piece, version)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    piece_version_id TEXT NOT NULL REFERENCES piece_versions(id),
    decision TEXT NOT NULL CHECK (decision IN ('approved','changes_requested')),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS reviews_by_version ON reviews(piece_version_id);
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    piece_version_id TEXT NOT NULL REFERENCES piece_versions(id),
    body TEXT NOT NULL,
    timestamp_seconds REAL CHECK (timestamp_seconds >= 0),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS comments_by_version ON comments(piece_version_id);
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL REFERENCES deliveries(id),
    approved_at TEXT NOT NULL,
    required_versions TEXT NOT NULL CHECK (json_valid(required_versions)),
    invalidated_at TEXT,
    invalidated_by_version_id TEXT REFERENCES piece_versions(id),
    invalidation_reason TEXT CHECK (invalidation_reason IN ('new_version','review_changed'))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS approvals_by_delivery ON approvals(delivery_id);
  CREATE UNIQUE INDEX IF NOT EXISTS one_active_approval
    ON approvals(delivery_id) WHERE invalidated_at IS NULL;
`;

export class Store {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:', private readonly clock: () => Date = () => new Date()) {
    this.db = new DatabaseSync(path, { timeout: 5_000 });
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private run(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params);
  }

  private transaction<T>(operation: () => T, mode: 'write' | 'read' = 'write'): T {
    // No await inside the transaction. IMMEDIATE serializes writers across processes.
    this.db.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createCampaign(name: string, requiredPieces: Piece[]): Campaign {
    const campaign: Campaign = {
      id: randomUUID(), name, required_pieces: requiredPieces, created_at: this.clock().toISOString(),
    };
    this.run('INSERT INTO campaigns VALUES (?, ?, ?, ?)',
      campaign.id, name, JSON.stringify(requiredPieces), campaign.created_at);
    return campaign;
  }

  getCampaign(id: string): Campaign {
    const row = this.one<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', id);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Campanha não encontrada.');
    return { ...row, required_pieces: JSON.parse(row.required_pieces) as Piece[] };
  }

  createDelivery(campaignId: string): DeliveryDetail {
    return this.transaction(() => {
      this.getCampaign(campaignId);
      const delivery: Delivery = {
        id: randomUUID(), campaign_id: campaignId, created_at: this.clock().toISOString(),
      };
      this.run('INSERT INTO deliveries VALUES (?, ?, ?)',
        delivery.id, delivery.campaign_id, delivery.created_at);
      return this.deliveryDetail(delivery.id);
    });
  }

  private delivery(id: string): Delivery {
    const delivery = this.one<Delivery>('SELECT * FROM deliveries WHERE id = ?', id);
    if (!delivery) throw new ApiError(404, 'NOT_FOUND', 'Entrega não encontrada.');
    return delivery;
  }

  private version(id: string): PieceVersion {
    const version = this.one<PieceVersion>('SELECT * FROM piece_versions WHERE id = ?', id);
    if (!version) throw new ApiError(404, 'NOT_FOUND', 'Versão não encontrada.');
    return version;
  }

  private currentVersion(deliveryId: string, piece: Piece): PieceVersion | undefined {
    return this.one<PieceVersion>(
      'SELECT * FROM piece_versions WHERE delivery_id = ? AND piece = ? ORDER BY version DESC LIMIT 1',
      deliveryId, piece);
  }

  createVersion(deliveryId: string, piece: Piece, assetUrl: string): VersionDetail {
    return this.transaction(() => {
      this.delivery(deliveryId);
      const previous = this.currentVersion(deliveryId, piece);
      const version: PieceVersion = {
        id: randomUUID(), delivery_id: deliveryId, piece,
        version: (previous?.version ?? 0) + 1, asset_url: assetUrl,
        status: 'pending', created_at: this.clock().toISOString(), reviewed_at: null,
      };
      this.run('INSERT INTO piece_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        version.id, deliveryId, piece, version.version, assetUrl,
        version.status, version.created_at, null);
      // Deliberately includes optional pieces; the next approval gate still ignores them.
      this.invalidate(deliveryId, version.id, 'new_version', version.created_at);
      return this.versionDetail(version);
    });
  }

  reviewVersion(id: string, decision: Decision): VersionDetail {
    return this.transaction(() => {
      const version = this.version(id);
      const reviewedAt = this.clock().toISOString();
      this.run('INSERT INTO reviews VALUES (?, ?, ?, ?)', randomUUID(), id, decision, reviewedAt);
      this.run('UPDATE piece_versions SET status = ?, reviewed_at = ? WHERE id = ?',
        decision, reviewedAt, id);
      if (decision === 'changes_requested') {
        const delivery = this.delivery(version.delivery_id);
        const required = this.getCampaign(delivery.campaign_id).required_pieces;
        if (required.includes(version.piece) &&
            this.currentVersion(delivery.id, version.piece)?.id === id) {
          this.invalidate(delivery.id, id, 'review_changed', reviewedAt);
        }
      }
      return this.versionDetail({ ...version, status: decision, reviewed_at: reviewedAt });
    });
  }

  addComment(id: string, body: string, timestamp: unknown): Comment {
    return this.transaction(() => {
      const version = this.version(id);
      let seconds: number | null = null;
      if (version.piece === 'video') {
        if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0) {
          throw new ApiError(400, 'INVALID_TIMESTAMP',
            'Comentário de vídeo exige timestamp_seconds numérico, finito e não negativo.');
        }
        seconds = timestamp;
      } else if (timestamp !== undefined) {
        throw new ApiError(400, 'INVALID_TIMESTAMP',
          'timestamp_seconds só se aplica a versões de vídeo.');
      }
      const comment: Comment = {
        id: randomUUID(), piece_version_id: id, body,
        timestamp_seconds: seconds, created_at: this.clock().toISOString(),
      };
      this.run('INSERT INTO comments VALUES (?, ?, ?, ?, ?)',
        comment.id, id, body, seconds, comment.created_at);
      return comment;
    });
  }

  private invalidate(deliveryId: string, versionId: string,
    reason: 'new_version' | 'review_changed', at: string): void {
    this.run(`UPDATE approvals SET invalidated_at = ?, invalidated_by_version_id = ?,
      invalidation_reason = ? WHERE delivery_id = ? AND invalidated_at IS NULL`,
    at, versionId, reason, deliveryId);
  }

  private gate(deliveryId: string, required: Piece[]): {
    pending: PendingPiece[]; requiredVersions: Partial<Record<Piece, string>>;
  } {
    const pending: PendingPiece[] = [];
    const requiredVersions: Partial<Record<Piece, string>> = {};
    for (const piece of required) {
      const current = this.currentVersion(deliveryId, piece);
      if (current) requiredVersions[piece] = current.id;
      if (!current) {
        pending.push({ piece, reason: 'missing', current_version_id: null });
      } else if (current.status !== 'approved') {
        pending.push({ piece, reason: current.status, current_version_id: current.id });
      }
    }
    return { pending, requiredVersions };
  }

  approveDelivery(id: string): DeliveryDetail {
    return this.transaction(() => {
      const delivery = this.delivery(id);
      const required = this.getCampaign(delivery.campaign_id).required_pieces;
      const { pending, requiredVersions } = this.gate(id, required);
      if (pending.length) {
        throw new ApiError(409, 'REQUIRED_PIECES_NOT_APPROVED',
          'Entrega não aprovada: faltam versões atuais aprovadas das peças obrigatórias.', pending);
      }
      const active = this.one<ApprovalRow>(
        'SELECT * FROM approvals WHERE delivery_id = ? AND invalidated_at IS NULL', id);
      if (!active) {
        this.run('INSERT INTO approvals VALUES (?, ?, ?, ?, NULL, NULL, NULL)',
          randomUUID(), id, this.clock().toISOString(), JSON.stringify(requiredVersions));
      }
      return this.deliveryDetail(id);
    });
  }

  private versionDetail(version: PieceVersion): VersionDetail {
    return {
      ...version,
      reviews: this.all<Review>('SELECT * FROM reviews WHERE piece_version_id = ? ORDER BY rowid', version.id),
      comments: this.all<Comment>('SELECT * FROM comments WHERE piece_version_id = ? ORDER BY rowid', version.id),
    };
  }

  getVersion(id: string): VersionDetail {
    return this.transaction(() => this.versionDetail(this.version(id)), 'read');
  }

  private deliveryDetail(id: string): DeliveryDetail {
    const delivery = this.delivery(id);
    const required = this.getCampaign(delivery.campaign_id).required_pieces;
    const { pending, requiredVersions } = this.gate(id, required);
    const approvals = this.all<ApprovalRow>(
      'SELECT * FROM approvals WHERE delivery_id = ? ORDER BY rowid', id).map(row => ({
      ...row, required_versions: JSON.parse(row.required_versions) as Approval['required_versions'],
    }));
    const active = approvals.find(approval => approval.invalidated_at === null);
    const approved = active !== undefined && pending.length === 0 && required.every(
      piece => active.required_versions[piece] === requiredVersions[piece]);
    const pieces = Object.fromEntries(PIECES.map(piece => {
      const versions = this.all<PieceVersion>(
        'SELECT * FROM piece_versions WHERE delivery_id = ? AND piece = ? ORDER BY version', id, piece);
      return [piece, {
        required: required.includes(piece),
        current_version_id: versions.at(-1)?.id ?? null,
        versions: versions.map(version => this.versionDetail(version)),
      }];
    })) as DeliveryDetail['pieces'];
    return {
      ...delivery, required_pieces: required, status: approved ? 'approved' : 'in_production',
      approved, approved_at: approved ? active.approved_at : null,
      pending_pieces: pending, pieces, approvals,
    };
  }

  getDelivery(id: string): DeliveryDetail {
    // All queries see one snapshot, even while another process creates a new version.
    return this.transaction(() => this.deliveryDetail(id), 'read');
  }
}
