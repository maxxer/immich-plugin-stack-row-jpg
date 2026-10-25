/**
 * Pure matching logic: no host calls, so it can be unit tested with plain Node.
 */

export type Primary = 'JPEG/HEIC' | 'RAW';

export type StackerConfig = {
  serverUrl: string;
  apiKey: string;
  rawExtensions: string[];
  companionExtensions: string[];
  primary: Primary;
  maxTimeDifferenceSeconds: number;
  matchCamera: boolean;
};

/** Minimal view of an asset, shared by the workflow payload and the search API response. */
export type AssetLike = {
  id: string;
  ownerId: string;
  type: string;
  originalFileName: string;
  fileCreatedAt: string;
  stackId?: string | null;
  isTrashed?: boolean;
  deletedAt?: string | null;
  exifInfo?: { make?: string | null; model?: string | null } | null;
};

export type FileKind = 'raw' | 'companion';

export const DEFAULT_RAW_EXTENSIONS = [
  'arw', 'srf', 'sr2', // Sony
  'cr2', 'cr3', 'crw', // Canon
  'nef', 'nrw', // Nikon
  'raf', // Fujifilm
  'orf', 'ori', // OM System / Olympus
  'rw2', 'raw', // Panasonic, Leica
  'dng', // Adobe / Leica / Pentax / phones
  'pef', // Pentax
  'srw', // Samsung
  'x3f', // Sigma
  'iiq', // Phase One
  '3fr', 'fff', // Hasselblad
  'erf', 'mef', 'mos', 'mrw', 'kdc', 'dcr', 'rwl', // other
];

export const DEFAULT_COMPANION_EXTENSIONS = ['jpg', 'jpeg', 'heic', 'heif', 'hif'];

export const DEFAULTS: Omit<StackerConfig, 'apiKey'> = {
  serverUrl: 'http://localhost:2283',
  rawExtensions: DEFAULT_RAW_EXTENSIONS,
  companionExtensions: DEFAULT_COMPANION_EXTENSIONS,
  primary: 'JPEG/HEIC',
  maxTimeDifferenceSeconds: 2,
  matchCamera: true,
};

/** Accepts "arw, .CR3;nef" or an array, returns ['arw', 'cr3', 'nef']. */
export const parseExtensionList = (value: unknown, fallback: string[]): string[] => {
  const raw = Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '';
  const list = raw
    .split(/[\s,;]+/)
    .map((ext) => ext.trim().replace(/^\./, '').toLowerCase())
    .filter((ext) => ext.length > 0);
  return list.length > 0 ? [...new Set(list)] : fallback;
};

/** Workflow config values are optional and untyped: apply defaults and validate. */
export const resolveConfig = (input: Record<string, unknown> | null | undefined): StackerConfig => {
  const config = input ?? {};
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  if (!apiKey) {
    throw new Error('raw-jpg-stacker: "API key" is not set in the workflow step configuration');
  }

  const serverUrl =
    typeof config.serverUrl === 'string' && config.serverUrl.trim()
      ? config.serverUrl.trim().replace(/\/+$/, '').replace(/\/api$/, '')
      : DEFAULTS.serverUrl;

  const seconds = Number(config.maxTimeDifferenceSeconds);
  const maxTimeDifferenceSeconds =
    config.maxTimeDifferenceSeconds === undefined || config.maxTimeDifferenceSeconds === null || Number.isNaN(seconds)
      ? DEFAULTS.maxTimeDifferenceSeconds
      : Math.max(0, seconds);

  return {
    serverUrl,
    apiKey,
    rawExtensions: parseExtensionList(config.rawExtensions, DEFAULTS.rawExtensions),
    companionExtensions: parseExtensionList(config.companionExtensions, DEFAULTS.companionExtensions),
    primary: config.primary === 'RAW' ? 'RAW' : 'JPEG/HEIC',
    maxTimeDifferenceSeconds,
    matchCamera: typeof config.matchCamera === 'boolean' ? config.matchCamera : DEFAULTS.matchCamera,
  };
};

/** "DSC01234.ARW" -> { stem: "DSC01234", ext: "arw" }. Files without an extension return undefined. */
export const splitFileName = (fileName: string): { stem: string; ext: string } | undefined => {
  const index = fileName.lastIndexOf('.');
  if (index <= 0 || index === fileName.length - 1) {
    return undefined;
  }
  return { stem: fileName.slice(0, index), ext: fileName.slice(index + 1).toLowerCase() };
};

