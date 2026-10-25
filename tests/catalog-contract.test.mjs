import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  GITHUB_MAX_FILE_BYTES,
  ZARR_METADATA_NAMES,
  compareCodePoints,
  describeStore,
  listStoreFiles,
  readArray,
  storeDigest,
} from '../scripts/anndata_store.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ANNDATA_ROOT = path.join(REPOSITORY_ROOT, 'anndata');
const CATALOG_PATH = path.join(ANNDATA_ROOT, 'datasets.json');
const SOURCES_ROOT = path.join(REPOSITORY_ROOT, 'sources');
const BUILD_ENVIRONMENT_PATH = path.join(SOURCES_ROOT, 'build-environment.json');

/** The samples the picker offers, in catalog order; Suo opens by default. */
const EXPECTED_DATASET_IDS = Object.freeze(['suo', 'garcia', 'he', 'kanemaru', 'pancreas']);
const DEFAULT_DATASET_ID = 'suo';
/** Which pinned builder produces each published store. */
const STORE_BUILDERS = Object.freeze({
  garcia: 'scripts/build_atlas.py',
  he: 'scripts/build_atlas.py',
  kanemaru: 'scripts/build_atlas.py',
  pancreas: 'scripts/build_pancreas.py',
  suo: 'scripts/build_atlas.py',
});
/**
 * `datasets.json` as the web app reads it (`anndata-catalog.js`,
 * `validateAnnDataCatalog`): these keys and no other, which the app refuses.
 */
const CATALOG_KEYS = Object.freeze(['datasets', 'default', 'schema']);
const CATALOG_SCHEMA = 2;
const ENTRY_KEYS = Object.freeze(['id', 'path', 'session']);
const SESSION_KEYS = Object.freeze(['bytes', 'path', 'sha256']);
/** The app's portable dataset id rule (`isPortableDatasetId`). */
const PORTABLE_DATASET_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,178}[A-Za-z0-9_-])?$/;
/**
 * GitHub Pages refuses to publish a site larger than 1 GB. The whole
 * repository is the site, so its published bytes are held to a budget with
 * room for a sixth sample or a rebuild that grows, instead of to the limit.
 */
const PAGES_SITE_LIMIT_BYTES = 1_000_000_000;
const PAGES_SITE_BUDGET_BYTES = 800_000_000;
/** The keys of `uns['cellucid']` read as values (the Cellucid-ready AnnData specification, §2); `outlierQuantiles` is described apart. */
const CELLUCID_KEYS = Object.freeze([
  'citation', 'defaults', 'description', 'id', 'name', 'schema', 'source', 'session',
]);
const DEFAULTS_KEYS = Object.freeze([
  'centroidMinPoints', 'embedding1d', 'embedding2d', 'embedding3d',
  'expression', 'geneIdColumn', 'knn', 'latentKey', 'normalizeEmbeddings', 'obsKeys',
  'vectorFieldDefault',
]);

/**
 * Every published store redistributes somebody else's atlas, so every one of
 * them carries a citation; a source record with a name and a URL but no
 * citation is the attribution failure this table exists to keep out.
 *
 * Each value was checked against the archive or publication it names, not
 * copied from an earlier record. Suo, Garcia and He are cited by their study
 * title and the ArrayExpress accession that holds the study's scRNA-seq
 * libraries; for Suo that is E-MTAB-11343, not the study's Visium accession
 * E-MTAB-11341. Kanemaru is the fetal heart of the Developing Heart Cell Atlas
 * (every one of its ten donors is an atlas donor, and none is a donor of the
 * adult-heart study E-MTAB-12916); that study has deposited no RNA accession in
 * a public archive, so it is cited by its preprint DOI and named by its data
 * portal. The values originate in `sources/<id>.json`, which the pinned build
 * passes to `prepare()`; a citation edited into a store alone would be gone at
 * the next rebuild and fails the store digest here.
 */
