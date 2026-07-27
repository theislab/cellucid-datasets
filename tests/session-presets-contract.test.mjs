import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const EXPORTS_ROOT = path.join(REPOSITORY_ROOT, 'exports');
const MAGIC = Buffer.from('CELLUCID_SESSION\n', 'utf8');
const PUBLICATION_MANIFEST_BYTES =
  '{ "states": ["default.cellucid-session"] }\n';
const CATALOG = JSON.parse(
  await readFile(path.join(EXPORTS_ROOT, 'datasets.json'), 'utf8'),
);
const EXPECTED = Object.freeze({
  suo: Object.freeze({
    cellCount: 561_947,
    varCount: 8_192,
    sha256: '5581569118eaa992d36cd3ce53cde0aa488d27b45f89b8f1a41d56de8f7b7a67',
  }),
  garcia: Object.freeze({
    cellCount: 219_731,
    varCount: 8_192,
    sha256: '3ebb88c01bc15edd6c3856c186065db5de7a7ac0c78c5bd62b6db439e4862ffc',
  }),
  he: Object.freeze({
    cellCount: 71_650,
    varCount: 8_192,
    sha256: '7959d6d4d0888ce9bf0f74f2a7cf807455503d5448723b582771d45d078c8e3c',
  }),
  kanemaru: Object.freeze({
    cellCount: 131_636,
    varCount: 8_192,
    sha256: '9d8029a362ae8545b14e0b755e906414d87411ad26ee7dbc1d173ee9f68837f5',
  }),
  pancreas: Object.freeze({
    cellCount: 3_696,
    varCount: 3_753,
    sha256: '53a182ea444b34bf65d2f0c83c5aac7eca195c2912680761052ab66b30d22433',
  }),
});
const EXPECTED_CAMERA = Object.freeze({
  navigationMode: 'orbit',
  orbit: Object.freeze({
    radius: 2.43,
    targetRadius: 2.43,
    theta: Math.PI / 4,
    phi: Math.PI / 4,
    target: Object.freeze([0, 0, 0]),
  }),
  freefly: Object.freeze({
    position: Object.freeze([
      1.215,
      1.7182694782833108,
      1.2149999999999999,
    ]),
    yaw: -3 * Math.PI / 4,
    pitch: -0.7853981633974484,
  }),
});
const EXPECTED_CHUNK_IDS = Object.freeze([
  'analysis/windows',
  'core/field-overlays',
  'core/state',
  'highlights/meta',
  'ui/dockable-layout',
]);

