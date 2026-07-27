import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGunzip, gunzipSync } from 'node:zlib';

const EXPECTED_DATASET_IDS = Object.freeze([
  'suo',
  'garcia',
  'he',
  'kanemaru',
  'pancreas',
]);
const EXPORTS_URL = new URL('../exports/', import.meta.url);
const CATALOG_URL = new URL('datasets.json', EXPORTS_URL);
const PUBLICATION_SIDECAR_NAMES = new Set([
  'default.cellucid-session',
  'state-snapshots.json',
]);
const PANCREAS_PROVENANCE_URL = new URL(
  '../sources/pancreas.json',
  import.meta.url
);
const PANCREAS_REQUIREMENTS_URL = new URL(
  '../requirements-pancreas.lock',
  import.meta.url
);
const CATALOG_REQUIRED_KEYS = Object.freeze([
  'datasets',
  'default',
  'version',
]);
const ENTRY_REQUIRED_KEYS = Object.freeze(['id', 'path']);
const ENTRY_OPTIONAL_KEYS = Object.freeze([
  'description',
  'n_cells',
  'n_genes',
  'name',
  'state_manifest',
  'state_sha256',
]);
const EXPECTED_STATE_SHA256 = Object.freeze({
  suo: '5581569118eaa992d36cd3ce53cde0aa488d27b45f89b8f1a41d56de8f7b7a67',
  garcia: '3ebb88c01bc15edd6c3856c186065db5de7a7ac0c78c5bd62b6db439e4862ffc',
  he: '7959d6d4d0888ce9bf0f74f2a7cf807455503d5448723b582771d45d078c8e3c',
  kanemaru: '9d8029a362ae8545b14e0b755e906414d87411ad26ee7dbc1d173ee9f68837f5',
  pancreas: '53a182ea444b34bf65d2f0c83c5aac7eca195c2912680761052ab66b30d22433',
});
const IDENTITY_REQUIRED_KEYS = Object.freeze([
  'cellucid_data_version',
  'description',
  'embeddings',
  'id',
  'name',
  'obs_fields',
  'stats',
  'version',
]);
const IDENTITY_OPTIONAL_KEYS = Object.freeze([
  'created_at',
  'export_settings',
  'source',
  'vector_fields',
]);
const CONNECTIVITY_DATASET_IDS = Object.freeze([
  'garcia',
  'he',
  'kanemaru',
  'pancreas',
  'suo',
]);
const ALL_DATASET_IDS = CONNECTIVITY_DATASET_IDS;
const UNIT_CONNECTIVITY_DATASET_IDS = new Set([
  'garcia',
  'he',
  'kanemaru',
  'suo',
]);
const SOURCE_EXPECTATIONS = Object.freeze({
  suo: {
    name: 'E-MTAB-11341',
    url: 'https://www.ebi.ac.uk/biostudies/arrayexpress/studies/E-MTAB-11341',
  },
  garcia: {
    name: 'E-MTAB-10551',
    url: 'https://www.ebi.ac.uk/biostudies/arrayexpress/studies/E-MTAB-10551',
  },
  he: {
    name: 'E-MTAB-11278',
    url: 'https://www.ebi.ac.uk/biostudies/arrayexpress/studies/E-MTAB-11278',
  },
  kanemaru: {
    name: 'E-MTAB-12916',
    url: 'https://www.ebi.ac.uk/biostudies/arrayexpress/studies/E-MTAB-12916',
  },
  pancreas: {
    name: 'scVelo pancreas (GSE132188 E15.5)',
    url: 'https://raw.githubusercontent.com/theislab/scvelo_notebooks/f6cad69fd509be44c8453205309f4c3c3c37ba34/data/Pancreas/endocrinogenesis_day15.h5ad',
    citation:
      'Bastidas-Ponce A, Tritschler S, Dony L, Scheibner K, Tarquis-Medina M, Salinno C, Schirge S, Burtscher I, Böttcher A, Theis FJ, Lickert H, Bakhti M. Comprehensive single cell mRNA profiling reveals a detailed roadmap for pancreatic endocrinogenesis. Development. 2019;146(12):dev173849. doi:10.1242/dev.173849.',
  },
});
const CONNECTIVITY_REQUIRED_KEYS = Object.freeze([
  'compression',
  'destinationsPath',
  'format',
  'index_bytes',
  'index_dtype',
  'max_neighbors',
  'n_cells',
  'n_edges',
  'sourcesPath',
  'weight_bytes',
  'weight_dtype',
  'weightsPath',
]);
const UNIT_FLOAT64_LE_BYTES = Object.freeze([
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0xf0,
  0x3f,
]);

function isPlainRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function assertExactKeys(
  value,
  required,
  optional,
  label
) {
  assert.ok(isPlainRecord(value), `${label} must be an object`);
  for (const key of required) {
    assert.ok(
      Object.hasOwn(value, key),
      `${label} is missing required field '${key}'`
    );
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    assert.ok(
      allowed.has(key),
      `${label} contains unsupported field '${key}'`
    );
  }
}

function assertStateCapability(entry, label) {
  const hasManifest = Object.hasOwn(entry, 'state_manifest');
  const hasSha256 = Object.hasOwn(entry, 'state_sha256');
  assert.equal(
    hasManifest,
    hasSha256,
    `${label} state_manifest and state_sha256 must appear together`
  );
  if (!hasManifest) {
    return false;
  }
  assert.match(
    entry.state_manifest,
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/,
    `${label}.state_manifest must be one safe local JSON basename`
  );
  assert.match(
    entry.state_sha256,
    /^[0-9a-f]{64}$/,
    `${label}.state_sha256 must be one lowercase SHA-256`
  );
  return true;
}

function decodeSafeSegment(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (
    decoded.length === 0 ||
    decoded === '.' ||
    decoded === '..' ||
    decoded.includes('/') ||
    decoded.includes('\\') ||
    decoded.includes('?') ||
    decoded.includes('#') ||
    /[\u0000-\u001f\u007f]/.test(decoded)
  ) {
    return null;
  }
  return decoded;
}

function resolveSafeDirectoryPath(value, id) {
  assert.equal(
    typeof value,
    'string',
    `dataset '${id}' path must be a string`
  );
  assert.ok(
    value.length > 0 &&
      value === value.trim() &&
      value.endsWith('/') &&
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.includes('?') &&
      !value.includes('#') &&
      !/^[A-Za-z]:/.test(value) &&
      !/[\u0000-\u001f\u007f]/.test(value),
    `dataset '${id}' must declare a safe relative directory path ending in '/'`
  );
  const encodedSegments = value.slice(0, -1).split('/');
  assert.ok(
    encodedSegments.length > 0 &&
      encodedSegments.every(segment => segment.length > 0),
    `dataset '${id}' must declare a safe relative directory path`
  );
  const decodedSegments = encodedSegments.map(decodeSafeSegment);
  assert.ok(
    decodedSegments.every(segment => segment !== null),
    `dataset '${id}' must declare a safe relative directory path`
  );
  const canonicalPath =
    decodedSegments
      .map(segment => encodeURIComponent(segment))
      .join('/') +
    '/';
  const resolved = new URL(canonicalPath, EXPORTS_URL);
  assert.ok(
    resolved.href.startsWith(EXPORTS_URL.href),
    `dataset '${id}' path must remain below exports/`
  );
  return resolved;
}

async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'));
}

async function assertUnitWeightPayload(url, nEdges, label) {
  const stream = createReadStream(url).pipe(createGunzip());
  let byteOffset = 0;
  for await (const chunk of stream) {
    for (let index = 0; index < chunk.length; index++) {
      assert.equal(
        chunk[index],
        UNIT_FLOAT64_LE_BYTES[byteOffset % 8],
        `${label} differs from little-endian Float64 1.0 at byte ${byteOffset}`
      );
      byteOffset += 1;
    }
  }
  assert.equal(
    byteOffset,
    nEdges * 8,
    `${label} must contain exactly one Float64 weight per edge`
  );
}

