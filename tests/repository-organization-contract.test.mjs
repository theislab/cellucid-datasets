import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = new URL('../', import.meta.url);
const WORKFLOWS_ROOT = new URL('.github/workflows/', REPOSITORY_ROOT);
const TESTS_ROOT = new URL('tests/', REPOSITORY_ROOT);
const SCRIPTS_ROOT = new URL('scripts/', REPOSITORY_ROOT);
const SOURCES_ROOT = new URL('sources/', REPOSITORY_ROOT);
const GIT_ATTRIBUTES_URL = new URL('.gitattributes', REPOSITORY_ROOT);
const README_URL = new URL('README.md', REPOSITORY_ROOT);
const CITATION_URL = new URL('CITATION.cff', REPOSITORY_ROOT);
const INDEX_URL = new URL('index.html', REPOSITORY_ROOT);
const CATALOG_URL = new URL('anndata/datasets.json', REPOSITORY_ROOT);
/** This file, so the suite sweep below cannot pass on an empty directory. */
const THIS_SUITE = path.basename(fileURLToPath(import.meta.url));
const THIS_SUITE_PATH = `tests/${THIS_SUITE}`;

/**
 * Every contract in this repository is enforced by one of the suites in
 * `tests/`, and the only thing that runs them is a command in a workflow.
 * Asserting that a workflow names *some* existing test left the one failure
 * mode that matters unguarded: a command that quietly stopped listing
 * `catalog-contract.test.mjs` would keep a green check while every payload
 * assertion in it went unrun. Restricting the sweep to `*.test.mjs` left the
 * identical hole one language over, and
 * the Python suite on the staged publisher fell straight through it -- seven
 * assertions that no workflow ever executed.
 * The runners are enumerated here instead, every file in `tests/` is assigned
 * to one of them, and a file that matches none is rejected outright rather
 * than silently uncovered.
 */
const SUITE_RUNNERS = Object.freeze([
  Object.freeze({
    suffix: '.test.mjs',
    label: 'node --test',
    invocation: /\bnode\b[\s\\>|-]*--test\b/g,
    minimumSuites: 3,
  }),
  Object.freeze({
    suffix: '.py',
    label: 'python -m unittest',
    invocation: /\bpython3?\b[\s\\>|-]*-m[\s\\>|-]*unittest\b/g,
    minimumSuites: 2,
  }),
]);

/**
 * Everything at the repository root is a text artifact the `* text=auto
 * eol=lf` policy governs, except the Finder index macOS drops beside them,
 * which is binary and ignored. The root is enumerated by exclusion rather than
 * by an allow-list so that a text file added at the root is swept the day it
 * lands instead of the day somebody remembers to name it here.
 */
const UNGOVERNED_ROOT_FILES = Object.freeze(['.DS_Store']);
/**
 * The directories whose every non-hidden file is a text artifact. `anndata/`
 * is not among them: it holds the stores' compressed chunks and the
 * `*.cellucid-session` binaries that `.gitattributes` marks `-text`, so only
 * its catalog is swept, by name, in readCatalogDocuments().
 */
const TEXT_SURFACE_DIRECTORIES = Object.freeze([
  Object.freeze({ region: 'workflows', prefix: '.github/workflows/', root: WORKFLOWS_ROOT }),
  Object.freeze({ region: 'tests', prefix: 'tests/', root: TESTS_ROOT }),
  Object.freeze({ region: 'scripts', prefix: 'scripts/', root: SCRIPTS_ROOT }),
  Object.freeze({ region: 'sources', prefix: 'sources/', root: SOURCES_ROOT }),
]);
const TEXT_SURFACE_REGIONS = Object.freeze([
  'anndata',
  'root',
  'scripts',
  'sources',
  'tests',
  'workflows',
]);
/**
 * Measured against the 30 text artifacts on disk today: 15 root files, 1
 * workflow, 5 suites, 5 scripts, 6 provenance records and the catalog. The
 * floor exists so an enumeration that lands on the wrong tree, or that quietly
 * loses a region, fails instead of sweeping a handful of files while reading
 * as though it swept the repository.
 */
