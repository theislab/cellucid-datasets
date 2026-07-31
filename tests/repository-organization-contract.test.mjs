import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = new URL('../', import.meta.url);
const WORKFLOWS_ROOT = new URL('.github/workflows/', REPOSITORY_ROOT);
const TESTS_ROOT = new URL('tests/', REPOSITORY_ROOT);
const SCRIPTS_ROOT = new URL('scripts/', REPOSITORY_ROOT);
const NOTEBOOKS_ROOT = new URL('notebooks/', REPOSITORY_ROOT);
const SOURCES_ROOT = new URL('sources/', REPOSITORY_ROOT);
const EXPORTS_ROOT = new URL('exports/', REPOSITORY_ROOT);
const GIT_ATTRIBUTES_URL = new URL('.gitattributes', REPOSITORY_ROOT);
const GITIGNORE_URL = new URL('.gitignore', REPOSITORY_ROOT);
const README_URL = new URL('README.md', REPOSITORY_ROOT);
const CATALOG_URL = new URL('exports/datasets.json', REPOSITORY_ROOT);
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
 * `tests/test_build_pancreas_publish.py` fell straight through it -- seven
 * assertions on the staged Pancreas publisher that no workflow ever executed.
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
    minimumSuites: 1,
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
 * The directories whose every non-hidden file is a text artifact. `exports/`
 * is not among them: it holds 37,000 gzip payloads and the
 * `*.cellucid-session` binaries that `.gitattributes` marks `-text`, so it is
 * swept by targeted extension in readCatalogDocuments() instead of by reading
 * everything.
 */
const TEXT_SURFACE_DIRECTORIES = Object.freeze([
  Object.freeze({ region: 'workflows', prefix: '.github/workflows/', root: WORKFLOWS_ROOT }),
  Object.freeze({ region: 'tests', prefix: 'tests/', root: TESTS_ROOT }),
  Object.freeze({ region: 'scripts', prefix: 'scripts/', root: SCRIPTS_ROOT }),
  Object.freeze({ region: 'notebooks', prefix: 'notebooks/', root: NOTEBOOKS_ROOT }),
  Object.freeze({ region: 'sources', prefix: 'sources/', root: SOURCES_ROOT }),
]);
const TEXT_SURFACE_REGIONS = Object.freeze([
  'exports',
  'notebooks',
  'root',
  'scripts',
  'sources',
  'tests',
  'workflows',
]);
/**
 * Measured against the 46 text artifacts on disk today: 6 root files, 1
 * workflow, 4 suites, 1 build script, 8 notebooks, 1 provenance record and 25
 * published catalog documents. The floor exists so an enumeration that lands
 * on the wrong tree, or that quietly loses a region, fails instead of sweeping
 * a handful of files while reading as though it swept the repository.
 */
const MINIMUM_TEXT_SURFACE_FILES = 40;
/**
 * The same surface minus the four artifacts excepted from the retired-path
 * rule below, one of which is the whole `notebooks/` directory. Measured at 35
 * today.
 */
const MINIMUM_GOVERNED_ARTIFACTS = 30;
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
 * The markers around the one definition of "published" the suites share.
 * `catalog-contract.test.mjs` swept `exports/` for prepared generations while
 * `session-presets-contract.test.mjs` swept it for state artifacts, and the
 * two disagreed about which directories counted: the first skipped the local
 * scratch exports `.gitignore` excludes, the second descended into them, and
 * this file kept a third copy of the same idea. Whichever of them was widened
 * first would have won without anything saying so, so the definition now lives
 * in one block, byte-identical wherever `exports/` is enumerated, and the
 * sweep below refuses a fourth.
 */
const PUBLISHED_GENERATIONS_BEGIN = /^\/\* published-generations:begin \*\/$/;
const PUBLISHED_GENERATIONS_END = /^\/\* published-generations:end \*\/$/;
/** How a suite names the root of `exports/` when it enumerates it. */
const EXPORTS_ROOT_REFERENCE = /\bEXPORTS_(?:ROOT|URL)\b/;
/**
 * The name convention this repository selected published generations by before
 * the rule moved into `.gitignore`. A suite reaching for it outside the shared
 * block is writing a second definition of "published".
 */
