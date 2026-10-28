/**
 * Read this repository's Cellucid-ready AnnData Zarr stores with Node's
 * standard library alone.
 *
 * The stores under `anndata/` are Zarr format 2 folders written by
 * `cellucid.prepare(format="zarr")`: consolidated metadata in `.zmetadata`,
 * every chunk compressed with zlib, numbers byte-shuffled (numcodecs'
 * `shuffle`) or stored as they are, strings in the `vlen-utf8` encoding. That
 * is all this module reads, and it refuses anything else by name, so the
 * contract suites and the preset publisher can open a store on a machine with
 * nothing installed but Node -- which is how this repository's CI runs them.
 * It is not a general Zarr reader.
 *
 * @module scripts/anndata_store
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

/** The documents a Zarr v2 store describes its groups and arrays with. */
export const ZARR_METADATA_NAMES = Object.freeze(['.zarray', '.zattrs', '.zgroup']);

/** GitHub refuses a pushed file larger than 100 MiB. */
export const GITHUB_MAX_FILE_BYTES = 100 * 1024 * 1024;

const TYPED_ARRAYS = Object.freeze({
  '<f4': { bytes: 4, read: (view, offset) => view.getFloat32(offset, true), Array: Float32Array },
  '<f8': { bytes: 8, read: (view, offset) => view.getFloat64(offset, true), Array: Float64Array },
  '|i1': { bytes: 1, read: (view, offset) => view.getInt8(offset), Array: Int8Array },
  '<i2': { bytes: 2, read: (view, offset) => view.getInt16(offset, true), Array: Int16Array },
  '<i4': { bytes: 4, read: (view, offset) => view.getInt32(offset, true), Array: Int32Array },
  '<u4': { bytes: 4, read: (view, offset) => view.getUint32(offset, true), Array: Uint32Array },
  '<i8': { bytes: 8, read: (view, offset) => Number(view.getBigInt64(offset, true)), Array: Float64Array },
  '|b1': { bytes: 1, read: (view, offset) => view.getUint8(offset) !== 0, Array: Array },
});

/**
 * Every file of a store, as repository-relative POSIX paths in code-point
 * order (the order `scripts/pinned_build.py` digests them in). A symbolic
 * link is refused: a published store holds files and folders only.
 *
 * @param {string} storeDir
 * @returns {Promise<string[]>}
 */
export async function listStoreFiles(storeDir) {
  const files = [];
  const walk = async (relative) => {
    for (const entry of await readdir(path.join(storeDir, relative), { withFileTypes: true })) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new Error(`${storeDir} holds the symbolic link ${child}; a published store holds none.`);
      }
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  await walk('');
  return files.sort(compareCodePoints);
}

