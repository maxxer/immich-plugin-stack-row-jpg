import {
  type AssetLike,
  type StackerConfig,
  findSiblings,
  getEligibility,
  isCompleteGroup,
  orderForStack,
} from './matching.ts';

export type HttpRequest = (
  url: string,
  options?: { method?: string; headers?: Record<string, string>; body?: string },
) => { ok: unknown; status: number; body: string };

export type Logger = { debug: (message: string) => void; info: (message: string) => void };

export type StackResult =
  | { action: 'skipped'; reason: string }
  | { action: 'stacked'; stackId: string; assetIds: string[] };

type SearchResponse = { assets?: { items?: AssetLike[] } };

const call = <T>(request: HttpRequest, config: StackerConfig, path: string, body: unknown): T => {
  const response = request(`${config.serverUrl}/api${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': config.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`raw-jpg-stacker: POST ${path} failed with ${response.status}: ${response.body.slice(0, 500)}`);
  }

  return (response.body ? JSON.parse(response.body) : {}) as T;
};

/** Server-side search: same file stem, images only, not already stacked, around the same capture time. */
export const buildSearchQuery = (asset: AssetLike, stem: string, config: StackerConfig) => {
  const filter: Record<string, unknown> = {
    originalFileName: { startsWith: `${stem}.` },
    type: { eq: 'IMAGE' },
  };

  if (config.maxTimeDifferenceSeconds > 0) {
    const takenAt = new Date(asset.fileCreatedAt).getTime();
    if (!Number.isNaN(takenAt)) {
      // one extra second of slack; the exact check happens client-side
      const window = (config.maxTimeDifferenceSeconds + 1) * 1000;
      filter.takenAt = {
        gte: new Date(takenAt - window).toISOString(),
        lte: new Date(takenAt + window).toISOString(),
      };
    }
  }

  return { filter, withStacked: false, withExif: true, size: 100 };
};

export const stackAsset = (
  asset: AssetLike,
  config: StackerConfig,
  request: HttpRequest,
  log: Logger = { debug: () => {}, info: () => {} },
): StackResult => {
  const eligibility = getEligibility(asset, config);
  if (!eligibility.ok) {
    log.debug(`raw-jpg-stacker: skip ${asset.originalFileName}: ${eligibility.reason}`);
    return { action: 'skipped', reason: eligibility.reason };
  }

  const search = call<SearchResponse>(request, config, '/search/metadata', buildSearchQuery(asset, eligibility.stem, config));
  const siblings = findSiblings(asset, search.assets?.items ?? [], config);
  const group = orderForStack([asset, ...siblings], config);

  if (!isCompleteGroup(group, config)) {
    const reason = siblings.length === 0 ? 'no matching RAW/JPEG sibling yet' : 'group has no RAW + JPEG/HEIC pair';
    log.debug(`raw-jpg-stacker: skip ${asset.originalFileName}: ${reason}`);
    return { action: 'skipped', reason };
  }

  const assetIds = group.map(({ id }) => id);
  const stack = call<{ id: string }>(request, config, '/stacks', { assetIds });

  log.info(`raw-jpg-stacker: stacked ${group.map(({ originalFileName }) => originalFileName).join(' + ')} (stack ${stack.id})`);
  return { action: 'stacked', stackId: stack.id, assetIds };
};
