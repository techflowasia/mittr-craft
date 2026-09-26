import type { Session } from '@opencode-ai/sdk/v2';

export type SessionMetadataRecord = Record<string, unknown>;

type MittrCraftMetadata = {
  kind?: 'review';
  originalSessionID?: string;
  reviewSessionID?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const getSessionMetadata = (session: Session | null | undefined): SessionMetadataRecord => {
  const metadata = (session as (Session & { metadata?: unknown }) | null | undefined)?.metadata;
  return isRecord(metadata) ? metadata : {};
};

const getMittrCraftMetadata = (metadata: SessionMetadataRecord): MittrCraftMetadata => {
  const value = metadata.mittrcraft;
  return isRecord(value) ? value as MittrCraftMetadata : {};
};

export const getReviewSessionID = (session: Session | null | undefined): string | null => {
  const value = getMittrCraftMetadata(getSessionMetadata(session)).reviewSessionID;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

export const getOriginalSessionID = (session: Session | null | undefined): string | null => {
  const value = getMittrCraftMetadata(getSessionMetadata(session)).originalSessionID;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

export const isReviewSession = (session: Session | null | undefined): boolean =>
  getMittrCraftMetadata(getSessionMetadata(session)).kind === 'review' && Boolean(getOriginalSessionID(session));

export const withReviewSessionLink = (
  metadata: SessionMetadataRecord,
  reviewSessionID: string,
): SessionMetadataRecord => {
  const current = getMittrCraftMetadata(metadata);
  return {
    ...metadata,
    mittrcraft: {
      ...current,
      reviewSessionID,
    },
  };
};

export const withReviewSessionMarker = (
  metadata: SessionMetadataRecord,
  originalSessionID: string,
): SessionMetadataRecord => {
  const current = getMittrCraftMetadata(metadata);
  return {
    ...metadata,
    mittrcraft: {
      ...current,
      kind: 'review' as const,
      originalSessionID,
    },
  };
};

export const withoutReviewSessionLink = (
  metadata: SessionMetadataRecord,
  reviewSessionID: string,
): SessionMetadataRecord => {
  const current = getMittrCraftMetadata(metadata);
  if (current.reviewSessionID !== reviewSessionID) return metadata;

  const restMittrCraft = { ...current };
  delete restMittrCraft.reviewSessionID;
  const next: SessionMetadataRecord = { ...metadata };
  if (Object.keys(restMittrCraft).length > 0) {
    next.mittrcraft = restMittrCraft;
  } else {
    delete next.mittrcraft;
  }
  return next;
};
