#!/usr/bin/env node
/**
 * Turn a Save State into a published `exports/<id>/default.cellucid-session`.
 *
 * These two are different documents, and the difference is invisible in the
 * result. Save State writes every chunk the viewer's session contributors emit
 * — seven for a session with nothing kept. The published-default reader accepts
 * exactly five, in one order, so publishing means dropping `cinematic/camera`
 * and `analysis/cache-inventory`.
 *
 * That drop is lossless only while both are empty. A recorded camera path
 * dropped from a capture is gone — the export format stores it nowhere else —
 * and the file that ships still loads, so nothing downstream ever notices. The
 * trim was performed by hand, correctly, once (CEL-0248); this is the same act
 * with the precondition enforced instead of remembered.
 *
 * Identity is the second difference, and it is invisible in the same way. A
 * preset is captured by serving the prepared generation locally, so the capture
 * names a `local-user` source and a dataset id the local source invented, while
 * the catalog serves those same bytes as `local-demo` under the generation's own
 * id. The viewer compares both fields before it applies a published default, so
 * a preset that shipped with the capture's identity was refused every time and
 * the sample opened with none of its view applied. This script restates the
 * identity — after reading the generation's counts out of `dataset_identity.json`
 * and recomputing its cell-order digest from the coordinates it ships, so the
 * rename is only ever applied to a capture that really was taken against them.
 *
 * The rule is not restated here. Both the accepted set and the refusal come
 * from `assets/js/app/session/published-default.js` in the viewer repository,
 * which is the module `restorePublishedDefaultState()` itself validates
 * against, so this script cannot drift from what the application will accept.
 *
 *   node scripts/publish_session_preset.mjs --dataset pancreas \
 *       --from ~/Downloads/cellucid-session-2026-08-02.cellucid-session
 *
 * `--dry-run` reports what would be written without touching the tree. The
 * catalog digest and the suite pins are *not* updated here; the script prints
 * the digest it produced and names the files that carry it, because repinning a
 * preset nobody has looked at is exactly the step that should stay deliberate.
 */

import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const EXPORTS_ROOT = path.join(REPOSITORY_ROOT, 'exports');
const PRESET_FILENAME = 'default.cellucid-session';
const VIEWER_REPOSITORY_URL = new URL('../../cellucid/', import.meta.url);
const PUBLISHED_DEFAULT_MODULE_URL = new URL(
  'assets/js/app/session/published-default.js',
  VIEWER_REPOSITORY_URL,
);
const BUNDLE_READER_MODULE_URL = new URL(
  'assets/js/app/session/bundle/reader.js',
  VIEWER_REPOSITORY_URL,
);
const SESSION_CONTEXT_MODULE_URL = new URL(
  'assets/js/app/session/session-context.js',
  VIEWER_REPOSITORY_URL,
);
const GL_UTILS_MODULE_URL = new URL(
  'assets/js/rendering/gl-utils.js',
  VIEWER_REPOSITORY_URL,
);

/**
 * The viewer's own publish rule.
 *
 * Loaded rather than reimplemented, and loaded lazily so the failure when the
 * viewer is not checked out beside this repository is one sentence a maintainer
 * can act on rather than a module-resolution stack.
 */
export async function loadPublishRule() {
  try {
    const [publishedDefault, reader, sessionContext, glUtils] =
      await Promise.all([
        import(PUBLISHED_DEFAULT_MODULE_URL.href),
        import(BUNDLE_READER_MODULE_URL.href),
        import(SESSION_CONTEXT_MODULE_URL.href),
        import(GL_UTILS_MODULE_URL.href),
      ]);
    return {
      ...publishedDefault,
      digestCellOrder: sessionContext.digestCellOrder,
      normalizePositions: glUtils.normalizePositions,
      readBundle: reader.readBundle,
    };
  } catch (cause) {
    throw new Error(
      'Publishing a preset needs the viewer repository checked out beside this '
        + `one, at ${fileURLToPath(VIEWER_REPOSITORY_URL)}. It owns the rule for `
        + 'which chunks a published default may carry, and that rule is not '
        + 'copied here on purpose: a copy is what goes stale.',
      { cause },
    );
  }
}

