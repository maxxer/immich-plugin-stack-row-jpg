import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AssetLike,
  findSiblings,
  orderForStack,
  parseExtensionList,
  resolveConfig,
  splitFileName,
} from '../src/matching.ts';
import { type HttpRequest, buildSearchQuery, stackAsset } from '../src/stacker.ts';

const OWNER = 'owner-1';
const config = resolveConfig({ apiKey: 'key' });

let counter = 0;
const asset = (originalFileName: string, overrides: Partial<AssetLike> = {}): AssetLike => ({
  id: `id-${originalFileName}-${counter++}`,
  ownerId: OWNER,
  type: 'IMAGE',
  originalFileName,
  fileCreatedAt: '2026-10-20T10:00:00.000Z',
  stackId: null,
  exifInfo: { make: 'SONY', model: 'ILCE-7M4' },
  ...overrides,
});

/** Fake Immich API: answers search with `library`, records stack calls. */
const fakeServer = (library: AssetLike[], stackStatus = 201) => {
  const calls: { url: string; body: any; headers?: Record<string, string> }[] = [];
  const request: HttpRequest = (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, body, headers: options?.headers });
    if (url.endsWith('/api/search/metadata')) {
      const prefix = body.filter.originalFileName.startsWith.toLowerCase();
      const items = library.filter((a) => a.originalFileName.toLowerCase().startsWith(prefix) && !a.stackId);
      return { ok: true, status: 200, body: JSON.stringify({ assets: { items } }) };
    }
    if (url.endsWith('/api/stacks')) {
      return { ok: stackStatus < 300, status: stackStatus, body: JSON.stringify({ id: 'stack-1' }) };
    }
    return { ok: false, status: 404, body: 'not found' };
  };
  return { request, calls };
};

describe('config', () => {
  it('requires an API key', () => {
    assert.throws(() => resolveConfig({}), /API key/);
    assert.throws(() => resolveConfig({ apiKey: '   ' }), /API key/);
  });

  it('applies defaults', () => {
    assert.equal(config.serverUrl, 'http://localhost:2283');
    assert.equal(config.primary, 'JPEG/HEIC');
    assert.equal(config.maxTimeDifferenceSeconds, 2);
    assert.equal(config.matchCamera, true);
    assert.ok(config.rawExtensions.includes('arw'));
  });

  it('normalises server URL and extension lists', () => {
    const custom = resolveConfig({
      apiKey: 'k',
      serverUrl: 'http://immich-server:2283/api/',
      rawExtensions: ' .ARW; cr3 ,nef',
      maxTimeDifferenceSeconds: 0,
    });
    assert.equal(custom.serverUrl, 'http://immich-server:2283');
    assert.deepEqual(custom.rawExtensions, ['arw', 'cr3', 'nef']);
    assert.equal(custom.maxTimeDifferenceSeconds, 0);
  });

  it('falls back when the extension list is empty', () => {
    assert.deepEqual(parseExtensionList('', ['jpg']), ['jpg']);
  });
});

describe('splitFileName', () => {
  it('splits on the last dot', () => {
    assert.deepEqual(splitFileName('DSC01234.ARW'), { stem: 'DSC01234', ext: 'arw' });
    assert.deepEqual(splitFileName('trip.day1.JPG'), { stem: 'trip.day1', ext: 'jpg' });
    assert.equal(splitFileName('README'), undefined);
    assert.equal(splitFileName('.hidden'), undefined);
  });
});

describe('findSiblings', () => {
  it('pairs RAW and JPEG with the same stem', () => {
    const jpg = asset('DSC01234.JPG');
    const raw = asset('DSC01234.ARW');
    assert.deepEqual(findSiblings(jpg, [jpg, raw], config), [raw]);
  });

  it('is case-insensitive on stem and extension', () => {
    const jpg = asset('dsc01234.jpg');
    const raw = asset('DSC01234.ARW');
    assert.deepEqual(findSiblings(jpg, [raw], config), [raw]);
  });

  it('ignores files whose stem only shares a prefix', () => {
    const jpg = asset('DSC0123.JPG');
    assert.deepEqual(findSiblings(jpg, [asset('DSC01234.ARW'), asset('DSC0123-edit.ARW')], config), []);
  });

  it('ignores another owner, a different camera, or a capture time too far apart', () => {
    const jpg = asset('DSC01234.JPG');
    const candidates = [
      asset('DSC01234.ARW', { ownerId: 'someone-else' }),
      asset('DSC01234.ARW', { exifInfo: { make: 'Canon', model: 'EOS R5' } }),
      asset('DSC01234.ARW', { fileCreatedAt: '2026-10-20T10:00:05.000Z' }),
    ];
    assert.deepEqual(findSiblings(jpg, candidates, config), []);
  });

  it('accepts sub-second differences and missing camera info', () => {
    const jpg = asset('DSC01234.JPG', { fileCreatedAt: '2026-10-20T10:00:00.640Z' });
    const raw = asset('DSC01234.ARW', { exifInfo: null });
    assert.deepEqual(findSiblings(jpg, [raw], config), [raw]);
  });

  it('can disable time and camera checks', () => {
    const relaxed = resolveConfig({ apiKey: 'k', maxTimeDifferenceSeconds: 0, matchCamera: false });
    const jpg = asset('DSC01234.JPG');
    const raw = asset('DSC01234.ARW', { fileCreatedAt: '2025-01-01T00:00:00Z', exifInfo: { make: 'Canon' } });
    assert.deepEqual(findSiblings(jpg, [raw], relaxed), [raw]);
  });

  it('does not pair two files with the same extension (duplicates)', () => {
    const jpg = asset('DSC01234.JPG');
    assert.deepEqual(findSiblings(jpg, [asset('DSC01234.jpg')], config), []);
  });

  it('skips stacked, trashed, video, and unconfigured files', () => {
    const jpg = asset('DSC01234.JPG');
    const candidates = [
      asset('DSC01234.ARW', { stackId: 'existing' }),
      asset('DSC01234.CR3', { isTrashed: true }),
      asset('DSC01234.MP4', { type: 'VIDEO' }),
      asset('DSC01234.XMP'),
    ];
    assert.deepEqual(findSiblings(jpg, candidates, config), []);
  });

  it('returns nothing when the asset itself is not eligible', () => {
    const png = asset('DSC01234.PNG');
    assert.deepEqual(findSiblings(png, [asset('DSC01234.ARW')], config), []);
  });
});

