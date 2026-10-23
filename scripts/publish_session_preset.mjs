#!/usr/bin/env node
/**
 * Turn a Save State into a published `anndata/<id>.cellucid-session`.
 *
 * These two are different documents, and the difference is invisible in the
 * result. Save State writes every chunk the viewer's session contributors
 * emit. The published-default reader (session format 2) accepts exactly seven,
 * in one order — core/field-overlays, core/state, ui/dockable-layout,
 * ui/figure-export, analysis/windows, analysis/docked, highlights/meta — so
 * publishing means dropping `cinematic/camera` (which must be empty).
 *
 * That drop is lossless only while it is empty. A recorded camera path
 * dropped from a capture is gone — the store holds it nowhere else — and the
 * file that ships still loads, so nothing downstream ever notices. This is the
 * drop with the precondition enforced instead of remembered.
 *
 * Identity is the second difference, and it is invisible in the same way. A
 * capture may be taken under another dataset id than the store's own (a local
 * copy, a served folder), and the viewer compares the id before it applies a
 * published default, so a preset shipped with the capture's id would be
 * refused every time and the sample would open with none of its view applied.
 * This script restates the id — after reading the store's counts and launch
 * defaults out of `anndata/<id>.zarr`, deriving the data mapping the viewer
 * opens the store with by the viewer's own rules, and recomputing the
 * cell-order digest from the coordinates the store holds, so the rename is
 * only ever applied to a capture that really was taken against them.
 *
 * The rules are not restated here. The accepted chunk set, the refusal, the
 * fingerprint check, the data-mapping rules and the digest all come from the
 * viewer repository checked out beside this one, so this script cannot drift
 * from what the application will accept.
 *
 *   node scripts/publish_session_preset.mjs --dataset pancreas \
 *       --from ~/Downloads/cellucid-session-2026-10-22.cellucid-session
 *
 * `--dry-run` reports what would be written without touching the tree. The
 * reviewed camera pinned in `tests/session-presets-contract.test.mjs` is *not*
 * updated here; the script prints what it published, because repinning a view
 * nobody has looked at is exactly the step that should stay deliberate.
 */

import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeStore, readObsm } from './anndata_store.mjs';

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const ANNDATA_ROOT = path.join(REPOSITORY_ROOT, 'anndata');
const CATALOG_PATH = path.join(ANNDATA_ROOT, 'datasets.json');
const VIEWER_REPOSITORY_URL = new URL('../../cellucid/', import.meta.url);
const VIEWER_MODULES = Object.freeze({
  publishedDefault: 'assets/js/app/session/published-default.js',
  reader: 'assets/js/app/session/bundle/reader.js',
  sessionContext: 'assets/js/app/session/session-context.js',
  glUtils: 'assets/js/rendering/gl-utils.js',
  dataMapping: 'assets/js/data/data-mapping.js',
});

/** The preset of one dataset, beside its store. */
export function presetPath(datasetId) {
  return path.join(ANNDATA_ROOT, `${datasetId}.cellucid-session`);
}

/**
 * The viewer's own publish rule.
 *
 * Loaded rather than reimplemented, and loaded lazily so the failure when the
 * viewer is not checked out beside this repository is one sentence a maintainer
 * can act on rather than a module-resolution stack.
 */
export async function loadPublishRule() {
  try {
    const modules = {};
    for (const [name, relative] of Object.entries(VIEWER_MODULES)) {
      modules[name] = await import(new URL(relative, VIEWER_REPOSITORY_URL).href);
    }
    return {
      ...modules.publishedDefault,
      assertDatasetFingerprint: modules.sessionContext.assertDatasetFingerprint,
      digestCellOrder: modules.sessionContext.digestCellOrder,
      normalizePositions: modules.glUtils.normalizePositions,
      readBundle: modules.reader.readBundle,
      dataMapping: modules.dataMapping,
    };
  } catch (cause) {
    throw new Error(
      'Publishing a preset needs the viewer repository checked out beside '
        + `this one, at ${fileURLToPath(VIEWER_REPOSITORY_URL)}. It owns the `
        + 'rules for which chunks a published default may carry and which data '
        + 'mapping a dataset opens with, and those rules are not copied here on '
        + 'purpose: a copy is what goes stale.',
      { cause },
    );
  }
}

/**
 * The data mapping the viewer opens one store with: its launch defaults
 * (`uns['cellucid']['defaults']`) where it states them, the viewer's default
 * rules (`data-mapping.js`) everywhere else.
 *
 * @param {Awaited<ReturnType<typeof describeStore>>} described
 * @param {object} dataMapping - The viewer's `data-mapping.js`.
 */
