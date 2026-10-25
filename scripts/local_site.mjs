/**
 * Serve the web app and this repository on loopback, the way the published
 * site serves them: the app from the viewer checkout beside this repository,
 * and this repository with permissive CORS and byte ranges, like GitHub Pages
 * serves `https://theislab.github.io/cellucid-datasets/`. The app is then
 * pointed at the local catalog with `?sampleCatalog=`.
 *
 * Used by `capture_session_preset.mjs` and `verify_catalog.mjs`; both need the
 * viewer repository checked out beside this one, and its Playwright install.
 *
 * @module scripts/local_site
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VIEWER_ROOT = path.resolve(REPOSITORY_ROOT, '..', 'cellucid');

const TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/vnd.microsoft.icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
});

function handler(root, cors) {
  return async (request, response) => {
    const headers = cors
      ? {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
      }
      : {};
    if (request.method === 'OPTIONS') {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    try {
      let pathname = decodeURIComponent(new URL(request.url, 'http://local').pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const file = path.join(root, pathname);
      if (!file.startsWith(root + path.sep)) throw Object.assign(new Error('outside'), { code: 'ENOENT' });
      const info = await stat(file);
      if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
      const start = range === null ? 0 : Number(range[1]);
      const end = range === null || range[2] === '' ? info.size - 1 : Math.min(Number(range[2]), info.size - 1);
      if (range !== null && start > end) {
        response.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` });
        response.end();
        return;
      }
      response.writeHead(range === null ? 200 : 206, {
        ...headers,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Length': info.size === 0 ? 0 : end - start + 1,
        'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        ...(range === null ? {} : { 'Content-Range': `bytes ${start}-${end}/${info.size}` }),
      });
      if (request.method === 'HEAD' || info.size === 0) {
        response.end();
        return;
      }
      createReadStream(file, { start, end }).pipe(response);
    } catch (error) {
      response.writeHead(error?.code === 'ENOENT' ? 404 : 500, headers);
      response.end();
    }
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

/**
 * Start both servers on free loopback ports.
 *
 * @returns {Promise<{appOrigin: string, catalogUrl: string, sampleUrl: (datasetId?: string) => string, close: () => Promise<void>}>}
 */
export async function startLocalSite() {
  try {
    await stat(path.join(VIEWER_ROOT, 'index.html'));
  } catch (cause) {
    throw new Error(
      `The viewer repository must be checked out beside this one, at ${VIEWER_ROOT}.`,
      { cause },
    );
  }
  const servers = [
    createServer(handler(VIEWER_ROOT, false)),
    createServer(handler(REPOSITORY_ROOT, true)),
  ];
  for (const server of servers) {
    server.keepAliveTimeout = 120_000;
    server.headersTimeout = 121_000;
  }
  const [appPort, dataPort] = await Promise.all(servers.map(listen));
  const appOrigin = `http://127.0.0.1:${appPort}`;
  const catalogUrl = `http://127.0.0.1:${dataPort}/anndata/`;
  return {
    appOrigin,
    catalogUrl,
    sampleUrl: (datasetId = null) => `${appOrigin}/?sampleCatalog=${encodeURIComponent(catalogUrl)}`
      + (datasetId === null ? '' : `&dataset=${encodeURIComponent(datasetId)}`),
    close: () => Promise.all(servers.map(server => new Promise(resolve => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }))).then(() => undefined),
  };
}

/**
 * Chromium from the viewer checkout's Playwright, with the GPU on.
 *
 * @returns {Promise<import('playwright').Browser>}
 */
export async function launchBrowser() {
  let playwright;
  try {
    playwright = await import(new URL(`file://${path.join(VIEWER_ROOT, 'node_modules', 'playwright', 'index.mjs')}`).href);
  } catch (cause) {
    throw new Error(
      `Playwright is not installed in ${VIEWER_ROOT}; run \`npm ci\` there first.`,
      { cause },
    );
  }
  return playwright.chromium.launch({
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
}

/**
 * Open the app on one sample of the local catalog and wait until it is drawn.
 *
 * @returns {Promise<number>} Milliseconds until the dataset was drawn.
 */
export async function openSample(page, site, datasetId) {
  const started = Date.now();
  await page.goto(site.sampleUrl(datasetId), { waitUntil: 'domcontentloaded' });
  try {
    await page.locator('#welcome-modal').waitFor({ state: 'visible', timeout: 15_000 });
    await page.keyboard.press('Escape');
  } catch {
    // The welcome overlay is not shown on every start.
  }
  await page.waitForFunction(() => {
    try {
      return window._cellucidViewer.getPointCount() > 0;
    } catch {
      return false;
    }
  }, null, { timeout: 600_000 });
  return Date.now() - started;
}

/** Record every notification the app shows, from the first frame on. */
export async function recordNotifications(page) {
  await page.addInitScript(() => {
    window.__cellucidNotifications = [];
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && node.classList.contains('notification')) {
            window.__cellucidNotifications.push({ at: performance.now(), node });
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

/** The text of every notification shown so far. */
export function notifications(page) {
  return page.evaluate(() => window.__cellucidNotifications.map(({ at, node }) => ({
    at,
    text: node.textContent.replace(/\s+/g, ' ').trim(),
  })));
}

/** Wait for a notification matching `pattern` shown after `after` (performance.now()). */
export function waitForNotification(page, pattern, after, timeout = 300_000) {
  return page.waitForFunction(
    ([source, since]) => window.__cellucidNotifications.some(
      ({ at, node }) => at >= since && new RegExp(source).test(node.textContent.replace(/\s+/g, ' ')),
    ),
    [pattern.source, after],
    { timeout },
  );
}