function assertExactKeys(value, expected, label) {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${label} must contain exactly the current fields`,
  );
}

function readU32(buffer, offset, label) {
  assert.ok(
    offset + 4 <= buffer.length,
    `${label} length prefix must fit inside the session`,
  );
  return buffer.readUInt32LE(offset);
}

function decodeSession(buffer, label) {
  assert.equal(
    buffer.subarray(0, MAGIC.length).compare(MAGIC),
    0,
    `${label} must use the current Cellucid session magic`,
  );
  let offset = MAGIC.length;
  const manifestLength = readU32(buffer, offset, `${label} manifest`);
  offset += 4;
  assert.ok(manifestLength > 0, `${label} manifest must be non-empty`);
  assert.ok(
    offset + manifestLength <= buffer.length,
    `${label} manifest must fit inside the session`,
  );
  const manifest = JSON.parse(
    buffer.subarray(offset, offset + manifestLength).toString('utf8'),
  );
  offset += manifestLength;
  assertExactKeys(
    manifest,
    ['createdAt', 'datasetFingerprint', 'chunks'],
    `${label} manifest`,
  );
  assert.equal(
    new Date(manifest.createdAt).toISOString(),
    manifest.createdAt,
    `${label} createdAt must be canonical ISO`,
  );
  assert.ok(Array.isArray(manifest.chunks), `${label} chunks must be an array`);

  const chunks = new Map();
  for (const [index, meta] of manifest.chunks.entries()) {
    assertExactKeys(
      meta,
      [
        'id',
        'contributorId',
        'priority',
        'kind',
        'codec',
        'label',
        'datasetDependent',
        'storedBytes',
        'uncompressedBytes',
      ],
      `${label} chunk ${index}`,
    );
    const storedLength = readU32(buffer, offset, `${label} chunk ${index}`);
    offset += 4;
    assert.equal(
      storedLength,
      meta.storedBytes,
      `${label} chunk ${meta.id} stored length`,
    );
    assert.ok(
      offset + storedLength <= buffer.length,
      `${label} chunk ${meta.id} must fit inside the session`,
    );
    const stored = buffer.subarray(offset, offset + storedLength);
    offset += storedLength;
    const decoded = meta.codec === 'gzip' ? gunzipSync(stored) : stored;
    assert.equal(
      decoded.length,
      meta.uncompressedBytes,
      `${label} chunk ${meta.id} decoded length`,
    );
    assert.equal(chunks.has(meta.id), false, `${label} repeats chunk ${meta.id}`);
    chunks.set(
      meta.id,
      meta.kind === 'json' ? JSON.parse(decoded.toString('utf8')) : decoded,
    );
  }
  assert.equal(offset, buffer.length, `${label} must not contain trailing bytes`);
  return { manifest, chunks };
}

async function findPublishedDatasetStateArtifacts(directory) {
  const published = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      published.push(...await findPublishedDatasetStateArtifacts(absolute));
    } else if (
      entry.isFile()
      && (
        entry.name.endsWith('.cellucid-session')
        || entry.name === 'state-snapshots.json'
      )
    ) {
      published.push(toRepositoryRelativePath(EXPORTS_ROOT, absolute));
    }
  }
  return published.sort();
}

function toRepositoryRelativePath(root, absolute, pathApi = path) {
  return pathApi.relative(root, absolute).split(pathApi.sep).join('/');
}

test('state artifact inventory uses portable repository paths', () => {
  assert.equal(
    toRepositoryRelativePath(
      'D:\\workspace\\exports',
      'D:\\workspace\\exports\\suo\\default.cellucid-session',
      path.win32,
    ),
    'suo/default.cellucid-session',
  );
  assert.equal(
    toRepositoryRelativePath(
      '/workspace/exports',
      '/workspace/exports/suo/state-snapshots.json',
      path.posix,
    ),
    'suo/state-snapshots.json',
  );
});

test('sample presets are exact generation sidecars with no top-level session store', async () => {
  await assert.rejects(
    readdir(path.join(REPOSITORY_ROOT, 'sessions')),
    { code: 'ENOENT' },
    'the retired top-level sessions directory must remain absent',
  );
  assert.deepEqual(
    await findPublishedDatasetStateArtifacts(EXPORTS_ROOT),
    Object.keys(EXPECTED)
      .flatMap(datasetId => [
        `${datasetId}/default.cellucid-session`,
        `${datasetId}/state-snapshots.json`,
      ])
      .sort(),
  );
});

for (const [datasetId, expected] of Object.entries(EXPECTED)) {
  test(`${datasetId} preset is a current close-up cell_type state`, async () => {
    const directory = path.join(EXPORTS_ROOT, datasetId);
    const catalogEntry = CATALOG.datasets.find(entry => entry.id === datasetId);
    assert.ok(catalogEntry, `catalog must contain ${datasetId}`);
    assert.equal(catalogEntry.state_manifest, 'state-snapshots.json');
    assert.equal(catalogEntry.state_sha256, expected.sha256);
    const publicationManifestPath = path.join(
      directory,
      catalogEntry.state_manifest,
    );
    const publicationManifestBytes = await readFile(
      publicationManifestPath,
      'utf8',
    );
    assert.equal(publicationManifestBytes, PUBLICATION_MANIFEST_BYTES);
    const publicationManifest = JSON.parse(publicationManifestBytes);
    assertExactKeys(
      publicationManifest,
      ['states'],
      `${datasetId} publication manifest`,
    );
    assert.deepEqual(publicationManifest.states, [
      'default.cellucid-session',
    ]);
    const [filename] = publicationManifest.states;
    assert.equal(filename, path.basename(filename));
    assert.match(
      filename,
      /^[A-Za-z0-9][A-Za-z0-9._-]*\.cellucid-session$/,
      `${datasetId} publication manifest must use one safe local basename`,
    );

    const label = `${datasetId}/${filename}`;
    const bytes = await readFile(path.join(directory, filename));
    assert.ok(bytes.length < 32 * 1024, `${label} must remain lightweight`);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      catalogEntry.state_sha256,
      `${label} bytes must match its catalog-pinned reviewed UI-authored state`,
    );

    const { manifest, chunks } = decodeSession(bytes, label);
    assert.deepEqual([...chunks.keys()].sort(), EXPECTED_CHUNK_IDS);
    assertExactKeys(
      manifest.datasetFingerprint,
      ['sourceType', 'datasetId', 'cellCount', 'varCount'],
      `${label} fingerprint`,
    );
    assert.deepEqual(manifest.datasetFingerprint, {
      sourceType: 'local-demo',
      datasetId,
      cellCount: expected.cellCount,
      varCount: expected.varCount,
    });
    assert.equal(
      chunks.has('cinematic/camera'),
      false,
      `${label} must not start or contain a moving camera path`,
    );
    assert.equal(chunks.has('core/state'), true);

    const core = chunks.get('core/state');
    assertExactKeys(
      core,
      [
        'camera',
        'liveDimensionLevel',
        'uiControls',
        'filters',
        'activeFields',
        'multiview',
      ],
      `${label} core state`,
    );
    assert.deepEqual(core.activeFields, {
      activeFieldKey: 'cell_type',
      activeFieldSource: 'obs',
    });
    assert.deepEqual(core.filters, {});
    assert.equal(core.liveDimensionLevel, 3);
    assert.deepEqual(core.camera, EXPECTED_CAMERA);
    assert.equal(core.uiControls['theme-select'].value, 'light');
    assert.equal(core.uiControls['background-select'].value, 'grid');

    assertExactKeys(
      core.multiview,
      ['layout', 'camerasLocked', 'liveCameraState', 'snapshots'],
      `${label} multiview state`,
    );
    assert.equal(core.multiview.camerasLocked, true);
    assert.deepEqual(core.multiview.snapshots, []);
    assert.deepEqual(core.multiview.liveCameraState, EXPECTED_CAMERA);
    assert.deepEqual(core.multiview.layout, {
      mode: 'grid',
      activeId: 'live',
      liveViewHidden: false,
    });
  });
}
