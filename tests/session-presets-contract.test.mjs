import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import { describeStore, readArray, readObsm } from '../scripts/anndata_store.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ANNDATA_ROOT = path.join(REPOSITORY_ROOT, 'anndata');
/** Session format 2: the format version is part of the signature. */
const MAGIC = Buffer.from('CELLUCID_SESSION/2\n', 'utf8');
const CATALOG = JSON.parse(await readFile(path.join(ANNDATA_ROOT, 'datasets.json'), 'utf8'));

/**
 * The reviewed starting view of every sample, pinned per dataset.
 *
 * `cellOrderDigest` is the application's digest of the 3-D coordinates the
 * store holds, in row order, after the viewer's in-place normalization. The
 * application recomputes it from the loaded dataset and refuses a preset whose
 * digest disagrees, so pinning it here is what lets this suite see a preset go
 * stale. The digests and cameras are the ones the reviewed presets carried
 * before the samples became AnnData stores: the stores lay out the same cells
 * at the same coordinates, and each preset was re-captured in the viewer on
 * its store with that reviewed view restored. Suo's and Garcia's cameras sat
 * inside their clouds (orbit radius 0.88 and 1.11 on coordinates normalized
 * to about [-1, 1]); they keep their reviewed direction and are pulled back
 * to radius 3 and 2.6, which frame the whole cloud.
 */
const EXPECTED = Object.freeze({
  suo: Object.freeze({
    cellCount: 561_947,
    varCount: 5_103,
    cellOrderDigest: 'a229f7d3347dbb46',
    camera: Object.freeze({
      navigationMode: 'orbit',
      orbit: Object.freeze({
        radius: 3,
        targetRadius: 3,
        theta: 2.861307695117691,
        phi: 1.7024549527672228,
        target: Object.freeze([0, 0, 0]),
      }),
      freefly: Object.freeze({
        position: Object.freeze([
          -2.8579796752272966,
          -0.3938357815841482,
          0.8227062374454679,
        ]),
        yaw: -0.2802849584721022,
        pitch: 0.1316586259723262,
      }),
    }),
  }),
  garcia: Object.freeze({
    cellCount: 219_731,
    varCount: 5_754,
    cellOrderDigest: 'd3a48cc719afee0b',
    camera: Object.freeze({
      navigationMode: 'orbit',
      orbit: Object.freeze({
        radius: 2.6,
        targetRadius: 2.6,
        theta: 1.4576226052247212,
        phi: 1.79557114622099,
        target: Object.freeze([0, 0, 0]),
      }),
      freefly: Object.freeze({
        position: Object.freeze([
          0.2862376254240006,
          -0.579505814629773,
          2.518380636957391,
        ]),
        yaw: -1.6839700483650721,
        pitch: 0.22477481942609343,
      }),
    }),
  }),
  he: Object.freeze({
    cellCount: 71_650,
    varCount: 5_152,
    cellOrderDigest: '0174556a9edc0bfc',
    camera: Object.freeze({
      navigationMode: 'orbit',
      orbit: Object.freeze({
        radius: 2.353322246692734,
        targetRadius: 2.353322246692734,
        theta: 0.530398163397444,
        phi: 1.4053981633974426,
        target: Object.freeze([0, 0, 0]),
      }),
      freefly: Object.freeze({
        position: Object.freeze([
          2.002285713714809,
          0.38746291461474713,
          1.1742444410048358,
        ]),
        yaw: -2.611194490192349,
        pitch: -0.16539816339745406,
      }),
    }),
  }),
  kanemaru: Object.freeze({
    cellCount: 131_636,
    varCount: 3_691,
    cellOrderDigest: '2ece95555de9b052',
    camera: Object.freeze({
      navigationMode: 'orbit',
      orbit: Object.freeze({
        radius: 2.0685682285825853,
        targetRadius: 2.0685682285825853,
        theta: 4.058985763658586,
        phi: 1.8019110881013711,
        target: Object.freeze([0, 0, 0]),
      }),
      freefly: Object.freeze({
        position: Object.freeze([
          -1.2240324140008385,
          -0.4738320041178864,
          -1.5988128088210334,
        ]),
        yaw: 0.9173931100687928,
        pitch: 0.23111476130647451,
      }),
    }),
  }),
  pancreas: Object.freeze({
    cellCount: 3_696,
    varCount: 3_753,
    cellOrderDigest: '6a65d001fc13301c',
    camera: Object.freeze({
      navigationMode: 'orbit',
      orbit: Object.freeze({
        radius: 2.24671229236822,
        targetRadius: 2.24671229236822,
        theta: 0.551567528087176,
        phi: 2.170347297568933,
        target: Object.freeze([0, 0, 0]),
      }),
      freefly: Object.freeze({
        position: Object.freeze([
          1.5797929083496445,
          -1.2677564267528365,
          0.9719897807248349,
        ]),
        yaw: -2.5900251255026174,
        pitch: 0.5995509707740364,
      }),
    }),
  }),
});