const SOURCE_EXPECTATIONS = Object.freeze({
  suo: {
    source: {
      name: 'E-MTAB-11343',
      url: 'https://www.ebi.ac.uk/biostudies/arrayexpress/studies/E-MTAB-11343',
    },
    citation: {
      text: 'Mapping the developing human immune system across organs. ArrayExpress study E-MTAB-11343.',
    },
  },
  garcia: {
    source: {
      name: 'E-MTAB-10551',
      url: 'https://www.ebi.ac.uk/biostudies/arrayexpress/studies/E-MTAB-10551',
    },
    citation: {
      text: 'Single-cell roadmap of human gonadal development. ArrayExpress study E-MTAB-10551.',
    },
  },
  he: {
    source: {
      name: 'E-MTAB-11278',
      url: 'https://www.ebi.ac.uk/biostudies/arrayexpress/studies/E-MTAB-11278',
    },
    citation: {
      text: 'A human fetal lung cell atlas uncovers proximal-distal gradients of differentiation and key regulators of epithelial fates. ArrayExpress study E-MTAB-11278.',
    },
  },
  kanemaru: {
    source: {
      name: 'Developing Heart Cell Atlas',
      url: 'https://www.heartcellatlas.org/foetal.html',
    },
    citation: {
      text: 'Cranley J, Kanemaru K, Bayraktar S, Knight-Schrijver V, et al. Developmental Dynamics of Human Cardiogenesis: A multi-omic reference and its disruption in Trisomy 21. bioRxiv. 2024. doi:10.1101/2024.04.29.591736.',
      url: 'https://doi.org/10.1101/2024.04.29.591736',
    },
  },
  pancreas: {
    source: {
      name: 'scVelo pancreas (GSE132188 E15.5)',
      url: 'https://raw.githubusercontent.com/theislab/scvelo_notebooks/f6cad69fd509be44c8453205309f4c3c3c37ba34/data/Pancreas/endocrinogenesis_day15.h5ad',
    },
    citation: {
      text: 'Bastidas-Ponce A, Tritschler S, Dony L, Scheibner K, Tarquis-Medina M, Salinno C, Schirge S, Burtscher I, Böttcher A, Theis FJ, Lickert H, Bakhti M. Comprehensive single cell mRNA profiling reveals a detailed roadmap for pancreatic endocrinogenesis. Development. 2019;146(12):dev173849. doi:10.1242/dev.173849.',
      url: 'https://doi.org/10.1242/dev.173849',
    },
  },
});

/**
 * A categorical obs field every cell shares is offered in the colour menu, in
 * the filter panel and in the legend, and every one of them does nothing: the
 * embedding comes back one flat colour, the filter selects all cells or none,
 * the legend prints one row. That is a published colouring that cannot answer a
 * question, and it costs a user a click to find out.
 *
 * It is not, however, a defect on its own, which is why this is a named list
 * and not a rule. Suo's `LVL0` is the published lineage subset: a constant
 * `LVL0` is the evidence that the documented selection held. The others are
 * sources that genuinely carry one value -- a single-organ study publishing
 * `organ`, or a cross-study integration covariate that does not vary inside one
 * study. A column something upstream collapsed would be a defect, and nothing
 * here is in that state. The list fails the moment a new flat colouring is
 * published or an old one starts to carry information.
 */
const CONSTANT_OBS_FIELDS = Object.freeze({
  'garcia/organ': 'Gonad',
  'garcia/integration_biological_unit': 'Cell',
  'garcia/integration_library_platform_coarse': '5GEX',
  'he/organ': 'Lung',
  'he/integration_biological_unit': 'Cell',
  'he/integration_sample_status': 'Fresh',
  'he/integration_library_platform_coarse': '5GEX',
  'kanemaru/organ': 'Heart',
  'suo/integration_biological_unit': 'Cell',
  'suo/integration_sample_status': 'Fresh',
  'suo/LVL0': 'Haematopoeitic_lineage',
});
const PRODUCER_MODULE_PATH = /^src\/cellucid\/(?:[A-Za-z0-9_]+\/)*[A-Za-z0-9_]+\.py$/;
const PRODUCER_REPOSITORY = process.env.CELLUCID_PYTHON_REPOSITORY
  ? path.resolve(process.env.CELLUCID_PYTHON_REPOSITORY)
  : path.resolve(REPOSITORY_ROOT, '..', 'cellucid-python');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const catalog = await readJson(CATALOG_PATH);

