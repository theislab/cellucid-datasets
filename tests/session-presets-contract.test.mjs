import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { describeStore, readArray, readObsm } from '../scripts/anndata_store.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ANNDATA_ROOT = path.join(REPOSITORY_ROOT, 'anndata');
/** Session format 4: the format version is part of the signature. */
const MAGIC = Buffer.from('CELLUCID_SESSION/4\n', 'utf8');
const CATALOG = JSON.parse(await readFile(path.join(ANNDATA_ROOT, 'datasets.json'), 'utf8'));

/**
 * The reviewed starting view of every sample, per dataset.
 *
 * A preset records the application's digest of the 3-D coordinates its store
 * holds: the stored values of its default 3-D embedding, each cell named by
 * its original position (`cell-order-digest.js`). The application recomputes
 * it from the loaded dataset and refuses a preset whose digest disagrees, so
 * this suite recomputes it from the store too (`digestStoreCellOrder`) and
 * compares the preset's with it: that is what lets it see a preset go stale.
 * The cameras are the ones the reviewed presets carried before the
 * samples became AnnData stores: the stores lay out the same cells at the same
 * coordinates, and each preset was re-captured in the viewer on its store with
 * that reviewed view restored (session format 4: the camera is the `camera`
 * value of the view's one root, the live view's). Suo's and Garcia's cameras
 * sat inside their clouds (orbit radius 0.88 and 1.11 on coordinates
 * normalized to about [-1, 1]); they keep their reviewed direction and are
 * pulled back to radius 3 and 2.6, which frame the whole cloud.
 */
