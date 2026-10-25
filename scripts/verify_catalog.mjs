#!/usr/bin/env node
/**
 * Open every sample of this repository's catalog in the viewer, end to end.
 *
 * Serves the viewer checkout beside this repository and this repository on
 * loopback (`local_site.mjs`), points the app at the local catalog with
 * `?sampleCatalog=`, and walks the sample picker in headless Chromium the way
 * a reader does. For each sample, in catalog order, it checks that:
 *
 * - the dataset opens under the name its store states;
 * - its starting view is applied: the camera and the data mapping the
 *   published `.cellucid-session` records, coloured by the field it names;
 * - another categorical field colours the cells (the first one of the store
 *   with more than one category, other than the starting view's);
 * - a gene colours the cells (the store's first gene);
 *
 * and that no notification reports a failure and the page logs no error. It
 * prints how long each step took and exits non-zero on the first failure.
 *
 *   node scripts/verify_catalog.mjs [--dataset <id>]... [--screenshots <dir>]
 */

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeStore, readArray } from './anndata_store.mjs';
import {
  REPOSITORY_ROOT,
  VIEWER_ROOT,
  launchBrowser,
  notifications,
  recordNotifications,
  startLocalSite,
  waitForNotification,
} from './local_site.mjs';

const ANNDATA_ROOT = path.join(REPOSITORY_ROOT, 'anndata');
const PROBLEM = /fail|error|unavailable|could not|refus/i;

/** What one sample should show, read from its store and its published view. */
async function planFor(entry) {
  const storeDir = path.join(ANNDATA_ROOT, `${entry.id}.zarr`);
  const described = await describeStore(storeDir);
  const { readBundle } = await import(
    new URL(`file://${path.join(VIEWER_ROOT, 'assets/js/app/session/bundle/reader.js')}`).href
  );
  const { gzipDecompress } = await import(
    new URL(`file://${path.join(VIEWER_ROOT, 'assets/js/app/session/codecs/gzip.js')}`).href
  );
  const bytes = await readFile(path.join(ANNDATA_ROOT, decodeURIComponent(entry.session.path)));
  const { manifest, chunkStream } = await readBundle(new Blob([bytes]), { signal: null, onProgress: null });
  let core = null;
  for await (const chunk of chunkStream) {
    if (chunk.meta.id !== 'core/state') continue;
    const raw = await gzipDecompress(chunk.bytes, { maxOutputBytes: chunk.meta.uncompressedBytes, signal: null });
    core = JSON.parse(new TextDecoder().decode(raw));
  }
  const columns = described.metadata['obs/.zattrs']['column-order'];
  let field = null;
  for (const column of columns) {
    if (column === core.activeFields.activeFieldKey) continue;
    if (described.metadata[`obs/${column}/.zattrs`]?.['encoding-type'] !== 'categorical') continue;
    const { values } = await readArray(storeDir, described.metadata, `obs/${column}/categories`);
    if (values.length > 1) {
      field = column;
      break;
    }
  }
  const { values: genes } = await readArray(storeDir, described.metadata, 'var/_index');
  return {
    id: entry.id,
    name: described.cellucid.name,
    cells: described.x.shape[0],
    startingField: core.activeFields.activeFieldKey,
    orbit: core.multiview.live.cameraState.orbit,
    enabled: manifest.datasetFingerprint.dataMapping.embeddings.enabled,
    field,
    gene: genes[0],
  };
}

function parseArguments(argv) {
  const options = { datasets: [], screenshots: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dataset') options.datasets.push(argv[index += 1]);
    else if (argument === '--screenshots') options.screenshots = argv[index += 1];
    else throw new Error(`Unrecognised argument ${JSON.stringify(argument)}.`);
  }
  return options;
}

/**
 * @param {{datasets: string[], screenshots: string|null}} options
 * @returns {Promise<object[]>} One timing record per sample.
 */