function assertExactKeys(value, keys, label, optional = []) {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`
  );
  const required = keys.filter((key) => !optional.includes(key));
  for (const key of required) {
    assert.ok(Object.hasOwn(value, key), `${label} is missing '${key}'`);
  }
  for (const key of Object.keys(value)) {
    assert.ok(keys.includes(key), `${label} has the unknown key '${key}'`);
  }
}

function storeDirectory(datasetId) {
  return path.join(ANNDATA_ROOT, `${datasetId}.zarr`);
}

test('anndata/datasets.json is the exact schema-2 catalog of the published samples', async () => {
  assertExactKeys(catalog, CATALOG_KEYS, 'datasets.json');
  assert.equal(catalog.schema, CATALOG_SCHEMA);
  assert.equal(catalog.default, DEFAULT_DATASET_ID, 'Suo must remain the catalog default');
  assert.ok(Array.isArray(catalog.datasets), 'datasets must be a list');
  assert.deepEqual(
    catalog.datasets.map((entry) => entry.id),
    [...EXPECTED_DATASET_IDS],
    'datasets.json must list exactly the published samples, in picker order'
  );
  for (const [index, entry] of catalog.datasets.entries()) {
    const label = `datasets[${index}]`;
    assertExactKeys(entry, ENTRY_KEYS, label, ['session']);
    assert.match(entry.id, PORTABLE_DATASET_ID, `${label}.id must be a portable dataset id`);
    assert.equal(
      entry.path,
      `${encodeURIComponent(entry.id)}.zarr/`,
      `${label}.path must name the store folder <id>.zarr/, canonically encoded`
    );
    assert.ok(Object.hasOwn(entry, 'session'), `${label} must publish its starting view`);
    assertExactKeys(entry.session, SESSION_KEYS, `${label}.session`);
    assert.equal(entry.session.path, `${encodeURIComponent(entry.id)}.cellucid-session`);
    const bytes = await readFile(path.join(ANNDATA_ROOT, decodeURIComponent(entry.session.path)));
    assert.equal(entry.session.bytes, bytes.length, `${label}.session.bytes must be the file's exact length`);
    assert.equal(entry.session.sha256, sha256(bytes), `${label}.session.sha256 must be the file's digest`);
  }
  assert.equal(
    `${JSON.stringify(catalog, null, 2)}\n`,
    await readFile(CATALOG_PATH, 'utf8'),
    'datasets.json must be written as two-space JSON with one trailing newline'
  );
});

test('anndata/ holds the catalog, the listed stores and their starting views, and nothing else', async () => {
  const expected = ['datasets.json'];
  for (const entry of catalog.datasets) {
    expected.push(`${entry.id}.zarr`, `${entry.id}.cellucid-session`);
  }
  const present = [];
  for (const entry of await readdir(ANNDATA_ROOT, { withFileTypes: true })) {
    // A hidden entry is a build's working state (a stage, a set-aside store,
    // a publication lock), which .gitignore keeps out of the repository.
    if (entry.name.startsWith('.')) continue;
    present.push(entry.name);
    if (entry.name.endsWith('.zarr')) {
      assert.ok(entry.isDirectory(), `anndata/${entry.name} must be a store folder`);
    } else {
      assert.ok(entry.isFile(), `anndata/${entry.name} must be a regular file`);
    }
  }
  assert.deepEqual(present.sort(compareCodePoints), expected.sort(compareCodePoints));
  const gitignore = await readFile(path.join(REPOSITORY_ROOT, '.gitignore'), 'utf8');
  assert.match(
    gitignore,
    /^\/anndata\/\.\*$/m,
    '.gitignore must keep every hidden entry beside the stores out of the repository'
  );
});

test('GitHub Pages serves the dot-files of the stores (.nojekyll at the site root)', async () => {
  // Jekyll hides every path that starts with "." or "_": without .nojekyll a
  // store's .zarray, .zattrs, .zgroup and .zmetadata are not published, and
  // the web app cannot open a single array.
  const marker = await lstat(path.join(REPOSITORY_ROOT, '.nojekyll'));
  assert.ok(marker.isFile(), '.nojekyll must be a regular file at the repository root');
});