const PRIVATE_GENERATION_FILTER = /startsWith\(\s*(['"])_\1/;
/** The suites that enumerate `exports/`, so an empty sweep cannot pass. */
const MINIMUM_EXPORTS_ENUMERATING_SUITES = 3;

/**
 * The README byte cap kept the file from becoming an implementation diary but
 * allowed it to become nothing at all: an empty README satisfies a cap. The
 * floor is measured against the current 2,022-byte file.
 */
const MINIMUM_README_BYTES = 1_200;
const MAXIMUM_README_BYTES = 4_500;
const REQUIRED_README_LINKS = Object.freeze([
  'https://cellucid.readthedocs.io/en/latest/',
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
  'sessions',
  'tests/bridge-contract.test.mjs',
]);

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
    covers: 'requirements-pancreas.lock',
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

/* published-generations:begin */
/**
 * The one definition of "published" these suites have, held byte-identical in
 * every file that enumerates `exports/`. Two files that each decided for
 * themselves which directories under `exports/` counted governed different
 * sets of artifacts while reading as though they governed the same set, and
 * whichever definition was widened first would have won in silence.
 *
 * The rule itself is not restated here. It is read out of `.gitignore`, which
 * is what actually decides whether a directory under `exports/` is committed:
 * every `/exports/<glob>/` line names a tree the repository keeps out, and a
 * hidden entry is never a prepared generation.
 * `repository-organization-contract.test.mjs` fails if a copy of this block
 * diverges from the others, if a suite that enumerates `exports/` carries no
 * copy, or if any suite selects generations by a name convention of its own.
 */
const PUBLISHED_GENERATION_IGNORE_SCOPE = '/exports/';

function publishedGenerationNames(entries, gitignoreText) {
  const excluded = gitignoreText
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.startsWith(PUBLISHED_GENERATION_IGNORE_SCOPE)
        && line.endsWith('/')
    )
    .map((line) => line.slice(PUBLISHED_GENERATION_IGNORE_SCOPE.length, -1));
  assert.ok(
    excluded.length > 0,
    '.gitignore names no uncommitted directory under exports/, so the rule '
      + 'these suites select published generations by is no longer there to read'
  );
  const patterns = excluded.map(
    (glob) =>
      new RegExp(
        `^${glob
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*')}$`
      )
  );
  return entries
    .filter(
      (entry) =>
        entry.isDirectory()
        && !entry.name.startsWith('.')
        && !patterns.some((pattern) => pattern.test(entry.name))
    )
    .map((entry) => entry.name)
    .sort();
}
/* published-generations:end */

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

/** The published catalog and every generation sidecar beside it, by extension. */
async function readCatalogDocuments() {
  const documents = [
    { region: 'exports', relative: 'exports/datasets.json', url: CATALOG_URL },
  ];
  const generations = publishedGenerationNames(
    await readdir(EXPORTS_ROOT, { withFileTypes: true }),
    await readFile(GITIGNORE_URL, 'utf8')
  );
  for (const generation of generations) {
    documents.push(
      ...(await readDirectoryArtifacts(
        {
          region: 'exports',
          prefix: `exports/${generation}/`,
          root: new URL(`${generation}/`, EXPORTS_ROOT),
        },
        /\.json$/
      ))
    );
  }
  return documents;
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
    'tests/test_build_pancreas_publish.py',
    'scripts/build_pancreas.py',
    'sources/pancreas.json',
    'exports/datasets.json',
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
    '* text=auto eol=lf\n*.cellucid-session -text\n',
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
  assert.ok(Buffer.byteLength(readme, 'utf8') <= MAXIMUM_README_BYTES);
  assert.ok(
    Buffer.byteLength(readme, 'utf8') >= MINIMUM_README_BYTES,
    `README is ${Buffer.byteLength(readme, 'utf8')} bytes, below the `
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
  assert.doesNotMatch(readme, /requirements-pancreas|build_pancreas\.py/);
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

/**
 * The invariant: every suite that enumerates `exports/` decides which of its
 * directories are published with the same rule, held as one byte-identical
 * block, and no suite may decide it any other way.
 */
test('every suite selects published generations by the one shared rule', async () => {
  const suiteNames = (await readSuiteNames()).filter((name) =>
    name.endsWith('.test.mjs')
  );
  assert.ok(
    suiteNames.length >= MINIMUM_EXPORTS_ENUMERATING_SUITES,
    `the sweep found ${suiteNames.length} JavaScript suites, fewer than the `
      + `${MINIMUM_EXPORTS_ENUMERATING_SUITES} this repository publishes, so it `
      + 'is reading the wrong directory'
  );

  const blocksBySuite = new Map();
  const enumeratingSuites = [];
  const ownFilters = [];
  for (const name of suiteNames) {
    const relative = `tests/${name}`;
    const source = await readFile(new URL(name, TESTS_ROOT), 'utf8');
    const blockLines = [];
    let blockCount = 0;
    let inside = false;
    let callsSharedRule = false;
    for (const [index, line] of source.split('\n').entries()) {
      if (PUBLISHED_GENERATIONS_BEGIN.test(line)) {
        assert.equal(
          inside,
          false,
          `${relative}:${index + 1} opens a published-generation block inside `
            + 'another one'
        );
        inside = true;
        blockCount += 1;
        blockLines.push(line);
        continue;
      }
      if (PUBLISHED_GENERATIONS_END.test(line)) {
        assert.equal(
          inside,
          true,
          `${relative}:${index + 1} closes a published-generation block that `
            + 'was never opened'
        );
        inside = false;
        blockLines.push(line);
        continue;
      }
      if (inside) {
        blockLines.push(line);
        continue;
      }
      if (line.includes('publishedGenerationNames(')) callsSharedRule = true;
      if (PRIVATE_GENERATION_FILTER.test(line)) {
        ownFilters.push(`${relative}:${index + 1}: ${line.trim()}`);
      }
    }
    assert.equal(
      inside,
      false,
      `${relative} opens a published-generation block it never closes`
    );
    assert.ok(
      blockCount <= 1,
      `${relative} carries ${blockCount} published-generation blocks; one copy `
        + 'per file is what makes them comparable'
    );

    const enumeratesExports = EXPORTS_ROOT_REFERENCE.test(source);
    if (enumeratesExports) enumeratingSuites.push(relative);
    assert.equal(
      blockCount === 1,
      enumeratesExports,
      enumeratesExports
        ? `${relative} enumerates exports/ without the shared published-`
          + 'generation block, so it is deciding for itself which directories '
          + 'are published'
        : `${relative} carries the shared published-generation block without `
          + 'enumerating exports/, so the copy is unused and free to rot away '
          + 'from the ones that are'
    );
    assert.equal(
      callsSharedRule,
      enumeratesExports,
      `${relative} must call publishedGenerationNames exactly where it decides `
        + 'which directories under exports/ are published'
    );
    if (blockCount === 1) blocksBySuite.set(relative, blockLines.join('\n'));
  }

  assert.ok(
    enumeratingSuites.length >= MINIMUM_EXPORTS_ENUMERATING_SUITES,
    `only ${enumeratingSuites.length} suites were seen to enumerate exports/, `
      + `below the ${MINIMUM_EXPORTS_ENUMERATING_SUITES} that do, so this sweep `
      + 'is not seeing the files it governs'
  );
  assert.deepEqual(
    [...blocksBySuite.keys()].sort(),
    [...enumeratingSuites].sort()
  );
  assert.equal(
    new Set(blocksBySuite.values()).size,
    1,
    `the ${blocksBySuite.size} copies of the published-generation block are not `
      + 'byte-identical, so these suites no longer share one definition of '
      + `which directories under exports/ are published:\n`
      + [...blocksBySuite.keys()].join('\n')
  );
  assert.deepEqual(
    ownFilters,
    [],
    'these lines select generations by a name convention of their own instead '
      + 'of by the shared rule, which is how a second definition of "published" '
      + 'gets written:\n'
      + ownFilters.join('\n')
  );

  // The rule read out of .gitignore, exercised against a listing this test
  // controls: the scratch exports the repository excludes and the hidden
  // entries beside them are not generations, and files never are.
  const gitignore = await readFile(GITIGNORE_URL, 'utf8');
  assert.deepEqual(
    publishedGenerationNames(
      [
        { name: 'pancreas', isDirectory: () => true },
        { name: '_scratch', isDirectory: () => true },
        { name: '.ipynb_checkpoints', isDirectory: () => true },
        { name: 'datasets.json', isDirectory: () => false },
      ],
      gitignore
    ),
    ['pancreas'],
    'the shared rule no longer excludes the scratch export directories '
      + '.gitignore keeps out of this repository, so a local export would be '
      + 'swept as though it had been published'
  );

  const generations = publishedGenerationNames(
    await readdir(EXPORTS_ROOT, { withFileTypes: true }),
    gitignore
  );
  const catalog = JSON.parse(await readFile(CATALOG_URL, 'utf8'));
  assert.ok(
    catalog.datasets.length > 0,
    'the published catalog must advertise at least one dataset'
  );
  for (const entry of catalog.datasets) {
    assert.ok(
      generations.includes(entry.id),
      `the shared rule does not count the catalogued dataset '${entry.id}' as `
        + 'published, so every sweep driven by it is skipping a dataset the '
        + 'sample picker offers'
    );
  }
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
