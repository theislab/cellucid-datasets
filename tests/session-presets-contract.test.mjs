import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const EXPORTS_ROOT = path.join(REPOSITORY_ROOT, 'exports-v3');
const GITIGNORE_PATH = path.join(REPOSITORY_ROOT, '.gitignore');
const MAGIC = Buffer.from('CELLUCID_SESSION\n', 'utf8');
const PUBLICATION_MANIFEST_BYTES =
  '{ "states": ["default.cellucid-session"] }\n';
const CATALOG = JSON.parse(
  await readFile(path.join(EXPORTS_ROOT, 'datasets.json'), 'utf8'),
);
/**
 * `cellOrderDigest` is the application's digest of the 3-D coordinates of the
 * published export, in dataset row order. The application recomputes it from
 * the loaded dataset and refuses a preset whose digest disagrees, so pinning it
 * here is what makes this suite able to see a preset go stale: the bytes and
 * their SHA-256 stay self-consistent no matter what the fingerprint says, and
 * on their own they proved nothing about whether the application would open the
 * file. A preset regenerated against re-ordered coordinates, or one carrying no
 * cell-order record at all, now fails here rather than in the browser.
 */
const EXPECTED = Object.freeze({
  suo: Object.freeze({
    cellCount: 561_947,
    varCount: 5_103,
    cellOrderDigest: 'a229f7d3347dbb46',
    sha256: '6357765ba0aa96bedd2caaa6076c81f44d8ff021d72b377f89e16ba2834aea49',
    camera: Object.freeze({
      navigationMode: 'orbit',
      orbit: Object.freeze({
        radius: 0.8817669428902989,
        targetRadius: 0.8817669428902989,
        theta: 2.861307695117691,
        phi: 1.7024549527672228,
        target: Object.freeze([0, 0, 0]),
      }),
      freefly: Object.freeze({
        position: Object.freeze([
          -0.8400240003559275,
          -0.11575712437608862,
          0.24181172129635684,
        ]),
        yaw: -0.2802849584721023,
        pitch: 0.1316586259723262,
      }),
    }),
  }),
  garcia: Object.freeze({
    cellCount: 219_731,
    varCount: 5_754,
    cellOrderDigest: 'd3a48cc719afee0b',
    sha256: '8cb657811976a23296cfb7ecd987ab634a808b093e9a14a656262a2d2d199440',
    camera: Object.freeze({
      navigationMode: 'orbit',
      orbit: Object.freeze({
        radius: 1.106010096941288,
        targetRadius: 1.106010096941288,
        theta: 1.4576226052247212,
        phi: 1.79557114622099,
        target: Object.freeze([0, 0, 0]),
      }),
      freefly: Object.freeze({
        position: Object.freeze([
          0.12176219378593962,
          -0.2465151085448905,
          1.0712901586216563,
        ]),
        yaw: -1.6839700483650721,
        pitch: 0.2247748194260934,
      }),
    }),
  }),
  he: Object.freeze({
    cellCount: 71_650,
    varCount: 5_152,
    cellOrderDigest: '0174556a9edc0bfc',
    sha256: '32369a536a22585b1d905c3a778fa41a49e5e4591112313ecb6ed7709e45a756',
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
    sha256: '76af3a7897d6e7fae330d59e6665a1cfabb7736321b3d11fe5ffb6ecfcf8a05d',
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
    sha256: '598cda75e3c6c05a0f01a1d64d4b8a532fdc442ce50455c14f7fe9e79b9034f6',
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
/**
 * Every preset is captured in the 3-D view, which is the dimension the
 * application opens on, so a preset saved in another dimension would be refused
 * at load with the "switch back to the ND view" message.
 */
const EXPECTED_CELL_ORDER_DIMENSION = 3;
/**
 * The identity a published default is read under.
 *
 * A preset is captured by serving the prepared generation locally, so the
 * capture names a `local-user` source and an id the local source invented,
 * while the catalog serves the same bytes as `local-demo` under the
 * generation's own id. `datasetFingerprintMatches()` compares both fields
 * before the viewer applies a published default, so a preset committed with the
 * capture's identity is refused on every open and the sample shows none of its
 * published view — the file is valid, and nothing about it looks wrong until
 * somebody loads it. `scripts/publish_session_preset.mjs` is what restates the
 * identity, and it may only do so for a capture whose counts and cell-order
 * digest it has re-derived from the generation itself.
 */
const EXPECTED_SOURCE_TYPE = 'local-demo';
const EXPECTED_CHUNK_IDS = Object.freeze([
  'analysis/windows',
  'core/field-overlays',
  'core/state',
  'highlights/meta',
  'ui/dockable-layout',
]);
/**
 * `restorePublishedDefaultState()` in
 * `cellucid/assets/js/app/session/session-serializer.js` accepts an advertised
 * `default.cellucid-session` only against `PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE`:
 * exactly these five chunks, in this order, each declaring exactly this
 * contributor, priority, kind, codec, label, and dataset-dependence. Comparing
 * the sorted id set proved only that the same five names were present, so a
 * preset that reordered its chunks, moved a payload to another contributor, or
 * relabelled one stayed well-formed here and was refused by the reader before it
 * could restore anything.
 *
 * This is a pin, not a second definition: `the pinned published-default profile
 * is the viewer's own` below reads
 * `PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE` out of the viewer repository and
 * fails when the two disagree. The pin exists so this suite still governs the
 * artifacts when it runs alone, which is how this repository's CI runs it; the
 * agreement test is what stops the pin outliving the rule it copies.
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
    id: 'analysis/windows',
    contributorId: 'analysis-windows',
    priority: 'eager',
    kind: 'json',
    codec: 'gzip',
    label: 'Analysis windows',
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
const PUBLISHED_DEFAULT_PROFILE_KEYS = Object.freeze([
  'contributorId',
  'priority',
  'kind',
  'codec',
  'label',
  'datasetDependent',
]);
/**
 * A published default has no size ceiling (the catalog declares its exact
 * length in `state_bytes`), so the only size property worth asserting is a
 * floor: a preset whose chunks all decoded to `{}` would otherwise pass. The reader refuses a
 * `core/state` whose `uiControls` record is not the complete current control
 * inventory (`validateCompleteControls()` in
 * `cellucid/assets/js/app/state-serializer/ui-controls.js`), and that inventory
 * alone is what makes these files as large as they are: the five published
 * presets measure 3,235 to 3,434 bytes. Anything under 2 KiB cannot be carrying
 * a reviewed view.
 *
 * This range is prose, not a pin, and it went stale once already: it still read
 * "2,678 to 2,691" after the presets grew by one control. It is restated with
 * every re-capture for that reason — the sizes the floor is argued from have to
 * be the sizes on disk, or the argument stops being checkable.
 */
const MINIMUM_REVIEWED_PRESET_BYTES = 2 * 1024;
/**
 * The controls the application sets from the loaded generation rather than from
 * the markup, so a capture is expected to disagree with the other four here:
 *
 * - `connectivity-limit`, whose slider maximum is clamped to the edges the
 *   viewer actually loaded (`updateSliderRange()` in
 *   `cellucid/assets/js/app/main.js`).
 * - `velocity-field`, whose option list is rebuilt from the dataset's declared
 *   vector fields (`renderFieldSelectForActiveDim()` in
 *   `cellucid/assets/js/app/ui/modules/velocity-overlay-controls.js`).
 * - `point-size` and `hp-antialias`, both computed from the cell count by
 *   `applyDatasetRenderDefaults()` in
 *   `cellucid/assets/js/app/ui/core/ui-coordinator.js`, because one shipped
 *   constant cannot be right for a 3,696-cell trajectory and an 18-million-cell
 *   atlas at once.
 *
 * Every other control is markup the reviewed captures share, so a divergence
 * outside this set is one dataset's view having silently drifted.
 *
 * Membership means a control *may* differ, not that it must. Two generations
 * that fall on the same side of the antialiasing threshold agree on it, and
 * that is a fact about the datasets rather than about the presets — requiring
 * every listed control to actually differ made this assertion fail the day a
 * re-capture happened to land five datasets in one bracket.
 */
const DATASET_DERIVED_UI_CONTROL_IDS = Object.freeze([
  'connectivity-limit',
  'hp-antialias',
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
 * (light) background. `04_official_sample_states.md` states these three by name, so they
 * are asserted by name rather than left to the byte pin.
 */
const EXPECTED_ACTIVE_FIELD_KEY = 'cell_type';
const EXPECTED_ACTIVE_FIELD_KIND = 'category';
const EXPECTED_THEME = 'light';
const EXPECTED_BACKGROUND = 'studio';
/**
 * The reviewed presets show the generation exactly as it was prepared: no field
 * or category is renamed, none is hidden, and none is invented. The last of
 * those is not a preference -- a user-defined field's codes travel in a
 * `user-defined/codes/<fieldId>` chunk, and the five-chunk published-default
 * profile above has no room for one, so the reader would refuse the file with
 * "User-defined code field ... is missing its chunk". A rename or a deletion of
 * `cell_type` would equally strand the field the same preset activates.
 */
const EXPECTED_FIELD_OVERLAYS = Object.freeze({
  renames: { fields: {}, categories: {} },
  deletedFields: { deleted: [], purged: [] },
  userDefinedFields: [],
});
/**
 * Every panel is docked. A floating panel is stored as the absolute viewport
 * rectangle it occupied on the author's screen (`readPanelRect()` in
 * `cellucid/assets/js/app/session/contributors/dockable-layout.js`), and
 * restoring one re-floats it at those pixel coordinates, so a published preset
 * that floated a panel would open it off-screen for every narrower window.
 */
const EXPECTED_DOCKABLE_LAYOUT = Object.freeze({ panels: [] });
/**
 * No analysis window is reopened. A window's computed artifacts travel as lazy
 * `analysis/artifacts/...` chunks named by an eager cache-inventory chunk, and
 * the published-default profile carries neither, so a restored window would open
 * with nothing behind it.
 */
const EXPECTED_ANALYSIS_WINDOWS = Object.freeze({ windows: [] });
/**
 * One empty highlight page. `assertPayload()` in
 * `cellucid/assets/js/app/session/contributors/highlights-meta.js` requires a
 * non-empty page inventory and an `activePageId` inside it, and each page's
 * groups carry only metadata: membership lives in a lazy
 * `highlights/cells/<groupId>` chunk the published-default profile cannot hold,
 * so a group listed here would be restored against a payload that does not
 * exist ("Highlight group ... has no expected cell membership chunk"). The
 * documentation says these presets start with nothing kept.
 */
const EXPECTED_HIGHLIGHT_PAGE_COUNT = 1;
const HIGHLIGHT_PAGE_ID_PATTERN = /^page_[1-9]\d*$/;
const HIGHLIGHT_PAGE_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
/**
 * The freefly camera the reviewed presets carry is derived from their orbit
 * camera by the viewer's own spherical-to-cartesian sync (the orbit branch of
 * `getCurrentCameraStateInternal()` in `cellucid/assets/js/rendering/viewer.js`),
 * so switching navigation mode after the preset is applied keeps the eye where
 * it already is. Recomputing it here reproduces all five published presets
 * bit-identically; the tolerance exists only so a future capture cannot fail on
 * a last-place rounding difference between the browser that wrote it and the
 * Node that reads it.
 */
const CAMERA_DERIVATION_TOLERANCE = 1e-12;
/**
 * `manifest.createdAt` records when a human sat in front of the viewer and
 * captured the view this file restores. It was checked only for canonical ISO
 * shape, which any well-formed instant satisfies -- a preset dated before the
 * generation it describes, or dated next century, passed.
 *
 * Two of its three bounds are read out of the repository and need no clock. A
 * capture cannot predate the generation it captures, so `createdAt` is ordered
 * against `dataset_identity.json`'s `created_at`; a preset older than its own
 * export was carried over from an earlier one, and the row indices it stores
 * denote cells that generation had not laid out yet. And the reviewed presets
 * are one review pass: all five were captured inside 7.858 seconds on
 * 2026-10-18, so a preset re-captured on its own, months from the other four,
 * shows a view nobody looked at beside the rest. The window is a day rather
 * than a minute because a re-capture may reasonably span a working session.
 *
 * The third bound is the clock, and it is the only one that can be: an instant
 * in the future is not a record of anything that happened. It is not
 * time-dependent in the way that makes a test flaky, because the bound only
 * ever moves forward -- a `createdAt` that passes today passes every day after
 * it, and the only way to fail is to publish a timestamp ahead of the machine
 * reading it.
 */
const MAXIMUM_REVIEW_PASS_SPAN_MS = 24 * 60 * 60 * 1000;

/* published-generations:begin */
/**
 * The one definition of "published" these suites have, held byte-identical in
 * every file that enumerates `exports-v3/`. Two files that each decided for
 * themselves which directories under `exports-v3/` counted governed different
 * sets of artifacts while reading as though they governed the same set, and
 * whichever definition was widened first would have won in silence.
 *
 * The rule itself is not restated here. It is read out of `.gitignore`, which
 * is what actually decides whether a directory under `exports-v3/` is committed:
 * every `/exports-v3/<glob>/` line names a tree the repository keeps out, and a
 * hidden entry is never a prepared generation.
 * `repository-organization-contract.test.mjs` fails if a copy of this block
 * diverges from the others, if a suite that enumerates `exports-v3/` carries no
 * copy, or if any suite selects generations by a name convention of its own.
 */
const PUBLISHED_GENERATION_IGNORE_SCOPE = '/exports-v3/';

function publishedGenerationNames(entries, gitignoreText) {
  const excluded = gitignoreText
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.startsWith(PUBLISHED_GENERATION_IGNORE_SCOPE)
        && line.endsWith('/')
    )
    .map((line) => line.slice(PUBLISHED_GENERATION_IGNORE_SCOPE.length, -1));
  assert.ok(
    excluded.length > 0,
    '.gitignore names no uncommitted directory under exports-v3/, so the rule '
      + 'these suites select published generations by is no longer there to read'
  );
  const patterns = excluded.map(
    (glob) =>
      new RegExp(
        `^${glob
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*')}$`
      )
  );
  return entries
    .filter(
      (entry) =>
        entry.isDirectory()
        && !entry.name.startsWith('.')
        && !patterns.some((pattern) => pattern.test(entry.name))
    )
    .map((entry) => entry.name)
    .sort();
}
/* published-generations:end */

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

async function readGenerationIdentity(datasetId) {
  return JSON.parse(
    await readFile(
      path.join(EXPORTS_ROOT, datasetId, 'dataset_identity.json'),
      'utf8',
    ),
  );
}

/**
 * The viewer's in-place normalization, transcribed from `normalizePositions()`
 * in `cellucid/assets/js/rendering/gl-utils.js`. The digest below is taken over
 * the array the viewer holds, which is the published payload after this pass,
 * not the payload as it sits on disk.
 *
 * @param {Float32Array} positions
 */
function normalizePositions(positions) {
  const n = positions.length / 3;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[3 * i];
    const y = positions[3 * i + 1];
    const z = positions[3 * i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const centerX = 0.5 * (minX + maxX);
  const centerY = 0.5 * (minY + maxY);
  const centerZ = 0.5 * (minZ + maxZ);
  let maxRange = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  if (maxRange === 0) maxRange = 1.0;
  const scale = 2.0 / maxRange;
  for (let i = 0; i < n; i++) {
    const idx = 3 * i;
    positions[idx] = (positions[idx] - centerX) * scale;
    positions[idx + 1] = (positions[idx + 1] - centerY) * scale;
    positions[idx + 2] = (positions[idx + 2] - centerZ) * scale;
  }
}

/**
 * `digestCellOrder()` from `cellucid/assets/js/app/session/session-context.js`,
 * transcribed. Two 32-bit accumulators are folded over the coordinate words, so
 * the result depends on the order of the cells and not only on their multiset.
 *
 * @param {Float32Array} positions
 * @returns {string} 16 lowercase hexadecimal characters.
 */
function digestCellOrder(positions) {
  const words = new Uint32Array(
    positions.buffer,
    positions.byteOffset,
    positions.length,
  );
  let low = 0x9e3779b1 ^ words.length;
  let high = 0x85ebca6b ^ words.length;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    low = Math.imul(low ^ word, 0x85ebca77);
    high = Math.imul(high ^ word, 0xc2b2ae3d);
    low = (low << 13) | (low >>> 19);
    high = (high << 17) | (high >>> 15);
  }
  low = Math.imul(low ^ (low >>> 16), 0x2c1b3c6d)
    ^ Math.imul(high ^ (high >>> 13), 0x297a2d39);
  high = Math.imul(high ^ (high >>> 16), 0x2c1b3c6d)
    ^ Math.imul(low ^ (low >>> 13), 0x297a2d39);
  return (high >>> 0).toString(16).padStart(8, '0')
    + (low >>> 0).toString(16).padStart(8, '0');
}

/**
 * Recompute one generation's cell-order digest out of the coordinates it
 * publishes, the way the application does when it decides whether to accept a
 * preset: decompress the payload of the embedding the fingerprint names,
 * normalize it in place, then digest it in dataset row order. The viewer's
 * `normalizePositions()` and `digestCellOrder()` treat the axes a 1-D or 2-D
 * layout lacks as the constant zero, so the payload is read into XYZ triples
 * with a zero third (and second) component, which is the word sequence both
 * fold, and the 3-D transcriptions above apply unchanged.
 */
async function digestPublishedCellOrder(datasetId, identity, embeddingId, label) {
  const item = identity.embeddings.items[embeddingId];
  assert.ok(
    item !== undefined,
    `${label} fingerprint names the embedding '${embeddingId}', which the `
      + 'generation does not publish',
  );
  const { dimension, file: relative } = item;
  const compressed = await readFile(
    path.join(EXPORTS_ROOT, datasetId, relative),
  );
  const decompressed = gunzipSync(compressed);
  assert.equal(
    decompressed.length,
    identity.stats.n_cells * dimension * 4,
    `${label} ${relative} must hold one Float32 per axis per published cell`,
  );
  // A pooled Buffer carries an arbitrary byteOffset; the digest reads the
  // coordinates as 32-bit words, which requires a 4-byte aligned buffer.
  const aligned = new ArrayBuffer(decompressed.byteLength);
  new Uint8Array(aligned).set(decompressed);
  const source = new Float32Array(aligned);
  const positions = new Float32Array(identity.stats.n_cells * 3);
  for (let cell = 0; cell < identity.stats.n_cells; cell++) {
    for (let axis = 0; axis < dimension; axis++) {
      positions[3 * cell + axis] = source[dimension * cell + axis];
    }
  }
  normalizePositions(positions);
  return digestCellOrder(positions);
}

/**
 * The data mapping a published default is captured in: the export kind, every
 * dimension's slot holding that dimension's default embedding, and only vector
 * bindings the generation declares. A preset captured in another mapping is
 * skipped at startup whenever a link resolves the default one, so publishing
 * one would ship a view that is never applied.
 */
function codePointCompare(left, right) {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/**
 * The generation's default export data mapping, exactly as the viewer derives
 * it (`exportDataMapping()` in `cellucid/assets/js/data/data-mapping.js`):
 * every declared embedding is enabled (sorted by id in code-point order), each
 * dimension defaults to the embedding `defaults` names, genes are named by the
 * default name set, and every declared vector binding is in use, sorted by
 * embedding id, then field.
 */
async function defaultExportMapping(datasetId, identity) {
  const defaults = {};
  for (const dimension of [1, 2, 3]) {
    const id = identity.embeddings.defaults[`${dimension}d`];
    defaults[`${dimension}d`] = id === undefined ? null : { key: id, columns: null };
  }
  const embeddings = {
    enabled: Object.keys(identity.embeddings.items)
      .sort(codePointCompare)
      .map(key => ({ key, columns: null })),
    defaults,
  };
  let geneNames = 'index';
  if (identity.stats.n_genes > 0) {
    const varManifest = JSON.parse(
      await readFile(path.join(EXPORTS_ROOT, datasetId, 'var_manifest.json'), 'utf8'),
    );
    const source = varManifest.gene_name_sets[0].source;
    geneNames = source === null ? 'index' : `column:${source}`;
  }
  const vectorFields = [];
  for (const [field, entry] of Object.entries(identity.vector_fields?.fields ?? {})) {
    for (const key of Object.keys(entry.files)) {
      vectorFields.push({ field, embedding: { key, columns: null } });
    }
  }
  vectorFields.sort((left, right) =>
    codePointCompare(left.embedding.key, right.embedding.key)
      || codePointCompare(left.field, right.field));
  return { kind: 'export', embeddings, geneNames, vectorFields };
}

async function assertDefaultExportMapping(mapping, datasetId, identity, label) {
  assert.deepEqual(
    mapping,
    await defaultExportMapping(datasetId, identity),
    `${label} must be captured in the generation's default data mapping: every `
      + 'declared embedding enabled, each dimension defaulting to its default '
      + 'embedding, its default gene names, and every published vector binding',
  );
  assert.deepEqual(
    Object.keys(mapping),
    ['kind', 'embeddings', 'geneNames', 'vectorFields'],
    `${label} dataMapping must be in canonical key order`,
  );
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

/**
 * The freefly eye, yaw, and pitch the viewer derives from one orbit camera.
 */
function deriveFreeflyFromOrbit(orbit) {
  const { radius, theta, phi, target } = orbit;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const eyeX = target[0] + radius * sinPhi * Math.cos(theta);
  const eyeY = target[1] + radius * cosPhi;
  const eyeZ = target[2] + radius * sinPhi * Math.sin(theta);
  const fwdX = target[0] - eyeX;
  const fwdY = target[1] - eyeY;
  const fwdZ = target[2] - eyeZ;
  const len = Math.sqrt(fwdX * fwdX + fwdY * fwdY + fwdZ * fwdZ) || 1;
  return {
    position: [eyeX, eyeY, eyeZ],
    yaw: Math.atan2(fwdZ / len, fwdX / len),
    pitch: Math.asin(Math.min(1, Math.max(-1, fwdY / len))),
  };
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

function isStateArtifactName(name) {
  return name.endsWith('.cellucid-session') || name === 'state-snapshots.json';
}

async function findStateArtifactsBelow(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...await findStateArtifactsBelow(absolute));
    } else if (entry.isFile() && isStateArtifactName(entry.name)) {
      found.push(toRepositoryRelativePath(EXPORTS_ROOT, absolute));
    }
  }
  return found;
}

/**
 * Every state artifact this repository publishes: the ones sitting beside a
 * published generation, and any left at the root of `exports-v3/` itself. The
 * walk used to descend into every directory under `exports-v3/`, including the
 * `_`-prefixed local scratch exports that `.gitignore` excludes and that
 * `catalog-contract.test.mjs` never swept, so the two files disagreed about
 * what "published" meant while both read as though they governed the same
 * tree. Both now select generations with the shared rule above.
 */
async function findPublishedStateArtifacts() {
  const entries = await readdir(EXPORTS_ROOT, { withFileTypes: true });
  const published = entries
    .filter((entry) => entry.isFile() && isStateArtifactName(entry.name))
    .map((entry) => entry.name);
  for (const generation of publishedGenerationNames(
    entries,
    await readFile(GITIGNORE_PATH, 'utf8'),
  )) {
    published.push(
      ...await findStateArtifactsBelow(path.join(EXPORTS_ROOT, generation)),
    );
  }
  return published.sort();
}

function toRepositoryRelativePath(root, absolute, pathApi = path) {
  return pathApi.relative(root, absolute).split(pathApi.sep).join('/');
}

test('state artifact inventory uses portable repository paths', () => {
  assert.equal(
    toRepositoryRelativePath(
      'D:\\workspace\\exports-v3',
      'D:\\workspace\\exports-v3\\suo\\default.cellucid-session',
      path.win32,
    ),
    'suo/default.cellucid-session',
  );
  assert.equal(
    toRepositoryRelativePath(
      '/workspace/exports-v3',
      '/workspace/exports-v3/suo/state-snapshots.json',
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
    await findPublishedStateArtifacts(),
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
    assert.ok(
      Number.isSafeInteger(catalogEntry.state_bytes) && catalogEntry.state_bytes > 0,
      `${datasetId} catalog entry must declare its state's exact byte length`,
    );
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
    assert.equal(
      bytes.length,
      catalogEntry.state_bytes,
      `${label} length must be the catalog's declared state_bytes`,
    );
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      catalogEntry.state_sha256,
      `${label} bytes must match its catalog-pinned reviewed UI-authored state`,
    );

    const { manifest, chunks } = decodeSession(bytes, label);
    assert.deepEqual([...chunks.keys()].sort(), EXPECTED_CHUNK_IDS);
    assertExactKeys(
      manifest.datasetFingerprint,
      [
        'sourceType',
        'datasetId',
        'cellCount',
        'varCount',
        'cellOrder',
        'dataMapping',
      ],
      `${label} fingerprint`,
    );
    assertExactKeys(
      manifest.datasetFingerprint.cellOrder,
      ['embedding', 'dimension', 'digest'],
      `${label} fingerprint cellOrder`,
    );
    assert.match(
      manifest.datasetFingerprint.cellOrder.digest,
      /^[0-9a-f]{16}$/,
      `${label} cell-order digest must be 16 lowercase hexadecimal characters`,
    );
    const { dataMapping, ...fingerprint } = manifest.datasetFingerprint;
    const generation = await readGenerationIdentity(datasetId);
    assert.deepEqual(fingerprint, {
      sourceType: EXPECTED_SOURCE_TYPE,
      datasetId,
      cellCount: expected.cellCount,
      varCount: expected.varCount,
      cellOrder: {
        embedding: {
          key: generation.embeddings.defaults[`${EXPECTED_CELL_ORDER_DIMENSION}d`],
          columns: null,
        },
        dimension: EXPECTED_CELL_ORDER_DIMENSION,
        digest: expected.cellOrderDigest,
      },
    });
    await assertDefaultExportMapping(dataMapping, datasetId, generation, label);
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
        'liveEmbedding',
        'uiControls',
        'filters',
        'activeFields',
        'multiview',
      ],
      `${label} core state`,
    );
    assert.deepEqual(
      core.liveEmbedding,
      { key: generation.embeddings.defaults[`${generation.embeddings.default_dimension}d`], columns: null },
      `${label} live view must show the generation's opening default embedding`,
    );
    assert.deepEqual(core.activeFields, {
      activeFieldKey: 'cell_type',
      activeFieldSource: 'obs',
    });
    assert.deepEqual(core.filters, {});
    assert.equal(generation.embeddings.items[core.liveEmbedding.key].dimension, 3);
    // Each preset frames its own dataset, so this is pinned per generation
    // rather than once: the presets shared one opening camera until each was
    // re-captured on the view its own embedding reads best in.
    assert.deepEqual(core.camera, expected.camera);
    assert.equal(core.uiControls['theme-select'].value, 'light');
    assert.equal(core.uiControls['background-select'].value, EXPECTED_BACKGROUND);

    assertExactKeys(
      core.multiview,
      ['layout', 'camerasLocked', 'liveCameraState', 'snapshots'],
      `${label} multiview state`,
    );
    assert.equal(core.multiview.camerasLocked, true);
    assert.deepEqual(core.multiview.snapshots, []);
    assert.deepEqual(core.multiview.liveCameraState, expected.camera);
    assert.deepEqual(core.multiview.layout, {
      mode: 'grid',
      activeId: 'live',
      liveViewHidden: false,
    });
  });
}

/**
 * Reading one preset out of `exports-v3/` exactly once, for the content contracts
 * below. Every assertion in this file that names a payload rather than a byte
 * count reads from here.
 */
async function loadPublishedPreset(datasetId) {
  const label = `${datasetId}/default.cellucid-session`;
  const bytes = await readFile(
    path.join(EXPORTS_ROOT, datasetId, 'default.cellucid-session'),
  );
  const { manifest, chunks } = decodeSession(bytes, label);
  return { bytes, chunks, label, manifest };
}

const PRESET_DATASET_IDS = Object.freeze(Object.keys(EXPECTED));

test('every catalog entry advertising a state publishes one reviewed preset', () => {
  const advertised = CATALOG.datasets
    .filter(entry => (
      Object.hasOwn(entry, 'state_manifest')
      || Object.hasOwn(entry, 'state_sha256')
      || Object.hasOwn(entry, 'state_bytes')
    ))
    .map(entry => entry.id)
    .sort();
  assert.ok(
    advertised.length > 0,
    'the published catalog must advertise at least one state capability, or '
      + 'this file is asserting nothing',
  );
  assert.deepEqual(
    [...PRESET_DATASET_IDS].sort(),
    advertised,
    'the reviewed presets pinned here must be exactly the catalog entries that '
      + 'advertise a state capability; a dataset advertised without a pinned '
      + 'preset is unreviewed, and a preset pinned without an advertisement is '
      + 'never fetched',
  );
});

for (const datasetId of PRESET_DATASET_IDS) {
  test(
    `${datasetId} preset matches the published-default profile the viewer accepts`,
    async () => {
      const { bytes, label, manifest } = await loadPublishedPreset(datasetId);
      assert.deepEqual(
        manifest.chunks.map(chunk => chunk.id),
        PUBLISHED_DEFAULT_CHUNK_PROFILE.map(profile => profile.id),
        `${label} must carry the five published-default chunks in the exact `
          + 'order the reader compares them in; the same ids in another order '
          + 'are refused before any of them is applied',
      );
      let aggregateUncompressedBytes = 0;
      let accountedBytes = MAGIC.length + 4
        + readU32(bytes, MAGIC.length, `${label} manifest`);
      for (const [index, profile] of PUBLISHED_DEFAULT_CHUNK_PROFILE.entries()) {
        const chunk = manifest.chunks[index];
        for (const key of PUBLISHED_DEFAULT_PROFILE_KEYS) {
          assert.equal(
            chunk[key],
            profile[key],
            `${label} chunk ${profile.id} must declare ${key} `
              + `${JSON.stringify(profile[key])}`,
          );
        }
        assert.ok(
          Number.isSafeInteger(chunk.storedBytes) && chunk.storedBytes > 0,
          `${label} chunk ${profile.id} must store at least one byte`,
        );
        assert.ok(
          Number.isSafeInteger(chunk.uncompressedBytes)
            && chunk.uncompressedBytes > 0,
          `${label} chunk ${profile.id} must decode to at least one byte`,
        );
        accountedBytes += 4 + chunk.storedBytes;
      }
      assert.equal(
        bytes.length,
        accountedBytes,
        `${label} length must be exactly its magic, manifest, and five `
          + 'length-prefixed payloads',
      );
      assert.ok(
        bytes.length >= MINIMUM_REVIEWED_PRESET_BYTES,
        `${label} is ${bytes.length} bytes, below the `
          + `${MINIMUM_REVIEWED_PRESET_BYTES}-byte floor a reviewed view needs; `
          + 'a size check without a floor accepts a preset that restores nothing',
      );
    },
  );

  test(
    `${datasetId} preset fingerprint is read back out of its generation`,
    async () => {
      const { label, manifest } = await loadPublishedPreset(datasetId);
      const identity = await readGenerationIdentity(datasetId);
      const fingerprint = manifest.datasetFingerprint;
      assert.equal(
        fingerprint.datasetId,
        identity.id,
        `${label} must name the generation it sits beside`,
      );
      assert.equal(
        typeof identity.created_at,
        'string',
        `${datasetId} publishes a reviewed preset but records no created_at, so `
          + 'there is nothing to order the capture against',
      );
      const preparedAt = Date.parse(identity.created_at);
      assert.ok(
        Number.isFinite(preparedAt),
        `${datasetId}/dataset_identity.json created_at `
          + `'${identity.created_at}' is not a readable instant`,
      );
      assert.ok(
        Date.parse(manifest.createdAt) >= preparedAt,
        `${label} was captured at ${manifest.createdAt}, before the generation `
          + `it describes was prepared at ${identity.created_at}. A preset that `
          + 'predates its own export was carried over from an earlier one, and '
          + 'every row index it stores denotes a cell this generation had not '
          + 'laid out yet',
      );
      assert.equal(
        fingerprint.cellCount,
        identity.stats.n_cells,
        `${label} records ${fingerprint.cellCount} cells while the generation `
          + `publishes ${identity.stats.n_cells}; the application compares the `
          + 'two and refuses the preset when they differ',
      );
      assert.equal(
        fingerprint.varCount,
        identity.stats.n_genes,
        `${label} records ${fingerprint.varCount} genes while the generation `
          + `publishes ${identity.stats.n_genes}`,
      );
      assert.equal(
        fingerprint.cellOrder.dimension,
        identity.embeddings.default_dimension,
        `${label} must have been captured on the dimension the generation `
          + 'publishes as its default, which is the only one the sample picker '
          + 'opens on',
      );
      assert.equal(
        fingerprint.cellOrder.embedding?.key,
        identity.embeddings.defaults[`${fingerprint.cellOrder.dimension}d`],
        `${label} must have been captured on the default embedding of the `
          + 'dimension it records',
      );
      assert.equal(
        identity.embeddings.items[fingerprint.cellOrder.embedding.key].dimension,
        fingerprint.cellOrder.dimension,
        `${label} cell-order embedding must have the dimension it records`,
      );
      await assertDefaultExportMapping(fingerprint.dataMapping, datasetId, identity, label);
      assert.equal(
        fingerprint.cellOrder.digest,
        await digestPublishedCellOrder(
          datasetId,
          identity,
          fingerprint.cellOrder.embedding.key,
          label,
        ),
        `${label} cell-order digest does not reproduce from the coordinates the `
          + 'generation publishes, so every row index the preset stores denotes '
          + 'a different cell than it did when the view was reviewed',
      );
    },
  );

  test(
    `${datasetId} preset activates a field the generation publishes`,
    async () => {
      const { chunks, label } = await loadPublishedPreset(datasetId);
      const identity = await readGenerationIdentity(datasetId);
      const core = chunks.get('core/state');
      assert.equal(
        core.activeFields.activeFieldSource,
        'obs',
        `${label} must colour by an observation field, which is the only source `
          + 'the documented starting state names',
      );
      const published = identity.obs_fields.find(
        field => field.key === core.activeFields.activeFieldKey,
      );
      assert.ok(
        published !== undefined,
        `${label} colours by '${core.activeFields.activeFieldKey}', which `
          + `${datasetId} does not publish; the application refuses a preset `
          + 'whose active field is not in the loaded inventory',
      );
      assert.equal(
        published.key,
        EXPECTED_ACTIVE_FIELD_KEY,
        `${label} must activate the documented ${EXPECTED_ACTIVE_FIELD_KEY} field`,
      );
      assert.equal(
        published.kind,
        EXPECTED_ACTIVE_FIELD_KIND,
        `${label} activates '${published.key}', which the generation publishes `
          + `as ${published.kind} rather than ${EXPECTED_ACTIVE_FIELD_KIND}`,
      );
      assert.ok(
        Number.isSafeInteger(published.n_categories)
          && published.n_categories > 1,
        `${label} colours by '${published.key}', which resolves to `
          + `${published.n_categories} categories, so the reviewed view opens `
          + 'as one flat colour',
      );

      const overlays = chunks.get('core/field-overlays');
      assertExactKeys(
        overlays,
        ['renames', 'deletedFields', 'userDefinedFields'],
        `${label} core/field-overlays`,
      );
      assert.equal(
        overlays.deletedFields.deleted.includes(published.key),
        false,
        `${label} deletes the same field it activates`,
      );
      assert.equal(
        Object.hasOwn(overlays.renames.fields, published.key),
        false,
        `${label} renames the same field it activates`,
      );
      assert.equal(
        identity.embeddings.items[core.liveEmbedding.key].dimension,
        identity.embeddings.default_dimension,
        `${label} must open on the dimension the generation publishes as its `
          + 'default',
      );
    },
  );

  test(
    `${datasetId} preset restores the generation exactly as prepared`,
    async () => {
      const { chunks, label } = await loadPublishedPreset(datasetId);

      const overlays = chunks.get('core/field-overlays');
      assert.deepEqual(
        overlays,
        EXPECTED_FIELD_OVERLAYS,
        `${label} core/field-overlays must rename nothing, hide nothing and `
          + 'invent nothing: a user-defined field would need a '
          + 'user-defined/codes chunk the five-chunk published-default profile '
          + 'cannot carry, and a rename or deletion would restore a view that '
          + 'disagrees with the prepared export',
      );

      assert.deepEqual(
        chunks.get('ui/dockable-layout'),
        EXPECTED_DOCKABLE_LAYOUT,
        `${label} ui/dockable-layout must dock every panel: a floating panel is `
          + "stored as the author's absolute viewport rectangle and would open "
          + 'off-screen on a narrower window',
      );

      assert.deepEqual(
        chunks.get('analysis/windows'),
        EXPECTED_ANALYSIS_WINDOWS,
        `${label} analysis/windows must reopen no window: their computed `
          + 'artifacts travel in chunks this profile cannot carry, so a '
          + 'restored window would open empty',
      );

      const highlights = chunks.get('highlights/meta');
      assertExactKeys(
        highlights,
        ['pages', 'activePageId'],
        `${label} highlights/meta`,
      );
      assert.ok(
        Array.isArray(highlights.pages),
        `${label} highlights/meta pages must be an array`,
      );
      assert.equal(
        highlights.pages.length,
        EXPECTED_HIGHLIGHT_PAGE_COUNT,
        `${label} must open on exactly ${EXPECTED_HIGHLIGHT_PAGE_COUNT} empty `
          + 'highlight page, which is what the documented "no kept snapshots" '
          + 'starting state means',
      );
      const pageIds = new Set();
      for (const [index, page] of highlights.pages.entries()) {
        const pageLabel = `${label} highlight page ${index}`;
        assertExactKeys(
          page,
          ['id', 'name', 'color', 'highlightedGroups'],
          pageLabel,
        );
        assert.match(
          page.id,
          HIGHLIGHT_PAGE_ID_PATTERN,
          `${pageLabel} id must use the application's page identity`,
        );
        assert.equal(
          pageIds.has(page.id),
          false,
          `${pageLabel} repeats the id ${page.id}`,
        );
        pageIds.add(page.id);
        assert.ok(
          typeof page.name === 'string' && page.name.length > 0,
          `${pageLabel} must carry a printable name`,
        );
        assert.match(
          page.color,
          HIGHLIGHT_PAGE_COLOR_PATTERN,
          `${pageLabel} colour must be a six-digit hex value`,
        );
        assert.deepEqual(
          page.highlightedGroups,
          [],
          `${pageLabel} lists a highlight group whose cell membership lives in `
            + 'a highlights/cells chunk this profile cannot carry, so the '
            + 'application would refuse the preset',
        );
      }
      assert.ok(
        pageIds.has(highlights.activePageId),
        `${label} activePageId '${highlights.activePageId}' is not one of its `
          + 'own pages',
      );
    },
  );

  test(
    `${datasetId} preset UI controls are restorable and dataset-consistent`,
    async () => {
      const { chunks, label } = await loadPublishedPreset(datasetId);
      const identity = await readGenerationIdentity(datasetId);
      const core = chunks.get('core/state');
      const controls = core.uiControls;
      assert.ok(
        controls !== null
          && typeof controls === 'object'
          && !Array.isArray(controls),
        `${label} uiControls must be an object`,
      );
      const controlIds = Object.keys(controls);
      assert.ok(
        controlIds.length > 0,
        `${label} carries no UI controls, and the application refuses any `
          + 'record that is not the complete current inventory',
      );
      for (const controlId of controlIds) {
        assertUiControlRecord(
          controlId,
          controls[controlId],
          `${label} UI control ${JSON.stringify(controlId)}`,
        );
      }

      assert.equal(
        controls['theme-select'].value,
        EXPECTED_THEME,
        `${label} must open on the documented ${EXPECTED_THEME} theme`,
      );
      assert.equal(
        controls['background-select'].value,
        EXPECTED_BACKGROUND,
        `${label} must open on the documented ${EXPECTED_BACKGROUND} background`,
      );
      assert.equal(
        controls['view-layout-mode'].value,
        core.multiview.layout.mode,
        `${label} restores the view-layout-mode select and the multiview layout `
          + 'from the same file; disagreeing values leave the control showing a '
          + 'layout the viewer is not in',
      );

      const edgeLimit = Number(controls['connectivity-limit'].value);
      assert.ok(
        Number.isSafeInteger(edgeLimit) && edgeLimit > 0,
        `${label} connectivity-limit must be a positive whole number of edges`,
      );
      const publishedEdges = identity.stats.has_connectivity === true
        ? identity.stats.n_edges
        : 0;
      assert.ok(
        edgeLimit <= publishedEdges,
        `${label} asks for ${edgeLimit} connectivity edges while the generation `
          + `publishes ${publishedEdges}; the application clamps that slider's `
          + 'maximum to the graph it loaded and refuses a session value above it',
      );

      const vectorFields = identity.vector_fields?.fields ?? {};
      const selectedVectorField = controls['velocity-field'].value;
      if (selectedVectorField === '') {
        assert.equal(
          Object.keys(vectorFields).length === 0
            || controls['velocity-overlay-enabled'].checked === false,
          true,
          `${label} selects no vector field while the overlay is enabled`,
        );
      } else {
        assert.ok(
          Object.hasOwn(vectorFields, selectedVectorField),
          `${label} selects the vector field '${selectedVectorField}', which `
            + `${datasetId} does not publish; the application rebuilds that `
            + "select's options from the generation and refuses a value that is "
            + 'not among them',
        );
        const liveEmbedding = core.liveEmbedding.key;
        assert.ok(
          Object.hasOwn(vectorFields[selectedVectorField].files, liveEmbedding),
          `${label} selects '${selectedVectorField}', which the generation does `
            + `not bind to '${liveEmbedding}', the embedding the preset opens on`,
        );
      }
    },
  );

  test(
    `${datasetId} preset camera is one resting orbit view`,
    async () => {
      const { chunks, label } = await loadPublishedPreset(datasetId);
      const core = chunks.get('core/state');
      for (const [cameraLabel, camera] of [
        [`${label} camera`, core.camera],
        [`${label} multiview liveCameraState`, core.multiview.liveCameraState],
      ]) {
        assert.equal(
          camera.navigationMode,
          'orbit',
          `${cameraLabel} must open in the documented Orbit navigation mode`,
        );
        assert.ok(
          Number.isFinite(camera.orbit.radius) && camera.orbit.radius > 0,
          `${cameraLabel} orbit radius must be a positive finite distance`,
        );
        assert.equal(
          camera.orbit.radius,
          camera.orbit.targetRadius,
          `${cameraLabel} is mid-zoom: its radius and targetRadius disagree, so `
            + 'the documented static close-up would drift the moment it is applied',
        );
        assert.ok(
          camera.orbit.phi > 0 && camera.orbit.phi < Math.PI,
          `${cameraLabel} orbit phi must sit strictly between the poles`,
        );
        const derived = deriveFreeflyFromOrbit(camera.orbit);
        for (const [axis, value] of derived.position.entries()) {
          assert.ok(
            Math.abs(camera.freefly.position[axis] - value)
              <= CAMERA_DERIVATION_TOLERANCE,
            `${cameraLabel} freefly eye axis ${axis} is `
              + `${camera.freefly.position[axis]} where its own orbit state puts `
              + `it at ${value}, so switching navigation mode teleports the view`,
          );
        }
        assert.ok(
          Math.abs(camera.freefly.yaw - derived.yaw)
            <= CAMERA_DERIVATION_TOLERANCE,
          `${cameraLabel} freefly yaw ${camera.freefly.yaw} does not look at the `
            + `orbit target, which needs ${derived.yaw}`,
        );
        assert.ok(
          Math.abs(camera.freefly.pitch - derived.pitch)
            <= CAMERA_DERIVATION_TOLERANCE,
          `${cameraLabel} freefly pitch ${camera.freefly.pitch} does not look at `
            + `the orbit target, which needs ${derived.pitch}`,
        );
      }
    },
  );
}

/**
 * The invariant: the reviewed presets are one review pass, so their capture
 * timestamps sit inside one window rather than being five unrelated instants
 * that each happen to be well-formed.
 */
test('the reviewed presets were captured in one review pass', async () => {
  assert.ok(
    PRESET_DATASET_IDS.length > 1,
    'comparing the reviewed capture times needs more than one preset',
  );
  const captures = await Promise.all(
    PRESET_DATASET_IDS.map(async (datasetId) => {
      const { label, manifest } = await loadPublishedPreset(datasetId);
      return { at: Date.parse(manifest.createdAt), label, text: manifest.createdAt };
    }),
  );
  const earliest = captures.reduce((low, one) => (one.at < low.at ? one : low));
  const latest = captures.reduce((high, one) => (one.at > high.at ? one : high));
  assert.ok(
    latest.at - earliest.at <= MAXIMUM_REVIEW_PASS_SPAN_MS,
    `${earliest.label} was captured at ${earliest.text} and ${latest.label} at `
      + `${latest.text}, ${((latest.at - earliest.at) / 3_600_000).toFixed(1)} `
      + `hours apart and outside the `
      + `${MAXIMUM_REVIEW_PASS_SPAN_MS / 3_600_000}-hour window one review pass `
      + 'takes. A preset re-captured on its own opens on a view nobody looked '
      + 'at beside the other four',
  );
});

test('reviewed presets differ only where the generations differ', async () => {
  assert.ok(
    PRESET_DATASET_IDS.length > 1,
    'comparing the reviewed presets needs more than one of them',
  );
  const controlsByDataset = new Map(
    await Promise.all(
      PRESET_DATASET_IDS.map(async datasetId => [
        datasetId,
        (await loadPublishedPreset(datasetId)).chunks.get('core/state')
          .uiControls,
      ]),
    ),
  );
  const [referenceId, ...otherIds] = PRESET_DATASET_IDS;
  const referenceControls = controlsByDataset.get(referenceId);
  const referenceIds = Object.keys(referenceControls).sort();
  assert.ok(
    referenceIds.length > 0,
    'the reviewed presets must carry a UI control inventory to compare',
  );
  const divergent = new Set();
  for (const datasetId of otherIds) {
    const controls = controlsByDataset.get(datasetId);
    assert.deepEqual(
      Object.keys(controls).sort(),
      referenceIds,
      `${datasetId} and ${referenceId} were captured against different control `
        + 'inventories, so at least one of them predates the current interface',
    );
    for (const controlId of referenceIds) {
      if (
        JSON.stringify(controls[controlId])
        !== JSON.stringify(referenceControls[controlId])
      ) {
        divergent.add(controlId);
      }
    }
  }
  const drifted = [...divergent]
    .filter(controlId => !DATASET_DERIVED_UI_CONTROL_IDS.includes(controlId))
    .sort();
  assert.deepEqual(
    drifted,
    [],
    'the reviewed presets must agree on every control the application does not '
      + 'derive from the loaded generation; a control that differs across the '
      + `five is one dataset opening on a view nobody reviewed (${
        drifted.join(', ')})`,
  );
  // The derived controls are what this assertion tolerates, so it is worth
  // knowing they are still reachable: an id that left the interface would sit
  // in the list forever, widening the tolerance against a control that no
  // longer exists.
  for (const controlId of DATASET_DERIVED_UI_CONTROL_IDS) {
    assert.ok(
      Object.hasOwn(referenceControls, controlId),
      `${controlId} is tolerated as dataset-derived but no reviewed preset `
        + 'carries it; the tolerance now covers nothing and hides whatever '
        + 'replaced it',
    );
  }
});

/* ------------------------------------------------------------------ *
 * A Save State is not a publishable preset.
 *
 * The viewer's Save State writes every chunk its session contributors emit --
 * seven for a session with nothing kept. `restorePublishedDefaultState()`
 * accepts exactly the five above, so publishing means dropping
 * `cinematic/camera` and `analysis/cache-inventory`, and that drop is lossless
 * only while both are empty. A recorded camera path dropped from a capture is
 * gone -- the export format stores it nowhere else -- and the file that ships
 * still loads, so nothing downstream notices (CEL-0248).
 *
 * `scripts/publish_session_preset.mjs` performs that trim and refuses when a
 * dropped chunk carries anything. The two tests below run it, because a publish
 * helper nobody exercises is a second way to get the trim wrong rather than the
 * first way to get it right. Both need the viewer repository, which owns the
 * rule; only an absent *repository* is a reason to skip.
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
    t.skip(
      'the cellucid repository is not checked out beside this one, so the '
        + 'profile pinned above cannot be compared with the rule it copies',
    );
    return;
  }
  const { PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE } = await import(
    new URL('assets/js/app/session/published-default.js', VIEWER_REPOSITORY_URL)
      .href
  );

  assert.deepEqual(
    PUBLISHED_DEFAULT_CHUNK_PROFILE.map(profile => ({ ...profile })),
    PUBLISHED_DEFAULT_STATIC_CHUNK_PROFILE.map(profile => ({ ...profile })),
    'the profile pinned in this file must be the one '
      + 'restorePublishedDefaultState() validates against, field for field and '
      + 'in the same order. A pin that outlives the rule it copies reads as '
      + 'agreement while the application refuses every preset it governs',
  );
  assert.deepEqual(
    [...PUBLISHED_DEFAULT_CHUNK_PROFILE.map(profile => profile.id)].sort(),
    [...EXPECTED_CHUNK_IDS],
    'the pinned ids and the pinned profile must describe one set of chunks',
  );
});

/**
 * The Save State a published preset was trimmed from.
 *
 * Built out of a published preset rather than invented, so the two differ by
 * exactly the chunks publishing removes: the viewer emits eager chunks in
 * contributor order, which puts `cinematic/camera` between the field overlays
 * and the core state, and the analysis cache inventory last.
 *
 * @param {{ bytes: Buffer, manifest: any }} preset
 * @param {{ keyframes: any[], artifactIds: string[] }} recorded
 */
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
        defaultSpeed: '50',
        autoplay: false,
        invertLook: false,
        orbitReverse: false,
        planarInvertAxes: false,
        planarZoomToCursor: true,
        showOrbitAnchor: true,
        orbitKeySpeed: '20',
        planarPanSpeed: '20',
        lookSensitivity: '10',
        moveSpeed: '20',
      },
    },
    {
      after: null,
      meta: {
        id: 'analysis/cache-inventory',
        contributorId: 'analysis-artifacts',
        priority: 'eager',
        kind: 'json',
        codec: 'gzip',
        label: 'Analysis cache inventory',
        datasetDependent: true,
      },
      payload: { artifactIds: recorded.artifactIds },
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

test('the publish helper reproduces a published preset from its save', async (t) => {
  if (!await viewerRepositoryPresent()) {
    t.skip('the cellucid repository is not checked out beside this one');
    return;
  }
  const { trimSaveStateToPreset } = await import(
    new URL('../scripts/publish_session_preset.mjs', import.meta.url).href
  );

  for (const datasetId of PRESET_DATASET_IDS) {
    const preset = await loadPublishedPreset(datasetId);
    const save = saveStateFor(preset, { keyframes: [], artifactIds: [] });
    assert.equal(
      save.chunkIds.length,
      PUBLISHED_DEFAULT_CHUNK_PROFILE.length + 2,
      `${preset.label} save must carry the two chunks publishing removes`,
    );

    const published = await trimSaveStateToPreset(save.bytes, datasetId);
    assert.deepEqual(
      published.chunkIds,
      PUBLISHED_DEFAULT_CHUNK_PROFILE.map(profile => profile.id),
      `${preset.label} must publish as the five accepted chunks in order`,
    );
    assert.deepEqual(
      Buffer.from(published.bytes),
      preset.bytes,
      `${preset.label} must be byte-identical to what the publish helper `
        + 'produces from the capture it came from -- if it is not, the '
        + 'committed file was trimmed by some other hand and the helper is not '
        + 'the thing that made it',
    );
    assert.equal(
      published.sha256,
      EXPECTED[datasetId].sha256,
      `${preset.label} published digest`,
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
  const datasetId = PRESET_DATASET_IDS[0];
  const preset = await loadPublishedPreset(datasetId);

  const withCameraPath = saveStateFor(preset, {
    keyframes: [{
      id: 'kf_1',
      label: 'Opening',
      durationMs: 1_000,
      camera: { radius: 2.43, theta: 0.78, phi: 0.78, target: [0, 0, 0] },
    }],
    artifactIds: [],
  });
  await assert.rejects(
    () => trimSaveStateToPreset(withCameraPath.bytes, datasetId),
    /cinematic\/camera.*keyframes holds 1 entry/s,
    'a capture holding a camera path must be refused by name and by content; '
      + 'publishing it would drop the path into a file that still loads',
  );

  const withCachedArtifacts = saveStateFor(preset, {
    keyframes: [],
    artifactIds: ['analysis/artifacts/bulk-gene/page_1/CD8A'],
  });
  await assert.rejects(
    () => trimSaveStateToPreset(withCachedArtifacts.bytes, datasetId),
    /analysis\/cache-inventory.*artifactIds holds 1 entry/s,
    'a capture naming cached analysis artifacts must be refused: the chunks '
      + 'those names point at cannot travel in a published default either',
  );
});