/** Code-point order, as Python sorts strings. */
export function compareCodePoints(left, right) {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/**
 * The digest `scripts/pinned_build.py` records for a store: SHA-256 over
 * every file's relative path, size and bytes, in code-point path order, with
 * each path and size framed as 8-byte little-endian lengths.
 *
 * @param {string} storeDir
 * @returns {Promise<{file_count: number, total_bytes: number, sha256: string, largest_file: {path: string, bytes: number}}>}
 */
export async function storeDigest(storeDir) {
  const digest = createHash('sha256');
  let totalBytes = 0;
  let largest = { path: '', bytes: -1 };
  const files = await listStoreFiles(storeDir);
  for (const relative of files) {
    const bytes = await readFile(path.join(storeDir, relative));
    const encoded = Buffer.from(relative, 'utf8');
    const frame = Buffer.alloc(8);
    frame.writeBigUInt64LE(BigInt(encoded.length));
    digest.update(frame);
    digest.update(encoded);
    frame.writeBigUInt64LE(BigInt(bytes.length));
    digest.update(frame);
    digest.update(bytes);
    totalBytes += bytes.length;
    if (bytes.length > largest.bytes) largest = { path: relative, bytes: bytes.length };
  }
  return {
    file_count: files.length,
    total_bytes: totalBytes,
    sha256: digest.digest('hex'),
    largest_file: largest,
  };
}

/**
 * The consolidated metadata of a store: `.zmetadata`'s `metadata` mapping.
 *
 * @param {string} storeDir
 * @returns {Promise<Record<string, any>>}
 */
export async function readConsolidated(storeDir) {
  const consolidated = JSON.parse(await readFile(path.join(storeDir, '.zmetadata'), 'utf8'));
  if (consolidated?.zarr_consolidated_format !== 1 || typeof consolidated.metadata !== 'object') {
    throw new Error(`${storeDir}/.zmetadata is not Zarr v2 consolidated metadata.`);
  }
  return consolidated.metadata;
}

function decodeVlenUtf8(bytes, count, label) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const items = view.getUint32(0, true);
  if (items !== count) throw new Error(`${label} holds ${items} strings in a chunk of ${count}.`);
  const values = [];
  let offset = 4;
  for (let index = 0; index < items; index++) {
    const length = view.getUint32(offset, true);
    offset += 4;
    values.push(Buffer.from(bytes.buffer, bytes.byteOffset + offset, length).toString('utf8'));
    offset += length;
  }
  if (offset !== bytes.byteLength) throw new Error(`${label} carries trailing bytes.`);
  return values;
}

/**
 * Undo numcodecs' `shuffle` filter: the encoded chunk holds byte 0 of every
 * element, then byte 1 of every element, and so on; bytes past the last whole
 * element are stored as they are.
 */
function unshuffle(bytes, elementSize) {
  const count = Math.floor(bytes.length / elementSize);
  const out = Buffer.allocUnsafe(bytes.length);
  for (let byte = 0; byte < elementSize; byte++) {
    const plane = byte * count;
    for (let element = 0; element < count; element++) out[element * elementSize + byte] = bytes[plane + element];
  }
  bytes.copy(out, count * elementSize, count * elementSize);
  return out;
}

/**
 * Read one array of a store whole, in C order.
 *
 * @param {string} storeDir
 * @param {Record<string, any>} metadata - From {@link readConsolidated}.
 * @param {string} key - The array's path in the store, e.g. `obsm/X_umap_3d`.
 * @returns {Promise<{shape: number[], dtype: string, values: ArrayLike<any>}>}
 */