/**
 * The identity the catalog serves this generation under.
 *
 * A preset is captured by serving the prepared directory locally, so the
 * capture names a `local-user` source and an id the local source invented. The
 * viewer refuses a preset whose fingerprint does not match the dataset it is
 * loaded beside, so publishing has to restate the identity — and may only do so
 * when the capture really was taken against these bytes. Everything below is
 * read out of the generation itself for exactly that reason: the counts from
 * its identity file, and the cell-order digest recomputed from the coordinate
 * payload it ships, through the viewer's own two functions.
 *
 * @param {string} datasetId
 * @param {{ digestCellOrder: Function, normalizePositions: Function,
 *   PUBLISHED_DEFAULT_SOURCE_TYPE: string }} rule
 * @param {number} dimension - The embedding the capture was taken in.
 * @returns {Promise<object>} A dataset fingerprint.
 */
export async function readPublishedIdentity(datasetId, rule, dimension) {
  const generation = path.join(EXPORTS_ROOT, datasetId);
  const identity = JSON.parse(
    await readFile(path.join(generation, 'dataset_identity.json'), 'utf8'),
  );

  // The preset is written into the directory named by `datasetId` and the
  // catalog entry is keyed by it, while the fingerprint has to carry the id the
  // generation calls itself. Publishing while those disagree would advertise
  // one name and ship another.
  if (identity.id !== datasetId) {
    throw new Error(
      `exports/${datasetId}/ holds a generation that calls itself `
        + `"${identity.id}". A preset is published under the id its generation `
        + 'records, and fetched from the directory the catalog names, so those '
        + 'two have to be the same name.',
    );
  }

  // The digest folds over 3-component triples, so reproducing it for another
  // embedding would mean padding the payload and guessing at what the viewer
  // holds. A capture in another dimension is refused here rather than published
  // with a digest nothing verified.
  if (dimension !== 3) {
    throw new Error(
      `This capture was taken in the ${dimension}-D view. A published default `
        + 'is opened in 3-D, and the cell-order digest can only be reproduced '
        + 'from the 3-D payload, so publishing it would ship an identity this '
        + 'step could not check. Re-capture the view in 3-D.',
    );
  }

  const relative = identity.embeddings?.files?.[`${dimension}d`];
  if (typeof relative !== 'string') {
    throw new Error(
      `${datasetId} publishes no ${dimension}-D point payload, so there is `
        + 'nothing to reproduce the capture\'s cell-order digest from.',
    );
  }
  const decompressed = gunzipSync(await readFile(path.join(generation, relative)));
  const expectedBytes = identity.stats.n_cells * 3 * 4;
  if (decompressed.length !== expectedBytes) {
    throw new Error(
      `${datasetId}/${relative} holds ${decompressed.length} bytes, and the `
        + `generation publishes ${identity.stats.n_cells} cells, which is `
        + `${expectedBytes} bytes of Float32 triples. The generation is not `
        + 'internally consistent, so no identity read out of it can be trusted.',
    );
  }
  // A pooled Buffer carries an arbitrary byteOffset; the digest reads these as
  // 32-bit words, which needs a 4-byte aligned buffer of its own.
  const aligned = new ArrayBuffer(decompressed.byteLength);
  new Uint8Array(aligned).set(decompressed);
  const positions = new Float32Array(aligned);
  // The digest is taken over what the viewer holds, which is the payload after
  // the in-place normalization it runs on load.
  rule.normalizePositions(positions);

  return {
    sourceType: rule.PUBLISHED_DEFAULT_SOURCE_TYPE,
    datasetId: identity.id,
    cellCount: identity.stats.n_cells,
    varCount: identity.stats.n_genes,
    cellOrder: { dimension, digest: rule.digestCellOrder(positions) },
  };
}

/**
 * The published default this capture becomes, or a refusal naming what would
 * have been lost.
 *
 * @param {Uint8Array} saveStateBytes - A `.cellucid-session` written by Save State.
 * @param {string} datasetId - The generation this is published beside.
 * @returns {Promise<{ bytes: Uint8Array, sha256: string, chunkIds: string[],
 *   identity: object }>}
 */