/** The published bytes of each preset, which `anndata/datasets.json` advertises. */
const EXPECTED_PRESET_SHA256 = Object.freeze({
  suo: 'a326506e1eede81c6cc1842daf4c34154076bf9792318817125fe298dcfeff2a',
  garcia: '3eb27c71ae7e5d0c85c3260624e13061a61925e54a3af9776bb02698c7c92645',
  he: 'd58ddca8c0eaf824cd7c5b99e8f08dbfa2c00099e25c28a829639e6c26fe15d1',
  kanemaru: 'dbe97741eacf1760b2015e35be3043814ef075962668462f167e6962e2571824',
  pancreas: '3b8f564fead7ec796ce4b5155876e0eac4de9f7c1a9902c860c311edbe278bd6',
});
const EXPECTED_CELL_ORDER_DIMENSION = 3;
/**
 * `restorePublishedDefaultState()` accepts an advertised preset only against
 * `PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE`: exactly these chunks, in this
 * order, each declaring exactly this contributor, priority, kind, codec,
 * label, and dataset-dependence. This is a pin, not a second definition: `the
 * pinned published-default profile is the viewer's own` below reads the
 * viewer's profile and fails when the two disagree. The pin exists so this
 * suite still governs the presets when it runs alone, which is how this
 * repository's CI runs it.
 */
const PUBLISHED_DEFAULT_CHUNK_PROFILE = Object.freeze([
  Object.freeze({
    id: 'core/field-overlays',
    contributorId: 'field-overlays',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Field overlays',
    datasetDependent: true,
  }),
  Object.freeze({
    id: 'core/state',
    contributorId: 'core-state',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Core state',
    datasetDependent: true,
  }),
  Object.freeze({
    id: 'ui/dockable-layout',
    contributorId: 'dockable-layout',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Floating panels',
    datasetDependent: false,
  }),
  Object.freeze({
    id: 'ui/figure-export',
    contributorId: 'figure-export',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Figure export',
    datasetDependent: false,
  }),
  Object.freeze({
    id: 'analysis/windows',
    contributorId: 'analysis-windows',
    priority: 'eager',
    kind: 'binary',
    codec: 'gzip',
    label: 'Analysis windows',
    datasetDependent: true,
  }),
  Object.freeze({
    id: 'analysis/docked',
    contributorId: 'analysis-docked',
    priority: 'eager',
    kind: 'binary',
    codec: 'gzip',
    label: 'Docked analysis',
    datasetDependent: true,
  }),
  Object.freeze({
    id: 'highlights/meta',
    contributorId: 'highlights-meta',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Highlight metadata',
    datasetDependent: true,
  }),
]);
/**
 * The controls the application sets from the loaded dataset rather than from
 * the markup, so a capture is expected to disagree with the other four here:
 *
 * - `connectivity-limit`, whose slider maximum is clamped to the edges the
 *   viewer actually loaded (`updateSliderRange()` in
 *   `cellucid/assets/js/app/main.js`).
 * - `velocity-field`, whose option list is rebuilt from the dataset's declared
 *   vector fields (`renderFieldSelectForActiveDim()` in
 *   `cellucid/assets/js/app/ui/modules/velocity-overlay-controls.js`).
 * - `point-size`, computed from the cell count by
 *   `applyDatasetRenderDefaults()` in
 *   `cellucid/assets/js/app/ui/core/ui-coordinator.js`, because one shipped
 *   constant cannot be right for a 3,696-cell trajectory and an 18-million-cell
 *   atlas at once.
 *
 * Every other control is markup the reviewed captures share, so a divergence
 * outside this set is one dataset's view having silently drifted.
 *
 * Membership means a control *may* differ, not that it must: two datasets of
 * similar size can agree on a point size, and that is a fact about the
 * datasets rather than about the presets.
 */