const EXPECTED = Object.freeze({
  suo: Object.freeze({
    cellCount: 561_947,
    varCount: 5_103,
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

const EXPECTED_CELL_ORDER_DIMENSION = 3;
/**
 * The state domains a starting view's one root holds: every domain of the
 * viewer (`cellucid/assets/js/app/actions/domains.js`) but the cells that are
 * open and the person's own layout (`STARTING_VIEW_OMITTED_DOMAINS`,
 * `published-default.js`). This is a pin, not a second definition: `every
 * preset is a starting view the viewer accepts` below reads the viewer's
 * domains and fails when the two disagree. The pin exists so this suite still
 * governs the presets when it runs alone, which is how this repository's CI
 * runs it.
 */
const STARTING_VIEW_DOMAINS = Object.freeze([
  'mapping', 'field-overlays', 'gene-sets', 'views', 'active-field', 'filters', 'colors', 'visibility',
  'highlights', 'camera', 'camera-path', 'settings', 'analysis',
]);
/**
 * The controls the application sets from the loaded dataset rather than from
 * the markup, so a capture is expected to disagree with the other four here:
 *
 * - `velocity-field`, whose option list is rebuilt from the dataset's declared
 *   vector fields (`renderFieldSelectForActiveDim()` in
 *   `cellucid/assets/js/app/ui/modules/velocity-overlay-controls.js`).
 * - `point-size`, computed from the cell count by
 *   `applyDatasetRenderDefaults()` in
 *   `cellucid/assets/js/app/ui/core/ui-coordinator.js`, because one shipped
 *   constant cannot be right for a 3,696-cell trajectory and an 18-million-cell
 *   atlas at once (the reviewed Pancreas view sets its own).
 *
 * Every other control is markup the reviewed captures share, so a divergence
 * outside this set is one dataset's view having silently drifted. That
 * includes `connectivity-limit`: its slider's range follows the edges the
 * viewer loaded, but a session records the person's edge preference
 * (`data-session-preference`), the same 250,000 in every preset until someone
 * moves the slider.
 *
 * Membership means a control *may* differ, not that it must: two datasets of
 * similar size can agree on a point size, and that is a fact about the
 * datasets rather than about the presets.
 */
const DATASET_DERIVED_UI_CONTROL_IDS = Object.freeze([
  'point-size',
  'velocity-field',
]);
/**
 * The control types of the viewer's control inventory a `settings` value
 * holds. Accordion sections (`details`) and the theme are the `layout`
 * domain's, which a starting view does not hold; the sidebar's pressed-button
 * groups (the selection tool) are page chrome, which the file carries beside
 * its history (`EXPECTED_CHROME`).
 */
const UI_CONTROL_TYPES = Object.freeze([
  'checkbox',
  'color',
  'number',
  'range',
  'select',
  'text',
]);
/**
 * The page chrome every reviewed view carries outside its history
 * (`chrome`, `cellucid/assets/js/app/session/history-file.js`,
 * `assertPageChrome`): the pressed button of each pressed-button group of the
 * sidebar, `data-state-serializer-pressed-group`. The reviewed views open
 * with the annotation selection tool, the one they were reviewed in; the
 * viewer puts it back after the view is shown (`applyPageChrome`), and every
 * later gesture is interpreted in it.
 */
const EXPECTED_CHROME = Object.freeze({ pressed: Object.freeze({ 'highlight-mode': 'highlight-mode-annotation' }) });
/**
 * The documented reviewed view: `cell_type` coloring, Studio (light)
 * background, nothing filtered, recolored, hidden, renamed, made, kept,
 * highlighted, analyzed or recorded. The theme, the panels and the sidebar are
 * the person's own (`layout`), which a starting view leaves alone.
 */
const EXPECTED_ACTIVE_FIELD = Object.freeze({ views: [{ source: 'obs', key: 'cell_type' }] });
const EXPECTED_BACKGROUND = 'studio';
const EXPECTED_FIELD_OVERLAYS = Object.freeze({
  renamedFields: [], renamedCategories: [], deletedFields: [], userFields: [],
});
const EXPECTED_GENE_SETS = Object.freeze({ sets: [] });
const EXPECTED_NO_FILTERS = Object.freeze({ views: [[]] });
const EXPECTED_NO_COLORS = Object.freeze({ views: [[]] });
const EXPECTED_ANALYSIS = Object.freeze({ windows: [], docked: { openMode: null, modes: {} } });
/** No camera path: the path the app opens with, and its playback settings. */
const EXPECTED_CAMERA_PATH = Object.freeze({
  keyframes: [], nextIndex: 1, loopBackKeyframeId: null, autoplay: false, loopPlayback: false,
  positionMethod: 'catmull-rom', rotationMethod: 'slerp', easing: 'linear', defaultSpeed: '30',
});
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

const SCRATCH = new Float32Array(1);
const SCRATCH_BITS = new Uint32Array(SCRATCH.buffer);

/** MurmurHash3 (x86, 32-bit) of four little-endian words under `seed`. */
function murmur3Words(words, seed) {
  let h = seed;
  for (let word of words) {
    word = Math.imul(word, 0xcc9e2d51);
    word = (word << 15) | (word >>> 17);
    word = Math.imul(word, 0x1b873593);
    h ^= word;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  return fmix32(h ^ 16);
}

function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * `cellOrderDigest()` from `cellucid/assets/js/data/cell-order-digest.js`
 * for 3-D points, transcribed: each cell's MurmurHash3 lanes of its original
 * position and the float32 bits of its three values, summed, then finalized
 * with the cell count. The order of the cells does not matter; which cell
 * each row is does.
 *
 * @param {Float32Array} values - Three stored values per row
 * @param {ArrayLike<number>} originals - The original position of each row
 */
function cellOrderDigest(values, originals) {
  let low = 0;
  let high = 0;
  const cells = values.length / 3;
  for (let row = 0; row < cells; row++) {
    const words = [Number(originals[row]) >>> 0];
    for (let axis = 0; axis < 3; axis++) {
      SCRATCH[0] = values[row * 3 + axis];
      const bits = SCRATCH_BITS[0];
      words.push((bits & 0x7f800000) === 0x7f800000 && (bits & 0x007fffff) !== 0 ? 0x7fc00000 : bits);
    }
    low = (low + murmur3Words(words, 0x9e3779b1)) >>> 0;
    high = (high + murmur3Words(words, 0x85ebca6b)) >>> 0;
  }
  const first = fmix32((high ^ fmix32(cells ^ 0x297a2d39)) >>> 0);
  const second = fmix32((low ^ fmix32(cells ^ 0x2c1b3c6d)) >>> 0);
  return first.toString(16).padStart(8, '0') + second.toString(16).padStart(8, '0');
}

/**
 * The cell-order digest of one store's default 3-D embedding, as the viewer
 * takes it: the stored values, each row named by its original position
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
  const values = new Float32Array(obsm.cells * 3);
  for (let row = 0; row < obsm.cells; row++) {
    for (let axis = 0; axis < 3; axis++) values[row * 3 + axis] = obsm.values[row * obsm.width + axis];
  }
  return { described, key, digest: cellOrderDigest(values, original) };
}

/**
 * One control record of the `settings` value, validated the way the viewer's
 * control inventory validates it before restoring anything
 * (`validateControlRecord()`, used by `app/state/domains/settings.js`). A
 * record that fails here is one the application refuses, so the preset that
 * carries it restores nothing.
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
      `${label} must be an exact lowercase six-digit hex color`,
    );
  }
}

/**
 * Session format 4 as `cellucid/assets/js/app/session/history-file.js` writes
 * it, and the History v2 records it holds (`cellucid/assets/js/app/history/model.js`).
 * A starting view names no cells and no genes.
 */
const MANIFEST_KEYS = Object.freeze([
  'createdAt', 'app', 'actions', 'scope', 'datasetFingerprint', 'source', 'requires', 'chrome',
  'activeTracker', 'trackers', 'chunks',
]);
const TRACKER_KEYS = Object.freeze([
  'id', 'name', 'dataset', 'createdAt', 'by', 'start', 'removed', 'rootId', 'headId', 'activeBranch',
  'mainBranch', 'paused', 'branches', 'groups', 'steps', 'turns', 'notes', 'journal', 'chats',
  'nextStep', 'nextBranch', 'nextGroup', 'nextNote', 'nextJournal',
]);
const BRANCH_KEYS = Object.freeze(['id', 'name', 'base', 'tip', 'createdAt', 'by', 'lane', 'locked', 'archived', 'notes']);
const STEP_KEYS = Object.freeze([
  'id', 'parent', 'children', 'branch', 'kind', 'type', 'params', 'v', 'code', 'label', 'by', 'at', 'until',
  'merged', 'ms', 'touches', 'before', 'after', 'reads', 'status', 'reason', 'outcome', 'coalesceKey',
  'replayOf', 'squashed', 'notes', 'bookmark', 'group',
]);
/** Who made a starting view's one state: the dataset opening, nobody named. */
const OPENED_BY = Object.freeze({ origin: 'startup', agent: null, model: null, host: null, person: null, turn: null });
/** What a starting view holds of its one tracker (`trimToPublishedDefault`, `published-default.js`). */
const STARTING_VIEW_SCOPE = Object.freeze({
  content: 'history', results: 'include', notes: false, chats: false, journal: false, times: 'exact', source: 'name',
});
const CHUNK_BASE_KEYS = Object.freeze(['id', 'kind', 'priority', 'codec', 'storedBytes', 'uncompressedBytes']);
const CHUNK_KEYS = Object.freeze({
  steps: [...CHUNK_BASE_KEYS, 'tracker'],
  parts: CHUNK_BASE_KEYS,
  array: [...CHUNK_BASE_KEYS, 'digest', 'encoding'],
  values: CHUNK_BASE_KEYS,
});
/** Within a priority the kinds come in this order (`history-file.js`). */
const CHUNK_KIND_ORDER = Object.freeze(['steps', 'parts', 'array', 'values']);
const SPECIAL_NUMBERS = Object.freeze({ NaN: Number.NaN, Infinity: Infinity, '-Infinity': -Infinity, '-0': -0 });
const PART_NAME = /^[0-9a-f]{64}$/;

/**
 * A value as a starting view stores it (`cellucid/assets/js/app/history/value-parts.js`):
 * JSON with each typed array as `{"$array": "<type>:<length>:<sha256>"}`, each
 * number JSON cannot hold as `{"$number": …}`, and each sub-value of at least
 * 512 characters as `{"$part": <name>}`, stored once in a `parts` chunk.
 * Arrays come back as `{array: <type>, length}`, which is all this suite
 * compares of them; the viewer's reader, where it is checked out, compares
 * the elements and each joined value against its hash.
 */
function joinSkeleton(node, parts, label, joining = new Set()) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((item, index) => joinSkeleton(item, parts, `${label}[${index}]`, joining));
  if (Object.hasOwn(node, '$array')) {
    assertExactKeys(node, ['$array'], `${label} array`);
    const match = /^([A-Za-z0-9]+):(0|[1-9]\d*):[0-9a-f]{64}$/.exec(node.$array);
    assert.ok(match !== null, `${label} names an array by its digest`);
    return { array: match[1], length: Number(match[2]) };
  }
  if (Object.hasOwn(node, '$number')) {
    assertExactKeys(node, ['$number'], `${label} number`);
    assert.ok(Object.hasOwn(SPECIAL_NUMBERS, node.$number), `${label} names a number JSON cannot hold`);
    return SPECIAL_NUMBERS[node.$number];
  }
  if (Object.hasOwn(node, '$part')) {
    assertExactKeys(node, ['$part'], `${label} part`);
    assert.ok(typeof node.$part === 'string' && PART_NAME.test(node.$part), `${label} names a part by its digest`);
    assert.ok(parts.has(node.$part), `${label} names a part the file holds`);
    assert.ok(!joining.has(node.$part), `${label} names a part inside itself`);
    joining.add(node.$part);
    const joined = joinSkeleton(parts.get(node.$part), parts, label, joining);
    joining.delete(node.$part);
    return joined;
  }
  return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, joinSkeleton(child, parts, `${label}.${key}`, joining)]));
}

/** The parts and arrays a skeleton names, through the parts it names. */
function namedByValues(skeletons, parts) {
  const named = { parts: new Set(), arrays: new Set() };
  const queue = [...skeletons];
  while (queue.length > 0) {
    const node = queue.pop();
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      queue.push(...node);
    } else if (typeof node.$array === 'string') {
      named.arrays.add(node.$array);
    } else if (typeof node.$part === 'string') {
      if (!named.parts.has(node.$part)) queue.push(parts.get(node.$part));
      named.parts.add(node.$part);
    } else {
      queue.push(...Object.values(node));
    }
  }
  return named;
}