const MINIMUM_TEXT_SURFACE_FILES = 25;
/**
 * The same surface minus the three artifacts excepted from the retired-path
 * rule below. Measured at 27 today.
 */
const MINIMUM_GOVERNED_ARTIFACTS = 22;
/**
 * The one place in this repository allowed to hold the vocabulary the
 * retired-path rule forbids is the block that defines the rule and its
 * exceptions. It is delimited by markers, it lives in this file, and it may
 * not grow past this many lines.
 */
const MAXIMUM_VOCABULARY_BLOCK_LINES = 60;
const VOCABULARY_BLOCK_BEGIN = /^\/\* retired-path-vocabulary:begin \*\/$/;
const VOCABULARY_BLOCK_END = /^\/\* retired-path-vocabulary:end \*\/$/;
/**
 * The README byte cap kept the file from becoming an implementation diary but
 * allowed it to become nothing at all: an empty README satisfies a cap. The
 * floor is measured against the current 4,497 hand-written bytes. Both bounds
 * govern the hand-written text: the generated citation region is excluded,
 * because its size is set by the shared citation, not by this README, and it
 * is held to that citation byte for byte by the citation test below.
 */
const MINIMUM_README_BYTES = 1_200;
const MAXIMUM_README_BYTES = 5_000;
const REQUIRED_README_LINKS = Object.freeze([
  'https://docs.cellucid.com/en/latest/',
  'https://github.com/theislab/cellucid',
  'https://github.com/theislab/cellucid-python',
  'https://github.com/theislab/cellucid-r',
  'https://github.com/theislab/cellucid-annotation',
  'https://github.com/theislab/cellucid-demo-custom-datasets',
]);
const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const MARKDOWN_BOLD_PATTERN = /\*\*([^*\n]+)\*\*/g;

const RETIRED_REPOSITORY_PATHS = Object.freeze([
  'bridge.html',
  'bridge.js',
  'exports-v3',
  'notebooks',
  'sessions',
  'tests/bridge-contract.test.mjs',
]);
/**
 * The words of the prepared-export layout this repository published before it
 * held AnnData stores. Nothing reads that layout any more, so a text artifact
 * that still names it describes a path the repository no longer has.
 */
const RETIRED_LAYOUT_LANGUAGE =
  /exports-v3|dataset_identity\.json|obs_manifest|var_manifest|state-snapshots\.json|default\.cellucid-session/;

/* retired-path-vocabulary:begin */
const RETIRED_PATH_LANGUAGE =
  /\bfallback\b|fall(?:ing)?[\s-]+back|best[\s_-]*effort|\blegacy\b|\bdeprecated\b|deprecation|backwards?[\s_-]*compat|\bshim\b/i;
/**
 * The rule forbids prose that promises behaviour this repository no longer
 * has. Three artifacts on the text surface carry the same words for reasons
 * that have nothing to do with Cellucid's own retired paths: two upstream
 * distribution names, an upstream file-format name, and upstream warning text
 * pinned character for character. Each is named here with the reason and with
 * one evidence pattern per clause of that reason. A second test re-measures
 * every entry and fails the moment one stops tripping the rule or stops
 * matching any one of its evidence patterns, so an exception cannot outlive the
 * reason it was granted.
 */
const RETIRED_PATH_LANGUAGE_EXCEPTIONS = Object.freeze([
  Object.freeze({
    covers: 'requirements-build.lock',
    reason:
      'pins two PyPI distributions whose published names are Deprecated and '
      + 'legacy-api-wrap',
    evidence: Object.freeze([/^Deprecated==\d/m, /^legacy-api-wrap==\d/m]),
  }),
  Object.freeze({
    covers: 'scripts/build_pancreas.py',
    reason:
      'labels the legacy H5AD encoding of the pinned source file on the four '
      + 'assertions that pin the warning set reading it emits',
    evidence: Object.freeze([/"legacy H5AD [A-Za-z ]+"/]),
  }),
  Object.freeze({
    covers: 'sources/pancreas.json',
    reason:
      'pins the upstream DeprecationWarning category and two upstream warning '
      + 'messages verbatim, which the builder compares character for character',
    evidence: Object.freeze([/"category": "DeprecationWarning"/, /is deprecated/]),
  }),
]);
/* retired-path-vocabulary:end */

