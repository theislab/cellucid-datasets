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

/**
 * The viewer's own publish rule.
 *
 * Loaded rather than reimplemented, and loaded lazily so the failure when the
 * viewer is not checked out beside this repository is one sentence a maintainer
 * can act on rather than a module-resolution stack.
 */
export async function loadPublishRule() {
  try {
    const [publishedDefault, reader] = await Promise.all([
      import(PUBLISHED_DEFAULT_MODULE_URL.href),
      import(BUNDLE_READER_MODULE_URL.href),
    ]);
    return { ...publishedDefault, readBundle: reader.readBundle };
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
 * The published default this capture becomes, or a refusal naming what would
 * have been lost.
 *
 * @param {Uint8Array} saveStateBytes - A `.cellucid-session` written by Save State.
 * @returns {Promise<{ bytes: Uint8Array, sha256: string, chunkIds: string[] }>}
 */
export async function trimSaveStateToPreset(saveStateBytes) {
  const {
    assertPublishedDefaultChunkProfile,
    readBundle,
    trimToPublishedDefault,
  } = await loadPublishRule();

  const trimmed = await trimToPublishedDefault(new Blob([saveStateBytes]));
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
    sha256: createHash('sha256').update(bytes).digest('hex'),
    chunkIds: manifest.chunks.map(chunk => chunk.id),
  };
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
  const result = await trimSaveStateToPreset(saveStateBytes);
  const target = path.join(generation, PRESET_FILENAME);
  if (!options.dryRun) await writeFile(target, result.bytes);
  return { ...result, target };
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
  process.stdout.write(
    `${options.dryRun ? 'would write' : 'wrote'} ${relative}\n`
      + `  ${published.bytes.byteLength} bytes, chunks: `
      + `${published.chunkIds.join(', ')}\n`
      + `  sha256 ${published.sha256}\n`
      + '  repin that digest in exports/datasets.json (state_sha256), '
      + 'tests/catalog-contract.test.mjs and '
      + 'tests/session-presets-contract.test.mjs before committing.\n',
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