/**
 * Read a published starting view (session format 4, `cellucid/assets/js/app/session/history-file.js`)
 * as this suite needs it, without the viewer: its manifest, its one tracker
 * of one root, and each state domain's value at that root. A starting view is
 * one tracker of one branch and one root, every chunk eager, no source and no
 * cells, no action, no journal and no conversation (`assertPublishedDefaultProfile`,
 * `published-default.js`), and its page chrome beside its history.
 */
function decodeStartingView(buffer, label) {
  assert.equal(
    buffer.subarray(0, MAGIC.length).compare(MAGIC),
    0,
    `${label} must use the current Cellucid session signature`,
  );
  let offset = MAGIC.length;
  const manifestLength = readU32(buffer, offset, `${label} manifest`);
  offset += 4;
  assert.ok(manifestLength > 0 && offset + manifestLength <= buffer.length, `${label} manifest must fit inside the session`);
  const manifest = JSON.parse(buffer.subarray(offset, offset + manifestLength).toString('utf8'));
  offset += manifestLength;
  assert.deepEqual(Object.keys(manifest), MANIFEST_KEYS, `${label} manifest holds exactly the current fields, in order (a starting view names no cells and no genes)`);
  assert.equal(manifest.source, null, `${label} is applied to the sample it ships beside, so it records no source`);
  assert.equal(new Date(manifest.createdAt).toISOString(), manifest.createdAt, `${label} createdAt must be canonical ISO`);
  const readAt = Date.now();
  assert.ok(
    Date.parse(manifest.createdAt) <= readAt,
    `${label} was captured at ${manifest.createdAt}, ahead of the `
      + `${new Date(readAt).toISOString()} clock reading it. A capture `
      + 'timestamp records something that already happened, so this file was '
      + 'either written by a machine whose clock is wrong or edited by hand',
  );
  assertExactKeys(manifest.app, ['version', 'catalog'], `${label} app stamp`);
  assert.match(manifest.app.version, /^\d+\.\d+\.\d+$/, `${label} names the viewer version that wrote it`);
  assert.match(manifest.app.catalog, /^[0-9a-f]{64}$/, `${label} names the action catalog it was written with`);
  assert.deepEqual(manifest.actions, [], `${label} holds no step, so it stamps no action`);
  assert.deepEqual(manifest.chrome, EXPECTED_CHROME, `${label} carries the reviewed selection tool as its page chrome`);

  assert.equal(manifest.trackers.length, 1, `${label} holds one tracker`);
  const [tracker] = manifest.trackers;
  assert.deepEqual(Object.keys(tracker), TRACKER_KEYS, `${label} tracker holds exactly the current fields, in order`);
  assert.equal(manifest.activeTracker, tracker.id);
  assert.deepEqual(manifest.scope, {
    trackers: [tracker.id], branches: [{ tracker: tracker.id, branches: [tracker.mainBranch] }], ...STARTING_VIEW_SCOPE,
  }, `${label} scope`);
  assert.equal(tracker.name, 'Starting view');
  assert.deepEqual(tracker.by, OPENED_BY, `${label} was made by the dataset opening`);
  assert.deepEqual(tracker.start, { kind: 'opened', from: null, report: null, mapping: null });
  assert.equal(tracker.createdAt, Date.parse(manifest.createdAt), `${label} tracker was made when it was captured`);
  assert.deepEqual(
    [tracker.headId, tracker.nextStep, tracker.removed, tracker.paused, tracker.journal],
    [tracker.rootId, 1, null, null, null],
    `${label} is one state, recording, with no Recently deleted: its root is its head`,
  );
  assert.deepEqual(
    [tracker.groups, tracker.turns, tracker.notes, tracker.chats],
    [[], [], [], []],
    `${label} holds no group, turn, note or conversation`,
  );
  assert.equal(tracker.branches.length, 1, `${label} holds one branch`);
  const [branch] = tracker.branches;
  assert.deepEqual(Object.keys(branch), BRANCH_KEYS, `${label} branch holds exactly the current fields, in order`);
  assert.deepEqual(
    { id: branch.id, name: branch.name, base: branch.base, tip: branch.tip, notes: branch.notes },
    { id: tracker.mainBranch, name: 'Main', base: null, tip: tracker.rootId, notes: [] },
    `${label} branch`,
  );
  assert.equal(tracker.activeBranch, tracker.mainBranch);

  const steps = [];
  const values = new Map();
  const parts = new Map();
  const arrays = new Set();
  let kindIndex = 0;
  for (const [index, meta] of manifest.chunks.entries()) {
    assert.ok(Object.hasOwn(CHUNK_KEYS, meta.kind), `${label} chunk ${index} is of a kind a starting view holds`);
    assertExactKeys(meta, CHUNK_KEYS[meta.kind], `${label} chunk ${meta.id}`);
    assert.equal(meta.priority, 'eager', `${label} chunk ${meta.id}: a starting view holds its one state only`);
    assert.ok(CHUNK_KIND_ORDER.indexOf(meta.kind) >= kindIndex, `${label} chunk ${meta.id} comes in the order of its kind`);
    kindIndex = CHUNK_KIND_ORDER.indexOf(meta.kind);
    const storedLength = readU32(buffer, offset, `${label} chunk ${meta.id}`);
    offset += 4;
    assert.equal(storedLength, meta.storedBytes, `${label} chunk ${meta.id} stored length`);
    assert.ok(offset + storedLength <= buffer.length, `${label} chunk ${meta.id} must fit inside the session`);
    const stored = buffer.subarray(offset, offset + storedLength);
    offset += storedLength;
    assert.ok(meta.codec === 'gzip' || meta.codec === 'none', `${label} chunk ${meta.id} codec`);
    const decoded = meta.codec === 'gzip' ? gunzipSync(stored) : stored;
    assert.equal(decoded.length, meta.uncompressedBytes, `${label} chunk ${meta.id} decoded length`);
    if (meta.codec === 'gzip') {
      // Kept compressed only where that saves at least a sixteenth of its bytes.
      assert.ok(meta.storedBytes * 16 <= meta.uncompressedBytes * 15, `${label} chunk ${meta.id} is compressed only for a gain`);
    }
    if (meta.kind === 'steps') {
      assert.equal(meta.id, `steps/0/${tracker.steps.indexOf(meta.id)}`, `${label} chunk ${meta.id} is a steps chunk its tracker names, in order`);
      assert.equal(meta.tracker, tracker.id);
      steps.push(...JSON.parse(decoded.toString('utf8')));
    } else if (meta.kind === 'array') {
      assert.equal(meta.id, `array/${meta.digest}`);
      assert.ok(meta.encoding === 'raw' || meta.encoding === 'cell-set', `${label} array ${meta.digest} encoding`);
      if (meta.encoding === 'raw') {
        assert.equal(
          createHash('sha256').update(decoded).digest('hex'),
          meta.digest.slice(meta.digest.lastIndexOf(':') + 1),
          `${label} array ${meta.digest} holds the bytes its digest names`,
        );
      }
      arrays.add(meta.digest);
    } else {
      const pieces = meta.kind === 'parts' ? parts : values;
      assert.equal(meta.id, `${meta.kind}/eager/${[...manifest.chunks].filter(chunk => chunk.kind === meta.kind).indexOf(meta)}`);
      for (const [name, skeleton] of Object.entries(JSON.parse(decoded.toString('utf8')))) {
        assert.ok(!pieces.has(name), `${label} holds ${meta.kind} ${name} once`);
        pieces.set(name, skeleton);
      }
    }
  }
  assert.equal(offset, buffer.length, `${label} must not contain trailing bytes`);
  assert.deepEqual(
    manifest.chunks.filter(chunk => chunk.kind === 'steps').map(chunk => chunk.id),
    tracker.steps,
    `${label} holds exactly the steps chunks its tracker names`,
  );

  assert.equal(steps.length, 1, `${label} holds one step, its root`);
  const [root] = steps;
  assert.deepEqual(Object.keys(root), STEP_KEYS, `${label} root holds exactly the current fields, in order`);
  assert.deepEqual(
    {
      id: root.id, parent: root.parent, children: root.children, branch: root.branch, kind: root.kind, type: root.type,
      params: root.params, by: root.by, touches: root.touches, before: root.before, reads: root.reads,
      status: root.status, squashed: root.squashed, notes: root.notes, bookmark: root.bookmark, group: root.group,
    },
    {
      id: tracker.rootId, parent: null, children: [], branch: tracker.mainBranch, kind: 'root', type: null,
      params: null, by: OPENED_BY, touches: [], before: {}, reads: {},
      status: 'applied', squashed: null, notes: [], bookmark: null, group: null,
    },
    `${label} root`,
  );
  // Two domains with equal values (no filters, no colors) share one.
  assert.deepEqual([...values.keys()].sort(), [...new Set(Object.values(root.after))].sort(), `${label} values (exactly the root's)`);
  const named = namedByValues([...values.values()], parts);
  assert.deepEqual([...parts.keys()].sort(), [...named.parts].sort(), `${label} holds exactly the parts its values name`);
  assert.deepEqual([...arrays].sort(), [...named.arrays].sort(), `${label} holds exactly the arrays its values name`);
  const domains = {};
  for (const [domain, hash] of Object.entries(root.after)) {
    domains[domain] = joinSkeleton(values.get(hash), parts, `${label} ${domain}`);
  }
  return { manifest, tracker, root, values: domains };
}

