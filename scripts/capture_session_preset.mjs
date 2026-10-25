#!/usr/bin/env node
/**
 * Capture a sample's starting view again, in the current viewer.
 *
 * A published starting view (`anndata/<id>.cellucid-session`) is a capture of
 * the viewer, so it has to be taken again whenever the viewer's session format
 * or the sample's store changes. This script does that without anybody
 * clicking: it serves the viewer checkout beside this repository and this
 * repository on loopback (`local_site.mjs`), opens the sample from the local
 * catalog in headless Chromium — which applies the starting view the catalog
 * names, exactly as the published site does — optionally enables extra
 * representations in the data mapping, and saves the state with the viewer's
 * own **Save** button.
 *
 *   node scripts/capture_session_preset.mjs --dataset pancreas \
 *       --enable X_pca:0,1 --out /tmp/pancreas.cellucid-session
 *   node scripts/publish_session_preset.mjs --dataset pancreas \
 *       --from /tmp/pancreas.cellucid-session
 *
 * `--enable <obsm key>:<columns>` adds one representation to the enabled set
 * (repeatable); the published Pancreas view enables the first two components
 * of its 50-component PCA, which is its latent space and so is not shown on
 * its own. To change the view itself — the camera, the coloured field — open
 * the sample in the app, frame it, choose **Save**, and publish that file.
 *
 * The capture is the input of `publish_session_preset.mjs`, which checks it
 * against the store and writes the published file and its catalog entry.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  launchBrowser,
  notifications,
  openSample,
  recordNotifications,
  startLocalSite,
  waitForNotification,
} from './local_site.mjs';

const RESTORED = /Session fully restored\./;

function parseArguments(argv) {
  const options = { datasetId: null, out: null, enable: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dataset') {
      options.datasetId = argv[index += 1] ?? null;
    } else if (argument === '--out') {
      options.out = argv[index += 1] ?? null;
    } else if (argument === '--enable') {
      const spec = argv[index += 1] ?? '';
      const match = /^([^:]+):(\d+(?:,\d+){0,2})$/.exec(spec);
      if (match === null) throw new Error(`--enable takes <obsm key>:<columns>, e.g. X_pca:0,1; got ${JSON.stringify(spec)}.`);
      options.enable.push({ key: match[1], columns: match[2].split(',').map(Number) });
    } else {
      throw new Error(`Unrecognised argument ${JSON.stringify(argument)}.`);
    }
  }
  if (options.datasetId === null || options.out === null) {
    throw new Error(
      'Usage: node scripts/capture_session_preset.mjs --dataset <id> --out <file> '
        + '[--enable <obsm key>:<columns>]...',
    );
  }
  return options;
}

/**
 * @param {{datasetId: string, out: string, enable: Array<{key: string, columns: number[]}>}} options
 * @returns {Promise<{openedMs: number, mapping: object}>}
 */
export async function captureSessionPreset(options) {
  const site = await startLocalSite();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await recordNotifications(page);
    const openedMs = await openSample(page, site, options.datasetId);
    // The catalog's starting view is applied after the dataset is drawn.
    await waitForNotification(page, RESTORED, 0, 120_000).catch(async () => {
      throw new Error(
        `${options.datasetId}: the catalog's starting view was not applied: `
          + JSON.stringify(await notifications(page)),
      );
    });

    if (options.enable.length > 0) {
      await page.evaluate(async ({ refs }) => {
        const { compareEmbeddingRefs } = await import('/assets/js/data/data-mapping.js');
        const state = window._cellucidState;
        const mapping = structuredClone(state.getDataMapping());
        for (const ref of refs) {
          if (!mapping.embeddings.enabled.some(existing => compareEmbeddingRefs(existing, ref) === 0)) {
            mapping.embeddings.enabled.push(ref);
          }
        }
        mapping.embeddings.enabled.sort(compareEmbeddingRefs);
        await state.applyDataMapping(mapping, { origin: 'user' });
      }, { refs: options.enable });
    }

    const download = page.waitForEvent('download');
    await page.locator('#save-state-btn').click();
    const file = await download;
    await file.saveAs(path.resolve(options.out));
    const mapping = await page.evaluate(() => window._cellucidState.getDataMapping());
    if (errors.length > 0) {
      throw new Error(`${options.datasetId}: the viewer reported errors:\n${errors.join('\n')}`);
    }
    return { openedMs, mapping };
  } finally {
    await browser.close();
    await site.close();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { openedMs, mapping } = await captureSessionPreset(options);
  process.stdout.write(
    `captured ${options.datasetId} into ${options.out} (opened in ${openedMs} ms)\n`
      + `  enabled: ${mapping.embeddings.enabled.map(ref => `${ref.key}[${ref.columns}]`).join(', ')}\n`
      + `  publish it with: node scripts/publish_session_preset.mjs --dataset ${options.datasetId} `
      + `--from ${options.out}\n`,
  );
}

if (process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