async function directorySize(url) {
  const sizes = await Promise.all(
    (await readdir(url, { withFileTypes: true })).map(async entry => {
      const entryUrl = new URL(entry.name, url);
      if (entry.isDirectory()) {
        return directorySize(new URL(`${entry.name}/`, url));
      }
      if (entry.isFile()) {
        return (await stat(entryUrl)).size;
      }
      return 0;
    })
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

function sha256(values) {
  return createHash('sha256').update(values).digest('hex');
}

function assertSha256Fields(value, label = '$') {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      assertSha256Fields(child, `${label}[${index}]`)
    );
    return;
  }
  if (!isPlainRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childLabel = `${label}.${key}`;
    if (key.endsWith('sha256')) {
      assert.match(
        child,
        /^[0-9a-f]{64}$/,
        `${childLabel} must be one exact lowercase SHA-256`
      );
    }
    assertSha256Fields(child, childLabel);
  }
}

async function generationDigest(directoryUrl) {
  const root = fileURLToPath(directoryUrl);
  const files = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const relative = path
          .relative(root, absolute)
          .split(path.sep)
          .join('/');
        if (!PUBLICATION_SIDECAR_NAMES.has(relative)) {
          files.push(absolute);
        }
      } else {
        assert.fail(`generation contains a non-file entry: ${absolute}`);
      }
    }
  }

  await walk(root);
  files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const digest = createHash('sha256');
  let totalBytes = 0;
  for (const absolute of files) {
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const relativeBytes = Buffer.from(relative, 'utf8');
    const payload = await readFile(absolute);
    const pathLength = Buffer.alloc(8);
    pathLength.writeBigUInt64LE(BigInt(relativeBytes.length));
    const payloadLength = Buffer.alloc(8);
    payloadLength.writeBigUInt64LE(BigInt(payload.length));
    digest.update(pathLength);
    digest.update(relativeBytes);
    digest.update(payloadLength);
    digest.update(payload);
    totalBytes += payload.length;
  }
  return {
    fileCount: files.length,
    totalBytes,
    sha256: digest.digest('hex'),
  };
}

async function mapWithConcurrency(values, concurrency, operation) {
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await operation(values[index], index);
    }
  }
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(
    Array.from({ length: workerCount }, () => worker())
  );
}

async function assertPancreasConnectivityPayload(
  directoryUrl,
  manifest,
  identity
) {
  const [sources, destinations, weights] = await Promise.all([
    readFile(new URL(manifest.sourcesPath, directoryUrl)).then(gunzipSync),
    readFile(new URL(manifest.destinationsPath, directoryUrl)).then(gunzipSync),
    readFile(new URL(manifest.weightsPath, directoryUrl)).then(gunzipSync),
  ]);
  assert.equal(sources.length, manifest.n_edges * manifest.index_bytes);
  assert.equal(
    destinations.length,
    manifest.n_edges * manifest.index_bytes
  );
  assert.equal(weights.length, manifest.n_edges * manifest.weight_bytes);

  const degrees = new Uint32Array(identity.stats.n_cells);
  let previousSource = -1;
  let previousDestination = -1;
  let hasNonUnitWeight = false;
  for (let index = 0; index < manifest.n_edges; index++) {
    const source = sources.readUInt16LE(index * 2);
    const destination = destinations.readUInt16LE(index * 2);
    const weight = weights.readDoubleLE(index * 8);
    assert.ok(
      source < destination,
      `pancreas edge ${index} must use canonical source < destination order`
    );
    assert.ok(
      source > previousSource ||
        (source === previousSource &&
          destination > previousDestination),
      `pancreas edge ${index} must be strictly lexicographically ordered`
    );
    assert.ok(
      destination < identity.stats.n_cells,
      `pancreas edge ${index} must reference an existing cell`
    );
    assert.ok(
      Number.isFinite(weight) && weight >= 0,
      `pancreas edge ${index} must have one finite non-negative weight`
    );
    hasNonUnitWeight ||= weight !== 1;
    degrees[source] += 1;
    degrees[destination] += 1;
    previousSource = source;
    previousDestination = destination;
  }
  assert.equal(
    Math.max(...degrees),
    manifest.max_neighbors,
    'pancreas max_neighbors must equal the maximum derived undirected degree'
  );
  assert.equal(
    hasNonUnitWeight,
    true,
    'pancreas must preserve the source weighted graph'
  );
}

const catalog = await readJson(CATALOG_URL);