for (const datasetId of EXPECTED_DATASET_IDS) {
  test(`${datasetId} is a Cellucid-ready AnnData Zarr store that names itself`, async () => {
    const directory = storeDirectory(datasetId);
    const provenance = await readJson(path.join(SOURCES_ROOT, `${datasetId}.json`));
    const contract = provenance.anndata_contract;
    const described = await describeStore(directory);
    const { metadata } = described;

    assert.deepEqual(metadata['.zgroup'], { zarr_format: 2 }, 'the store must be a Zarr v2 group');
    assert.deepEqual(
      metadata['.zattrs'],
      { 'encoding-type': 'anndata', 'encoding-version': '0.1.0' },
      'the root must carry the AnnData encoding'
    );
    // The web app learns every group and array from .zmetadata alone, since a
    // browser cannot list a folder: every metadata document on disk must be
    // in it, exactly as the file beside it states it.
    const onDisk = (await listStoreFiles(directory)).filter((relative) =>
      ZARR_METADATA_NAMES.includes(path.posix.basename(relative))
    );
    assert.deepEqual(Object.keys(metadata).sort(compareCodePoints), onDisk);
    for (const relative of onDisk) {
      const stated = { ...metadata[relative] };
      if (relative.endsWith('.zgroup')) delete stated.consolidated_metadata;
      assert.deepEqual(stated, await readJson(path.join(directory, relative)), `.zmetadata states ${relative}`);
    }

    assert.equal(described.x?.encoding, 'csc_matrix', 'X must be stored gene-major');
    const [nObs, nVars] = described.x.shape;
    assert.deepEqual(
      [nObs, nVars],
      contract.recorded.expression.shape,
      'X must have the shape the pinned build recorded'
    );
    const graph = metadata['obsp/connectivities/.zattrs'];
    assert.equal(graph?.['encoding-type'], 'csr_matrix', 'obsp/connectivities must be a csr_matrix');
    assert.deepEqual(graph.shape, [nObs, nObs]);
    for (const [key, { shape, dtype }] of Object.entries(described.obsm)) {
      assert.equal(dtype, '<f4', `obsm/${key} must be float32`);
      assert.equal(shape[0], nObs, `obsm/${key} must hold one row per cell`);
    }

    const cellucid = described.cellucid;
    assert.deepEqual(cellucid, contract.uns_cellucid, "uns['cellucid'] must be the one sources/ records");
    // The latent space's outlier quantiles: one float32 vector per cell for
    // every categorical field prepare() scores (the specification, §2).
    if (cellucid.defaults?.latentKey !== undefined) {
      const fields = Object.entries(described.outlierQuantiles?.fields ?? {});
      assert.ok(fields.length > 0, `${datasetId} must store outlier quantiles in its latent space`);
      for (const [key, { shape, dtype }] of fields) {
        assert.deepEqual([shape, dtype], [[nObs], '<f4'], `outlierQuantiles/fields/${key}`);
      }
    }
    assertExactKeys(cellucid, CELLUCID_KEYS, "uns['cellucid']", ['citation', 'defaults', 'description', 'source', 'session']);
    assert.equal(cellucid.schema, 1);
    assert.equal(cellucid.id, datasetId, "uns['cellucid']['id'] must be the catalog id");
    assert.equal(described.title, cellucid.name, "uns['title'] must be the dataset name");
    assert.deepEqual(
      { source: cellucid.source, citation: cellucid.citation },
      SOURCE_EXPECTATIONS[datasetId],
      `${datasetId} must credit the study it redistributes`
    );
    const defaults = cellucid.defaults;
    assertExactKeys(defaults, DEFAULTS_KEYS, "uns['cellucid']['defaults']", DEFAULTS_KEYS);
    for (const slot of ['embedding1d', 'embedding2d', 'embedding3d']) {
      const key = defaults[slot];
      const dimension = Number(slot[9]);
      assert.ok(
        Object.hasOwn(described.obsm, key) && described.obsm[key].shape[1] >= dimension,
        `defaults.${slot} must name an obsm array at least ${dimension} wide`
      );
    }
    assert.ok(Object.hasOwn(described.obsm, defaults.latentKey), 'defaults.latentKey must name an obsm array');
    if (Object.hasOwn(defaults, 'vectorFieldDefault')) {
      // scVelo's naming: the field <field> on X_<basis> is obsm['<field>_<basis>'].
      const fields = Object.keys(described.obsm).filter(
        (key) =>
          key.startsWith(`${defaults.vectorFieldDefault}_`)
          && Object.hasOwn(described.obsm, `X_${key.slice(defaults.vectorFieldDefault.length + 1)}`)
      );
      assert.ok(fields.length > 0, 'defaults.vectorFieldDefault must name a field the store holds');
    }
  });

  test(`${datasetId} is byte for byte the store its pinned build recorded`, async () => {
    const provenance = await readJson(path.join(SOURCES_ROOT, `${datasetId}.json`));
    assert.equal(provenance.schema_version, 4);
    assert.equal(provenance.dataset_id, datasetId);
    assert.equal(provenance.builder, STORE_BUILDERS[datasetId]);
    await stat(path.join(REPOSITORY_ROOT, provenance.builder));
    const contract = provenance.anndata_contract;
    assert.equal(contract.store, `anndata/${datasetId}.zarr`);
    assert.equal(contract.zarr_format, 2);
    const { largest_file: largest, ...measured } = await storeDigest(storeDirectory(datasetId));
    assert.deepEqual(
      measured,
      contract.recorded.store,
      `anndata/${datasetId}.zarr differs from the store sources/${datasetId}.json records; `
        + 'a store is rebuilt by its pinned build, never edited'
    );
    assert.ok(
      largest.bytes <= GITHUB_MAX_FILE_BYTES,
      `${largest.path} is ${largest.bytes} bytes, more than GitHub accepts in one file`
    );
  });

  test(`${datasetId} names every constant categorical field it publishes`, async () => {
    const directory = storeDirectory(datasetId);
    const { metadata } = await describeStore(directory);
    const constant = {};
    for (const name of Object.keys(metadata)) {
      const match = /^obs\/([^/]+)\/\.zattrs$/.exec(name);
      if (match === null || metadata[name]['encoding-type'] !== 'categorical') continue;
      const column = match[1];
      const { values: codes } = await readArray(directory, metadata, `obs/${column}/codes`);
      const { values: categories } = await readArray(directory, metadata, `obs/${column}/categories`);
      const used = new Set(codes);
      if (used.size === 1 && !used.has(-1)) {
        constant[`${datasetId}/${column}`] = categories[codes[0]];
      }
    }
    const expected = Object.fromEntries(
      Object.entries(CONSTANT_OBS_FIELDS).filter(([key]) => key.startsWith(`${datasetId}/`))
    );
    assert.deepEqual(constant, expected);
  });
}