const DATASET_DERIVED_UI_CONTROL_IDS = Object.freeze([
  'connectivity-limit',
  'point-size',
  'velocity-field',
]);
/**
 * The control types `buildCurrentInventory()` produces, in
 * `cellucid/assets/js/app/state-serializer/ui-controls.js`. `pressed-group` is
 * a toolbelt — several buttons of which exactly one is pressed — and it is the
 * one type whose record carries neither a `value`, a `checked` nor an `open`.
 */
const UI_CONTROL_TYPES = Object.freeze([
  'checkbox',
  'color',
  'details',
  'number',
  'pressed-group',
  'range',
  'select',
  'text',
]);
/**
 * The documented reviewed view: `cell_type` colouring, light theme, Studio
 * (light) background, nothing filtered, renamed, floated, kept or reopened.
 */
const EXPECTED_ACTIVE_FIELDS = Object.freeze({ activeFieldKey: 'cell_type', activeFieldSource: 'obs' });
const EXPECTED_THEME = 'light';
const EXPECTED_BACKGROUND = 'studio';
const EXPECTED_FIELD_OVERLAYS = Object.freeze({
  renames: { fields: {}, categories: {} },
  deletedFields: { deleted: [], purged: [] },
  userDefinedFields: [],
});
const EXPECTED_DOCKABLE_LAYOUT = Object.freeze({ panels: [] });
/**
 * Representations a starting view enables beside the store's defaults. Every
 * one is its sample's latent space read at two columns, which the viewer does
 * not show on its own: Pancreas opens with its PCA view enabled, the first
 * two components of the 50-component PCA it measures outliers in.
 */
const EXTRA_ENABLED = Object.freeze({
  pancreas: Object.freeze([{ key: 'X_pca', columns: [0, 1] }]),
});
/** The obs fields the view needs, which the reader checks before applying it. */
const EXPECTED_REQUIRES = Object.freeze({ obs: ['cell_type'], var: [] });
/**
 * The presets are one review pass: re-captured together, so a preset
 * re-captured on its own, months from the others, shows a view nobody looked
 * at beside the rest.
 */
const MAXIMUM_REVIEW_PASS_SPAN_MS = 24 * 60 * 60 * 1000;
const PRESET_DATASET_IDS = Object.freeze(Object.keys(EXPECTED));

