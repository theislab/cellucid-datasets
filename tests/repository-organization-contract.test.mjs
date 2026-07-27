import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const REPOSITORY_ROOT = new URL('../', import.meta.url);
const WORKFLOWS_ROOT = new URL('.github/workflows/', REPOSITORY_ROOT);
const GIT_ATTRIBUTES_URL = new URL('.gitattributes', REPOSITORY_ROOT);
const README_URL = new URL('README.md', REPOSITORY_ROOT);
const RETIRED_REPOSITORY_PATHS = Object.freeze([
  'bridge.html',
  'bridge.js',
  'sessions',
  'tests/bridge-contract.test.mjs',
]);
const RETIRED_PATH_LANGUAGE =
  /\bfallback\b|fall(?:ing)?[\s-]+back|best[\s_-]*effort|\blegacy\b|\bdeprecated\b|deprecation|backwards?[\s_-]*compat|\bshim\b/i;

test('all text artifacts keep exact LF bytes on every checkout platform', async () => {
  assert.equal(
    await readFile(GIT_ATTRIBUTES_URL, 'utf8'),
    '* text=auto eol=lf\n*.cellucid-session -text\n',
  );
});

test('shipped dataset catalog surfaces contain only current contract language', async () => {
  const files = [
    README_URL,
    new URL('index.html', REPOSITORY_ROOT),
  ];
  const workflowNames = (await readdir(WORKFLOWS_ROOT))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  files.push(
    ...workflowNames.map((name) => new URL(name, WORKFLOWS_ROOT))
  );

  const violations = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      if (RETIRED_PATH_LANGUAGE.test(line)) {
        violations.push(
          `${file.pathname.split('/cellucid-datasets/')[1]}:${index + 1}: ${line.trim()}`
        );
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('README stays a concise demo-catalog guide instead of an implementation diary', async () => {
  const readme = await readFile(README_URL, 'utf8');
  assert.ok(Buffer.byteLength(readme, 'utf8') <= 4_500);
  assert.match(readme, /public demo-dataset extension of/);
  for (const url of [
    'https://cellucid.readthedocs.io/en/latest/',
    'https://github.com/theislab/cellucid',
    'https://github.com/theislab/cellucid-python',
    'https://github.com/theislab/cellucid-r',
    'https://github.com/theislab/cellucid-annotation',
    'https://github.com/theislab/cellucid-demo-custom-datasets',
  ]) {
    assert.ok(readme.includes(url), `README must link to ${url}`);
  }
  assert.doesNotMatch(
    readme,
    /^## (?:Rebuilding|Web application configuration|GitHub Pages)/m
  );
  assert.doesNotMatch(readme, /requirements-pancreas|build_pancreas\.py/);
});

test('dataset workflows reference only tests that exist in the repository', async () => {
  const workflowNames = (await readdir(WORKFLOWS_ROOT))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  assert.ok(workflowNames.length > 0, 'at least one dataset workflow is required');

  for (const workflowName of workflowNames) {
    const source = await readFile(
      new URL(workflowName, WORKFLOWS_ROOT),
      'utf8'
    );
    const testPaths = [
      ...source.matchAll(/\btests\/[A-Za-z0-9._/-]+\.test\.mjs\b/g),
    ].map((match) => match[0]);
    assert.ok(
      testPaths.length > 0,
      `${workflowName} must run at least one repository test`
    );
    for (const testPath of testPaths) {
      await assert.doesNotReject(
        access(new URL(testPath, REPOSITORY_ROOT)),
        `${workflowName} references missing ${testPath}`
      );
    }
  }
});

test('retired bridge and top-level session paths have no repository surface', async () => {
  for (const relativePath of RETIRED_REPOSITORY_PATHS) {
    await assert.rejects(
      access(new URL(relativePath, REPOSITORY_ROOT)),
      /ENOENT/,
      `${relativePath} must remain deleted`
    );
  }

  const workflowNames = await readdir(WORKFLOWS_ROOT);
  for (const workflowName of workflowNames.filter((name) => /\.ya?ml$/.test(name))) {
    const source = await readFile(
      new URL(workflowName, WORKFLOWS_ROOT),
      'utf8'
    );
    assert.doesNotMatch(source, /\bbridge\b/i);
  }
});
