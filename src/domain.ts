export const PIECES = ['script', 'video', 'cover', 'caption'] as const;
export type Piece = (typeof PIECES)[number];
export type Decision = 'approved' | 'changes_requested';
export type VersionStatus = 'pending' | Decision;

export interface Campaign {
  id: string;
  name: string;
  required_pieces: Piece[];
  created_at: string;
}

export interface Delivery {
  id: string;
  campaign_id: string;
  created_at: string;
}

export interface Review {
  id: string;
  piece_version_id: string;
  decision: Decision;
  created_at: string;
}

export interface Comment {
  id: string;
  piece_version_id: string;
  body: string;
  timestamp_seconds: number | null;
  created_at: string;
}

export interface PieceVersion {
  id: string;
  delivery_id: string;
  piece: Piece;
  version: number;
  asset_url: string;
  status: VersionStatus;
  created_at: string;
  reviewed_at: string | null;
}

export interface VersionDetail extends PieceVersion {
  reviews: Review[];
  comments: Comment[];
}

export interface Approval {
  id: string;
  delivery_id: string;
  approved_at: string;
  required_versions: Partial<Record<Piece, string>>;
  invalidated_at: string | null;
  invalidated_by_version_id: string | null;
  invalidation_reason: 'new_version' | 'review_changed' | null;
}

export interface PendingPiece {
  piece: Piece;
  reason: 'missing' | 'pending' | 'changes_requested';
  current_version_id: string | null;
}

export interface DeliveryDetail extends Delivery {
  required_pieces: Piece[];
  status: 'in_production' | 'approved';
  approved: boolean;
  approved_at: string | null;
  pending_pieces: PendingPiece[];
  pieces: Record<Piece, {
    required: boolean;
    current_version_id: string | null;
    versions: VersionDetail[];
  }>;
  approvals: Approval[];
}

export class ApiError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    public readonly code: string,
    message: string,
    public readonly pendingPieces?: PendingPiece[],
  ) {
    super(message);
  }
}