test('state capability is optional only as one complete integrity pair', () => {
  assert.equal(
    assertStateCapability(
      { id: 'custom', path: 'custom/' },
      'custom dataset'
    ),
    false
  );
  assert.throws(
    () => assertStateCapability(
      {
        id: 'custom',
        path: 'custom/',
        state_manifest: 'state-snapshots.json',
      },
      'custom dataset'
    ),
    /must appear together/
  );
  assert.throws(
    () => assertStateCapability(
      {
        id: 'custom',
        path: 'custom/',
        state_sha256:
          '5581569118eaa992d36cd3ce53cde0aa488d27b45f89b8f1a41d56de8f7b7a67',
      },
      'custom dataset'
    ),
    /must appear together/
  );
});

test('sample datasets.json has one exact five-dataset catalog', () => {
  assertExactKeys(
    catalog,
    CATALOG_REQUIRED_KEYS,
    [],
    'datasets.json'
  );
  assert.equal(catalog.version, 1);
  assert.ok(
    Array.isArray(catalog.datasets) &&
      catalog.datasets.length === EXPECTED_DATASET_IDS.length,
    'datasets.json must advertise exactly the five sample datasets'
  );

  const ids = new Set();
  const paths = new Set();
  for (let index = 0; index < catalog.datasets.length; index++) {
    const entry = catalog.datasets[index];
    const label = `datasets[${index}]`;
    assertExactKeys(
      entry,
      ENTRY_REQUIRED_KEYS,
      ENTRY_OPTIONAL_KEYS,
      label
    );
    assert.ok(
      typeof entry.id === 'string' &&
        entry.id.length > 0 &&
        entry.id === entry.id.trim(),
      `${label}.id must be a non-empty string`
    );
    assert.ok(!ids.has(entry.id), `duplicate dataset id '${entry.id}'`);
    ids.add(entry.id);
    assert.equal(
      assertStateCapability(entry, label),
      true,
      `${label} must advertise its official state capability`
    );

    const resolvedPath = resolveSafeDirectoryPath(
      entry.path,
      entry.id
    );
    assert.equal(
      entry.state_manifest,
      'state-snapshots.json',
      `${label} must explicitly advertise its one local state manifest`
    );
    assert.equal(
      entry.state_sha256,
      EXPECTED_STATE_SHA256[entry.id],
      `${label} must pin its reviewed UI-authored state bytes`
    );
    assert.ok(
      !paths.has(resolvedPath.href),
      `duplicate dataset path '${entry.path}'`
    );
    paths.add(resolvedPath.href);
  }

  assert.deepEqual(
    [...ids].sort(),
    [...EXPECTED_DATASET_IDS].sort()
  );
  assert.ok(
    typeof catalog.default === 'string' &&
      catalog.default.length > 0 &&
      ids.has(catalog.default),
    'datasets.json requires an explicit default matching one dataset id'
  );
  assert.equal(
    catalog.default,
    'suo',
    'Suo must remain the explicit sample catalog default'
  );
});

for (const expectedId of EXPECTED_DATASET_IDS) {
  test(
    `${expectedId} catalog entry exactly agrees with its identity`,
    async () => {
      const entry = catalog.datasets.find(
        candidate => candidate.id === expectedId
      );
      assert.ok(entry, `catalog is missing '${expectedId}'`);
      const directoryUrl = resolveSafeDirectoryPath(
        entry.path,
        entry.id
      );
      const allowedDirectoryUrls = new Set(
        EXPECTED_DATASET_IDS.map(
          id => new URL(`${id}/`, EXPORTS_URL).href
        )
      );
      assert.ok(
        allowedDirectoryUrls.has(directoryUrl.href),
        `catalog path for '${expectedId}' is not an advertised sample directory`
      );

      const identity = await readJson(
        new URL('dataset_identity.json', directoryUrl)
      );
      assertExactKeys(
        identity,
        IDENTITY_REQUIRED_KEYS,
        IDENTITY_OPTIONAL_KEYS,
        `${expectedId}/dataset_identity.json`
      );
      assert.equal(
        Object.hasOwn(identity, '_cellucid_version_marker'),
        false,
        `${expectedId}/dataset_identity.json contains the retired _cellucid_version_marker`
      );
      assert.equal(
        identity.id,
        entry.id,
        `${expectedId} identity id must equal its catalog id`
      );

      const duplicateAssertions = [
        ['name', identity.name],
        ['description', identity.description],
        ['n_cells', identity.stats?.n_cells],
        ['n_genes', identity.stats?.n_genes],
      ];
      for (const [key, identityValue] of duplicateAssertions) {
        if (Object.hasOwn(entry, key)) {
          assert.equal(
            entry[key],
            identityValue,
            `${expectedId} catalog ${key} must exactly equal canonical identity ${key}`
          );
        }
      }
    }
  );
}