/**
 * What a starting view holds, without how its chunks were stored: a chunk's
 * gzip bytes (and so its stored length, and whether gzip gained enough to be
 * kept) depend on the zlib the writer's Node was built with, never on the
 * session. Everything else -- the manifest, the tracker, the root step and
 * every domain's value, arrays by the digest of their raw bytes -- is the
 * session and is compared whole.
 */
function sessionContent({ manifest, tracker, root, values }) {
  const { chunks, ...header } = manifest;
  return {
    header,
    chunks: chunks.map(({ storedBytes, codec, ...chunk }) => chunk),
    tracker,
    root,
    values,
  };
}

async function loadPublishedPreset(datasetId) {
  const entry = CATALOG.datasets.find(candidate => candidate.id === datasetId);
  assert.ok(entry?.session, `the catalog must advertise a starting view for ${datasetId}`);
  const label = `anndata/${entry.session.path}`;
  const bytes = await readFile(path.join(ANNDATA_ROOT, decodeURIComponent(entry.session.path)));
  return { bytes, entry, label, ...decodeStartingView(bytes, label) };
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
    const { bytes, entry, label, manifest, values } = await loadPublishedPreset(datasetId);
    assert.equal(entry.session.path, `${datasetId}.cellucid-session`);
    assert.equal(entry.session.bytes, bytes.length, `${label} length must be the catalog's`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest, entry.session.sha256, `${label} must be the bytes the catalog advertises`);
    assert.deepEqual(
      Object.keys(values).sort(),
      [...STARTING_VIEW_DOMAINS].sort(),
      `${label} must hold every state domain but the open cells and the person's layout`,
    );

    const store = await digestStoreCellOrder(datasetId);
    const { defaults } = store.described.cellucid;
    const fingerprint = manifest.datasetFingerprint;
    assertExactKeys(fingerprint, ['datasetId', 'name', 'cellCount', 'varCount', 'cellOrder', 'dataMapping'], `${label} fingerprint`);
    assert.deepEqual(manifest.requires, EXPECTED_REQUIRES, `${label} requires exactly the field it colors by`);
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
    assert.deepEqual(manifest.trackers[0].dataset, { id: datasetId, name: fingerprint.name, cellOrder: fingerprint.cellOrder });

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
    assert.deepEqual(values.mapping, mapping, `${label} shows the data mapping its fingerprint names`);

    assert.deepEqual(values.views, {
      layout: 'grid',
      focus: 0,
      liveHidden: false,
      camerasLinked: true,
      views: [{ embedding: { key: defaults.embedding3d, columns: [0, 1, 2] }, followsDefault: true, centroids: { points: false, labels: false } }],
    }, `${label} shows the live view alone, on the store's default 3-D embedding`);
    assert.deepEqual(values['active-field'], EXPECTED_ACTIVE_FIELD);
    assert.deepEqual(values.filters, EXPECTED_NO_FILTERS);
    assert.deepEqual(values.colors, EXPECTED_NO_COLORS);
    assert.deepEqual(values.visibility, { views: [{ array: 'Uint32Array', length: 0 }] }, `${label} hides no cell by hand`);
    // Each preset frames its own dataset, so the camera is pinned per sample.
    assert.deepEqual(values.camera, { views: [expected.camera] });
    assert.deepEqual(values['camera-path'], EXPECTED_CAMERA_PATH);

    assertExactKeys(values.settings, ['controls', 'figureExport'], `${label} settings`);
    assert.equal(values.settings.controls['background-select']?.value, EXPECTED_BACKGROUND);
    for (const [controlId, record] of Object.entries(values.settings.controls)) {
      assertUiControlRecord(controlId, record, `${label} control ${controlId}`);
    }
    assert.ok(
      values.settings.figureExport !== null && typeof values.settings.figureExport === 'object',
      `${label} holds the Figure export panel's settings`,
    );

    assert.deepEqual(values['field-overlays'], EXPECTED_FIELD_OVERLAYS);
    assert.deepEqual(values['gene-sets'], EXPECTED_GENE_SETS);
    assert.deepEqual(values.analysis, EXPECTED_ANALYSIS);
    const { highlights } = values;
    assert.equal(highlights.pages.length, 1, `${label} keeps one empty highlight page`);
    assert.deepEqual(highlights.pages[0].groups, []);
    assert.equal(highlights.active, highlights.pages[0].id);
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
    (await loadPublishedPreset(datasetId)).values.settings.controls,
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
  const figureExports = await Promise.all(PRESET_DATASET_IDS.map(async datasetId => (
    (await loadPublishedPreset(datasetId)).values.settings.figureExport
  )));
  for (const [index, figureExport] of figureExports.entries()) {
    assert.deepEqual(figureExport, figureExports[0], `${PRESET_DATASET_IDS[index]} and ${referenceId} carry different Figure export settings`);
  }
});