export function defaultAnnDataMapping(described, dataMapping) {
  const defaults = described.cellucid.defaults ?? {};
  const latentKey = defaults.latentKey ?? null;
  const entries = Object.entries(described.obsm).map(([key, { shape }]) => ({
    key,
    width: shape[1],
    usable: true,
    reason: null,
  }));
  const { slots } = dataMapping.resolveEmbeddingSlots(entries, { latentKey });
  for (const slot of dataMapping.DIMENSION_SLOTS) {
    const stated = defaults[`embedding${slot}`];
    if (stated === undefined) continue;
    slots[slot] = typeof stated === 'string'
      ? { key: stated, columns: dataMapping.defaultColumns(dataMapping.slotDimension(slot)) }
      : { key: stated.key, columns: [...stated.columns] };
  }
  const enabled = dataMapping.defaultEnabledEmbeddings(entries, slots, { latentKey });
  const hasGraph = described.metadata['obsp/connectivities/.zattrs'] !== undefined;
  return dataMapping.validateDataMapping({
    kind: dataMapping.ANNDATA_KIND,
    embeddings: { enabled, defaults: slots },
    knn: defaults.knn ?? (hasGraph ? 'connectivities' : null),
    geneNames: defaults.geneIdColumn === undefined ? 'index' : `column:${defaults.geneIdColumn}`,
    expression: defaults.expression ?? 'X',
    latent: latentKey,
    vectorFields: dataMapping.defaultVectorBindings(entries, enabled),
  });
}

/**
 * The capture's data mapping, if a published default may carry it: the
 * store's default mapping, with any further representations enabled beside
 * the default ones.
 *
 * Every group but the enabled set must be the default — the embedding each
 * dimension opens on, the neighbour graph, the gene names, the expression,
 * the latent space and the vector bindings — so the sample opens on the store
 * as published. Enabling more is what a published view may add: the Pancreas
 * view enables the first two components of its PCA, which is its latent space
 * and so is not shown on its own. Each added representation must be an `obsm`
 * array of the store, read at 1 to 3 of its columns; the viewer restores the
 * enabled set when it applies the view.
 *
 * @returns {object} The canonical mapping the published default carries.
 */
function requirePublishableMapping(mapping, defaultMapping, described, dataMappingRules) {
  const refuse = (why) => new Error(
    `This capture cannot be published: ${why}. A published default is opened on the `
      + `store as published, in its default data mapping (${JSON.stringify(defaultMapping)}), `
      + 'with at most further representations enabled. Capture it again on the store as published.',
  );
  let canonical;
  try {
    canonical = dataMappingRules.validateDataMapping(mapping, { label: 'Captured data mapping' });
  } catch (error) {
    throw refuse(error.message);
  }
  const { enabled, ...rest } = canonical.embeddings;
  const { enabled: defaultEnabled, ...defaultRest } = defaultMapping.embeddings;
  const sameExceptEnabled = JSON.stringify({ ...canonical, embeddings: rest })
    === JSON.stringify({ ...defaultMapping, embeddings: defaultRest });
  if (!sameExceptEnabled) throw refuse('it was taken in another data mapping than the default one');
  const key = ref => JSON.stringify(ref);
  const enabledKeys = new Set(enabled.map(key));
  const missing = defaultEnabled.filter(ref => !enabledKeys.has(key(ref)));
  if (missing.length > 0) throw refuse(`it does not enable ${JSON.stringify(missing)}`);
  const defaultKeys = new Set(defaultEnabled.map(key));
  for (const ref of enabled.filter(candidate => !defaultKeys.has(key(candidate)))) {
    const width = described.obsm[ref.key]?.shape?.[1];
    if (width === undefined || ref.columns.length < 1 || ref.columns.length > 3
      || ref.columns.some(column => column >= width)) {
      throw refuse(`it enables ${JSON.stringify(ref)}, which the store cannot show`);
    }
  }
  return canonical;
}