export const getKind = (fileName: string, config: StackerConfig): FileKind | undefined => {
  const parts = splitFileName(fileName);
  if (!parts) {
    return undefined;
  }
  if (config.rawExtensions.includes(parts.ext)) {
    return 'raw';
  }
  if (config.companionExtensions.includes(parts.ext)) {
    return 'companion';
  }
  return undefined;
};

const normalize = (value?: string | null) => (value ?? '').trim().toLowerCase();

const sameCamera = (a: AssetLike, b: AssetLike) => {
  const makeA = normalize(a.exifInfo?.make);
  const makeB = normalize(b.exifInfo?.make);
  const modelA = normalize(a.exifInfo?.model);
  const modelB = normalize(b.exifInfo?.model);
  // only reject when both sides know the value and they disagree
  if (makeA && makeB && makeA !== makeB) {
    return false;
  }
  if (modelA && modelB && modelA !== modelB) {
    return false;
  }
  return true;
};

const timeDifferenceSeconds = (a: AssetLike, b: AssetLike) =>
  Math.abs(new Date(a.fileCreatedAt).getTime() - new Date(b.fileCreatedAt).getTime()) / 1000;

/** Should this asset be processed at all? Returns its kind and stem, or a reason to skip. */
export const getEligibility = (
  asset: AssetLike,
  config: StackerConfig,
): { ok: true; kind: FileKind; stem: string } | { ok: false; reason: string } => {
  if (asset.type !== 'IMAGE') {
    return { ok: false, reason: `not an image (${asset.type})` };
  }
  if (asset.stackId) {
    return { ok: false, reason: 'already in a stack' };
  }
  if (asset.deletedAt || asset.isTrashed) {
    return { ok: false, reason: 'in trash' };
  }
  const parts = splitFileName(asset.originalFileName);
  const kind = getKind(asset.originalFileName, config);
  if (!parts || !kind) {
    return { ok: false, reason: `extension not configured (${asset.originalFileName})` };
  }
  return { ok: true, kind, stem: parts.stem };
};

/** Filter search results down to the assets that belong in the same stack as `asset`. */
export const findSiblings = (asset: AssetLike, candidates: AssetLike[], config: StackerConfig): AssetLike[] => {
  const self = getEligibility(asset, config);
  if (!self.ok) {
    return [];
  }

  const stem = self.stem.toLowerCase();
  const ownExt = splitFileName(asset.originalFileName)!.ext;
  const seen = new Set<string>([asset.id]);
  const siblings: AssetLike[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.id)) {
      continue;
    }
    seen.add(candidate.id);

    const eligibility = getEligibility(candidate, config);
    if (!eligibility.ok || candidate.ownerId !== asset.ownerId) {
      continue;
    }
    if (eligibility.stem.toLowerCase() !== stem) {
      continue;
    }
    // a second file with the very same extension is a duplicate, not a RAW+JPG pair
    if (splitFileName(candidate.originalFileName)!.ext === ownExt) {
      continue;
    }
    if (config.maxTimeDifferenceSeconds > 0 && timeDifferenceSeconds(asset, candidate) > config.maxTimeDifferenceSeconds) {
      continue;
    }
    if (config.matchCamera && !sameCamera(asset, candidate)) {
      continue;
    }
    siblings.push(candidate);
  }

  return siblings;
};

/**
 * Deterministic order: preferred kind first, then by position in the extension list, then by id.
 * Both files of a pair may be processed at the same time; because both runs produce the same
 * order (same primary), Immich merges the two stacks into one instead of fighting over the cover.
 */
export const orderForStack = (assets: AssetLike[], config: StackerConfig): AssetLike[] => {
  const preferred: FileKind = config.primary === 'RAW' ? 'raw' : 'companion';
  const rank = (asset: AssetLike) => {
    const kind = getKind(asset.originalFileName, config);
    const ext = splitFileName(asset.originalFileName)?.ext ?? '';
    const list = kind === 'raw' ? config.rawExtensions : config.companionExtensions;
    return { kindRank: kind === preferred ? 0 : 1, extRank: list.indexOf(ext) };
  };

  return [...assets].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra.kindRank - rb.kindRank || ra.extRank - rb.extRank || a.id.localeCompare(b.id);
  });
};

/** A valid group needs at least one RAW and one companion file. */
export const isCompleteGroup = (assets: AssetLike[], config: StackerConfig) => {
  const kinds = new Set(assets.map((asset) => getKind(asset.originalFileName, config)));
  return kinds.has('raw') && kinds.has('companion');
};