test('catalogued source records exactly agree with their authorities', async () => {
  for (const expectedId of EXPECTED_DATASET_IDS) {
    const identity = await readJson(
      new URL(`${expectedId}/dataset_identity.json`, EXPORTS_URL)
    );
    assert.deepEqual(
      identity.source,
      SOURCE_EXPECTATIONS[expectedId],
      `${expectedId} source record must exactly match its declared authority`
    );
  }
});

test('pancreas provenance and artifacts form one exact multidimensional velocity generation', async () => {
  const provenance = await readJson(PANCREAS_PROVENANCE_URL);
  const requirementsLock = await readFile(PANCREAS_REQUIREMENTS_URL);
  const directoryUrl = new URL('pancreas/', EXPORTS_URL);
  const identity = await readJson(
    new URL('dataset_identity.json', directoryUrl)
  );
  const obsManifest = await readJson(
    new URL('obs_manifest.json', directoryUrl)
  );
  const varManifest = await readJson(
    new URL('var_manifest.json', directoryUrl)
  );

  assert.equal(provenance.schema_version, 2);
  assertSha256Fields(provenance);
  assert.equal(JSON.stringify(provenance).includes('PENDING'), false);
  assert.equal(provenance.dataset_id, 'pancreas');
  assert.equal(
    sha256(requirementsLock),
    provenance.build_environment.requirements_lock_sha256
  );
  assert.doesNotMatch(
    requirementsLock.toString('utf8'),
    /^cellucid==/m,
    'the unpublished Cellucid producer must not be disguised as a resolvable third-party lock pin'
  );
  assert.deepEqual(
    {
      repository:
        provenance.build_environment.cellucid_producer.repository,
      version: provenance.build_environment.cellucid_producer.version,
      sourceTree:
        provenance.build_environment.cellucid_producer
          .source_tree_manifest_sha256,
    },
    {
      repository: 'https://github.com/theislab/cellucid-python',
      version: '0.9.1',
      sourceTree:
        '4fa5024ce5878655bad027f421b4e62ea3ef07f7eb1238fe0604712ca92ef042',
    }
  );
  assert.equal(
    provenance.source.commit,
    'f6cad69fd509be44c8453205309f4c3c3c37ba34'
  );
  assert.equal(
    provenance.source.sha256,
    '9e3e459eca00ba06b496ec80def32941b5b2889918720e3e7aa6ffb811fbe7c6'
  );
  assert.equal(provenance.source.size_bytes, 52_477_898);
  assert.equal(provenance.source.geo_accession, 'GSE132188');
  assert.equal(provenance.public_gene_contract.n_genes, 3_753);
  assert.equal(
    provenance.analysis_contract.preprocessing.analysis_genes,
    2_000
  );
  assert.equal(
    provenance.analysis_contract.velocity.velocity_genes,
    1_037
  );
  assert.equal(
    provenance.warning_contract.scvelo_stochastic_fit.count,
    provenance.analysis_contract.velocity.velocity_genes
  );
  assert.equal(
    provenance.analysis_contract.velocity_graph.nnz,
    503_696
  );
  assert.deepEqual(
    Object.values(provenance.analysis_contract.embeddings).map(
      embedding => embedding.ownership
    ),
    ['derived', 'source', 'derived']
  );

  const input = provenance.input_contract;
  const output = provenance.export_contract;
  assert.deepEqual(output.derived_obs_fields, {
    cell_type: {
      ownership: 'derived convenience alias',
      source_field: 'clusters',
      categories_json_sha256:
        input.digests.clusters_categories_json_sha256,
      codes_i32_sha256:
        input.digests.clusters_codes_i32_sha256,
    },
  });
  const publishedCategoricalLevels = {
    ...input.categorical_levels,
    cell_type:
      input.categorical_levels[
        output.derived_obs_fields.cell_type.source_field
      ],
  };
  assert.equal(
    identity.cellucid_data_version,
    output.cellucid_data_version
  );
  assert.equal(identity.id, provenance.dataset_id);
  assert.equal(identity.name, output.dataset_name);
  assert.equal(identity.description, output.dataset_description);
  assert.equal(identity.created_at, output.artifact_created_at);
  assert.deepEqual(identity.source, SOURCE_EXPECTATIONS.pancreas);
  assert.equal(identity.stats.n_cells, input.n_cells);
  assert.equal(
    identity.stats.n_genes,
    provenance.public_gene_contract.n_genes
  );
  assert.equal(
    identity.stats.n_obs_fields,
    input.obs_fields.length + Object.keys(output.derived_obs_fields).length
  );
  assert.equal(identity.stats.n_categorical_fields, 3);
  assert.equal(identity.stats.n_continuous_fields, 2);
  assert.equal(identity.stats.has_connectivity, true);
  assert.equal(identity.stats.n_edges, 33_476);
  assert.deepEqual(identity.embeddings, {
    available_dimensions: [1, 2, 3],
    default_dimension: 3,
    files: {
      '1d': 'points_1d.bin.gz',
      '2d': 'points_2d.bin.gz',
      '3d': 'points_3d.bin.gz',
    },
  });
  assert.deepEqual(identity.vector_fields, {
    default_field: 'velocity_umap',
    fields: {
      velocity_umap: {
        label: 'velocity_umap',
        basis: 'umap',
        available_dimensions: [1, 2, 3],
        default_dimension: 3,
        files: {
          '1d': 'vectors/velocity_umap_1d.bin.gz',
          '2d': 'vectors/velocity_umap_2d.bin.gz',
          '3d': 'vectors/velocity_umap_3d.bin.gz',
        },
      },
    },
  });
  assert.deepEqual(identity.export_settings, {
    compression: output.compression,
    var_quantization: output.var_quantization,
    obs_continuous_quantization:
      output.obs_continuous_quantization,
    obs_categorical_dtype: output.obs_categorical_dtype,
  });

  assert.equal(obsManifest._format, 'compact_v1');
  assert.equal(obsManifest.n_points, input.n_cells);
  assert.equal(
    obsManifest.centroid_outlier_quantile,
    output.centroid_outlier_quantile
  );
  assert.deepEqual(
    obsManifest._continuousFields.map(field => field[0]),
    input.continuous_fields
  );
  assert.deepEqual(
    obsManifest._categoricalFields.map(field => field[0]),
    Object.keys(publishedCategoricalLevels)
  );
  for (const [key, categories, dtype, missingCode] of
    obsManifest._categoricalFields) {
    assert.deepEqual(categories, publishedCategoricalLevels[key]);
    assert.equal(dtype, 'uint8');
    assert.equal(missingCode, 255);
    const codes = gunzipSync(
      await readFile(new URL(`obs/${key}.codes.u8.gz`, directoryUrl))
    );
    const outliers = gunzipSync(
      await readFile(new URL(`obs/${key}.outliers.u8.gz`, directoryUrl))
    );
    assert.equal(codes.length, input.n_cells);
    assert.equal(outliers.length, input.n_cells);
    for (const code of codes) {
      assert.ok(
        code < categories.length,
        `${key} must contain only declared category codes`
      );
    }
  }
  const clustersField = obsManifest._categoricalFields.find(
    field => field[0] === 'clusters'
  );
  const cellTypeField = obsManifest._categoricalFields.find(
    field => field[0] === 'cell_type'
  );
  assert.ok(clustersField);
  assert.ok(cellTypeField);
  assert.deepEqual(
    ['clusters', ...cellTypeField.slice(1)],
    clustersField,
    'derived cell_type must preserve categories, code width, missing code, '
      + 'centroids, and extrema from clusters'
  );
  assert.equal(
    (
      await readFile(new URL('obs/cell_type.codes.u8.gz', directoryUrl))
    ).compare(
      await readFile(new URL('obs/clusters.codes.u8.gz', directoryUrl))
    ),
    0,
    'derived cell_type codes must be byte-identical to clusters'
  );
  assert.equal(
    (
      await readFile(new URL('obs/cell_type.outliers.u8.gz', directoryUrl))
    ).compare(
      await readFile(new URL('obs/clusters.outliers.u8.gz', directoryUrl))
    ),
    0,
    'derived cell_type outliers must be byte-identical to clusters'
  );
  for (const [key] of obsManifest._continuousFields) {
    const values = gunzipSync(
      await readFile(new URL(`obs/${key}.values.u8.gz`, directoryUrl))
    );
    assert.equal(values.length, input.n_cells);
  }

  assert.equal(varManifest._format, 'compact_v1');
  assert.equal(varManifest.n_points, input.n_cells);
  assert.equal(
    varManifest.fields.length,
    provenance.public_gene_contract.n_genes
  );
  const geneKeys = new Set();
  const portableGeneKeys = new Set();
  const genePayloads = [];
  for (const [key, minimum, maximum] of varManifest.fields) {
    assert.ok(
      typeof key === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(key),
      `gene key ${key} must remain one portable exact identifier`
    );
    assert.ok(
      Number.isFinite(minimum) &&
        Number.isFinite(maximum) &&
        maximum > minimum,
      `${key} must encode one finite nonconstant field`
    );
    assert.equal(geneKeys.has(key), false, `duplicate gene key ${key}`);
    assert.equal(
      portableGeneKeys.has(key.toLowerCase()),
      false,
      `case-insensitive gene-path collision for ${key}`
    );
    geneKeys.add(key);
    portableGeneKeys.add(key.toLowerCase());
    genePayloads.push({
      key,
      url: new URL(`var/${key}.values.u8.gz`, directoryUrl),
    });
  }
  await mapWithConcurrency(
    genePayloads,
    32,
    async ({ key, url }) => {
      const values = gunzipSync(await readFile(url));
      assert.equal(
        values.length,
        input.n_cells,
        `${key} must contain one quantized value per cell`
      );
    }
  );

  for (const dimension of [1, 2, 3]) {
    const relative = `points_${dimension}d.bin.gz`;
    const points = gunzipSync(
      await readFile(new URL(relative, directoryUrl))
    );
    const payloadContract = output.semantic_payloads[relative];
    assert.equal(points.length, input.n_cells * dimension * 4);
    assert.equal(points.length, payloadContract.raw_bytes);
    assert.equal(sha256(points), payloadContract.raw_sha256);
    for (let offset = 0; offset < points.length; offset += 4) {
      const coordinate = points.readFloatLE(offset);
      assert.ok(
        Number.isFinite(coordinate) &&
          coordinate >= -1 &&
          coordinate <= 1,
        `pancreas ${dimension}D coordinate at byte ${offset} must be finite in [-1, 1]`
      );
    }

    const vectorRelative =
      `vectors/velocity_umap_${dimension}d.bin.gz`;
    const vectors = gunzipSync(
      await readFile(new URL(vectorRelative, directoryUrl))
    );
    const vectorContract = output.semantic_payloads[vectorRelative];
    assert.equal(vectors.length, input.n_cells * dimension * 4);
    assert.equal(vectors.length, vectorContract.raw_bytes);
    assert.equal(sha256(vectors), vectorContract.raw_sha256);
    let nonzeroRows = 0;
    for (let row = 0; row < input.n_cells; row++) {
      let rowIsNonzero = false;
      for (let component = 0; component < dimension; component++) {
        const offset = (row * dimension + component) * 4;
        const value = vectors.readFloatLE(offset);
        assert.ok(
          Number.isFinite(value),
          `pancreas ${dimension}D velocity at byte ${offset} must be finite`
        );
        rowIsNonzero ||= value !== 0;
      }
      nonzeroRows += Number(rowIsNonzero);
    }
    assert.equal(nonzeroRows, vectorContract.nonzero_rows);
  }

  const generation = await generationDigest(directoryUrl);
  assert.deepEqual(generation, {
    fileCount: output.expected_file_count,
    totalBytes: output.expected_total_bytes,
    sha256: output.generation_sha256,
  });
  assert.equal(
    await directorySize(directoryUrl),
    output.expected_total_bytes
      + (
        await Promise.all(
          [...PUBLICATION_SIDECAR_NAMES].map(async relative =>
            (await stat(new URL(relative, directoryUrl))).size
          )
        )
      ).reduce((sum, size) => sum + size, 0)
  );
  assert.ok(
    output.expected_total_bytes <= 3 * 1024 * 1024,
    'pancreas prepared generation must remain at most 3 MiB'
  );
});