export async function readArray(storeDir, metadata, key) {
  const zarray = metadata[`${key}/.zarray`];
  if (zarray === undefined) throw new Error(`${storeDir} has no array ${key}.`);
  const label = `${path.basename(storeDir)}/${key}`;
  if (zarray.zarr_format !== 2 || zarray.order !== 'C') throw new Error(`${label} is not a C-order Zarr v2 array.`);
  if (zarray.compressor?.id !== 'zlib') throw new Error(`${label} is not zlib-compressed.`);
  const strings = zarray.dtype === '|O';
  if (strings && !(zarray.filters?.length === 1 && zarray.filters[0].id === 'vlen-utf8')) {
    throw new Error(`${label} holds objects that are not vlen-utf8 strings.`);
  }
  const type = strings ? null : TYPED_ARRAYS[zarray.dtype];
  if (!strings && type === undefined) throw new Error(`${label} has the dtype ${zarray.dtype}, which this reader does not read.`);
  const shuffled = !strings && zarray.filters !== null;
  if (shuffled && !(zarray.filters.length === 1 && zarray.filters[0].id === 'shuffle'
    && zarray.filters[0].elementsize === type.bytes)) {
    throw new Error(`${label} carries filters this reader does not apply.`);
  }
  const shape = zarray.shape;
  if (shape.length > 2) throw new Error(`${label} has ${shape.length} dimensions; this reader reads up to two.`);
  const size = shape.reduce((product, extent) => product * extent, 1);
  const values = strings ? new Array(size).fill(zarray.fill_value) : new type.Array(size);
  if (!strings && zarray.fill_value !== 0 && zarray.fill_value !== false) values.fill(zarray.fill_value);
  const separator = zarray.dimension_separator ?? '.';
  const chunkShape = zarray.chunks;
  const grid = shape.map((extent, axis) => Math.ceil(extent / chunkShape[axis]));
  const columns = shape.length === 2 ? shape[1] : 1;
  const chunkColumns = shape.length === 2 ? chunkShape[1] : 1;
  const chunkSize = chunkShape.reduce((product, extent) => product * extent, 1);
  const chunkIndexes = shape.length === 0
    ? [[]]
    : shape.length === 1
      ? Array.from({ length: grid[0] }, (_, row) => [row])
      : Array.from({ length: grid[0] * grid[1] }, (_, index) => [Math.floor(index / grid[1]), index % grid[1]]);
  for (const chunkIndex of chunkIndexes) {
    const name = shape.length === 0 ? '0' : chunkIndex.join(separator);
    let compressed;
    try {
      compressed = await readFile(path.join(storeDir, key, name));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const inflated = inflateSync(compressed);
    const bytes = shuffled ? unshuffle(inflated, type.bytes) : inflated;
    const decoded = strings ? decodeVlenUtf8(bytes, chunkSize, `${label}/${name}`) : null;
    if (!strings && bytes.length !== chunkSize * type.bytes) {
      throw new Error(`${label}/${name} decodes to ${bytes.length} bytes, not ${chunkSize * type.bytes}.`);
    }
    const view = strings ? null : new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rowStart = shape.length === 0 ? 0 : chunkIndex[0] * chunkShape[0];
    const columnStart = shape.length === 2 ? chunkIndex[1] * chunkShape[1] : 0;
    const rows = shape.length === 0 ? 1 : Math.min(chunkShape[0], shape[0] - rowStart);
    const width = shape.length === 2 ? Math.min(chunkColumns, columns - columnStart) : 1;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < width; column++) {
        const source = row * chunkColumns + column;
        const target = (rowStart + row) * columns + columnStart + column;
        values[target] = strings ? decoded[source] : type.read(view, source * type.bytes);
      }
    }
  }
  return { shape, dtype: zarray.dtype, values };
}

/**
 * Read one `uns` group as the plain JSON it was written from: a `dict`
 * becomes an object, a `string` or `numeric-scalar` its value, a
 * `string-array` or `array` a list.
 *
 * @param {string} storeDir
 * @param {Record<string, any>} metadata
 * @param {string} key - e.g. `uns/cellucid`
 * @returns {Promise<any>}
 */
export async function readUnsElement(storeDir, metadata, key, skip = []) {
  const attributes = metadata[`${key}/.zattrs`] ?? {};
  const encoding = attributes['encoding-type'];
  if (metadata[`${key}/.zgroup`] !== undefined) {
    if (encoding !== 'dict') throw new Error(`${key} is a ${encoding} group, not a dict.`);
    const prefix = `${key}/`;
    const children = new Set();
    for (const name of Object.keys(metadata)) {
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length).split('/');
      if (rest.length === 2 && !skip.includes(rest[0])) children.add(rest[0]);
    }
    const value = {};
    for (const child of [...children].sort(compareCodePoints)) {
      value[child] = await readUnsElement(storeDir, metadata, `${prefix}${child}`);
    }
    return value;
  }
  const { shape, values } = await readArray(storeDir, metadata, key);
  if (encoding === 'string' || encoding === 'numeric-scalar') {
    if (shape.length !== 0) throw new Error(`${key} is a ${encoding} of shape ${JSON.stringify(shape)}.`);
    return values[0];
  }
  if (encoding === 'string-array' || encoding === 'array') return Array.from(values);
  throw new Error(`${key} has the encoding ${encoding}, which uns does not hold here.`);
}