function assertExactKeys(value, expected, label) {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} must contain exactly the current fields`);
}

function readU32(buffer, offset, label) {
  assert.ok(offset + 4 <= buffer.length, `${label} length prefix must fit inside the session`);
  return buffer.readUInt32LE(offset);
}

/**
 * The viewer's in-place normalization (`normalizePositions()` in
 * `cellucid/assets/js/rendering/gl-utils.js`) for 3-D points, transcribed.
 *
 * @param {Float32Array} positions
 */
function normalizePositions(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index++) {
    const axis = index % 3;
    if (positions[index] < min[axis]) min[axis] = positions[index];
    if (positions[index] > max[axis]) max[axis] = positions[index];
  }
  const center = [0, 1, 2].map(axis => 0.5 * (min[axis] + max[axis]));
  let range = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  if (range === 0) range = 1.0;
  const scale = 2.0 / range;
  for (let index = 0; index < positions.length; index++) {
    positions[index] = (positions[index] - center[index % 3]) * scale;
  }
}

/**
 * `digestCellOrder()` from `cellucid/assets/js/app/session/session-context.js`
 * for 3-D points, transcribed. Two 32-bit accumulators are folded over the
 * coordinate words, so the result depends on the order of the cells.
 *
 * @param {Float32Array} positions
 */
function digestCellOrder(positions) {
  const words = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  let low = 0x9e3779b1 ^ words.length;
  let high = 0x85ebca6b ^ words.length;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    low = Math.imul(low ^ word, 0x85ebca77);
    high = Math.imul(high ^ word, 0xc2b2ae3d);
    low = (low << 13) | (low >>> 19);
    high = (high << 17) | (high >>> 15);
  }
  low = Math.imul(low ^ (low >>> 16), 0x2c1b3c6d) ^ Math.imul(high ^ (high >>> 13), 0x297a2d39);
  high = Math.imul(high ^ (high >>> 16), 0x2c1b3c6d) ^ Math.imul(low ^ (low >>> 13), 0x297a2d39);
  return (high >>> 0).toString(16).padStart(8, '0') + (low >>> 0).toString(16).padStart(8, '0');
}

/**
 * The cell-order digest of one store's default 3-D embedding, as the viewer
 * holds it: the cells by ascending original position
 * (`obs['cellucid_original_position']`, the store being in priority order),
 * so the digest names the cells whatever order the store keeps them in.
 */
async function digestStoreCellOrder(datasetId) {
  const storeDir = path.join(ANNDATA_ROOT, `${datasetId}.zarr`);
  const described = await describeStore(storeDir);
  const key = described.cellucid.defaults.embedding3d;
  const obsm = await readObsm(storeDir, described.metadata, key);
  const { values: original } = await readArray(storeDir, described.metadata, 'obs/cellucid_original_position');
  assert.equal(original.length, obsm.cells, `${datasetId}: one original position per cell`);
  const positions = new Float32Array(obsm.cells * 3);
  for (let row = 0; row < obsm.cells; row++) {
    for (let axis = 0; axis < 3; axis++) positions[original[row] * 3 + axis] = obsm.values[row * obsm.width + axis];
  }
  normalizePositions(positions);
  return { described, key, digest: digestCellOrder(positions) };
}

/**
 * One serialized sidebar control, validated the way `validateControlRecord()`
 * in `cellucid/assets/js/app/state-serializer/ui-controls.js` validates it
 * before restoring anything. A record that fails here is one the application
 * refuses, so the preset that carries it restores nothing.
 */
function assertUiControlRecord(controlId, record, label) {
  assert.ok(
    controlId.length > 0 && controlId === controlId.trim(),
    `${label} id must be a stable non-empty trimmed DOM id`,
  );
  assert.ok(
    record !== null && typeof record === 'object' && !Array.isArray(record),
    `${label} must be an object`,
  );
  assert.ok(
    UI_CONTROL_TYPES.includes(record.type),
    `${label} declares the unsupported control type ${JSON.stringify(record.type)}`,
  );
  if (record.type === 'checkbox') {
    assertExactKeys(record, ['type', 'checked'], label);
    assert.equal(
      typeof record.checked,
      'boolean',
      `${label} checked must be a boolean`,
    );
    return;
  }
  if (record.type === 'details') {
    assertExactKeys(record, ['type', 'open'], label);
    assert.equal(
      typeof record.open,
      'boolean',
      `${label} open must be a boolean`,
    );
    return;
  }
  if (record.type === 'pressed-group') {
    assertExactKeys(record, ['type', 'pressedId'], label);
    assert.ok(
      typeof record.pressedId === 'string'
        && record.pressedId.length > 0
        && record.pressedId === record.pressedId.trim(),
      `${label} pressedId must be the stable DOM id of the pressed button; the `
        + 'application refuses a group whose recorded button it cannot find, and '
        + 'the value it would otherwise restore is the mode every later gesture '
        + 'is interpreted in',
    );
    return;
  }
  assertExactKeys(record, ['type', 'value'], label);
  assert.equal(
    typeof record.value,
    'string',
    `${label} value must be a string`,
  );
  if (record.type === 'range' || record.type === 'number') {
    assert.ok(
      record.value.length > 0 && Number.isFinite(Number(record.value)),
      `${label} value ${JSON.stringify(record.value)} must be a finite numeric `
        + 'string, which the application requires before it will move the slider',
    );
    return;
  }
  if (record.type === 'color') {
    assert.match(
      record.value,
      /^#[0-9a-f]{6}$/,
      `${label} must be an exact lowercase six-digit hex colour`,
    );
  }
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
    ['createdAt', 'datasetFingerprint', 'source', 'requires', 'chunks'],
    `${label} manifest`,
  );
  assert.equal(
    manifest.source,
    null,
    `${label} is applied to the sample it ships beside, so it records no source`,
  );
  assert.equal(
    new Date(manifest.createdAt).toISOString(),
    manifest.createdAt,
    `${label} createdAt must be canonical ISO`,
  );
  const readAt = Date.now();
  assert.ok(
    Date.parse(manifest.createdAt) <= readAt,
    `${label} was captured at ${manifest.createdAt}, ahead of the `
      + `${new Date(readAt).toISOString()} clock reading it. A capture `
      + 'timestamp records something that already happened, so this file was '
      + 'either written by a machine whose clock is wrong or edited by hand',
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

async function loadPublishedPreset(datasetId) {
  const entry = CATALOG.datasets.find(candidate => candidate.id === datasetId);
  assert.ok(entry?.session, `the catalog must advertise a starting view for ${datasetId}`);
  const label = `anndata/${entry.session.path}`;
  const bytes = await readFile(path.join(ANNDATA_ROOT, decodeURIComponent(entry.session.path)));
  const { manifest, chunks } = decodeSession(bytes, label);
  return { bytes, chunks, entry, label, manifest };
}

test('every catalogued sample publishes one reviewed preset', () => {
  assert.deepEqual(
    CATALOG.datasets.map(entry => entry.id).sort(),
    [...PRESET_DATASET_IDS].sort(),
    'every sample in the catalog has a reviewed starting view pinned here, and no other',
  );
});

for (const datasetId of PRESET_DATASET_IDS) {
  const expected = EXPECTED[datasetId];
  test(`${datasetId} preset is the reviewed close-up cell_type view of its store`, async () => {
    const { bytes, chunks, entry, label, manifest } = await loadPublishedPreset(datasetId);
    assert.equal(entry.session.path, `${datasetId}.cellucid-session`);
    assert.equal(entry.session.bytes, bytes.length, `${label} length must be the catalog's`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest, entry.session.sha256, `${label} must be the bytes the catalog advertises`);
    assert.equal(digest, EXPECTED_PRESET_SHA256[datasetId], `${label} must be the reviewed preset`);

    assert.deepEqual(
      manifest.chunks.map(({ storedBytes, uncompressedBytes, ...profile }) => profile),
      PUBLISHED_DEFAULT_CHUNK_PROFILE.map(profile => ({ ...profile })),
      `${label} must carry exactly the published-default profile, in order`,
    );

    const store = await digestStoreCellOrder(datasetId);
    const { defaults } = store.described.cellucid;
    const fingerprint = manifest.datasetFingerprint;
    assertExactKeys(fingerprint, ['datasetId', 'name', 'cellCount', 'varCount', 'cellOrder', 'dataMapping'], `${label} fingerprint`);
    assert.deepEqual(manifest.requires, EXPECTED_REQUIRES, `${label} requires exactly the field it colours by`);
    assert.deepEqual(
      { datasetId: fingerprint.datasetId, name: fingerprint.name, cellCount: fingerprint.cellCount, varCount: fingerprint.varCount },
      {
        datasetId,
        name: store.described.cellucid.name,
        cellCount: store.described.x.shape[0],
        varCount: store.described.x.shape[1],
      },
      `${label} must name the store it ships beside`,
    );
    assert.deepEqual(
      [fingerprint.cellCount, fingerprint.varCount],
      [expected.cellCount, expected.varCount],
    );
    assert.deepEqual(fingerprint.cellOrder, {
      embedding: { key: store.key, columns: [0, 1, 2] },
      dimension: EXPECTED_CELL_ORDER_DIMENSION,
      digest: store.digest,
    }, `${label} must record the cell order of the store's default 3-D embedding`);
    assert.equal(store.digest, expected.cellOrderDigest, `${label} cell order`);

    const mapping = fingerprint.dataMapping;
    assert.deepEqual(Object.keys(mapping), ['kind', 'embeddings', 'knn', 'geneNames', 'expression', 'log1p', 'highlyVariable', 'latent', 'vectorFields']);
    // No sample records `uns['log1p']` or a `highly_variable` column.
    assert.deepEqual(mapping.log1p, {});
    assert.equal(mapping.highlyVariable, null);
    assert.equal(mapping.kind, 'anndata');
    assert.deepEqual(mapping.embeddings.defaults, {
      '1d': { key: defaults.embedding1d, columns: [0] },
      '2d': { key: defaults.embedding2d, columns: [0, 1] },
      '3d': { key: defaults.embedding3d, columns: [0, 1, 2] },
    }, `${label} must be captured on the store's launch default embeddings`);
    assert.equal(mapping.latent, defaults.latentKey);
    assert.deepEqual(
      mapping.embeddings.enabled.filter(ref => ref.key === defaults.latentKey),
      EXTRA_ENABLED[datasetId] ?? [],
      `${label} enables exactly the reviewed views of its latent space`,
    );
    assert.equal(mapping.knn, 'connectivities');
    assert.equal(mapping.geneNames, 'index');
    assert.equal(mapping.expression, 'X');

    const core = chunks.get('core/state');
    assertExactKeys(core, ['liveEmbedding', 'uiControls', 'filters', 'activeFields', 'multiview'], `${label} core state`);
    assert.deepEqual(core.liveEmbedding, { key: defaults.embedding3d, columns: [0, 1, 2] });
    assert.deepEqual(core.activeFields, EXPECTED_ACTIVE_FIELDS);
    assert.deepEqual(core.filters, {});
    assert.equal(core.uiControls['theme-select'].value, EXPECTED_THEME);
    assert.equal(core.uiControls['background-select'].value, EXPECTED_BACKGROUND);
    for (const [controlId, record] of Object.entries(core.uiControls)) {
      assertUiControlRecord(controlId, record, `${label} control ${controlId}`);
    }
    assertExactKeys(core.multiview, ['layout', 'camerasLocked', 'live', 'snapshots'], `${label} multiview`);
    assert.deepEqual(core.multiview.layout, { mode: 'grid', activeId: 'live', liveViewHidden: false });
    assert.equal(core.multiview.camerasLocked, true);
    // Each preset frames its own dataset, so the camera is pinned per sample.
    assert.deepEqual(core.multiview.live.cameraState, expected.camera);
    assert.deepEqual(core.multiview.snapshots, []);

    assert.deepEqual(chunks.get('core/field-overlays'), EXPECTED_FIELD_OVERLAYS);
    assert.deepEqual(chunks.get('ui/dockable-layout'), EXPECTED_DOCKABLE_LAYOUT);
    const highlights = chunks.get('highlights/meta');
    assert.equal(highlights.pages.length, 1, `${label} keeps one empty highlight page`);
    assert.deepEqual(highlights.pages[0].highlightedGroups, []);
    assert.equal(highlights.activePageId, highlights.pages[0].id);
  });
}