/**
 * The identity the catalog serves this store under.
 *
 * A capture may name another dataset id than the store's own. The viewer
 * refuses a preset whose fingerprint does not match the dataset it is loaded
 * beside, so publishing has to restate the identity — and may only do so when
 * the capture really was taken against these bytes. Everything below is read
 * out of the store itself for exactly that reason: the name from
 * `uns['cellucid']`, the counts from `X`, the data mapping from its `obsm` and launch defaults, and the cell-order digest
 * recomputed from the coordinates of the embedding the capture names, through
 * the viewer's own functions.
 *
 * A published default is captured in the store's default data mapping —
 * every dimension shows its default embedding, genes carry their default
 * names, every default vector binding is in use — and may enable further
 * representations (`requirePublishableMapping`). The viewer verifies a
 * preset's mapping against the store before applying anything, so a capture
 * taken in any other mapping is refused here instead of being published as a
 * view nobody sees.
 *
 * @param {string} datasetId
 * @param {object} rule - From {@link loadPublishRule}.
 * @param {object} captured - The capture's own dataset fingerprint.
 * @returns {Promise<object>} A dataset fingerprint.
 */
export async function readPublishedIdentity(datasetId, rule, captured) {
  const storeDir = path.join(ANNDATA_ROOT, `${datasetId}.zarr`);
  const described = await describeStore(storeDir);
  if (described.cellucid?.id !== datasetId) {
    throw new Error(
      `anndata/${datasetId}.zarr states the id ${JSON.stringify(described.cellucid?.id)} `
        + "in uns['cellucid']. A preset is published under the id its store states, "
        + 'and the catalog lists the store under the same id, so those have to agree.',
    );
  }
  const [cellCount, varCount] = described.x.shape;
  const defaultMapping = defaultAnnDataMapping(described, rule.dataMapping);
  const dataMapping = requirePublishableMapping(captured?.dataMapping, defaultMapping, described, rule.dataMapping);

  const dimension = captured?.cellOrder?.dimension;
  const embedding = captured?.cellOrder?.embedding;
  if (JSON.stringify(embedding) !== JSON.stringify(dataMapping.embeddings.defaults[`${dimension}d`])) {
    throw new Error(
      `This capture records its cell order on ${JSON.stringify(embedding)} `
        + `in ${dimension}-D, which is not the default ${dimension}-D embedding `
        + `of ${datasetId}, so there is no layout to reproduce its cell-order digest from.`,
    );
  }
  const obsm = await readObsm(storeDir, described.metadata, embedding.key);
  const positions = new Float32Array(cellCount * dimension);
  for (let cell = 0; cell < cellCount; cell++) {
    for (let axis = 0; axis < dimension; axis++) {
      positions[cell * dimension + axis] = obsm.values[cell * obsm.width + embedding.columns[axis]];
    }
  }
  // The digest is taken over what the viewer holds, which is the layout after
  // the in-place normalization it runs on load.
  rule.normalizePositions(positions, dimension);

  const identity = {
    datasetId,
    name: described.cellucid.name,
    cellCount,
    varCount,
    cellOrder: {
      embedding: { key: embedding.key, columns: [...embedding.columns] },
      dimension,
      digest: rule.digestCellOrder(positions, dimension),
    },
    dataMapping,
  };
  rule.assertDatasetFingerprint(identity, 'Published dataset fingerprint');
  return identity;
}

/**
 * The published default this capture becomes, or a refusal naming what would
 * have been lost.
 *
 * @param {Uint8Array} saveStateBytes - A `.cellucid-session` written by Save State.
 * @param {string} datasetId - The store this is published beside.
 * @returns {Promise<{ bytes: Uint8Array, sha256: string, chunkIds: string[],
 *   identity: object }>}
 */
export async function trimSaveStateToPreset(saveStateBytes, datasetId) {
  const rule = await loadPublishRule();
  const { assertPublishedDefaultChunkProfile, readBundle, trimToPublishedDefault } = rule;

  // The capture's own cell-order embedding decides which coordinates the
  // identity is read from, and its data mapping must be the store's default
  // with, at most, further representations enabled.
  const { manifest: captured } = await readBundle(new Blob([saveStateBytes]), {
    signal: null,
    onProgress: null,
  });
  const identity = await readPublishedIdentity(datasetId, rule, captured.datasetFingerprint);

  const trimmed = await trimToPublishedDefault(new Blob([saveStateBytes]), identity);
  const bytes = new Uint8Array(await trimmed.arrayBuffer());

  // Read the result back through the viewer's reader and put it to the same
  // check the application runs. A publish step that emitted a file the app
  // refuses would be worse than no publish step at all.
  const { manifest } = await readBundle(new Blob([bytes]), {
    signal: null,
    onProgress: null,
  });
  assertPublishedDefaultChunkProfile(manifest.chunks);

  return {
    bytes,
    identity,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    chunkIds: manifest.chunks.map(chunk => chunk.id),
  };
}