export async function trimSaveStateToPreset(saveStateBytes, datasetId) {
  const rule = await loadPublishRule();
  const {
    assertPublishedDefaultChunkProfile,
    readBundle,
    trimToPublishedDefault,
  } = rule;

  // The capture's own dimension decides which payload the identity is read
  // from, so a 2-D capture is refused by name rather than compared against a
  // 3-D digest it was never going to match.
  const { manifest: captured } = await readBundle(new Blob([saveStateBytes]), {
    signal: null,
    onProgress: null,
  });
  const identity = await readPublishedIdentity(
    datasetId,
    rule,
    captured.datasetFingerprint?.cellOrder?.dimension,
  );

  const trimmed = await trimToPublishedDefault(
    new Blob([saveStateBytes]),
    identity,
  );
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
 * The catalog's `state_sha256` is an integrity check the application runs
 * before it applies a published default, so a preset replaced without it is
 * refused at load with "does not match the advertised generation" — and the
 * catalog is served straight off the default branch, which means the mismatch
 * is live the moment it is pushed, and the contract suite can only report it
 * afterwards. Writing the digest here is what removes the window: the artifact
 * and its advertisement move in one step, or neither moves.
 *
 * The reviewed pins in `tests/` are deliberately *not* written. Those record
 * that somebody looked at the view; a script that updated its own expectations
 * would assert only that it ran.
 *
 * @param {string} datasetId
 * @param {string} sha256
 * @returns {Promise<string>} The digest the catalog previously advertised.
 */
async function repinCatalogState(datasetId, sha256) {
  const catalogPath = path.join(EXPORTS_ROOT, 'datasets.json');
  const text = await readFile(catalogPath, 'utf8');
  const catalog = JSON.parse(text);
  const entry = catalog.datasets?.find(candidate => candidate.id === datasetId);
  if (entry === undefined) {
    throw new Error(
      `exports/datasets.json advertises no dataset "${datasetId}", so the `
        + 'preset just written would never be fetched.',
    );
  }
  const previous = entry.state_sha256;
  if (typeof previous !== 'string') {
    throw new Error(
      `exports/datasets.json entry for "${datasetId}" carries no state_sha256, `
        + 'so it does not advertise a published default at all.',
    );
  }
  // Re-publishing an unchanged capture reproduces the same bytes, and the
  // rewrite below would find nothing to replace and read that as a failure.
  if (previous === sha256) return previous;
  // Rewritten as one exact field rather than by re-serializing the catalog, so
  // publishing a preset cannot reformat, reorder or drop anything else in a
  // file the application parses.
  const pattern = new RegExp(`("state_sha256"\\s*:\\s*")${previous}(")`);
  const updated = text.replace(pattern, `$1${sha256}$2`);
  if (updated === text) {
    throw new Error(
      `Could not rewrite the state_sha256 of "${datasetId}" in `
        + 'exports/datasets.json. Update it by hand to '
        + `${sha256} before committing.`,
    );
  }
  await writeFile(catalogPath, updated);
  return previous;
}

/**
 * @param {{ datasetId: string, savePath: string, dryRun: boolean }} options
 */
export async function publishSessionPreset(options) {
  const generation = path.join(EXPORTS_ROOT, options.datasetId);
  const present = await stat(generation).then(
    entry => entry.isDirectory(),
    () => false,
  );
  if (!present) {
    throw new Error(
      `No prepared generation at ${path.relative(REPOSITORY_ROOT, generation)}. `
        + 'A preset is published beside the generation it was captured against, '
        + 'so the dataset id has to be one this repository already ships.',
    );
  }
  const saveStateBytes = await readFile(options.savePath);
  const result = await trimSaveStateToPreset(saveStateBytes, options.datasetId);
  const target = path.join(generation, PRESET_FILENAME);
  let advertised = null;
  if (!options.dryRun) {
    await writeFile(target, result.bytes);
    // After the preset, so a failure to write it leaves the catalog pointing at
    // the file that is still there rather than at one that was never written.
    advertised = await repinCatalogState(options.datasetId, result.sha256);
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
      + `  published as ${published.identity.sourceType}:`
      + `${published.identity.datasetId}, `
      + `${published.identity.cellCount} cells, `
      + `${published.identity.varCount} genes, `
      + `${cellOrder.dimension}-D cell order ${cellOrder.digest}\n`
      + `  sha256 ${published.sha256}\n`
      + (options.dryRun
        ? '  exports/datasets.json would be repointed at that digest\n'
        : `  exports/datasets.json repointed at it (was ${
          published.advertised})\n`)
      + '  now repin that digest in tests/catalog-contract.test.mjs and '
      + 'tests/session-presets-contract.test.mjs, and re-record the reviewed '
      + 'camera there, before committing.\n',
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