for (const datasetId of ALL_DATASET_IDS) {
  test(
    `${datasetId} categorical generation uses one explicit exact code width`,
    async () => {
      const directoryUrl = new URL(`${datasetId}/`, EXPORTS_URL);
      const identity = await readJson(
        new URL('dataset_identity.json', directoryUrl)
      );
      const manifest = await readJson(
        new URL('obs_manifest.json', directoryUrl)
      );
      const declaredDtype =
        identity.export_settings?.obs_categorical_dtype;
      assert.ok(
        declaredDtype === 'uint8' || declaredDtype === 'uint16',
        `${datasetId} must declare exactly uint8 or uint16 categorical codes`
      );
      const bytesPerCode = declaredDtype === 'uint8' ? 1 : 2;
      const missingCode = declaredDtype === 'uint8' ? 255 : 65535;
      const extension = declaredDtype === 'uint8' ? 'u8' : 'u16';
      const otherExtension = declaredDtype === 'uint8' ? 'u16' : 'u8';

      assert.ok(
        Array.isArray(manifest._categoricalFields),
        `${datasetId} must publish categorical field metadata`
      );
      assert.equal(
        manifest._categoricalFields.length,
        identity.stats.n_categorical_fields
      );
      for (const field of manifest._categoricalFields) {
        const key = field[0];
        assert.equal(
          field[2],
          declaredDtype,
          `${datasetId}/${key} must use the generation's declared code width`
        );
        assert.equal(
          field[3],
          missingCode,
          `${datasetId}/${key} must use the matching missing code`
        );

        const payloadUrl = new URL(
          `obs/${key}.codes.${extension}.gz`,
          directoryUrl
        );
        const payload = await readFile(payloadUrl);
        assert.ok(
          payload.length >= 18,
          `${datasetId}/${key} code payload must be one complete gzip member`
        );
        assert.equal(
          payload.readUInt32LE(payload.length - 4),
          identity.stats.n_cells * bytesPerCode,
          `${datasetId}/${key} gzip size must match one code per cell`
        );
        await assert.rejects(
          readFile(
            new URL(
              `obs/${key}.codes.${otherExtension}.gz`,
              directoryUrl
            )
          ),
          { code: 'ENOENT' },
          `${datasetId}/${key} must not retain an alternate code-width payload`
        );
      }
    }
  );
}