/**
 * Point the catalog at the preset that was just written.
 *
 * The catalog's `session.bytes` and `session.sha256` are integrity checks the
 * application runs before it applies a published default, so a preset replaced
 * without them is refused at load — and the catalog is served straight off the
 * default branch, which means the mismatch is live the moment it is pushed.
 * Writing both here is what removes the window: the artifact and its
 * advertisement move in one step, or neither moves.
 *
 * @param {string} datasetId
 * @param {string} sha256
 * @param {number} byteLength
 * @returns {Promise<object|null>} The session the catalog previously advertised.
 */
async function repinCatalogSession(datasetId, sha256, byteLength) {
  const catalog = JSON.parse(await readFile(CATALOG_PATH, 'utf8'));
  const entry = catalog.datasets?.find(candidate => candidate.id === datasetId);
  if (entry === undefined) {
    throw new Error(
      `anndata/datasets.json lists no dataset "${datasetId}", so the preset `
        + 'just written would never be fetched.',
    );
  }
  const previous = entry.session ?? null;
  entry.session = {
    path: `${encodeURIComponent(datasetId)}.cellucid-session`,
    bytes: byteLength,
    sha256,
  };
  await writeFile(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  return previous;
}

/**
 * @param {{ datasetId: string, savePath: string, dryRun: boolean }} options
 */
export async function publishSessionPreset(options) {
  const store = path.join(ANNDATA_ROOT, `${options.datasetId}.zarr`);
  const present = await stat(store).then(entry => entry.isDirectory(), () => false);
  if (!present) {
    throw new Error(
      `No store at ${path.relative(REPOSITORY_ROOT, store)}. A preset is published `
        + 'beside the store it was captured against, so the dataset id has to be '
        + 'one this repository already ships.',
    );
  }
  const saveStateBytes = await readFile(options.savePath);
  const result = await trimSaveStateToPreset(saveStateBytes, options.datasetId);
  const target = presetPath(options.datasetId);
  let advertised = null;
  if (!options.dryRun) {
    await writeFile(target, result.bytes);
    // After the preset, so a failure to write it leaves the catalog pointing at
    // the file that is still there rather than at one that was never written.
    advertised = await repinCatalogSession(
      options.datasetId,
      result.sha256,
      result.bytes.byteLength,
    );
  }
  return { ...result, advertised, target };
}

function parseArguments(argv) {
  const options = { datasetId: null, savePath: null, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--dataset') {
      options.datasetId = argv[index += 1] ?? null;
    } else if (argument === '--from') {
      options.savePath = argv[index += 1] ?? null;
    } else {
      throw new Error(`Unrecognised argument ${JSON.stringify(argument)}.`);
    }
  }
  if (options.datasetId === null || options.savePath === null) {
    throw new Error(
      'Usage: node scripts/publish_session_preset.mjs --dataset <id> '
        + '--from <save-state file> [--dry-run]',
    );
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const published = await publishSessionPreset({
    datasetId: options.datasetId,
    savePath: path.resolve(options.savePath),
    dryRun: options.dryRun,
  });
  const relative = path.relative(REPOSITORY_ROOT, published.target);
  const { cellOrder } = published.identity;
  process.stdout.write(
    `${options.dryRun ? 'would write' : 'wrote'} ${relative}\n`
      + `  ${published.bytes.byteLength} bytes, chunks: `
      + `${published.chunkIds.join(', ')}\n`
      + `  published as ${published.identity.datasetId}, `
      + `${published.identity.cellCount} cells, `
      + `${published.identity.varCount} genes, `
      + `${cellOrder.dimension}-D cell order on ${cellOrder.embedding.key} `
      + `${cellOrder.digest}\n`
      + `  sha256 ${published.sha256}\n`
      + (options.dryRun
        ? '  anndata/datasets.json would be repointed at that digest\n'
        : `  anndata/datasets.json repointed at it (was ${
          published.advertised === null ? 'no session' : published.advertised.sha256})\n`)
      + '  now re-record the reviewed camera in '
      + 'tests/session-presets-contract.test.mjs, if it changed, before committing.\n',
  );
}

if (process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A refusal here is the point of the script, so it reaches the operator as a
  // sentence rather than as a module stack. The cause chain is kept, because a
  // container that failed to parse says where.
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    for (let cause = error.cause; cause !== undefined; cause = cause.cause) {
      process.stderr.write(`  caused by: ${cause.message}\n`);
    }
    process.exitCode = 1;
  }
}