test('the reviewed presets were captured in one review pass', async () => {
  const captures = await Promise.all(PRESET_DATASET_IDS.map(async (datasetId) => {
    const { label, manifest } = await loadPublishedPreset(datasetId);
    return { at: Date.parse(manifest.createdAt), label, text: manifest.createdAt };
  }));
  const earliest = captures.reduce((low, one) => (one.at < low.at ? one : low));
  const latest = captures.reduce((high, one) => (one.at > high.at ? one : high));
  assert.ok(
    latest.at - earliest.at <= MAXIMUM_REVIEW_PASS_SPAN_MS,
    `${earliest.label} was captured at ${earliest.text} and ${latest.label} at ${latest.text}, `
      + 'outside the window one review pass takes',
  );
});

test('reviewed presets differ only where the datasets differ', async () => {
  const controlsByDataset = new Map(await Promise.all(PRESET_DATASET_IDS.map(async datasetId => [
    datasetId,
    (await loadPublishedPreset(datasetId)).chunks.get('core/state').uiControls,
  ])));
  const [referenceId, ...otherIds] = PRESET_DATASET_IDS;
  const referenceControls = controlsByDataset.get(referenceId);
  const referenceIds = Object.keys(referenceControls).sort();
  const divergent = new Set();
  for (const datasetId of otherIds) {
    const controls = controlsByDataset.get(datasetId);
    assert.deepEqual(Object.keys(controls).sort(), referenceIds, `${datasetId} and ${referenceId} carry different control inventories`);
    for (const controlId of referenceIds) {
      if (JSON.stringify(controls[controlId]) !== JSON.stringify(referenceControls[controlId])) divergent.add(controlId);
    }
  }
  assert.deepEqual(
    [...divergent].filter(controlId => !DATASET_DERIVED_UI_CONTROL_IDS.includes(controlId)).sort(),
    [],
    'the reviewed presets must agree on every control the application does not derive from the loaded dataset',
  );
  for (const controlId of DATASET_DERIVED_UI_CONTROL_IDS) {
    assert.ok(Object.hasOwn(referenceControls, controlId), `${controlId} is tolerated but no preset carries it`);
  }
});