/* ------------------------------------------------------------------ *
 * The viewer's own rules, where the viewer repository is checked out.
 *
 * `scripts/publish_session_preset.mjs` imports the starting-view profile,
 * the trim, the fingerprint check, the data-mapping rules and the cell-order
 * digest from the viewer, so these tests ask the application itself whether it
 * accepts each preset. Only an absent *repository* is a reason to skip.
 * ------------------------------------------------------------------ */

/** The viewer checkout: beside this repository, or where `CELLUCID_WEB_ROOT` says. */
const VIEWER_REPOSITORY_URL = process.env.CELLUCID_WEB_ROOT
  ? pathToFileURL(`${path.resolve(process.env.CELLUCID_WEB_ROOT)}/`)
  : new URL('../../cellucid/', import.meta.url);

async function viewerRepositoryPresent() {
  try {
    return (await stat(VIEWER_REPOSITORY_URL)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether the viewer checkout is absent and the test may go without it (it is
 * then skipped). Where siblings are required (`CELLUCID_REQUIRE_SIBLINGS=1`) its
 * absence is a failure: a contract that skips in the job that is the gate holds
 * nothing.
 */
async function viewerAbsent(t, env = process.env) {
  if (await viewerRepositoryPresent()) return false;
  const what = 'the cellucid repository is not checked out beside this one';
  assert.notEqual(env.CELLUCID_REQUIRE_SIBLINGS, '1', `${what}, and CELLUCID_REQUIRE_SIBLINGS=1 asks for it`);
  t.skip(what);
  return true;
}

function viewerModule(relative) {
  return import(new URL(relative, VIEWER_REPOSITORY_URL).href);
}

/** A value read by the viewer, as this suite's own decoder gives it back. */
function asDecoded(value) {
  if (ArrayBuffer.isView(value)) return { array: value.constructor.name, length: value.length };
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(asDecoded);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, asDecoded(child)]));
}