export async function verifyCatalog(options) {
  const catalog = JSON.parse(await readFile(path.join(ANNDATA_ROOT, 'datasets.json'), 'utf8'));
  const entries = catalog.datasets.filter(
    entry => options.datasets.length === 0 || options.datasets.includes(entry.id)
  );
  const plans = [];
  for (const entry of entries) plans.push(await planFor(entry));
  if (options.screenshots !== null) await mkdir(options.screenshots, { recursive: true });

  const site = await startLocalSite();
  const browser = await launchBrowser();
  const results = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await recordNotifications(page);
    const now = () => page.evaluate(() => performance.now());
    const shoot = async (name) => {
      if (options.screenshots !== null) {
        await page.screenshot({ path: path.join(options.screenshots, `${name}.png`) });
      }
    };

    let started = Date.now();
    await page.goto(site.sampleUrl(plans[0].id), { waitUntil: 'domcontentloaded' });
    try {
      await page.locator('#welcome-modal').waitFor({ state: 'visible', timeout: 15_000 });
      await page.keyboard.press('Escape');
    } catch {
      // The welcome overlay is not shown on every start.
    }
    for (const [index, plan] of plans.entries()) {
      if (index > 0) {
        started = Date.now();
        await page.locator('#dataset-select').selectOption(`dataset:local-demo:${plan.id}`);
      }
      await page.waitForFunction(
        ({ name, cells }) => {
          try {
            return document.querySelector('#dataset-name')?.textContent.trim() === name
              && window._cellucidViewer.getPointCount() === cells;
          } catch {
            return false;
          }
        },
        { name: plan.name, cells: plan.cells },
        { timeout: 600_000 },
      );
      const openMs = Date.now() - started;

      await page.waitForFunction(
        ({ orbit, field }) => {
          const camera = window._cellucidViewer.getCameraState().orbit;
          return ['radius', 'theta', 'phi'].every(key => camera[key] === orbit[key])
            && document.querySelector('#categorical-field option:checked')?.textContent.trim() === field;
        },
        { orbit: plan.orbit, field: plan.startingField },
        { timeout: 120_000 },
      );
      const startingViewMs = Date.now() - started;
      const enabled = await page.evaluate(() => window._cellucidState.getDataMapping().embeddings.enabled);
      if (JSON.stringify(enabled) !== JSON.stringify(plan.enabled)) {
        throw new Error(`${plan.id}: the starting view enables ${JSON.stringify(enabled)}, not ${JSON.stringify(plan.enabled)}.`);
      }
      await shoot(`${plan.id}-1-starting-view`);

      let mark = await now();
      let stepStarted = Date.now();
      await page.locator('#categorical-field').selectOption({ label: plan.field });
      await waitForNotification(page, new RegExp(`Loaded field: ${plan.field}`), mark);
      const fieldMs = Date.now() - stepStarted;
      await shoot(`${plan.id}-2-field`);

      mark = await now();
      stepStarted = Date.now();
      await page.locator('#gene-expression-search').click();
      await page.locator('#gene-expression-search').fill(plan.gene);
      await page.locator('#gene-expression-dropdown .dropdown-item', { hasText: plan.gene }).first().click();
      await waitForNotification(page, new RegExp(`Loaded gene: ${plan.gene.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), mark);
      const geneMs = Date.now() - stepStarted;
      await shoot(`${plan.id}-3-gene`);

      results.push({ id: plan.id, cells: plan.cells, openMs, startingViewMs, field: plan.field, fieldMs, gene: plan.gene, geneMs });
    }
    const problems = (await notifications(page)).filter(note => PROBLEM.test(note.text));
    if (problems.length > 0 || errors.length > 0) {
      throw new Error(`The viewer reported problems:\n${[...problems.map(note => note.text), ...errors].join('\n')}`);
    }
  } finally {
    await browser.close();
    await site.close();
  }
  return results;
}

if (process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    for (const result of await verifyCatalog(parseArguments(process.argv.slice(2)))) {
      process.stdout.write(
        `${result.id}: ${result.cells} cells, opened in ${result.openMs} ms, starting view at `
          + `${result.startingViewMs} ms, field ${result.field} in ${result.fieldMs} ms, `
          + `gene ${result.gene} in ${result.geneMs} ms\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