/* ------------------------------------------------------------------ *
 * The viewer's own rules, where the viewer repository is checked out.
 *
 * `scripts/publish_session_preset.mjs` imports the published-default profile,
 * the trim, the fingerprint check, the data-mapping rules and the cell-order
 * digest from the viewer, so these tests ask the application itself whether it
 * accepts each preset. Only an absent *repository* is a reason to skip.
 * ------------------------------------------------------------------ */

const VIEWER_REPOSITORY_URL = new URL('../../cellucid/', import.meta.url);

async function viewerRepositoryPresent() {
  try {
    return (await stat(VIEWER_REPOSITORY_URL)).isDirectory();
  } catch {
    return false;
  }
}

test("the pinned published-default profile is the viewer's own", async (t) => {
  if (!await viewerRepositoryPresent()) {
    t.skip('the cellucid repository is not checked out beside this one');
    return;
  }
  const { PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE } = await import(
    new URL('assets/js/app/session/published-default.js', VIEWER_REPOSITORY_URL).href
  );
  assert.deepEqual(
    PUBLISHED_DEFAULT_CHUNK_PROFILE.map(profile => ({ ...profile })),
    PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE.map(profile => ({ ...profile })),
  );
});

test("every preset's fingerprint is the one the viewer derives from its store", async (t) => {
  if (!await viewerRepositoryPresent()) {
    t.skip('the cellucid repository is not checked out beside this one');
    return;
  }
  const { loadPublishRule, readPublishedIdentity } = await import(
    new URL('../scripts/publish_session_preset.mjs', import.meta.url).href
  );
  const rule = await loadPublishRule();
  for (const datasetId of PRESET_DATASET_IDS) {
    const { label, manifest } = await loadPublishedPreset(datasetId);
    rule.assertPublishedDefaultChunkProfile(manifest.chunks);
    rule.assertDatasetFingerprint(manifest.datasetFingerprint, `${label} fingerprint`);
    assert.deepEqual(
      await readPublishedIdentity(datasetId, rule, manifest.datasetFingerprint),
      manifest.datasetFingerprint,
      `${label} must carry the fingerprint the viewer computes for its store: the counts, `
        + 'the default data mapping and the cell-order digest',
    );
  }
});