test('every preset is a starting view the viewer accepts, read as this suite reads it', async (t) => {
  if (await viewerAbsent(t)) return;
  const { readStartingView } = await import(new URL('../scripts/publish_session_preset.mjs', import.meta.url).href);
  const { DOMAIN_IDS } = await viewerModule('assets/js/app/actions/domains.js');
  const { STARTING_VIEW_OMITTED_DOMAINS } = await viewerModule('assets/js/app/session/published-default.js');
  assert.deepEqual(
    [...STARTING_VIEW_DOMAINS],
    DOMAIN_IDS.filter(id => !STARTING_VIEW_OMITTED_DOMAINS.includes(id)),
    "the pinned starting-view domains are the viewer's own",
  );
  for (const datasetId of PRESET_DATASET_IDS) {
    const preset = await loadPublishedPreset(datasetId);
    // The viewer's reader: the profile, every array against its digest, every
    // value against its hash, the one root.
    const view = await readStartingView(preset.bytes);
    assert.deepEqual(view.manifest, preset.manifest, `${preset.label} manifest`);
    assert.deepEqual(asDecoded(view.values), preset.values, `${preset.label} values`);
  }
});

test("every preset's fingerprint is the one the viewer derives from its store", async (t) => {
  if (await viewerAbsent(t)) return;
  const { loadPublishRule, readPublishedIdentity } = await import(
    new URL('../scripts/publish_session_preset.mjs', import.meta.url).href
  );
  const rule = await loadPublishRule();
  for (const datasetId of PRESET_DATASET_IDS) {
    const { label, manifest } = await loadPublishedPreset(datasetId);
    rule.assertDatasetFingerprint(manifest.datasetFingerprint, `${label} fingerprint`);
    assert.deepEqual(
      await readPublishedIdentity(datasetId, rule, manifest.datasetFingerprint),
      manifest.datasetFingerprint,
      `${label} must carry the fingerprint the viewer computes for its store: the counts, `
        + 'the default data mapping and the cell-order digest',
    );
  }
});