test('every published file fits GitHub, and the site fits GitHub Pages with room to spare', async (t) => {
  let siteBytes = 0;
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const { size } = await stat(absolute);
        assert.ok(size <= GITHUB_MAX_FILE_BYTES, `${absolute} is larger than GitHub accepts in one file`);
        siteBytes += size;
      }
    }
  };
  const sizes = [];
  for (const datasetId of EXPECTED_DATASET_IDS) {
    const { total_bytes: bytes, file_count: files } = await storeDigest(storeDirectory(datasetId));
    sizes.push(`${datasetId}: ${(bytes / 1e6).toFixed(1)} MB in ${files} files`);
  }
  await walk(ANNDATA_ROOT);
  t.diagnostic(`${sizes.join('; ')}; anndata/ ${(siteBytes / 1e6).toFixed(1)} MB`);
  assert.ok(
    siteBytes <= PAGES_SITE_BUDGET_BYTES,
    `anndata/ is ${siteBytes} bytes, over the ${PAGES_SITE_BUDGET_BYTES}-byte budget kept below `
      + `the ${PAGES_SITE_LIMIT_BYTES}-byte GitHub Pages site limit`
  );
});

test('the pinned producer manifest agrees with the files it enumerates', async () => {
  const environment = await readJson(BUILD_ENVIRONMENT_PATH);
  assert.equal(environment.schema_version, 2);
  const producer = environment.cellucid_producer;
  const sourceFiles = producer.source_files;
  assert.ok(
    Array.isArray(sourceFiles) && sourceFiles.length > 0,
    'the producer manifest must enumerate the pinned modules by path, because '
      + 'a directory pattern lets a removed file leave the pin without a trace'
  );
  const paths = sourceFiles.map((entry) => entry.path);
  assert.deepEqual(paths, [...paths].sort(), 'producer source_files must be in LC_ALL=C path order');
  assert.equal(new Set(paths).size, paths.length, 'producer source_files must name each path once');
  for (const relative of paths) assert.match(relative, PRODUCER_MODULE_PATH);
  assert.ok(
    paths.includes('src/cellucid/prepare_data/_store.py'),
    'the pin must reach the module that writes the store'
  );
  const manifest = sourceFiles.map((entry) => `${entry.sha256}  ${entry.path}\n`).join('');
  assert.equal(
    sha256(Buffer.from(manifest, 'utf8')),
    producer.source_tree_manifest_sha256,
    'the recorded producer manifest digest must be the digest of exactly the source_files list'
  );
});