function saveStateFor(preset, recorded) {
  const droppedChunks = [
    {
      after: 'core/field-overlays',
      meta: {
        id: 'cinematic/camera',
        contributorId: 'cinematic-camera',
        priority: 'eager',
        kind: 'json',
        codec: 'gzip',
        label: 'Cinematic camera path',
        datasetDependent: true,
      },
      payload: {
        keyframes: recorded.keyframes,
        nextIndex: recorded.keyframes.length + 1,
        loopBackKeyframeId: null,
        autoplay: false,
        loopPlayback: false,
        positionMethod: 'catmull-rom',
        rotationMethod: 'slerp',
        easing: 'linear',
        defaultSpeed: '30',
        invertLook: false,
        lookSensitivity: '5',
        moveSpeed: '100',
        orbitKeySpeed: '40',
        orbitReverse: true,
        planarInvertAxes: false,
        planarPanSpeed: '100',
        planarZoomToCursor: true,
        showOrbitAnchor: true,
        navigationMode: 'orbit',
      },
    },
  ];

  // Split the preset back into its stored chunk bytes.
  let offset = MAGIC.length + 4
    + readU32(preset.bytes, MAGIC.length, 'preset manifest');
  const stored = new Map();
  for (const meta of preset.manifest.chunks) {
    offset += 4;
    stored.set(meta.id, preset.bytes.subarray(offset, offset + meta.storedBytes));
    offset += meta.storedBytes;
  }

  const metas = [];
  const payloads = [];
  const append = (dropped) => {
    const raw = Buffer.from(JSON.stringify(dropped.payload), 'utf8');
    const gzipped = gzipSync(raw);
    metas.push({
      ...dropped.meta,
      storedBytes: gzipped.length,
      uncompressedBytes: raw.length,
    });
    payloads.push(gzipped);
  };
  for (const meta of preset.manifest.chunks) {
    metas.push(meta);
    payloads.push(stored.get(meta.id));
    for (const dropped of droppedChunks) {
      if (dropped.after === meta.id) append(dropped);
    }
  }
  for (const dropped of droppedChunks) {
    if (dropped.after === null) append(dropped);
  }

  const manifestBytes = Buffer.from(
    JSON.stringify({
      createdAt: preset.manifest.createdAt,
      datasetFingerprint: preset.manifest.datasetFingerprint,
      source: { kind: 'sample', dataset: preset.manifest.datasetFingerprint.datasetId },
      requires: preset.manifest.requires,
      chunks: metas,
    }),
    'utf8',
  );
  const parts = [MAGIC, Buffer.alloc(4), manifestBytes];
  parts[1].writeUInt32LE(manifestBytes.length, 0);
  for (const payload of payloads) {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(payload.length, 0);
    parts.push(length, Buffer.from(payload));
  }
  return { bytes: Buffer.concat(parts), chunkIds: metas.map(meta => meta.id) };
}