/** The camera a dataset opens with before its starting view is applied. */
const OPENING_CAMERA = Object.freeze({
  navigationMode: 'orbit',
  orbit: { radius: 3, targetRadius: 3, theta: 0.7853981633974483, phi: 0.7853981633974483, target: [0, 0, 0] },
  freefly: { position: [1.5, 2.121320343559643, 1.4999999999999998], yaw: -2.356194490192345, pitch: -0.7853981633974484 },
});

/**
 * A Save of the dataset the preset is the starting view of, as the viewer
 * writes one (`app/session/share-scope.js`, the whole history): the tracker
 * it was captured in, opened on every cell with the person's own layout,
 * then framed (`camera.set`) — and, given `made`, another step that made
 * content (a highlight).
 */
async function saveOf(preset, { made = false } = {}) {
  const { writeHistoryFile } = await viewerModule('assets/js/app/session/history-file.js');
  const { createBy, createStep, createTracker } = await viewerModule('assets/js/app/history/model.js');
  const { actionStamps } = await viewerModule('assets/js/app/session/app-stamp.js');
  const { getActionCatalog } = await viewerModule('assets/js/app/actions/index.js');
  const { readStartingView } = await import(new URL('../scripts/publish_session_preset.mjs', import.meta.url).href);
  const { hashValue } = await viewerModule('assets/js/app/history/value-pool.js');
  const { values: presetValues, root } = await readStartingView(preset.bytes);
  const pool = new Map();
  const put = async value => {
    const hash = await hashValue(value);
    pool.set(hash, value);
    return hash;
  };
  for (const [domain, hash] of Object.entries(root.after)) pool.set(hash, presetValues[domain]);
  const opened = {
    ...root.after,
    cells: await put({ open: null, genes: null }),
    layout: await put({ theme: 'light', sections: { 'session-section': true }, panels: [], sidebar: { open: true, width: null } }),
    camera: await put({ views: [structuredClone(OPENING_CAMERA)] }),
  };
  const { manifest } = preset;
  const at = Date.parse(manifest.createdAt);
  const person = createBy({ origin: 'user' });
  const catalog = getActionCatalog();
  const tracker = createTracker({
    id: manifest.trackers[0].id, name: 'Tracker 1', dataset: manifest.trackers[0].dataset, createdAt: at,
    by: createBy({ origin: 'startup' }), rootValues: opened,
  });
  const add = step => {
    tracker.steps.find(candidate => candidate.id === step.parent).children.push(step.id);
    tracker.steps.push(step);
    tracker.headId = step.id;
    tracker.branches[0].tip = step.id;
    tracker.nextStep += 1;
  };
  add(createStep({
    id: 's1', parent: 's0', branch: tracker.mainBranch, type: 'camera.set', v: catalog.get('camera.set').version,
    params: { view: 'View 1', camera: presetValues.camera.views[0] }, label: 'Moved the camera of View 1', by: person, at,
    touches: ['camera'], before: { camera: opened.camera }, after: { camera: root.after.camera },
    reads: { views: opened.views }, coalesceKey: 'View 1',
  }));
  if (made) {
    const highlights = structuredClone(presetValues.highlights);
    highlights.pages[0].groups.push({ id: 'highlight_1', type: 'lasso', label: 'Lasso', enabled: true, cells: Uint32Array.of(0, 1, 2) });
    add(createStep({
      id: 's2', parent: 's1', branch: tracker.mainBranch, type: 'highlight.cells', v: catalog.get('highlight.cells').version,
      params: { cells: [0, 1, 2], label: 'Lasso', tool: 'lasso' }, label: 'Highlighted 3 cells as "Lasso"', by: person, at,
      touches: ['highlights'], before: { highlights: root.after.highlights }, after: { highlights: await put(highlights) },
      reads: { cells: opened.cells },
    }));
  }
  const blob = await writeHistoryFile({
    header: {
      createdAt: manifest.createdAt,
      datasetFingerprint: manifest.datasetFingerprint,
      source: { kind: 'sample', dataset: manifest.datasetFingerprint.datasetId },
      requires: manifest.requires,
    },
    app: manifest.app,
    actions: await actionStamps(tracker.steps, catalog),
    scope: {
      trackers: [tracker.id], branches: [{ tracker: tracker.id, branches: [tracker.mainBranch] }], content: 'history',
      results: 'include', notes: true, chats: false, journal: true, times: 'exact', source: 'full',
    },
    history: { activeTracker: tracker.id, trackers: [tracker] },
    valueOf: hash => pool.get(hash),
    chrome: manifest.chrome,
  });
  return new Uint8Array(await blob.arrayBuffer());
}

