import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
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
const GITIGNORE_URL = new URL('../.gitignore', import.meta.url);
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
const UNPINNED_GENERATIONS_URL = new URL(
  '../sources/unpinned-generations.json',
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
  suo: '000063ef8b4617ae58d9275b9c18ac6a38bd950df35c828f2514046a3a210417',
  garcia: 'b246daf96914be1db847bc1dc565a191d1257f48525d2930beb7190a00c247a8',
  he: 'cc88d26764ba24459463e14b90c39c37a16ae55512a0210820476a8352224682',
  kanemaru: '5adb4368b7b0a2d4b892785d6486c125308afd8f632e649f67b648596e0a49ac',
  pancreas: 'a37e0500ecac42ec123dc958f19f5190a8124c6cb2f12125af4e646660b3ec42',
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
const DISTINCT_WEIGHT_SAMPLE_LIMIT = 8;
/**
 * A categorical obs field every cell shares is offered in the colour menu, in
 * the filter panel and in the legend, and every one of them does nothing: the
 * embedding comes back one flat colour, the filter selects all cells or none,
 * the legend prints one row. That is a published colouring that cannot answer a
 * question, and it costs a user a click to find out.
 *
 * It is not, however, a defect on its own, which is why this is a named list
 * and not a rule. Three things make a field constant and only one of them is
 * wrong. Suo's `LVL0` is the worked example of the first: the published Suo is
 * the `Haematopoeitic_lineage` category of a five-category column, so a
 * constant `LVL0` is the evidence that the documented subset held, and a
 * varying one would mean it had not. The second is a source that genuinely
 * carries one value -- a single-organ study publishing `organ`, or a
 * cross-study integration covariate that does not vary inside one study. The
 * third, a column something upstream collapsed, is a defect, and nothing in
 * this repository is in that state today.
 *
 * Every entry below was measured twice: here, against `exports/`, and against
 * the source object the generation was prepared from. `origin: 'source'` means
 * the source AnnData declares and uses exactly this one category over exactly
 * the cells the generation publishes, so nothing was lost on the way out.
 * `origin: 'subset'` means the source carries several and the published
 * generation is one of them; those entries name the published generations that
 * still show the column varying, which is the part of the reason this
 * repository can re-measure.
 *
 * Nothing here can be fixed by deleting a field from `exports/`: republishing a
 * generation is a coordinated change across the writers, the reader and the
 * presets. The list is what makes the cost visible and what fails the moment a
 * new flat colouring is published or an old one starts to carry information.
 */
const CONSTANT_OBS_FIELDS = Object.freeze({
  'garcia/organ': Object.freeze({
    value: 'Gonad',
    cells: 219_731,
    missing: 0,
    origin: 'source',
    reason:
      'E-MTAB-10551 is one gonadal study, and `organ` is the cross-organ '
      + 'covariate of the shared developmental-atlas annotation; the source '
      + 'declares and uses the single category Gonad over all 219,731 cells',
  }),
  'garcia/integration_biological_unit': Object.freeze({
    value: 'Cell',
    cells: 219_731,
    missing: 0,
    origin: 'source',
    reason:
      'whole cells rather than nuclei, which is what every generation in this '
      + 'catalog was sequenced from; the source declares this one category',
  }),
  'garcia/integration_library_platform_coarse': Object.freeze({
    value: '5GEX',
    cells: 219_731,
    missing: 0,
    origin: 'source',
    reason:
      'one 5-prime chemistry across the study; the source declares this one '
      + 'category, and Suo publishes the same column with two',
  }),
  'he/organ': Object.freeze({
    value: 'Lung',
    cells: 71_650,
    missing: 0,
    origin: 'source',
    reason:
      'E-MTAB-11278 is one fetal lung atlas; the source declares and uses the '
      + 'single category Lung over all 71,650 cells',
  }),
  'he/integration_biological_unit': Object.freeze({
    value: 'Cell',
    cells: 71_650,
    missing: 0,
    origin: 'source',
    reason:
      'whole cells rather than nuclei; the source declares this one category',
  }),
  'he/integration_sample_status': Object.freeze({
    value: 'Fresh',
    cells: 71_650,
    missing: 0,
    origin: 'source',
    reason:
      'every sample dissociated fresh; the source declares this one category, '
      + 'and Garcia publishes the same column with Fresh and Frozen',
  }),
  'he/integration_library_platform_coarse': Object.freeze({
    value: '5GEX',
    cells: 71_650,
    missing: 0,
    origin: 'source',
    reason:
      'one 5-prime chemistry across the study; the source declares this one '
      + 'category, and Suo publishes the same column with two',
  }),
  'kanemaru/organ': Object.freeze({
    value: 'Heart',
    cells: 131_636,
    missing: 0,
    origin: 'source',
    reason:
      'E-MTAB-12916 is one cardiac study, and `organ` is the cross-organ '
      + 'covariate of the shared developmental-atlas annotation; the source '
      + 'declares and uses the single category Heart over all 131,636 cells',
  }),
  'suo/integration_biological_unit': Object.freeze({
    value: 'Cell',
    cells: 561_947,
    missing: 0,
    origin: 'source',
    reason:
      'whole cells rather than nuclei; the source declares this one category '
      + 'over all 841,922 of its cells, so the published lineage subset is not '
      + 'what made it constant',
  }),
  'suo/integration_sample_status': Object.freeze({
    value: 'Fresh',
    cells: 561_947,
    missing: 0,
    origin: 'source',
    reason:
      'every sample dissociated fresh; the source declares this one category '
      + 'over all 841,922 of its cells, so the published lineage subset is not '
      + 'what made it constant, and Garcia publishes the same column with two',
  }),
  'suo/LVL0': Object.freeze({
    value: 'Haematopoeitic_lineage',
    cells: 561_947,
    missing: 0,
    origin: 'subset',
    corroboratedBy: Object.freeze(['garcia', 'he']),
    reason:
      'the published Suo is one lineage of a five-lineage source: 561,947 of '
      + 'its 841,922 cells, selected by LVL0 == Haematopoeitic_lineage before '
      + 'anything else runs. A constant LVL0 is the evidence that selection '
      + 'held; an LVL0 that varied would mean it had not',
  }),
});
const CONSTANT_OBS_FIELD_ORIGINS = Object.freeze(['source', 'subset']);
const OBS_FIELD_REQUIRED_KEYS = Object.freeze(['key', 'kind']);
const OBS_FIELD_OPTIONAL_KEYS = Object.freeze(['n_categories']);
/**
 * Every published generation redistributes somebody else's atlas, so every one
 * of them carries a citation; a source record with a name and a URL but no
 * citation is the attribution failure this table exists to keep out.
 *
 * The four human atlases are cited by their ArrayExpress study title and
 * accession and by nothing else. No author, year, journal or DOI appears here,
 * because the repository establishes none of them: the integration outputs under
 * `.anndatas/` carry no bibliographic record, and each
 * `<id>_1_prepare_anndata.ipynb` names only the accession. Filling those fields
 * in is a real improvement and it is welcome, but it has to come from the
 * primary publications, and the export notebook's `source_citation=` argument is
 * where it lands -- `dataset_identity.json` is written by `prepare`, never by
 * hand, so a citation edited into the JSON alone would be gone at the next
 * rebuild.
 */
const SOURCE_EXPECTATIONS = Object.freeze({
  suo: {
    name: 'E-MTAB-11341',
    url: 'https://www.ebi.ac.uk/biostudies/arrayexpress/studies/E-MTAB-11341',
    citation:
      'Mapping the developing human immune system across organs. ArrayExpress study E-MTAB-11341.',
  },
  garcia: {
    name: 'E-MTAB-10551',
    url: 'https://www.ebi.ac.uk/biostudies/arrayexpress/studies/E-MTAB-10551',
    citation:
      'Single-cell roadmap of human gonadal development. ArrayExpress study E-MTAB-10551.',
  },
  he: {
    name: 'E-MTAB-11278',
    url: 'https://www.ebi.ac.uk/biostudies/arrayexpress/studies/E-MTAB-11278',
    citation:
      'A human fetal lung cell atlas uncovers proximal-distal gradients of differentiation and key regulators of epithelial fates. ArrayExpress study E-MTAB-11278.',
  },
  kanemaru: {
    name: 'E-MTAB-12916',
    url: 'https://www.ebi.ac.uk/biostudies/arrayexpress/studies/E-MTAB-12916',
    citation:
      'Spatially resolved multiomics of human cardiac niches. ArrayExpress study E-MTAB-12916.',
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

/**
 * Payload identity. A payload filename is an integer index, or a fixed neutral
 * name that is the same in every generation. It never carries dataset content.
 *
 * A filename that spelled out a gene name or an obs column made the file tree a
 * second, unversioned copy of the manifest, and the two could disagree: the
 * name had to survive a filesystem that lowercases, a URL that percent-encodes,
 * and a checkout on a platform that reserves `CON`, so the set of names a
 * dataset could publish was decided by path rules rather than by the
 * annotation. The manifests already say what every field is. The files are now
 * numbered, and the manifest entry is the only thing that says what a number
 * means.
 */
const CANONICAL_INDEX = /^(?:0|[1-9][0-9]*)$/;
/** Every payload name each axis directory is allowed to hold, by index. */
const INDEXED_PAYLOAD_NAMES = Object.freeze({
  var: /^(?:0|[1-9][0-9]*)\.values\.(?:u8|f32)(?:\.gz)?$/,
  obs: /^(?:0|[1-9][0-9]*)\.(?:values\.(?:u8|f32)|codes\.u(?:8|16)|outliers\.(?:u8|f32))(?:\.gz)?$/,
  vectors: /^(?:0|[1-9][0-9]*)_[123]d\.bin(?:\.gz)?$/,
});
const PAYLOAD_AXES = Object.freeze(['var', 'obs', 'vectors']);
/**
 * The connectivity graph is one edge list per generation, so its three payloads
 * need no name of their own and are given none: every generation publishes the
 * same three bytes-worth of filename, which is what "carries no dataset
 * content" means operationally -- the names are cross-checked for equality
 * across generations below.
 */
const CONNECTIVITY_NEUTRAL_PATHS = Object.freeze({
  sourcesPath: 'connectivity/edges.src.bin.gz',
  destinationsPath: 'connectivity/edges.dst.bin.gz',
  weightsPath: 'connectivity/edges.weights.f64.bin.gz',
});
const CONNECTIVITY_NEUTRAL_FILES = Object.freeze(
  Object.values(CONNECTIVITY_NEUTRAL_PATHS)
    .map(relative => relative.slice('connectivity/'.length))
    .sort()
);
/** The neutral files a generation root holds, beside the axis directories. */
const GENERATION_ROOT_FILES = Object.freeze([
  'connectivity_manifest.json',
  'dataset_identity.json',
  'obs_manifest.json',
  'points_1d.bin.gz',
  'points_2d.bin.gz',
  'points_3d.bin.gz',
  'var_manifest.json',
]);
const GENERATION_DIRECTORIES = Object.freeze([
  'connectivity',
  'obs',
  'var',
  'vectors',
]);
/**
 * The two entry shapes each manifest array is allowed, by whether the payload
 * the entry describes is quantized. A `var` entry and an obs-continuous entry
 * are deliberately the same length, so no reader may infer which kind of field
 * an entry describes from how long it is; the array it was read out of is the
 * only thing that says.
 */
const ENTRY_LENGTHS = Object.freeze({
  var: Object.freeze({ quantized: 4, exact: 2 }),
  obsContinuous: Object.freeze({ quantized: 4, exact: 2 }),
  obsCategorical: Object.freeze({ quantized: 8, exact: 6 }),
});
/**
 * A field name is display text: it is printed in the field selector, the
 * legend, and every exported figure, and it is typed into the gene search box.
 * It is no longer a path segment, so nothing about it has to please a
 * filesystem -- but a name that is blank, padded, or carries control
 * characters is text a reader can neither read nor type back.
 */
const DISPLAY_TEXT_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;


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

/** Substitute one payload path pattern, rejecting a token the axis cannot fill. */
function resolvePayloadPattern(pattern, values, label) {
  assert.equal(
    typeof pattern,
    'string',
    `${label} must declare its payload path as one exact pattern string`
  );
  return pattern.replace(/\{(\w+)\}/g, (whole, token) => {
    const value = values[token];
    assert.notEqual(
      value,
      undefined,
      `${label} substitutes ${whole} into '${pattern}', which this axis does `
        + 'not supply'
    );
    return String(value);
  });
}

/**
 * Every `var` field of one generation, as the manifest describes it: the index
 * that names its payload, the display name a reader sees, its quantized range,
 * and the payload path resolved out of the manifest's own pattern.
 */
function readVarFields(datasetId, manifest) {
  const pattern = manifest._varSchema?.pathPattern;
  return manifest.fields.map((entry, ordinal) => {
    const [index, name, minimum, maximum] = entry;
    return {
      entry,
      ordinal,
      index,
      name,
      minimum,
      maximum,
      path: resolvePayloadPattern(
        pattern,
        { index },
        `${datasetId}/var_manifest.json _varSchema`
      ),
    };
  });
}

function readObsContinuousFields(datasetId, manifest) {
  const pattern = manifest._obsSchemas?.continuous?.pathPattern;
  return manifest._continuousFields.map((entry, ordinal) => {
    const [index, key, minimum, maximum] = entry;
    return {
      entry,
      ordinal,
      index,
      key,
      minimum,
      maximum,
      path: resolvePayloadPattern(
        pattern,
        { index },
        `${datasetId}/obs_manifest.json _obsSchemas.continuous`
      ),
    };
  });
}

/**
 * A quantized payload and the bounds declared beside it are one statement, and
 * the two halves have to agree or the viewer draws one field's values under
 * another field's scale.
 *
 * `minValue` and `maxValue` are the payload's own extremes, so a manifest that
 * declares a range has a cell at each end and the codes must differ. compact_v1's
 * constant case is the complement: equal bounds, and then every code is `0`,
 * which the viewer decodes back to that exact value. A field carrying one value
 * -- a gene a lineage subset left undetected, a column the subset flattened --
 * is publishable and is checked here as the case it is, not as a defect. A
 * payload matching neither shape is what this catches.
 */
function assertPayloadMatchesAdvertisedRange({
  values,
  minimum,
  maximum,
  label,
  manifest,
}) {
  let lowest = values[0];
  let highest = values[0];
  for (const value of values) {
    if (value < lowest) lowest = value;
    if (value > highest) highest = value;
  }
  if (maximum === minimum) {
    assert.equal(
      highest,
      0,
      `${label} advertises the constant ${minimum} in ${manifest}, so every `
        + `code must be 0; the payload carries codes up to ${highest}`
    );
    return;
  }
  assert.ok(
    highest > lowest,
    `${label} quantizes to the single value ${lowest} for every cell while `
      + `${manifest} advertises the range [${minimum}, ${maximum}]`
  );
}

function readObsCategoricalFields(datasetId, manifest, extension) {
  const schema = manifest._obsSchemas?.categorical;
  const label = `${datasetId}/obs_manifest.json _obsSchemas.categorical`;
  return manifest._categoricalFields.map((entry, ordinal) => {
    const [
      index,
      key,
      categories,
      dtype,
      missingCode,
      centroids,
      outlierLow,
      outlierHigh,
    ] = entry;
    const values = { index, ext: extension };
    return {
      entry,
      ordinal,
      index,
      key,
      categories,
      dtype,
      missingCode,
      centroids,
      outlierLow,
      outlierHigh,
      codesPath: resolvePayloadPattern(schema?.codesPathPattern, values, label),
      outliersPath:
        schema?.outlierPathPattern === undefined
          ? null
          : resolvePayloadPattern(schema.outlierPathPattern, values, label),
    };
  });
}

/** The extension the declared categorical code width writes into a filename. */
function categoricalCodeExtension(declaredDtype) {
  return declaredDtype === 'uint8' ? 'u8' : 'u16';
}

/**
 * Every vector field a generation declares, with the integer that names its
 * payloads read back out of the files it points at. A field whose three
 * dimensions do not agree on one integer is reported as `index: null`, which
 * the contract below rejects.
 */
function readVectorFields(identity) {
  const fields = identity.vector_fields?.fields ?? {};
  return Object.entries(fields).map(([label, field]) => {
    const stems = new Set();
    const files = [];
    for (const dimension of field.available_dimensions) {
      const relative = field.files?.[`${dimension}d`];
      files.push(relative);
      const match = /^vectors\/(.+)_[123]d\.bin(?:\.gz)?$/.exec(relative ?? '');
      stems.add(match === null ? null : match[1]);
    }
    const stem = stems.size === 1 ? [...stems][0] : null;
    return {
      label,
      field,
      files,
      stem,
      index: stem !== null && CANONICAL_INDEX.test(stem) ? Number(stem) : null,
    };
  });
}

/** Every file one axis directory holds, or `null` when the directory is absent. */
async function readAxisPayloadNames(directoryUrl, axis) {
  try {
    return (
      await readdir(new URL(`${axis}/`, directoryUrl), { withFileTypes: true })
    )
      .filter(entry => !entry.name.startsWith('.'))
      .map(entry => {
        assert.ok(
          entry.isFile(),
          `${axis}/${entry.name} is not a regular payload file`
        );
        return entry.name;
      })
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The display-text rule. A field name is printed and typed, never resolved as a
 * path, so it must be exactly the characters a reader sees: non-empty, with no
 * surrounding whitespace to make two names look identical, and no control
 * characters a legend cannot render.
 */
function assertDisplayText(value, label) {
  assert.equal(
    typeof value,
    'string',
    `${label} must be one exact string, because it is what the field selector `
      + 'and every exported figure print'
  );
  assert.ok(value.length > 0, `${label} must not be blank`);
  assert.equal(
    value,
    value.trim(),
    `${label} is padded with whitespace the legend prints and nobody can type`
  );
  assert.doesNotMatch(
    value,
    DISPLAY_TEXT_CONTROL_CHARACTERS,
    `${label} carries control characters, so it is not display text`
  );
}

/**
 * Stream one gzipped Float64 weight column and report what it actually
 * contains. The atlases publish tens of millions of edges, so the payload is
 * summarised as it decompresses instead of being materialised: `min`/`max` are
 * exact over every value, and `distinct` keeps at most
 * `DISTINCT_WEIGHT_SAMPLE_LIMIT` observed values so a failure can name them.
 */
async function measureWeightColumn(url) {
  const stream = createReadStream(url).pipe(createGunzip());
  const distinct = new Set();
  let carry = Buffer.alloc(0);
  let byteLength = 0;
  let count = 0;
  let min = Infinity;
  let max = -Infinity;
  let nonFinite = 0;
  let nonPositive = 0;
  for await (const chunk of stream) {
    byteLength += chunk.length;
    const buffer =
      carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
    const usable = buffer.length - (buffer.length % 8);
    for (let offset = 0; offset < usable; offset += 8) {
      const weight = buffer.readDoubleLE(offset);
      count += 1;
      if (Number.isFinite(weight)) {
        if (weight < min) min = weight;
        if (weight > max) max = weight;
      } else {
        nonFinite += 1;
      }
      if (!(weight > 0)) {
        nonPositive += 1;
      }
      if (distinct.size < DISTINCT_WEIGHT_SAMPLE_LIMIT) {
        distinct.add(weight);
      }
    }
    carry = Buffer.from(buffer.subarray(usable));
  }
  return Object.freeze({
    byteLength,
    count,
    distinct: Object.freeze([...distinct]),
    max,
    min,
    nonFinite,
    nonPositive,
    trailingBytes: carry.length,
    varies: min < max,
  });
}

const weightColumnMeasurements = new Map();

function measureWeightColumnOnce(url) {
  const cached = weightColumnMeasurements.get(url.href);
  if (cached) {
    return cached;
  }
  const measurement = measureWeightColumn(url);
  weightColumnMeasurements.set(url.href, measurement);
  return measurement;
}

/**
 * The categorical obs fields of one generation that every cell shares, read out
 * of the code payloads rather than inferred from the declared category count,
 * so a field whose categories outnumber the codes actually written is measured
 * as what it renders as. One payload is decompressed at a time; the widest is
 * one byte per cell.
 */
async function measureConstantCategoricalFields(datasetId) {
  const directoryUrl = new URL(`${datasetId}/`, EXPORTS_URL);
  const identity = PUBLISHED_IDENTITIES.get(datasetId);
  const manifest = await readJson(
    new URL('obs_manifest.json', directoryUrl)
  );
  const declaredDtype = identity.export_settings?.obs_categorical_dtype;
  assert.ok(
    declaredDtype === 'uint8' || declaredDtype === 'uint16',
    `${datasetId} must declare exactly uint8 or uint16 categorical codes`
  );
  const bytesPerCode = declaredDtype === 'uint8' ? 1 : 2;
  const missingCode = declaredDtype === 'uint8' ? 255 : 65535;
  const extension = categoricalCodeExtension(declaredDtype);
  const constant = new Map();
  for (const { key, categories, codesPath } of readObsCategoricalFields(
    datasetId,
    manifest,
    extension
  )) {
    const codes = gunzipSync(await readFile(new URL(codesPath, directoryUrl)));
    const used = new Set();
    let missing = 0;
    for (let cell = 0; cell < identity.stats.n_cells; cell++) {
      const code =
        bytesPerCode === 1 ? codes[cell] : codes.readUInt16LE(cell * 2);
      if (code === missingCode) {
        missing += 1;
        continue;
      }
      used.add(code);
    }
    if (used.size > 1) {
      continue;
    }
    constant.set(
      key,
      Object.freeze({
        cells: identity.stats.n_cells,
        declaredCategories: categories.length,
        missing,
        value: used.size === 1 ? categories[[...used][0]] : null,
      })
    );
  }
  return constant;
}

const constantFieldMeasurements = new Map();

function measureConstantCategoricalFieldsOnce(datasetId) {
  const cached = constantFieldMeasurements.get(datasetId);
  if (cached) {
    return cached;
  }
  const measurement = measureConstantCategoricalFields(datasetId);
  constantFieldMeasurements.set(datasetId, measurement);
  return measurement;
}

function recordedConstantFieldKeys(datasetId) {
  return Object.keys(CONSTANT_OBS_FIELDS)
    .filter(label => label.startsWith(`${datasetId}/`))
    .map(label => label.slice(datasetId.length + 1))
    .sort();
}

/**
 * Whether this directory entry is part of the published generation.
 *
 * A published generation contains no dot-prefixed entry. The ones that turn up
 * in a working tree are local tool metadata that never reaches the published
 * repository — Finder's `.DS_Store`, the exporter's `.<id>.cellucid.lock` — and
 * measuring them made one unchanged generation weigh 6,148 bytes more on a
 * maintainer's laptop than in CI. A pin whose value depends on who last opened
 * the folder teaches everyone to disregard it.
 *
 * `no published generation carries a dot-prefixed file` asserts against the
 * committed tree that this only ever skips such metadata.
 */
function isPublishedEntry(entry) {
  return !entry.name.startsWith('.');
}

async function directorySize(url) {
  const sizes = await Promise.all(
    (await readdir(url, { withFileTypes: true }))
      .filter(isPublishedEntry)
      .map(async entry => {
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
      if (!isPublishedEntry(entry)) continue;
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

/**
 * Read the edge pairs themselves. A `n_edges` that agrees with the payload
 * length says nothing about what the payload holds, so every edge is checked
 * for canonical `source < destination` order, strict lexicographic ordering,
 * an in-range destination, and a degree distribution whose maximum is the
 * declared `max_neighbors`. The weight column is contracted separately, by the
 * weight-content tests below.
 */
async function assertConnectivityEdgePayload(
  datasetId,
  directoryUrl,
  manifest,
  identity
) {
  const [sources, destinations] = await Promise.all([
    readFile(new URL(manifest.sourcesPath, directoryUrl)).then(gunzipSync),
    readFile(new URL(manifest.destinationsPath, directoryUrl)).then(gunzipSync),
  ]);
  assert.equal(sources.length, manifest.n_edges * manifest.index_bytes);
  assert.equal(
    destinations.length,
    manifest.n_edges * manifest.index_bytes
  );
  const readIndex =
    manifest.index_bytes === 2
      ? (buffer, index) => buffer.readUInt16LE(index * 2)
      : (buffer, index) => buffer.readUInt32LE(index * 4);

  const degrees = new Uint32Array(identity.stats.n_cells);
  let previousSource = -1;
  let previousDestination = -1;
  for (let index = 0; index < manifest.n_edges; index++) {
    const source = readIndex(sources, index);
    const destination = readIndex(destinations, index);
    assert.ok(
      source < destination,
      `${datasetId} edge ${index} must use canonical source < destination order`
    );
    assert.ok(
      source > previousSource ||
        (source === previousSource &&
          destination > previousDestination),
      `${datasetId} edge ${index} must be strictly lexicographically ordered`
    );
    assert.ok(
      destination < identity.stats.n_cells,
      `${datasetId} edge ${index} must reference an existing cell`
    );
    degrees[source] += 1;
    degrees[destination] += 1;
    previousSource = source;
    previousDestination = destination;
  }
  let maximumDegree = 0;
  for (const degree of degrees) {
    if (degree > maximumDegree) maximumDegree = degree;
  }
  assert.equal(
    maximumDegree,
    manifest.max_neighbors,
    `${datasetId} max_neighbors must equal the maximum derived undirected degree`
  );
}

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

const catalog = await readJson(CATALOG_URL);

/**
 * Every prepared generation committed to `exports/`, whether or not
 * `datasets.json` advertises it yet, selected by the shared rule above so this
 * sweep and the state-artifact sweep in `session-presets-contract.test.mjs`
 * cannot disagree about which directories are published. Discovery is asserted
 * against the catalog below so an empty or shrinking sweep fails instead of
 * passing vacuously.
 */
const PUBLISHED_DATASET_IDS = Object.freeze(
  publishedGenerationNames(
    await readdir(EXPORTS_URL, { withFileTypes: true }),
    await readFile(GITIGNORE_URL, 'utf8')
  )
);
const PUBLISHED_IDENTITIES = new Map(
  await Promise.all(
    PUBLISHED_DATASET_IDS.map(async datasetId => [
      datasetId,
      await readJson(
        new URL(`${datasetId}/dataset_identity.json`, EXPORTS_URL)
      ),
    ])
  )
);
const PUBLISHED_CONNECTIVITY_DATASET_IDS = Object.freeze(
  PUBLISHED_DATASET_IDS.filter(
    datasetId =>
      PUBLISHED_IDENTITIES.get(datasetId).stats?.has_connectivity === true
  )
);

test('the payload/bounds agreement check reads both compact_v1 range cases', () => {
  // No generation published today carries a constant continuous field, so the
  // constant branch has no artifact to measure and is asserted here instead.
  // A generation that does carry one must still be checked rather than waved
  // through, and a payload contradicting its bounds must still fail in either
  // direction.
  assertPayloadMatchesAdvertisedRange({
    values: Uint8Array.of(0, 0, 0),
    minimum: 2.5,
    maximum: 2.5,
    label: 'constant field',
    manifest: 'var_manifest.json',
  });
  assert.throws(
    () => assertPayloadMatchesAdvertisedRange({
      values: Uint8Array.of(0, 7, 0),
      minimum: 2.5,
      maximum: 2.5,
      label: 'constant field',
      manifest: 'var_manifest.json',
    }),
    /every code must be 0/
  );
  assertPayloadMatchesAdvertisedRange({
    values: Uint8Array.of(0, 128, 254),
    minimum: 0,
    maximum: 9,
    label: 'varying field',
    manifest: 'var_manifest.json',
  });
  assert.throws(
    () => assertPayloadMatchesAdvertisedRange({
      values: Uint8Array.of(3, 3, 3),
      minimum: 0,
      maximum: 9,
      label: 'varying field',
      manifest: 'var_manifest.json',
    }),
    /single value 3/
  );
});

test('every prepared generation in exports/ is swept for payload content', () => {
  for (const datasetId of EXPECTED_DATASET_IDS) {
    assert.ok(
      PUBLISHED_DATASET_IDS.includes(datasetId),
      `catalogued dataset '${datasetId}' has no prepared generation in exports/`
    );
  }
  for (const datasetId of CONNECTIVITY_DATASET_IDS) {
    assert.ok(
      PUBLISHED_CONNECTIVITY_DATASET_IDS.includes(datasetId),
      `'${datasetId}' must declare its connectivity graph in dataset_identity.json`
    );
  }
  assert.ok(
    PUBLISHED_CONNECTIVITY_DATASET_IDS.length >=
      CONNECTIVITY_DATASET_IDS.length,
    'the connectivity sweep must cover at least every catalogued dataset'
  );
});

test('no published generation carries a dot-prefixed file', async () => {
  // The companion to the exclusion in `generationDigest()`. That walk skips
  // dot-prefixed entries so local tool metadata cannot change what a generation
  // measures; this asserts the exclusion is only ever skipping such metadata,
  // by asking git what the repository actually publishes rather than looking at
  // the working tree the exclusion exists to tolerate.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const tracked = await promisify(execFile)(
    'git',
    ['ls-files', '-z', '--', 'exports'],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), maxBuffer: 64 << 20 }
  ).then(
    result => result.stdout.split('\0').filter(line => line.length > 0),
    cause => {
      assert.fail(
        'this check asks git which files the repository publishes, and git '
          + `could not answer here: ${cause.message}`
      );
    }
  );
  assert.ok(
    tracked.length > 0,
    'git reported no published files under exports/, so this check compared '
      + 'nothing'
  );
  const dotted = tracked.filter(relative =>
    relative.split('/').some(segment => segment.startsWith('.'))
  );
  assert.deepEqual(
    dotted,
    [],
    'a published generation now carries a dot-prefixed file, which '
      + 'generationDigest() skips as local tool metadata. Its bytes are '
      + 'therefore in no pin. Either it does not belong in exports/, or the '
      + 'exclusion has to learn the difference'
  );
});

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
          '20769ea20075a212811e080392aec08edc1e7209c65a97be4640927f2677a87c',
      },
      'custom dataset'
    ),
    /must appear together/
  );
});

test('sample datasets.json has one exact catalog of the published datasets', () => {
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
    'datasets.json must advertise exactly the published sample datasets'
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
    // Stated separately from the table above so that a generation added later
    // cannot ship uncited merely by being added to both sides at once.
    assert.equal(
      typeof identity.source?.citation,
      'string',
      `${expectedId} redistributes a published atlas, so its source record must `
        + 'carry a citation; name and url alone credit an archive and not the study'
    );
    assert.ok(
      identity.source.citation.trim().length > 0,
      `${expectedId} source citation must say something`
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
      // Repinned deliberately, twice now: first when the producer gained its
      // manifest read-back check, then when it gained the surrogate and
      // float32-underflow refusals. Each time verified output-neutral rather
      // than assumed - a full rebuild against the new producer reproduced
      // generation_sha256 89c6b684... exactly, and all 3,774 artifacts
      // compared byte-identical to the published generation. Any change under
      // cellucid-python/src/cellucid/ lands here, so run this suite after one.
      // This pin is the second of two on purpose - moving sources/pancreas.json
      // alone must fail here, so a repin cannot happen silently.
      sourceTree:
        '977d07007990a34da3bb5534cc78e8e5a0c5b13ff4211def6630d79fe25a6cf7',
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
          '1d': 'vectors/0_1d.bin.gz',
          '2d': 'vectors/0_2d.bin.gz',
          '3d': 'vectors/0_3d.bin.gz',
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
  const pancreasContinuous = readObsContinuousFields('pancreas', obsManifest);
  const pancreasCategorical = readObsCategoricalFields(
    'pancreas',
    obsManifest,
    categoricalCodeExtension(output.obs_categorical_dtype)
  );
  assert.deepEqual(
    pancreasContinuous.map(field => field.key),
    input.continuous_fields
  );
  assert.deepEqual(
    pancreasCategorical.map(field => field.key),
    Object.keys(publishedCategoricalLevels)
  );
  for (const field of pancreasCategorical) {
    const { key, categories, dtype, missingCode } = field;
    assert.deepEqual(categories, publishedCategoricalLevels[key]);
    assert.equal(dtype, 'uint8');
    assert.equal(missingCode, 255);
    const codes = gunzipSync(
      await readFile(new URL(field.codesPath, directoryUrl))
    );
    const outliers = gunzipSync(
      await readFile(new URL(field.outliersPath, directoryUrl))
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
  const clustersField = pancreasCategorical.find(
    field => field.key === 'clusters'
  );
  const cellTypeField = pancreasCategorical.find(
    field => field.key === 'cell_type'
  );
  assert.ok(clustersField);
  assert.ok(cellTypeField);
  assert.deepEqual(
    [
      clustersField.categories,
      clustersField.dtype,
      clustersField.missingCode,
      clustersField.centroids,
      clustersField.outlierLow,
      clustersField.outlierHigh,
    ],
    [
      cellTypeField.categories,
      cellTypeField.dtype,
      cellTypeField.missingCode,
      cellTypeField.centroids,
      cellTypeField.outlierLow,
      cellTypeField.outlierHigh,
    ],
    'derived cell_type must preserve categories, code width, missing code, '
      + 'centroids, and extrema from clusters'
  );
  assert.equal(
    (
      await readFile(new URL(cellTypeField.codesPath, directoryUrl))
    ).compare(
      await readFile(new URL(clustersField.codesPath, directoryUrl))
    ),
    0,
    'derived cell_type codes must be byte-identical to clusters'
  );
  assert.equal(
    (
      await readFile(new URL(cellTypeField.outliersPath, directoryUrl))
    ).compare(
      await readFile(new URL(clustersField.outliersPath, directoryUrl))
    ),
    0,
    'derived cell_type outliers must be byte-identical to clusters'
  );
  for (const field of pancreasContinuous) {
    const values = gunzipSync(
      await readFile(new URL(field.path, directoryUrl))
    );
    assert.equal(values.length, input.n_cells);
  }

  assert.equal(varManifest._format, 'compact_v1');
  assert.equal(varManifest.n_points, input.n_cells);
  assert.equal(
    varManifest.fields.length,
    provenance.public_gene_contract.n_genes
  );
  const geneNames = new Set();
  const genePayloads = readVarFields('pancreas', varManifest);
  for (const { name, minimum, maximum } of genePayloads) {
    assertDisplayText(name, `pancreas gene name '${name}'`);
    assert.ok(
      Number.isFinite(minimum) &&
        Number.isFinite(maximum) &&
        maximum >= minimum,
      `${name} must encode one finite range`
    );
    assert.equal(geneNames.has(name), false, `duplicate gene name ${name}`);
    geneNames.add(name);
  }
  await mapWithConcurrency(
    genePayloads,
    32,
    async ({ name, minimum, maximum, path: relative }) => {
      const values = gunzipSync(
        await readFile(new URL(relative, directoryUrl))
      );
      assert.equal(
        values.length,
        input.n_cells,
        `${name} must contain one quantized value per cell`
      );
      assertPayloadMatchesAdvertisedRange({
        values,
        minimum,
        maximum,
        label: `pancreas gene ${name}`,
        manifest: 'var_manifest.json',
      });
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

    // The one vector field is payload index 0, and its filename is that index
    // rather than its obsm key: identity.vector_fields is what names the field.
    const vectorRelative = `vectors/0_${dimension}d.bin.gz`;
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

/**
 * Pancreas is the only generation this repository can rebuild and check. Its
 * source is pinned by digest, its producer by the SHA-256 of every module the
 * export path executes, its environment by a hashed lock file, and the
 * directory it must emit by the digest measured above, so a rebuild that
 * differed anywhere would fail loudly.
 *
 * The other four have none of that. Their notebooks assert no version, hash no
 * input and hash no output, so a rebuild that quietly produced different bytes
 * would satisfy every check they make. `sources/unpinned-generations.json` is
 * not a substitute for the missing pin and does not claim to be: it records
 * what can be read off artifacts already committed here, and this test keeps
 * those readings true. It catches a published generation changing under the
 * repository, and it ties each one to the notebook run its committed output
 * describes. It cannot catch producer drift, which needs the pin these four do
 * not have.
 */
test('the unpinned generations still match everything recorded about them', async () => {
  const record = await readJson(UNPINNED_GENERATIONS_URL);
  const pancreas = await readJson(PANCREAS_PROVENANCE_URL);
  const unpinnedIds = PUBLISHED_DATASET_IDS.filter(
    datasetId => datasetId !== pancreas.dataset_id
  );
  assert.deepEqual(
    Object.keys(record.generations).sort(),
    unpinnedIds,
    'sources/unpinned-generations.json must cover every published generation '
      + 'sources/pancreas.json does not pin, and no other: a dataset in '
      + 'neither file carries no reproducibility record at all, and one in '
      + 'both is being described as pinned and unpinned at once'
  );
  for (const statement of ['recorded', 'not_proved', 'not_recoverable']) {
    assert.ok(
      Array.isArray(record[statement]) && record[statement].length > 0,
      `sources/unpinned-generations.json must keep its '${statement}' `
        + 'statement, which is what stops the digests below reading as a '
        + 'reproducibility guarantee they are not'
    );
  }

  for (const datasetId of unpinnedIds) {
    const entry = record.generations[datasetId];
    const directoryUrl = new URL(`${datasetId}/`, EXPORTS_URL);
    assert.deepEqual(
      await generationDigest(directoryUrl),
      {
        fileCount: entry.observed.file_count,
        totalBytes: entry.observed.total_bytes,
        sha256: entry.observed.generation_sha256,
      },
      `exports/${datasetId}/ no longer matches the bytes recorded for it. `
        + 'Either the generation was republished, in which case re-record it '
        + 'and say what produced the new one, or it changed without anyone '
        + 'republishing it, which is corruption'
    );
    assert.equal(
      entry.producer.cellucid_data_version,
      PUBLISHED_IDENTITIES.get(datasetId).cellucid_data_version,
      `the producer version recorded for ${datasetId} is not the one `
        + `exports/${datasetId}/dataset_identity.json states, so the record is `
        + 'attributing the generation to a version that did not write it'
    );
    assert.equal(
      entry.observed.file_count,
      entry.notebook_reported_file_count,
      `exports/${datasetId}/ holds a different number of files than the `
        + 'committed output of the notebook this record attributes it to, so '
        + 'the two are no longer describing one run'
    );
    for (const relative of entry.notebooks) {
      assert.ok(
        (await lstat(new URL(`../${relative}`, import.meta.url))).isFile(),
        `sources/unpinned-generations.json names ${relative}, which is not a `
          + 'file, so the recipe it credits for this generation is gone'
      );
    }
  }
});

/**
 * The Pancreas builder attributes the published generation to one exact
 * producer source tree. That claim was carried as an aggregate digest plus a
 * short list of interesting files, and nothing measured either against the
 * producer repository: the list went on naming `src/cellucid/prepare_data.py`
 * for three commits after that file became a package directory, and the only
 * thing that ever noticed was a build nobody runs between releases. The
 * manifest is now one explicit path list, and these two tests read it -- the
 * first everywhere, the second wherever the producer repository is checked out
 * beside this one -- so a pinned path that stops resolving fails in the suite
 * a maintainer already runs.
 */
const PRODUCER_MODULE_PATH = /^src\/cellucid\/(?:[A-Za-z0-9_]+\/)*[A-Za-z0-9_]+\.py$/;
const PRODUCER_REPOSITORY_URL = new URL(
  '../../cellucid-python/',
  import.meta.url
);

test('the pinned producer manifest agrees with the files it enumerates', async () => {
  const provenance = await readJson(PANCREAS_PROVENANCE_URL);
  const producer = provenance.build_environment.cellucid_producer;
  const sourceFiles = producer.source_files;

  assert.ok(
    Array.isArray(sourceFiles) && sourceFiles.length > 0,
    'the producer manifest must enumerate the pinned modules by path, because '
      + 'a directory pattern lets a removed file leave the pin without a trace'
  );
  const paths = sourceFiles.map((entry) => entry.path);
  assert.deepEqual(
    paths,
    [...paths].sort(),
    'producer source_files must hold the LC_ALL=C path order the recorded '
      + 'manifest digest is computed in'
  );
  assert.equal(
    new Set(paths).size,
    paths.length,
    'producer source_files must name each path once'
  );
  for (const relative of paths) {
    assert.match(
      relative,
      PRODUCER_MODULE_PATH,
      'every pinned producer path must be one repository-relative Python '
        + 'module below src/cellucid'
    );
  }
  assert.ok(
    paths.includes('src/cellucid/prepare_data/__init__.py'),
    'the pin must reach the writer package that emits the export'
  );

  // The aggregate is what the builder compares, and the per-file list is what
  // a reader inspects. Recomputing one from the other is what stops a hand
  // edit to a single hash from leaving the two disagreeing in silence.
  const manifest = sourceFiles
    .map((entry) => `${entry.sha256}  ${entry.path}\n`)
    .join('');
  assert.equal(
    sha256(Buffer.from(manifest, 'utf8')),
    producer.source_tree_manifest_sha256,
    'the recorded producer manifest digest must be the digest of exactly the '
      + 'source_files list beneath it'
  );
});

test(
  'every pinned producer file exists and hashes to its pinned value',
  async (t) => {
    let producerRoot;
    try {
      producerRoot = await stat(PRODUCER_REPOSITORY_URL);
    } catch {
      producerRoot = null;
    }
    if (producerRoot === null || !producerRoot.isDirectory()) {
      t.skip(
        'the cellucid-python producer repository is not checked out beside '
          + 'this one, so the pinned paths cannot be read here'
      );
      return;
    }

    const provenance = await readJson(PANCREAS_PROVENANCE_URL);
    const producer = provenance.build_environment.cellucid_producer;
    const missing = [];
    const differing = [];
    for (const entry of producer.source_files) {
      const fileUrl = new URL(entry.path, PRODUCER_REPOSITORY_URL);
      let metadata;
      try {
        metadata = await lstat(fileUrl);
      } catch {
        missing.push(entry.path);
        continue;
      }
      if (!metadata.isFile()) {
        missing.push(entry.path);
        continue;
      }
      if (sha256(await readFile(fileUrl)) !== entry.sha256) {
        differing.push(entry.path);
      }
    }

    assert.deepEqual(
      missing,
      [],
      'sources/pancreas.json pins producer paths the producer repository no '
        + 'longer has, so the Pancreas generation is attributed to code that '
        + 'cannot be read'
    );
    assert.deepEqual(
      differing,
      [],
      'the pinned producer files changed, so the published Pancreas generation '
        + 'was not produced by the code sources/pancreas.json records; rebuild '
        + 'the generation or repin the manifest deliberately'
    );
  }
);

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
      const extension = categoricalCodeExtension(declaredDtype);
      const otherExtension = declaredDtype === 'uint8' ? 'u16' : 'u8';

      assert.ok(
        Array.isArray(manifest._categoricalFields),
        `${datasetId} must publish categorical field metadata`
      );
      assert.equal(
        manifest._categoricalFields.length,
        identity.stats.n_categorical_fields
      );
      for (const field of readObsCategoricalFields(
        datasetId,
        manifest,
        extension
      )) {
        const { key, categories } = field;
        assert.equal(
          field.dtype,
          declaredDtype,
          `${datasetId}/${key} must use the generation's declared code width`
        );
        assert.equal(
          field.missingCode,
          missingCode,
          `${datasetId}/${key} must use the matching missing code`
        );
        assert.ok(
          Array.isArray(categories) && categories.length > 0,
          `${datasetId}/${key} must declare at least one category`
        );
        const uniqueCategories = new Set();
        for (const category of categories) {
          assert.ok(
            typeof category === 'string' && category.length > 0,
            `${datasetId}/${key} must label every category with one exact `
              + 'non-empty string'
          );
          assert.equal(
            uniqueCategories.has(category),
            false,
            `${datasetId}/${key} repeats the category '${category}'`
          );
          uniqueCategories.add(category);
        }
        assert.deepEqual(
          categories.filter(category => category !== category.trim()),
          [],
          `${datasetId}/${key} publishes category labels with surrounding `
            + 'whitespace, which the legend prints and nobody can type'
        );

        const payloadUrl = new URL(field.codesPath, directoryUrl);
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
              field.codesPath.replace(
                `.codes.${extension}.`,
                `.codes.${otherExtension}.`
              ),
              directoryUrl
            )
          ),
          { code: 'ENOENT' },
          `${datasetId}/${key} must not retain an alternate code-width payload`
        );

        const codes = gunzipSync(payload);
        assert.equal(
          codes.length,
          identity.stats.n_cells * bytesPerCode,
          `${datasetId}/${key} must decompress to one code per cell`
        );
        const usedCodes = new Uint8Array(categories.length);
        let missingCells = 0;
        for (let cell = 0; cell < identity.stats.n_cells; cell++) {
          const code =
            bytesPerCode === 1
              ? codes[cell]
              : codes.readUInt16LE(cell * 2);
          if (code === missingCode) {
            missingCells += 1;
            continue;
          }
          assert.ok(
            code < categories.length,
            `${datasetId}/${key} must contain only declared category codes`
          );
          usedCodes[code] = 1;
        }
        assert.ok(
          missingCells < identity.stats.n_cells,
          `${datasetId}/${key} is missing for every cell, so the published `
            + 'field carries no information; drop it from the generation'
        );
        assert.deepEqual(
          categories.filter((_, code) => usedCodes[code] === 0),
          [],
          `${datasetId}/${key} declares categories that no cell uses; a `
            + 'category nothing is coded to is dead weight in the legend'
        );
      }
    }
  );
}

for (const datasetId of PUBLISHED_DATASET_IDS) {
  test(
    `${datasetId} advertises obs fields that exist and vary`,
    async () => {
      const directoryUrl = new URL(`${datasetId}/`, EXPORTS_URL);
      const identity = PUBLISHED_IDENTITIES.get(datasetId);
      const manifest = await readJson(
        new URL('obs_manifest.json', directoryUrl)
      );
      assert.ok(
        Array.isArray(identity.obs_fields) &&
          identity.obs_fields.length > 0,
        `${datasetId} must advertise a non-empty obs field list`
      );
      assert.equal(
        identity.obs_fields.length,
        identity.stats.n_obs_fields,
        `${datasetId} must advertise exactly the obs fields it counts`
      );
      assert.equal(
        manifest.n_points,
        identity.stats.n_cells,
        `${datasetId} obs manifest and identity must describe one cell count`
      );

      const advertised = new Map();
      for (const [index, field] of identity.obs_fields.entries()) {
        const label = `${datasetId}/dataset_identity.json obs_fields[${index}]`;
        assertExactKeys(
          field,
          OBS_FIELD_REQUIRED_KEYS,
          OBS_FIELD_OPTIONAL_KEYS,
          label
        );
        assert.ok(
          typeof field.key === 'string' && field.key.length > 0,
          `${label}.key must be a non-empty string`
        );
        assert.ok(
          field.kind === 'category' || field.kind === 'continuous',
          `${label}.kind must be exactly 'category' or 'continuous'`
        );
        assert.equal(
          Object.hasOwn(field, 'n_categories'),
          field.kind === 'category',
          `${label} must declare n_categories exactly for category fields`
        );
        assert.equal(
          advertised.has(field.key),
          false,
          `${datasetId} advertises the obs field '${field.key}' twice`
        );
        advertised.set(field.key, field);
      }

      assert.equal(
        manifest._categoricalFields.length,
        identity.stats.n_categorical_fields,
        `${datasetId} must publish exactly the categorical fields it counts`
      );
      assert.equal(
        manifest._continuousFields.length,
        identity.stats.n_continuous_fields,
        `${datasetId} must publish exactly the continuous fields it counts`
      );
      const categoricalFields = readObsCategoricalFields(
        datasetId,
        manifest,
        categoricalCodeExtension(identity.export_settings?.obs_categorical_dtype)
      );
      const continuousFields = readObsContinuousFields(datasetId, manifest);
      assert.deepEqual(
        [...advertised.keys()].sort(),
        [
          ...categoricalFields.map(field => field.key),
          ...continuousFields.map(field => field.key),
        ].sort(),
        `${datasetId} must advertise exactly the obs fields it publishes`
      );
      for (const { key, categories } of categoricalFields) {
        assert.equal(
          advertised.get(key).kind,
          'category',
          `${datasetId}/${key} is published as a category`
        );
        assert.equal(
          advertised.get(key).n_categories,
          categories.length,
          `${datasetId}/${key} must advertise its published category count`
        );
      }

      for (const { key, minimum, maximum, path: relative } of continuousFields) {
        assert.equal(
          advertised.get(key).kind,
          'continuous',
          `${datasetId}/${key} is published as a continuous field`
        );
        assert.ok(
          Number.isFinite(minimum) &&
            Number.isFinite(maximum) &&
            maximum >= minimum,
          `${datasetId}/${key} must encode one finite range`
        );
        const values = gunzipSync(
          await readFile(new URL(relative, directoryUrl))
        );
        assert.equal(
          values.length,
          identity.stats.n_cells,
          `${datasetId}/${key} must contain one quantized value per cell`
        );
        assertPayloadMatchesAdvertisedRange({
          values,
          minimum,
          maximum,
          label: `${datasetId}/${key}`,
          manifest: 'obs_manifest.json',
        });
      }
    }
  );

  test(
    `${datasetId} embeddings resolve to coordinates that span every axis`,
    async () => {
      const directoryUrl = new URL(`${datasetId}/`, EXPORTS_URL);
      const identity = PUBLISHED_IDENTITIES.get(datasetId);
      const embeddings = identity.embeddings;
      assert.ok(
        Array.isArray(embeddings.available_dimensions) &&
          embeddings.available_dimensions.length > 0,
        `${datasetId} must advertise at least one embedding dimension`
      );
      assert.ok(
        embeddings.available_dimensions.includes(
          embeddings.default_dimension
        ),
        `${datasetId} default_dimension must be one advertised dimension`
      );
      assert.deepEqual(
        Object.keys(embeddings.files).sort(),
        embeddings.available_dimensions
          .map(dimension => `${dimension}d`)
          .sort(),
        `${datasetId} must publish one point payload per advertised dimension`
      );

      for (const dimension of embeddings.available_dimensions) {
        const relative = embeddings.files[`${dimension}d`];
        const points = gunzipSync(
          await readFile(new URL(relative, directoryUrl))
        );
        assert.equal(
          points.length,
          identity.stats.n_cells * dimension * 4,
          `${datasetId}/${relative} must contain one Float32 per axis per cell`
        );
        const lowest = new Array(dimension).fill(Infinity);
        const highest = new Array(dimension).fill(-Infinity);
        for (let offset = 0; offset < points.length; offset += 4) {
          const coordinate = points.readFloatLE(offset);
          assert.ok(
            Number.isFinite(coordinate) &&
              coordinate >= -1 &&
              coordinate <= 1,
            `${datasetId}/${relative} coordinate at byte ${offset} must be `
              + 'finite in [-1, 1]'
          );
          const axis = (offset / 4) % dimension;
          if (coordinate < lowest[axis]) lowest[axis] = coordinate;
          if (coordinate > highest[axis]) highest[axis] = coordinate;
        }
        for (let axis = 0; axis < dimension; axis++) {
          assert.ok(
            highest[axis] > lowest[axis],
            `${datasetId}/${relative} collapses axis ${axis} onto the single `
              + `coordinate ${lowest[axis]}, so the cell count matches while `
              + 'the embedding shows nothing'
          );
        }
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
      assert.equal(
        manifest.n_edges,
        identity.stats.n_edges,
        `${datasetId} connectivity manifest and identity must declare one edge count`
      );
      assert.equal(
        manifest.n_cells,
        identity.stats.n_cells,
        `${datasetId} connectivity manifest and identity must declare one cell count`
      );
    }
  );
}

for (const datasetId of PUBLISHED_CONNECTIVITY_DATASET_IDS) {
  test(
    `${datasetId} connectivity edges reference real cells in canonical order`,
    async () => {
      const directoryUrl = new URL(`${datasetId}/`, EXPORTS_URL);
      const manifest = await readJson(
        new URL('connectivity_manifest.json', directoryUrl)
      );
      await assertConnectivityEdgePayload(
        datasetId,
        directoryUrl,
        manifest,
        PUBLISHED_IDENTITIES.get(datasetId)
      );
    }
  );
}

/**
 * The invariant: every published connectivity weight column must hold one
 * finite, strictly positive Float64 per declared edge *and take more than one
 * distinct value*, because the application draws `weight / maxWeight` and a
 * column with a single distinct value therefore paints every edge at full
 * strength — well-formed, and empty of information.
 */
for (const datasetId of PUBLISHED_CONNECTIVITY_DATASET_IDS) {
  test(
    `${datasetId} connectivity weights carry per-edge information`,
    async () => {
      const directoryUrl = new URL(`${datasetId}/`, EXPORTS_URL);
      const manifest = await readJson(
        new URL('connectivity_manifest.json', directoryUrl)
      );
      const identity = PUBLISHED_IDENTITIES.get(datasetId);
      const label = `${datasetId}/${manifest.weightsPath}`;
      const measurement = await measureWeightColumnOnce(
        new URL(manifest.weightsPath, directoryUrl)
      );
      assert.equal(
        measurement.trailingBytes,
        0,
        `${label} must decompress to whole Float64 weights`
      );
      assert.equal(
        measurement.byteLength,
        manifest.n_edges * manifest.weight_bytes,
        `${label} must contain exactly one Float64 weight per edge`
      );
      assert.equal(
        measurement.count,
        manifest.n_edges,
        `${label} must contain exactly one Float64 weight per edge`
      );
      assert.equal(
        measurement.count,
        identity.stats.n_edges,
        `${label} must contain exactly one Float64 weight per declared edge`
      );
      assert.equal(
        measurement.nonFinite,
        0,
        `${label} must contain only finite weights`
      );
      assert.equal(
        measurement.nonPositive,
        0,
        `${label} must contain only strictly positive weights, which is what `
          + 'createConnectivityRenderWeights() accepts'
      );

      assert.ok(
        measurement.varies,
        `${label} gives all ${measurement.count} edges the single weight `
          + `${measurement.min}, so every edge renders at full strength and `
          + 'the edge-strength channel carries no information; publish the '
          + 'source graph weights instead of a placeholder'
      );
    }
  );
}


/**
 * The invariant: every categorical obs field a published generation offers as a
 * colouring must take more than one value across its cells, unless it is named
 * in CONSTANT_OBS_FIELDS with the one value it takes and the reason it takes
 * only that one.
 */
for (const datasetId of PUBLISHED_DATASET_IDS) {
  test(
    `${datasetId} names every obs field that paints one flat colour`,
    async () => {
      const measured = await measureConstantCategoricalFieldsOnce(datasetId);
      assert.deepEqual(
        [...measured.keys()].sort(),
        recordedConstantFieldKeys(datasetId),
        `${datasetId} publishes categorical obs fields that every cell shares, `
          + 'so colouring by them paints the whole embedding one colour and '
          + 'filtering by them selects all cells or none. Judge each one and '
          + 'name it in CONSTANT_OBS_FIELDS with the value it takes and why it '
          + 'takes only that one -- a source that carries one value, or a '
          + 'documented subset of a column that carries several -- or drop it '
          + 'from the generation. An entry recorded for a field that now '
          + 'varies must be deleted from CONSTANT_OBS_FIELDS instead'
      );
    }
  );
}

test('constant obs-field exemptions cannot outlive the defect', async () => {
  assert.ok(
    Object.keys(CONSTANT_OBS_FIELDS).length > 0,
    'CONSTANT_OBS_FIELDS is empty, so this re-measure asserts nothing; delete '
      + 'it and its sweep together if no published generation carries a flat '
      + 'obs field any more'
  );
  const stale = [];
  for (const [label, exemption] of Object.entries(CONSTANT_OBS_FIELDS)) {
    const [datasetId, key] = label.split('/');
    assert.ok(
      PUBLISHED_DATASET_IDS.includes(datasetId),
      `'${datasetId}' is no longer a published generation; delete '${label}' `
        + 'from CONSTANT_OBS_FIELDS'
    );
    assert.ok(
      CONSTANT_OBS_FIELD_ORIGINS.includes(exemption.origin),
      `'${label}' records the origin '${exemption.origin}', which says nothing `
        + `about why the field is constant; it must be one of `
        + `${CONSTANT_OBS_FIELD_ORIGINS.join(' or ')}`
    );
    assert.equal(
      Object.hasOwn(exemption, 'corroboratedBy'),
      exemption.origin === 'subset',
      `'${label}' must name the published generations that still show this `
        + 'column varying exactly when it claims the constancy is the subset; a '
        + 'source-constant field has no such witness, and a subset-constant one '
        + 'cannot be re-measured without it'
    );

    const measured = await measureConstantCategoricalFieldsOnce(datasetId);
    const observed = measured.get(key);
    if (observed === undefined) {
      stale.push(
        `${label}: no longer one flat colour, so the exemption protects nothing`
      );
      continue;
    }
    assert.equal(
      observed.cells,
      exemption.cells,
      `${datasetId} was regenerated (${observed.cells} cells, not `
        + `${exemption.cells}); re-measure '${label}' against the source it was `
        + 'prepared from and delete its CONSTANT_OBS_FIELDS entry if the field '
        + 'now carries information'
    );
    assert.deepEqual(
      { value: observed.value, missing: observed.missing },
      { value: exemption.value, missing: exemption.missing },
      `'${label}' no longer publishes the value this exemption records, so the `
        + 'reason it was granted was measured against a different generation'
    );
    assert.equal(
      observed.declaredCategories,
      1,
      `'${label}' declares ${observed.declaredCategories} categories while `
        + 'coding only one of them, so the legend prints rows no cell uses'
    );

    if (exemption.origin !== 'subset') {
      continue;
    }
    assert.ok(
      exemption.corroboratedBy.length > 0,
      `'${label}' claims the constancy is the subset but names no published `
        + 'generation that shows the column varying'
    );
    for (const witnessId of exemption.corroboratedBy) {
      assert.ok(
        PUBLISHED_DATASET_IDS.includes(witnessId),
        `'${label}' names '${witnessId}' as evidence that ${key} varies outside `
          + 'the subset, but that generation is no longer published; re-measure '
          + 'the claim against one that is'
      );
      const witness = await readJson(
        new URL(`${witnessId}/obs_manifest.json`, EXPORTS_URL)
      );
      const field = readObsCategoricalFields(
        witnessId,
        witness,
        categoricalCodeExtension(
          PUBLISHED_IDENTITIES.get(witnessId).export_settings
            ?.obs_categorical_dtype
        )
      ).find(entry => entry.key === key);
      assert.ok(
        field,
        `'${label}' names '${witnessId}' as evidence that ${key} varies outside `
          + `the subset, but ${witnessId} no longer publishes ${key}`
      );
      assert.ok(
        field.categories.length > 1,
        `'${label}' names '${witnessId}' as evidence that ${key} varies outside `
          + `the subset, but ${witnessId} now publishes it with `
          + `${field.categories.length} category, so the column is constant `
          + 'everywhere and the subset is not what makes it constant here'
      );
      assert.ok(
        field.categories.includes(exemption.value),
        `'${label}' names '${witnessId}' as evidence that ${key} varies outside `
          + `the subset, but '${exemption.value}' is not one of the categories `
          + `${witnessId} publishes for it`
      );
    }
  }
  assert.deepEqual(
    stale,
    [],
    'these obs fields no longer paint the one flat colour they were exempted '
      + 'for; delete them from CONSTANT_OBS_FIELDS so the exemption cannot '
      + 'outlive the defect:\n'
      + stale.join('\n')
  );
});


/**
 * The payload-identity contract. Everything below reads one generation off disk
 * and against its own manifests: what the files are called, which index each
 * entry claims, whether the two agree, and whether the manifest still says
 * anything a filesystem has to be able to spell.
 */
for (const datasetId of PUBLISHED_DATASET_IDS) {
  test(
    `${datasetId} names every file by an integer index or a neutral name`,
    async () => {
      const directoryUrl = new URL(`${datasetId}/`, EXPORTS_URL);
      const entries = (
        await readdir(directoryUrl, { withFileTypes: true })
      ).filter(entry => !entry.name.startsWith('.'));
      const rootFiles = entries
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
        .sort();
      const directories = entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort();
      assert.equal(
        entries.length,
        rootFiles.length + directories.length,
        `${datasetId} holds an entry that is neither a file nor a directory`
      );
      assert.deepEqual(
        rootFiles.filter(
          name =>
            !GENERATION_ROOT_FILES.includes(name)
            && !PUBLICATION_SIDECAR_NAMES.has(name)
        ),
        [],
        `${datasetId} publishes a root file outside the neutral set every `
          + 'generation shares, so its name carries something about this '
          + `dataset: ${GENERATION_ROOT_FILES.join(', ')}`
      );
      for (const required of ['dataset_identity.json', 'obs_manifest.json']) {
        assert.ok(
          rootFiles.includes(required),
          `${datasetId} must publish ${required}`
        );
      }
      assert.deepEqual(
        directories.filter(name => !GENERATION_DIRECTORIES.includes(name)),
        [],
        `${datasetId} publishes a directory outside the fixed set `
          + `${GENERATION_DIRECTORIES.join(', ')}`
      );

      for (const axis of PAYLOAD_AXES) {
        const names = await readAxisPayloadNames(directoryUrl, axis);
        if (names === null) continue;
        assert.deepEqual(
          names.filter(name => !INDEXED_PAYLOAD_NAMES[axis].test(name)),
          [],
          `${datasetId}/${axis} names payload files after something other than `
            + 'their integer index. A filename is an index or a fixed neutral '
            + 'name and never dataset content: the manifest beside it is what '
            + 'says which field the index belongs to'
        );
      }
    }
  );

  test(
    `${datasetId} gives every field one index in its axis, used once`,
    async () => {
      const directoryUrl = new URL(`${datasetId}/`, EXPORTS_URL);
      const identity = PUBLISHED_IDENTITIES.get(datasetId);

      const varManifest = await readJson(
        new URL('var_manifest.json', directoryUrl)
      );
      const varIndices = varManifest.fields.map(entry => entry[0]);
      assert.deepEqual(
        [...varIndices].sort((left, right) => left - right),
        Array.from({ length: varIndices.length }, (_, index) => index),
        `${datasetId}/var does not give its ${varIndices.length} genes the `
          + 'indices 0..N-1 exactly once, so two of them name one payload '
          + 'file and the viewer draws one gene under another gene’s name'
      );

      const obsManifest = await readJson(
        new URL('obs_manifest.json', directoryUrl)
      );
      const obsIndices = [
        ...obsManifest._continuousFields,
        ...obsManifest._categoricalFields,
      ].map(entry => entry[0]);
      assert.deepEqual(
        [...obsIndices].sort((left, right) => left - right),
        Array.from({ length: obsIndices.length }, (_, index) => index),
        `${datasetId}/obs does not give its ${obsIndices.length} fields the `
          + 'indices 0..N-1 exactly once across _continuousFields and '
          + '_categoricalFields together. Both arrays write into obs/, so '
          + 'they share one index space and a repeated index silently '
          + 'overwrites one field’s payload with another’s'
      );

      const fields = readVectorFields(identity);
      assert.deepEqual(
        fields.filter(field => field.index === null).map(field => field.label),
        [],
        `${datasetId} declares vector payloads that do not resolve to one `
          + 'integer index shared by every dimension of the field'
      );
      assert.deepEqual(
        fields.map(field => field.index).sort((left, right) => left - right),
        Array.from({ length: fields.length }, (_, index) => index),
        `${datasetId}/vectors does not give its ${fields.length} vector `
          + 'fields the indices 0..N-1 exactly once'
      );
    }
  );

  test(
    `${datasetId} publishes exactly the payload files its manifests declare`,
    async () => {
      const directoryUrl = new URL(`${datasetId}/`, EXPORTS_URL);
      const identity = PUBLISHED_IDENTITIES.get(datasetId);
      const declared = { var: [], obs: [], vectors: [] };

      const rootFiles = new Set(
        (await readdir(directoryUrl, { withFileTypes: true }))
          .filter(entry => entry.isFile())
          .map(entry => entry.name)
      );
      if (rootFiles.has('var_manifest.json')) {
        const varManifest = await readJson(
          new URL('var_manifest.json', directoryUrl)
        );
        declared.var = readVarFields(datasetId, varManifest).map(
          field => field.path
        );
      }
      const obsManifest = await readJson(
        new URL('obs_manifest.json', directoryUrl)
      );
      const extension = categoricalCodeExtension(
        identity.export_settings?.obs_categorical_dtype
      );
      for (const field of readObsContinuousFields(datasetId, obsManifest)) {
        declared.obs.push(field.path);
      }
      for (const field of readObsCategoricalFields(
        datasetId,
        obsManifest,
        extension
      )) {
        declared.obs.push(field.codesPath);
        if (field.outliersPath !== null) declared.obs.push(field.outliersPath);
      }
      for (const field of readVectorFields(identity)) {
        declared.vectors.push(...field.files);
      }

      for (const axis of PAYLOAD_AXES) {
        const expected = declared[axis].map(relative => {
          assert.ok(
            relative.startsWith(`${axis}/`),
            `${datasetId} declares '${relative}' as a ${axis} payload without `
              + `writing it into ${axis}/`
          );
          return relative.slice(axis.length + 1);
        });
        assert.equal(
          new Set(expected).size,
          expected.length,
          `${datasetId}/${axis} declares one payload path twice, so one field’s `
            + 'values are published under another field’s entry'
        );
        const published = await readAxisPayloadNames(directoryUrl, axis);
        if (expected.length === 0) {
          assert.equal(
            published,
            null,
            `${datasetId} declares no ${axis} payload but publishes a `
              + `${axis}/ directory holding ${published?.length} files`
          );
          continue;
        }
        assert.notEqual(
          published,
          null,
          `${datasetId} declares ${expected.length} ${axis} payloads and `
            + `publishes no ${axis}/ directory at all`
        );
        assert.deepEqual(
          published,
          [...expected].sort(),
          `${datasetId}/${axis} publishes files its manifests do not declare, `
            + 'or declares payloads it does not publish. Every payload on disk '
            + 'is reachable from a manifest entry and nothing else is there'
        );
      }
    }
  );

  test(
    `${datasetId} reaches every payload by index and never by name`,
    async () => {
      const directoryUrl = new URL(`${datasetId}/`, EXPORTS_URL);
      const patterns = [];
      const varManifest = await readJson(
        new URL('var_manifest.json', directoryUrl)
      );
      patterns.push(['_varSchema.pathPattern', varManifest._varSchema?.pathPattern]);
      const obsManifest = await readJson(
        new URL('obs_manifest.json', directoryUrl)
      );
      const schemas = obsManifest._obsSchemas ?? {};
      patterns.push(
        ['_obsSchemas.continuous.pathPattern', schemas.continuous?.pathPattern],
        [
          '_obsSchemas.categorical.codesPathPattern',
          schemas.categorical?.codesPathPattern,
        ]
      );
      if (schemas.categorical?.outlierPathPattern !== undefined) {
        patterns.push([
          '_obsSchemas.categorical.outlierPathPattern',
          schemas.categorical.outlierPathPattern,
        ]);
      }
      for (const [label, pattern] of patterns) {
        assert.equal(
          typeof pattern,
          'string',
          `${datasetId} ${label} must be one exact pattern string`
        );
        assert.ok(
          pattern.includes('{index}'),
          `${datasetId} ${label} is '${pattern}', which does not substitute the `
            + 'field index that names its payload'
        );
        assert.equal(
          pattern.includes('{key}'),
          false,
          `${datasetId} ${label} is '${pattern}', so the payload path is still `
            + 'spelled out of a field name. The manifest already carries the '
            + 'name; a path that repeats it makes the filesystem a second copy '
            + 'of the identity that can disagree with the first'
        );
      }
    }
  );

  test(
    `${datasetId} field entries carry one of the two shapes their array allows`,
    async () => {
      const directoryUrl = new URL(`${datasetId}/`, EXPORTS_URL);
      const obsManifest = await readJson(
        new URL('obs_manifest.json', directoryUrl)
      );
      const schemas = obsManifest._obsSchemas ?? {};
      const arrays = [];
      const varManifest = await readJson(
        new URL('var_manifest.json', directoryUrl)
      );
      arrays.push({
        label: 'var_manifest.json fields',
        entries: varManifest.fields,
        lengths: ENTRY_LENGTHS.var,
        quantized: varManifest._varSchema?.quantized,
      });
      arrays.push(
        {
          label: 'obs_manifest.json _continuousFields',
          entries: obsManifest._continuousFields,
          lengths: ENTRY_LENGTHS.obsContinuous,
          quantized: schemas.continuous?.quantized,
        },
        {
          label: 'obs_manifest.json _categoricalFields',
          entries: obsManifest._categoricalFields,
          lengths: ENTRY_LENGTHS.obsCategorical,
          quantized: schemas.categorical?.outlierQuantized,
        }
      );
      for (const { label, entries, lengths, quantized } of arrays) {
        assert.equal(
          typeof quantized,
          'boolean',
          `${datasetId} ${label} must say in its schema whether its payload is `
            + 'quantized, because that is what decides the entry shape'
        );
        const expected = quantized ? lengths.quantized : lengths.exact;
        for (const [ordinal, entry] of entries.entries()) {
          assert.ok(
            Array.isArray(entry),
            `${datasetId} ${label}[${ordinal}] must be one array`
          );
          assert.equal(
            entry.length,
            expected,
            `${datasetId} ${label}[${ordinal}] has ${entry.length} elements; a `
              + `${quantized ? 'quantized' : 'full-precision'} entry in this `
              + `array has exactly ${expected}`
          );
          assert.ok(
            Number.isInteger(entry[0]) && entry[0] >= 0,
            `${datasetId} ${label}[${ordinal}] must declare its own payload `
              + 'index as element [0]'
          );
          assert.equal(
            typeof entry[1],
            'string',
            `${datasetId} ${label}[${ordinal}] must carry its one name as `
              + 'element [1]'
          );
        }
      }
      // `var` and obs-continuous are the same length on purpose, so that no
      // reader can decide what kind of field an entry describes by measuring
      // it. Pinning the collision keeps someone from "fixing" the ambiguity by
      // giving one of them an extra element.
      assert.equal(
        ENTRY_LENGTHS.var.quantized,
        ENTRY_LENGTHS.obsContinuous.quantized,
        'a quantized var entry and a quantized obs-continuous entry must stay '
          + 'the same length; the array an entry came from is what says which '
          + 'kind of field it is'
      );
      assert.equal(ENTRY_LENGTHS.var.exact, ENTRY_LENGTHS.obsContinuous.exact);
    }
  );

  test(`${datasetId} publishes one exact display name per field`, async () => {
    const directoryUrl = new URL(`${datasetId}/`, EXPORTS_URL);
    const obsManifest = await readJson(
      new URL('obs_manifest.json', directoryUrl)
    );
    const identity = PUBLISHED_IDENTITIES.get(datasetId);
    const extension = categoricalCodeExtension(
      identity.export_settings?.obs_categorical_dtype
    );
    const varManifest = await readJson(
      new URL('var_manifest.json', directoryUrl)
    );
    const axes = [
      {
        axis: 'var',
        label: 'gene name',
        names: readVarFields(datasetId, varManifest).map(field => field.name),
      },
      {
        axis: 'obs',
        label: 'obs field key',
        names: [
          ...readObsContinuousFields(datasetId, obsManifest),
          ...readObsCategoricalFields(datasetId, obsManifest, extension),
        ].map(field => field.key),
      },
    ];
    for (const { axis, label, names } of axes) {
      const seen = new Set();
      for (const name of names) {
        assertDisplayText(name, `${datasetId}/${axis} ${label} '${name}'`);
        assert.equal(
          seen.has(name),
          false,
          `${datasetId}/${axis} publishes the ${label} '${name}' twice, so two `
            + 'fields are indistinguishable everywhere the app prints one'
        );
        seen.add(name);
      }
      assert.ok(
        names.length > 0,
        `${datasetId}/${axis} publishes no field at all`
      );
    }
  });
}

for (const datasetId of PUBLISHED_CONNECTIVITY_DATASET_IDS) {
  test(
    `${datasetId} connectivity payloads carry the fixed neutral names`,
    async () => {
      const directoryUrl = new URL(`${datasetId}/`, EXPORTS_URL);
      const manifest = await readJson(
        new URL('connectivity_manifest.json', directoryUrl)
      );
      for (const [key, expected] of Object.entries(CONNECTIVITY_NEUTRAL_PATHS)) {
        assert.equal(
          manifest[key],
          expected,
          `${datasetId} connectivity ${key} must be exactly '${expected}'. The `
            + 'graph is one edge list per generation, so its payloads are named '
            + 'the same in every dataset and carry nothing about this one'
        );
      }
      assert.deepEqual(
        await readAxisPayloadNames(directoryUrl, 'connectivity'),
        [...CONNECTIVITY_NEUTRAL_FILES],
        `${datasetId}/connectivity must hold exactly the three neutral edge `
          + 'payloads and nothing else'
      );
    }
  );
}

test('connectivity filenames are the same bytes in every generation', async () => {
  assert.ok(
    PUBLISHED_CONNECTIVITY_DATASET_IDS.length > 1,
    'fewer than two generations publish a connectivity graph, so comparing '
      + 'their filenames proves nothing about the names being neutral'
  );
  const byDataset = new Map();
  for (const datasetId of PUBLISHED_CONNECTIVITY_DATASET_IDS) {
    byDataset.set(
      datasetId,
      await readAxisPayloadNames(
        new URL(`${datasetId}/`, EXPORTS_URL),
        'connectivity'
      )
    );
  }
  const distinct = new Set(
    [...byDataset.values()].map(names => JSON.stringify(names))
  );
  assert.equal(
    distinct.size,
    1,
    'these generations name their connectivity payloads differently, so the '
      + 'names carry something about the dataset after all:\n'
      + [...byDataset]
        .map(([datasetId, names]) => `${datasetId}: ${names.join(', ')}`)
        .join('\n')
  );
  for (const [datasetId, names] of byDataset) {
    for (const name of names) {
      assert.equal(
        name.toLowerCase().includes(datasetId.toLowerCase()),
        false,
        `${datasetId}/connectivity/${name} spells its own dataset id`
      );
    }
  }
});