test('the publish helper reproduces every published preset from its save', async (t) => {
  if (!await viewerRepositoryPresent()) {
    t.skip('the cellucid repository is not checked out beside this one');
    return;
  }
  const { trimSaveStateToPreset } = await import(
    new URL('../scripts/publish_session_preset.mjs', import.meta.url).href
  );
  for (const datasetId of PRESET_DATASET_IDS) {
    const preset = await loadPublishedPreset(datasetId);
    const save = saveStateFor(preset, { keyframes: [], });
    assert.equal(save.chunkIds.length, PUBLISHED_DEFAULT_CHUNK_PROFILE.length + 1);
    const published = await trimSaveStateToPreset(save.bytes, datasetId);
    assert.deepEqual(published.chunkIds, PUBLISHED_DEFAULT_CHUNK_PROFILE.map(profile => profile.id));
    assert.deepEqual(
      Buffer.from(published.bytes),
      preset.bytes,
      `${preset.label} must be byte-identical to what the publish helper produces from its capture`,
    );
  }
});

test('the publish helper refuses a capture that would lose recorded work', async (t) => {
  if (!await viewerRepositoryPresent()) {
    t.skip('the cellucid repository is not checked out beside this one');
    return;
  }
  const { trimSaveStateToPreset } = await import(
    new URL('../scripts/publish_session_preset.mjs', import.meta.url).href
  );
  const datasetId = PRESET_DATASET_IDS.at(-1);
  const preset = await loadPublishedPreset(datasetId);
  const withCameraPath = saveStateFor(preset, {
    keyframes: [{
      id: 'kf_1',
      label: 'Opening',
      durationMs: 1_000,
      camera: { radius: 2.43, theta: 0.78, phi: 0.78, target: [0, 0, 0] },
    }],
  });
  await assert.rejects(() => trimSaveStateToPreset(withCameraPath.bytes, datasetId), /cinematic\/camera/);
});