async function readWorkflowNames() {
  return (await readdir(WORKFLOWS_ROOT))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
}

async function readSuiteNames() {
  return (await readdir(TESTS_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

function runnerForSuite(name) {
  return SUITE_RUNNERS.find((runner) => name.endsWith(runner.suffix)) ?? null;
}

/**
 * Split a workflow into one command region per runner invocation: each region
 * runs from its own invocation to the next invocation of any runner, so a
 * suite named in one runner's step can never be credited to another's.
 */
function readRunnerCommands(source) {
  const marks = [];
  for (const runner of SUITE_RUNNERS) {
    for (const match of source.matchAll(runner.invocation)) {
      marks.push({ runner, index: match.index });
    }
  }
  marks.sort((left, right) => left.index - right.index);
  return marks.map((mark, position) => ({
    runner: mark.runner,
    command: source.slice(mark.index, marks[position + 1]?.index ?? source.length),
  }));
}

async function readDirectoryArtifacts({ region, prefix, root }, pattern = null) {
  return (await readdir(root, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile()
        && !entry.name.startsWith('.')
        && (pattern === null || pattern.test(entry.name))
    )
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      region,
      relative: `${prefix}${name}`,
      url: new URL(name, root),
    }));
}

/** The published catalog: the one text artifact under `anndata/`. */
async function readCatalogDocuments() {
  return [{ region: 'anndata', relative: 'anndata/datasets.json', url: CATALOG_URL }];
}

/**
 * Every text artifact this repository keeps, in one enumeration. Both
 * whole-repository sweeps below read it, so neither can quietly govern less
 * than the other while reading as though it governed everything.
 */
async function readTextSurface() {
  const surface = (await readdir(REPOSITORY_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !UNGOVERNED_ROOT_FILES.includes(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      region: 'root',
      relative: name,
      url: new URL(name, REPOSITORY_ROOT),
    }));
  for (const directory of TEXT_SURFACE_DIRECTORIES) {
    surface.push(...(await readDirectoryArtifacts(directory)));
  }
  surface.push(...(await readCatalogDocuments()));
  return surface;
}

/**
 * Read one enumerated artifact, or `null` when it vanished between the
 * directory listing and this read. A file being rewritten is not a contract
 * violation; every sweep that tolerates this also asserts a floor on what it
 * actually read, so a vanishing file cannot erode coverage.
 */
async function readArtifactText(url, encoding = 'utf8') {
  try {
    return await readFile(url, encoding);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function retiredPathExceptionFor(relative) {
  return (
    RETIRED_PATH_LANGUAGE_EXCEPTIONS.find((exception) =>
      exception.covers.endsWith('/')
        ? relative.startsWith(exception.covers)
        : relative === exception.covers
    ) ?? null
  );
}

test('the text-surface enumeration reaches every region of the repository', async () => {
  const surface = await readTextSurface();
  assert.deepEqual(
    [...new Set(surface.map((artifact) => artifact.region))].sort(),
    [...TEXT_SURFACE_REGIONS],
    'the text surface lost a region, so the two whole-repository sweeps below '
      + 'stopped governing part of the repository without saying so'
  );
  assert.ok(
    surface.length >= MINIMUM_TEXT_SURFACE_FILES,
    `the text surface enumerates ${surface.length} artifacts, below the `
      + `${MINIMUM_TEXT_SURFACE_FILES} this repository keeps`
  );
  for (const anchor of [
    '.gitattributes',
    'README.md',
    THIS_SUITE_PATH,
    'tests/test_pinned_build_publish.py',
    'scripts/pinned_build.py',
    'scripts/build_atlas.py',
    'scripts/build_pancreas.py',
    'sources/build-environment.json',
    'sources/pancreas.json',
    'sources/suo.json',
    'scripts/anndata_store.mjs',
    'tests/test_anndata_stores.py',
    'index.html',
    'anndata/datasets.json',
  ]) {
    assert.ok(
      surface.some((artifact) => artifact.relative === anchor),
      `the text surface does not reach ${anchor}, so a sweep driven by it is `
        + 'measuring some other tree'
    );
  }
});

test('all text artifacts keep exact LF bytes on every checkout platform', async () => {
  assert.equal(
    await readFile(GIT_ATTRIBUTES_URL, 'utf8'),
    '* text=auto eol=lf\n*.cellucid-session -text\n/anndata/*.zarr/** -text\n',
    'the stores\' chunks are compressed bytes with no extension, which text=auto '
      + 'could take for text and rewrite on checkout',
  );

  // The policy file agreeing with itself says nothing about the bytes the
  // policy exists to govern: a repository whose every text artifact carried
  // CRLF satisfied the assertion above. Reading a hand-picked handful of them
  // said little more -- scripts/, notebooks/, sources/ and every published
  // catalog document sat outside that handful. The whole text surface is read
  // here and required to hold no carriage return.
  const surface = await readTextSurface();
  const carriageReturns = [];
  let read = 0;
  for (const artifact of surface) {
    const bytes = await readArtifactText(artifact.url, null);
    if (bytes === null) continue;
    read += 1;
    if (bytes.includes(0x0d)) carriageReturns.push(artifact.relative);
  }
  assert.ok(
    read >= MINIMUM_TEXT_SURFACE_FILES,
    `only ${read} of the ${surface.length} enumerated text artifacts were `
      + `read, below the ${MINIMUM_TEXT_SURFACE_FILES} this repository keeps, `
      + 'so this sweep is not covering the repository it claims to cover'
  );
  assert.deepEqual(
    carriageReturns,
    [],
    'these text artifacts carry CRLF bytes, which the .gitattributes policy '
      + 'above exists to prevent and which a checkout on another platform will '
      + 'reproduce'
  );
});

test('shipped dataset catalog surfaces contain only current contract language', async () => {
  // README, index.html and the workflows were the whole of this sweep, so the
  // suites, the build script, the notebooks, the provenance record and every
  // published catalog document could describe a path this repository no longer
  // has without anything noticing. The rule now runs over the same enumeration
  // the CRLF sweep uses; the four artifacts that legitimately carry the
  // vocabulary are named as exceptions and re-measured by the test below.
  const surface = await readTextSurface();
  const violations = [];
  const blockBegins = [];
  const blockEnds = [];
  let blockLines = 0;
  let read = 0;
  let governed = 0;
  for (const artifact of surface) {
    if (retiredPathExceptionFor(artifact.relative) !== null) continue;
    governed += 1;
    const source = await readArtifactText(artifact.url);
    if (source === null) continue;
    read += 1;
    let insideBlock = false;
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      if (VOCABULARY_BLOCK_BEGIN.test(line)) {
        blockBegins.push(`${artifact.relative}:${index + 1}`);
        insideBlock = true;
        continue;
      }
      if (VOCABULARY_BLOCK_END.test(line)) {
        blockEnds.push(`${artifact.relative}:${index + 1}`);
        insideBlock = false;
        continue;
      }
      if (insideBlock) {
        blockLines += 1;
        continue;
      }
      if (RETIRED_PATH_LANGUAGE.test(line)) {
        violations.push(`${artifact.relative}:${index + 1}: ${line.trim()}`);
      }
    }
  }

  assert.ok(
    read >= MINIMUM_GOVERNED_ARTIFACTS,
    `only ${read} of the ${governed} governed text artifacts were read, below `
      + `the ${MINIMUM_GOVERNED_ARTIFACTS} this rule governs, so this sweep is `
      + 'not covering the repository it claims to cover'
  );
  assert.deepEqual(
    [
      blockBegins.map((mark) => mark.split(':')[0]),
      blockEnds.map((mark) => mark.split(':')[0]),
    ],
    [[THIS_SUITE_PATH], [THIS_SUITE_PATH]],
    'the block that is allowed to hold the forbidden vocabulary must appear '
      + 'exactly once, in the file that defines the rule; a second pair of '
      + 'markers anywhere on the text surface is an unreviewed escape hatch'
  );
  assert.ok(
    blockLines > 0 && blockLines <= MAXIMUM_VOCABULARY_BLOCK_LINES,
    `the vocabulary block spans ${blockLines} lines, outside the 1..`
      + `${MAXIMUM_VOCABULARY_BLOCK_LINES} range it is allowed; it may hold the `
      + 'rule and its exceptions and nothing else'
  );
  assert.deepEqual(violations, []);
});

test('every retired-path-language exception still has the reason it was granted', async () => {
  const surface = await readTextSurface();
  for (const exception of RETIRED_PATH_LANGUAGE_EXCEPTIONS) {
    const covered = surface.filter(
      (artifact) => retiredPathExceptionFor(artifact.relative) === exception
    );
    assert.ok(
      covered.length > 0,
      `no text artifact matches the exception written for ${exception.covers}, `
        + 'so it outlived the file it was granted to and must be deleted'
    );
    let tripsRule = false;
    const unmatched = new Set(exception.evidence);
    let read = 0;
    for (const artifact of covered) {
      const source = await readArtifactText(artifact.url);
      if (source === null) continue;
      read += 1;
      if (RETIRED_PATH_LANGUAGE.test(source)) tripsRule = true;
      for (const evidence of exception.evidence) {
        if (evidence.test(source)) unmatched.delete(evidence);
      }
    }
    assert.ok(read > 0, `none of the ${covered.length} artifacts covered by the `
      + `exception for ${exception.covers} could be read`);
    assert.ok(
      tripsRule,
      `${exception.covers} no longer trips the rule, so its exception protects `
        + 'nothing and must be deleted rather than left to cover a future one'
    );
    assert.deepEqual(
      [...unmatched],
      [],
      `${exception.covers} no longer matches every pattern behind its recorded `
        + `reason -- ${exception.reason} -- so the reason is no longer why it `
        + 'is excepted'
    );
  }
});

test('README stays a concise demo-catalog guide instead of an implementation diary', async () => {
  const readme = await readFile(README_URL, 'utf8');
  const region = citationRegion(readme);
  const handWrittenBytes = Buffer.byteLength(readme, 'utf8')
    - Buffer.byteLength(region.text, 'utf8');
  assert.ok(handWrittenBytes <= MAXIMUM_README_BYTES);
  assert.ok(
    handWrittenBytes >= MINIMUM_README_BYTES,
    `README is ${handWrittenBytes} hand-written bytes, below the `
      + `${MINIMUM_README_BYTES}-byte floor; the cap alone accepted an empty file`
  );
  assert.match(readme, /public demo-dataset extension of/);
  for (const url of REQUIRED_README_LINKS) {
    assert.ok(readme.includes(url), `README must link to ${url}`);
  }
  assert.doesNotMatch(
    readme,
    /^## (?:Rebuilding|Web application configuration|GitHub Pages)/m
  );
  assert.doesNotMatch(
    readme,
    /requirements-build|build_(?:atlas|pancreas)\.py|pinned_build/
  );
});

test('every promised README destination is a real markdown link', async () => {
  const readme = await readFile(README_URL, 'utf8');
  const targets = new Map();
  for (const [, text, target] of readme.matchAll(MARKDOWN_LINK_PATTERN)) {
    assert.ok(
      text.trim().length > 0,
      `README link to ${target} must carry printable link text`
    );
    assert.match(
      target,
      /^https:\/\/[^\s]+$/,
      `README link "${text}" points at ${target}, which is not an absolute `
        + 'https destination a reader of the rendered page can follow'
    );
    if (!targets.has(target)) targets.set(target, []);
    targets.get(target).push(text);
  }
  assert.ok(
    targets.size > 0,
    'the README must carry markdown links, or this sweep asserts nothing'
  );
  for (const url of REQUIRED_README_LINKS) {
    assert.ok(
      targets.has(url),
      `README mentions ${url} without linking to it; a bare URL in prose is `
        + 'not a destination anyone can click'
    );
  }
});

test('README names every dataset the published catalog advertises', async () => {
  const readme = await readFile(README_URL, 'utf8');
  const catalog = JSON.parse(await readFile(CATALOG_URL, 'utf8'));
  assert.ok(
    Array.isArray(catalog.datasets) && catalog.datasets.length > 0,
    'the published catalog must advertise at least one dataset'
  );
  const highlighted = new Set();
  for (const [, span] of readme.matchAll(MARKDOWN_BOLD_PATTERN)) {
    for (const word of span.toLowerCase().split(/[^a-z0-9_-]+/)) {
      if (word.length > 0) highlighted.add(word);
    }
  }
  assert.ok(
    highlighted.size > 0,
    'the README must name its samples in bold, or this sweep asserts nothing'
  );
  for (const entry of catalog.datasets) {
    assert.ok(
      highlighted.has(entry.id.toLowerCase()),
      `README does not name the catalogued sample '${entry.id}'; the sample `
        + 'picker offers it and the README claims to list what the catalog '
        + 'includes'
    );
  }
});

test('no text artifact describes the prepared-export layout this repository no longer has', async () => {
  const surface = await readTextSurface();
  const violations = [];
  let read = 0;
  for (const artifact of surface) {
    if (artifact.relative === THIS_SUITE_PATH) continue;
    const source = await readArtifactText(artifact.url);
    if (source === null) continue;
    read += 1;
    for (const [index, line] of source.split('\n').entries()) {
      if (RETIRED_LAYOUT_LANGUAGE.test(line)) {
        violations.push(`${artifact.relative}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  assert.ok(read >= MINIMUM_GOVERNED_ARTIFACTS, `only ${read} text artifacts were read`);
  assert.deepEqual(violations, []);
});

test('the site shell lists the catalog the web app reads', async () => {
  const index = await readFile(INDEX_URL, 'utf8');
  assert.match(index, /fetch\('\.\/anndata\/datasets\.json'/);
  assert.match(index, /catalog\.schema !== 2/);
});

test('every test suite in tests/ is run by every dataset workflow', async () => {
  const suiteNames = await readSuiteNames();
  assert.ok(
    suiteNames.includes(THIS_SUITE),
    `the suite sweep must find ${THIS_SUITE}, which is running right now; a `
      + 'sweep that cannot see itself is measuring the wrong directory'
  );

  const suitesByRunner = new Map(SUITE_RUNNERS.map((runner) => [runner, []]));
  const unrunnable = [];
  for (const name of suiteNames) {
    const runner = runnerForSuite(name);
    if (runner === null) {
      unrunnable.push(`tests/${name}`);
      continue;
    }
    suitesByRunner.get(runner).push(`tests/${name}`);
  }
  assert.deepEqual(
    unrunnable,
    [],
    'these files sit in tests/ and match no runner this sweep knows how to '
      + 'trace, so no workflow can be shown to execute them; give them a '
      + 'runner in SUITE_RUNNERS or take them out of tests/'
  );
  for (const runner of SUITE_RUNNERS) {
    const suites = suitesByRunner.get(runner);
    assert.ok(
      suites.length >= runner.minimumSuites,
      `tests/ holds ${suites.length} ${runner.label} suites, fewer than the `
        + `${runner.minimumSuites} this repository publishes`
    );
  }

  const workflowNames = await readWorkflowNames();
  assert.ok(workflowNames.length > 0, 'at least one dataset workflow is required');
  for (const workflowName of workflowNames) {
    const source = await readFile(new URL(workflowName, WORKFLOWS_ROOT), 'utf8');
    const commands = readRunnerCommands(source);
    for (const runner of SUITE_RUNNERS) {
      const suites = suitesByRunner.get(runner);
      const invocations = commands.filter((entry) => entry.runner === runner);
      assert.ok(
        invocations.length > 0,
        `${workflowName} runs no ${runner.label} command, so none of the `
          + `${suites.length} ${runner.suffix} suites in tests/ is checked by it`
      );
      const missing = suites.filter(
        (suitePath) => !invocations.some((entry) => entry.command.includes(suitePath))
      );
      assert.deepEqual(
        missing,
        [],
        `${workflowName} runs ${runner.label} without ${missing.join(', ')}; a `
          + 'suite left out of the command is disabled while the check stays green'
      );
    }
  }
});

test('dataset workflows reference only tests that exist in the repository', async () => {
  const workflowNames = await readWorkflowNames();
  assert.ok(workflowNames.length > 0, 'at least one dataset workflow is required');

  for (const workflowName of workflowNames) {
    const source = await readFile(new URL(workflowName, WORKFLOWS_ROOT), 'utf8');
    const testPaths = [
      ...source.matchAll(/\btests\/[A-Za-z0-9._/-]+\.(?:test\.mjs|py)\b/g),
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

  const workflowNames = await readWorkflowNames();
  for (const workflowName of workflowNames) {
    const source = await readFile(new URL(workflowName, WORKFLOWS_ROOT), 'utf8');
    assert.doesNotMatch(source, /\bbridge\b/i);
  }
});

/**
 * The Cellucid citation is written once, in the preferred-citation block that
 * every Cellucid repository's CITATION.cff shares, and generated everywhere
 * else by cellucid-private/scripts/sync_citation.py. The README's citation
 * region records the SHA-256 of the block it came from and of its own body, so
 * a block changed without re-running the script, or a region edited by hand,
 * fails here.
 */
const CITATION_BLOCK_BEGIN = '# BEGIN cellucid preferred-citation';
const CITATION_BLOCK_END = '# END cellucid preferred-citation';
const CITATION_REGION_BEGIN = /^<!-- BEGIN cellucid-citation \(generated by cellucid-private\/scripts\/sync_citation\.py from CITATION\.cff; do not edit\) source-sha256=([0-9a-f]{64}) body-sha256=([0-9a-f]{64}) -->\n/gm;
const CITATION_REGION_END = '<!-- END cellucid-citation -->\n';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function preferredCitationBlock(text) {
  const lines = text.split(/(?<=\n)/);
  const indexOf = (marker) => lines.flatMap((line, index) => (
    line.replace(/\n$/, '') === marker ? [index] : []
  ));
  const begins = indexOf(CITATION_BLOCK_BEGIN);
  const ends = indexOf(CITATION_BLOCK_END);
  assert.equal(begins.length, 1, `CITATION.cff must hold one "${CITATION_BLOCK_BEGIN}" line`);
  assert.equal(ends.length, 1, `CITATION.cff must hold one "${CITATION_BLOCK_END}" line`);
  assert.ok(ends[0] > begins[0]);
  const block = lines.slice(begins[0], ends[0] + 1).join('');
  return block.endsWith('\n') ? block : `${block}\n`;
}

function citationRegion(text) {
  const begins = [...text.matchAll(CITATION_REGION_BEGIN)];
  assert.equal(begins.length, 1, 'README.md must hold exactly one generated citation region');
  assert.equal(text.split(CITATION_REGION_END).length, 2, 'README.md must hold exactly one region end');
  const bodyStart = begins[0].index + begins[0][0].length;
  const bodyEnd = text.indexOf(CITATION_REGION_END);
  assert.ok(bodyEnd >= bodyStart, 'the citation region must end after it begins');
  return {
    source: begins[0][1],
    recordedBody: begins[0][2],
    body: text.slice(bodyStart, bodyEnd),
    text: text.slice(begins[0].index, bodyEnd + CITATION_REGION_END.length),
  };
}

test('the README citation is generated from this CITATION.cff and unedited', async () => {
  const block = preferredCitationBlock(await readFile(CITATION_URL, 'utf8'));
  const region = citationRegion(await readFile(README_URL, 'utf8'));
  assert.equal(
    region.source,
    sha256(block),
    'CITATION.cff changed after the README citation was generated; run '
      + 'cellucid-private/scripts/sync_citation.py'
  );
  assert.equal(
    region.recordedBody,
    sha256(region.body),
    'the README citation region was edited by hand; edit '
      + 'theislab/cellucid/CITATION.cff and run cellucid-private/scripts/sync_citation.py'
  );
  const placeholder = !/^ {2}doi:/m.test(block);
  assert.equal(region.body.includes('**Placeholder citation.**'), placeholder);
});
