#!/usr/bin/env node
/**
 * Capture a sample's starting view again, in the current viewer.
 *
 * A published starting view (`anndata/<id>.cellucid-session`) is a capture of
 * the viewer, so it has to be taken again whenever the viewer's session format
 * or the sample's store changes. This script does that without anybody
 * clicking: it serves the viewer checkout beside this repository and this
 * repository on loopback (`local_site.mjs`), opens the sample from the local
 * catalog in headless Chromium — which puts back the starting view the catalog
 * names, exactly as the published site does, before the dataset's history
 * starts — optionally changes the view through the viewer's own actions, and
 * saves the history with the State panel's own **Share… › Save file**.
 *
 *   node scripts/capture_session_preset.mjs --dataset pancreas \
 *       --enable X_pca:0,1 --out /tmp/pancreas.cellucid-session
 *   node scripts/publish_session_preset.mjs --dataset pancreas \
 *       --from /tmp/pancreas.cellucid-session
 *
 * `--enable <obsm key>:<columns>` adds one representation to the enabled set
 * of the data mapping (repeatable; the `mapping.set` action); the published
 * Pancreas view enables the first two components of its 50-component PCA,
 * which is its latent space and so is not shown on its own.
 *
 * `--action <json>` dispatches one action of the viewer's catalog
 * (`{"type": …, "params": …}`, `cellucid/assets/js/app/actions/definitions/`)
 * after the representations are enabled, in the order given (repeatable),
 * e.g. to frame the view or color it:
 *
 *   --action '{"type":"color.by","params":{"field":{"source":"obs","key":"cell_type"}}}'
 *   --action '{"type":"camera.set","params":{"view":"View 1","camera":{…}}}'
 *
 * Each action is a step of the history the save holds; publishing keeps the
 * state they lead to (the head) as the view's one state. To change the view
 * by hand instead, open the sample in the app, frame it, choose **Share… ›
 * Save file** in the State panel (without notes), and publish that file.
 *
 * The capture is the input of `publish_session_preset.mjs`, which checks it
 * against the store and writes the published file and its catalog entry.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REPOSITORY_ROOT,
  launchBrowser,
  notifications,
  openSample,
  recordNotifications,
  startLocalSite,
} from './local_site.mjs';

/** A notification that says something did not work. */
const PROBLEM = /fail|error|unavailable|could not|refus/i;

function parseArguments(argv) {
  const options = { datasetId: null, out: null, enable: [], actions: [] };
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
    } else if (argument === '--action') {
      const text = argv[index += 1] ?? '';
      let action;
      try {
        action = JSON.parse(text);
      } catch (cause) {
        throw new Error(`--action takes one action as JSON, {"type": …, "params": …}; got ${JSON.stringify(text)}.`, { cause });
      }
      if (action === null || typeof action !== 'object' || typeof action.type !== 'string'
        || Object.keys(action).some(key => key !== 'type' && key !== 'params')) {
        throw new Error(`--action takes {"type": …, "params": …}; got ${JSON.stringify(text)}.`);
      }
      options.actions.push({ type: action.type, params: action.params ?? {} });
    } else {
      throw new Error(`Unrecognised argument ${JSON.stringify(argument)}.`);
    }
  }
  if (options.datasetId === null || options.out === null) {
    throw new Error(
      'Usage: node scripts/capture_session_preset.mjs --dataset <id> --out <file> '
        + '[--enable <obsm key>:<columns>]... [--action <json>]...',
    );
  }
  return options;
}

/**
 * @param {{datasetId: string, out: string, enable: Array<{key: string, columns: number[]}>,
 *   actions?: Array<{type: string, params: object}>}} options
 * @returns {Promise<{openedMs: number, mapping: object, startingView: boolean}>}
 */
export async function captureSessionPreset(options) {
  const catalog = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, 'anndata', 'datasets.json'), 'utf8'));
  const entry = catalog.datasets.find(candidate => candidate.id === options.datasetId);
  if (entry === undefined) throw new Error(`anndata/datasets.json lists no dataset "${options.datasetId}".`);
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
    // The catalog's starting view is put back before the dataset's history
    // starts, so the history's first tracker is what a capture starts from.
    await page.waitForFunction(() => window._cellucidHistories?.current()?.active != null, null, { timeout: 600_000 })
      .catch(() => {
        throw new Error(`${options.datasetId}: the dataset's history did not start.`);
      });
    const failed = (await notifications(page)).filter(note => PROBLEM.test(note.text));
    if (failed.length > 0 || errors.length > 0) {
      throw new Error(
        `${options.datasetId}: the sample did not open cleanly`
          + `${entry.session === undefined ? '' : ' with the starting view the catalog names'}:\n`
          + [...failed.map(note => note.text), ...errors].join('\n'),
      );
    }
    // A starting view is captured on every cell: an opening that shows a
    // first view of fewer cells grows to them first.
    await page.waitForFunction(() => window._cellucidState?.cellIdentity?.isSubset === false, null, { timeout: 600_000 })
      .catch(() => {
        throw new Error(`${options.datasetId}: the sample did not open every cell; a starting view is captured on every cell.`);
      });

    await page.evaluate(async ({ refs, actions }) => {
      const { getActions } = await import('/assets/js/app/actions/index.js');
      const dispatcher = getActions();
      if (refs.length > 0) {
        const { compareEmbeddingRefs } = await import('/assets/js/data/data-mapping.js');
        const { embeddings } = window._cellucidState.getDataMapping();
        const enabled = structuredClone(embeddings.enabled);
        for (const ref of refs) {
          if (!enabled.some(existing => compareEmbeddingRefs(existing, ref) === 0)) enabled.push(ref);
        }
        enabled.sort(compareEmbeddingRefs);
        await dispatcher.dispatch('mapping.set', { embeddings: { enabled, defaults: structuredClone(embeddings.defaults) } });
      }
      for (const { type, params } of actions) await dispatcher.dispatch(type, params);
    }, { refs: options.enable, actions: options.actions ?? [] });

    // The State panel's Share… › Save file, as a person takes it: the
    // history as the dialog opens (its tracker's main and shown branches),
    // without notes, conversations or Recently deleted.
    await page.locator('#history-share-btn').click();
    await page.locator('#history-share-dialog').waitFor({ state: 'visible' });
    await page.locator('#history-share-notes').uncheck();
    for (const extra of ['#history-share-chats', '#history-share-journal']) {
      const box = page.locator(extra);
      if (await box.isVisible() && await box.isChecked()) await box.uncheck();
    }
    const download = page.waitForEvent('download');
    await page.locator('#history-share-save').click();
    const file = await download;
    await file.saveAs(path.resolve(options.out));
    const mapping = await page.evaluate(() => window._cellucidState.getDataMapping());
    const problems = (await notifications(page)).filter(note => PROBLEM.test(note.text));
    if (problems.length > 0 || errors.length > 0) {
      throw new Error(`${options.datasetId}: the viewer reported problems:\n${[...problems.map(note => note.text), ...errors].join('\n')}`);
    }
    return { openedMs, mapping, startingView: entry.session !== undefined };
  } finally {
    await browser.close();
    await site.close();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { openedMs, mapping, startingView } = await captureSessionPreset(options);
  process.stdout.write(
    `captured ${options.datasetId} into ${options.out} (opened in ${openedMs} ms, `
      + `${startingView ? 'from the starting view the catalog names' : 'the catalog names no starting view'}, `
      + `${options.actions.length} action(s) dispatched)\n`
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