/** `uns['cellucid']['outlierQuantiles']['fields']`, described from its metadata; null when absent. */
function describeOutlierQuantiles(metadata) {
  const prefix = 'uns/cellucid/outlierQuantiles/fields/';
  if (metadata['uns/cellucid/outlierQuantiles/.zgroup'] === undefined) return null;
  const fields = {};
  for (const [name, document] of Object.entries(metadata)) {
    const match = name.startsWith(prefix) ? /^([^/]+)\/\.zarray$/.exec(name.slice(prefix.length)) : null;
    if (match !== null) fields[match[1]] = { shape: document.shape, dtype: document.dtype };
  }
  return { fields };
}

/**
 * What one store says about itself, read the way the web app reads it:
 * shapes from the element attributes, the obsm keys and widths, and
 * `uns['title']` and `uns['cellucid']`. `uns['cellucid']['outlierQuantiles']`
 * (one float32 array per categorical field, written by `prepare(latent_key=...)`)
 * is described from its metadata, as the web app opens it, not read:
 * `outlierQuantiles` is `{fields: {<obs key>: {shape, dtype}}}`, or null.

 *
 * @param {string} storeDir
 */
export async function describeStore(storeDir) {
  const metadata = await readConsolidated(storeDir);
  const rootAttributes = metadata['.zattrs'] ?? {};
  const x = metadata['X/.zattrs'];
  const obsm = {};
  for (const name of Object.keys(metadata)) {
    const match = /^obsm\/([^/]+)\/\.zarray$/.exec(name);
    if (match !== null) obsm[match[1]] = { shape: metadata[name].shape, dtype: metadata[name].dtype };
  }
  // What the viewer's log1p and highly-variable defaults read: Scanpy's
  // `uns['log1p']`, the layers, raw.X's dtype and each var column's dtype.
  const layers = Object.keys(metadata)
    .map(name => /^layers\/([^/]+)\/\.z(?:array|group)$/.exec(name)?.[1])
    .filter(name => name !== undefined);
  const rawX = metadata['raw/X/.zarray'] ?? null;
  const varColumns = Object.keys(metadata)
    .map(name => /^var\/([^/]+)\/\.z(array|group)$/.exec(name))
    .filter(match => match !== null && match[1] !== '_index')
    .map(([name, key, kind]) => ({
      key,
      dtype: kind === 'array'
        ? (metadata[name].dtype === '|b1' ? 'bool' : String(metadata[name].dtype))
        : (metadata[`var/${key}/.zattrs`]?.['encoding-type'] === 'nullable-boolean' ? 'boolean' : 'object'),
    }));
  const log1p = metadata['uns/log1p/.zgroup'] === undefined && metadata['uns/log1p/.zarray'] === undefined
    ? null
    : await readUnsElement(storeDir, metadata, 'uns/log1p');
  return {
    metadata,
    encoding: rootAttributes['encoding-type'],
    x: x === undefined ? null : { encoding: x['encoding-type'], shape: x.shape },
    layers,
    raw: rawX === null ? null : { dtype: rawX.dtype },
    varColumns,
    log1p,
    obsm,
    title: await readUnsElement(storeDir, metadata, 'uns/title'),
    cellucid: await readUnsElement(storeDir, metadata, 'uns/cellucid', ['outlierQuantiles']),
    outlierQuantiles: describeOutlierQuantiles(metadata),
  };
}

/**
 * One `obsm` array as a Float32Array of `shape[1]` values per cell.
 *
 * @param {string} storeDir
 * @param {Record<string, any>} metadata
 * @param {string} key - The obsm key.
 */
export async function readObsm(storeDir, metadata, key) {
  const { shape, dtype, values } = await readArray(storeDir, metadata, `obsm/${key}`);
  if (dtype !== '<f4' || shape.length !== 2) throw new Error(`obsm/${key} is not a two-dimensional float32 array.`);
  return { cells: shape[0], width: shape[1], values };
}