for (const datasetId of CONNECTIVITY_DATASET_IDS) {
  test(
    `${datasetId} publishes the one mandatory weighted connectivity contract`,
    async () => {
      const directoryUrl = new URL(`${datasetId}/`, EXPORTS_URL);
      const [manifest, identity] = await Promise.all([
        readJson(
          new URL('connectivity_manifest.json', directoryUrl)
        ),
        readJson(new URL('dataset_identity.json', directoryUrl)),
      ]);
      assertExactKeys(
        manifest,
        CONNECTIVITY_REQUIRED_KEYS,
        [],
        `${datasetId}/connectivity_manifest.json`
      );
      assert.equal(manifest.format, 'edge_pairs');
      assert.equal(manifest.compression, 6);
      assert.equal(manifest.weight_dtype, 'float64');
      assert.equal(manifest.weight_bytes, 8);
      assert.equal(
        manifest.weightsPath,
        'connectivity/edges.weights.f64.bin.gz'
      );
      if (UNIT_CONNECTIVITY_DATASET_IDS.has(datasetId)) {
        await assertUnitWeightPayload(
          new URL(manifest.weightsPath, directoryUrl),
          manifest.n_edges,
          `${datasetId}/${manifest.weightsPath}`
        );
      } else {
        await assertPancreasConnectivityPayload(
          directoryUrl,
          manifest,
          identity
        );
      }
    }
  );
}