describe('orderForStack', () => {
  const raw = asset('IMG_0001.CR3', { id: 'b' });
  const jpg = asset('IMG_0001.JPG', { id: 'c' });
  const heic = asset('IMG_0001.HEIC', { id: 'a' });

  it('puts the JPEG first by default, preferring earlier extensions', () => {
    assert.deepEqual(
      orderForStack([raw, heic, jpg], config).map((a) => a.originalFileName),
      ['IMG_0001.JPG', 'IMG_0001.HEIC', 'IMG_0001.CR3'],
    );
  });

  it('puts the RAW first when configured', () => {
    const rawFirst = resolveConfig({ apiKey: 'k', primary: 'RAW' });
    assert.equal(orderForStack([jpg, raw], rawFirst)[0], raw);
  });

  it('is deterministic regardless of which file triggered', () => {
    assert.deepEqual(orderForStack([raw, jpg], config), orderForStack([jpg, raw], config));
  });
});

describe('buildSearchQuery', () => {
  it('searches by stem prefix with a time window, unstacked images only', () => {
    const query = buildSearchQuery(asset('DSC01234.JPG'), 'DSC01234', config);
    assert.deepEqual(query.filter.originalFileName, { startsWith: 'DSC01234.' });
    assert.deepEqual(query.filter.type, { eq: 'IMAGE' });
    assert.deepEqual(query.filter.takenAt, { gte: '2026-10-20T09:59:57.000Z', lte: '2026-10-20T10:00:03.000Z' });
    assert.equal(query.withStacked, false);
    assert.equal(query.withExif, true);
  });

  it('omits the time window when disabled', () => {
    const query = buildSearchQuery(asset('A.JPG'), 'A', resolveConfig({ apiKey: 'k', maxTimeDifferenceSeconds: 0 }));
    assert.equal(query.filter.takenAt, undefined);
  });
});

describe('stackAsset', () => {
  it('creates a stack with the JPEG as cover, sending the API key', () => {
    const jpg = asset('DSC01234.JPG');
    const raw = asset('DSC01234.ARW');
    const { request, calls } = fakeServer([jpg, raw, asset('DSC09999.ARW')]);

    const result = stackAsset(raw, config, request);

    assert.deepEqual(result, { action: 'stacked', stackId: 'stack-1', assetIds: [jpg.id, raw.id] });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'http://localhost:2283/api/search/metadata');
    assert.equal(calls[0].headers?.['x-api-key'], 'key');
    assert.equal(calls[1].url, 'http://localhost:2283/api/stacks');
    assert.deepEqual(calls[1].body, { assetIds: [jpg.id, raw.id] });
  });

  it('waits when the sibling has not been uploaded yet', () => {
    const raw = asset('DSC01234.ARW');
    const { request, calls } = fakeServer([raw]);
    assert.equal(stackAsset(raw, config, request).action, 'skipped');
    assert.equal(calls.length, 1);
  });

  it('does not call the API for ineligible assets', () => {
    const { request, calls } = fakeServer([]);
    assert.equal(stackAsset(asset('clip.MOV', { type: 'VIDEO' }), config, request).action, 'skipped');
    assert.equal(stackAsset(asset('A.JPG', { stackId: 's' }), config, request).action, 'skipped');
    assert.equal(calls.length, 0);
  });

  it('surfaces API errors so the workflow run is logged as failed', () => {
    const jpg = asset('X.JPG');
    const raw = asset('X.ARW');
    const { request } = fakeServer([jpg, raw], 400);
    assert.throws(() => stackAsset(jpg, config, request), /POST \/stacks failed with 400/);
  });
});