test('the publish helper reproduces every published preset from its save', async (t) => {
  if (await viewerAbsent(t)) return;
  const { trimSaveStateToPreset } = await import(
    new URL('../scripts/publish_session_preset.mjs', import.meta.url).href
  );
  for (const datasetId of PRESET_DATASET_IDS) {
    const preset = await loadPublishedPreset(datasetId);
    const save = await saveOf(preset);
    assert.notDeepEqual(Buffer.from(save), preset.bytes, 'the save is a history, not the starting view');
    const published = await trimSaveStateToPreset(save, datasetId);
    assert.deepEqual(
      sessionContent(decodeStartingView(Buffer.from(published.bytes), preset.label)),
      sessionContent(preset),
      `${preset.label} must hold exactly what the publish helper produces from its capture`,
    );
  }
});

test('the publish helper refuses a capture that would lose recorded work', async (t) => {
  if (await viewerAbsent(t)) return;
  const { trimSaveStateToPreset } = await import(
    new URL('../scripts/publish_session_preset.mjs', import.meta.url).href
  );
  const datasetId = PRESET_DATASET_IDS.at(-1);
  const preset = await loadPublishedPreset(datasetId);
  await assert.rejects(
    async () => trimSaveStateToPreset(await saveOf(preset, { made: true }), datasetId),
    /Publishing would carry content made in the capture \(highlight pages and their groups of cells\)/,
  );
});