test('every pinned producer file exists and hashes to its pinned value', async (t) => {
  try {
    await stat(path.join(PRODUCER_REPOSITORY, 'pyproject.toml'));
  } catch {
    t.skip(
      'the cellucid-python producer repository is not checked out beside this one and '
        + 'CELLUCID_PYTHON_REPOSITORY names none, so the pinned paths cannot be read here'
    );
    return;
  }
  const { cellucid_producer: producer } = await readJson(BUILD_ENVIRONMENT_PATH);
  const differing = [];
  for (const entry of producer.source_files) {
    let bytes;
    try {
      bytes = await readFile(path.join(PRODUCER_REPOSITORY, entry.path));
    } catch {
      differing.push(`${entry.path} (missing)`);
      continue;
    }
    if (sha256(bytes) !== entry.sha256) differing.push(entry.path);
  }
  assert.deepEqual(
    differing,
    [],
    'the pinned producer files changed, so the published stores were not written by the '
      + 'code sources/build-environment.json records; rebuild them or repin deliberately'
  );
});

/**
 * The documentation site lists every sample's upstream study in one table, and
 * a reader cites from it. Each row must link exactly the upstream study that
 * `sources/<id>.json` records: `upstream_url` for the four atlases, which is
 * also the `source.url` their stores publish, and `geo_url` for Pancreas,
 * whose `source.url` is the commit-pinned file rather than the study.
 */
const PROVENANCE_DOCS_PATH = 'docs/user_guide/web_app/b_data_loading/12_sample_dataset_provenance.md';

test('the documented upstream study of every sample is the one its store declares', async (t) => {
  let page;
  try {
    page = await readFile(path.join(PRODUCER_REPOSITORY, PROVENANCE_DOCS_PATH), 'utf8');
  } catch {
    t.skip('the cellucid-python repository, which holds the documentation, is not checked out beside this one');
    return;
  }
  for (const datasetId of EXPECTED_DATASET_IDS) {
    const provenance = await readJson(path.join(SOURCES_ROOT, `${datasetId}.json`));
    const studyUrl = provenance.source.upstream_url ?? provenance.source.geo_url;
    assert.equal(typeof studyUrl, 'string', `sources/${datasetId}.json must record the upstream study's URL`);
    if (provenance.source.upstream_url !== undefined) {
      assert.equal(
        provenance.source.upstream_url,
        provenance.anndata_contract.uns_cellucid.source.url,
        `${datasetId}: the store must publish the upstream study its build record names`
      );
    }
    const rows = page
      .split('\n')
      .filter((line) => line.startsWith('|') && line.includes(`| \`${datasetId}\` |`));
    assert.equal(rows.length, 1, `${PROVENANCE_DOCS_PATH} must list ${datasetId} in exactly one row`);
    const link = rows[0].split('|').at(-2).trim().match(/^\[[^\]]+\]\(([^)]+)\)/);
    assert.ok(link, `${datasetId}: the upstream-study cell must open with a Markdown link`);
    assert.equal(link[1], studyUrl, `${datasetId}: the documented upstream study must be the recorded one`);
  }
});
