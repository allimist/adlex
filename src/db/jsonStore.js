/**
 * JSON-file implementation of the Firestore-shaped adapter.
 * One file per collection: DATA_DIR/<collection>.json = { v: 1, docs: { id: {...} } }
 * Writes are debounced (250 ms, max 2 s) and atomic (tmp + fsync + rename).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DbError } from './adapter.js';
import { runQuery } from './query.js';
import { ulid } from '../lib/ids.js';

const DEBOUNCE_MS = 250;
const MAX_WAIT_MS = 2000;
const NAME_RE = /^[A-Za-z0-9_\-]+$/;

function clone(v) {
  return v === undefined ? undefined : structuredClone(v);
}

class DocSnapshot {
  constructor(id, data) {
    this.id = id;
    this._data = data;
  }
  get exists() {
    return this._data !== undefined;
  }
  data() {
    return clone(this._data);
  }
}

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
  }
  get size() {
    return this.docs.length;
  }
  get empty() {
    return this.docs.length === 0;
  }
  forEach(fn) {
    this.docs.forEach(fn);
  }
}

class Query {
  constructor(store, name, spec) {
    this._store = store;
    this._name = name;
    this._spec = spec || { filters: [], orders: [], limit: undefined, startAfter: undefined };
  }
  _with(patch) {
    return new Query(this._store, this._name, { ...this._spec, ...patch });
  }
  where(field, op, value) {
    return this._with({ filters: [...this._spec.filters, [field, op, value]] });
  }
  orderBy(field, dir = 'asc') {
    if (dir !== 'asc' && dir !== 'desc') throw new DbError('invalid-argument', 'orderBy direction must be asc|desc');
    return this._with({ orders: [...this._spec.orders, [field, dir]] });
  }
  limit(n) {
    if (!Number.isInteger(n) || n < 0) throw new DbError('invalid-argument', 'limit must be a non-negative integer');
    return this._with({ limit: n });
  }
  startAfter(...values) {
    return this._with({ startAfter: values });
  }
  async get() {
    const col = await this._store._load(this._name);
    const entries = [];
    for (const [id, data] of col.docs) entries.push({ id, data });
    const rows = runQuery(entries, this._spec, this._store.strict);
    return new QuerySnapshot(rows.map((r) => new DocSnapshot(r.id, r.data)));
  }
}

class DocRef {
  constructor(store, name, id) {
    this._store = store;
    this._name = name;
    this.id = id;
  }
  get path() {
    return `${this._name}/${this.id}`;
  }
  async get() {
    const col = await this._store._load(this._name);
    return new DocSnapshot(this.id, col.docs.get(this.id));
  }
  async set(data, opts = {}) {
    const col = await this._store._load(this._name);
    this._store._applySet(col, this.id, data, opts);
    this._store._markDirty(this._name);
  }
  async create(data) {
    const col = await this._store._load(this._name);
    if (col.docs.has(this.id)) throw new DbError('already-exists', `Document ${this.path} already exists`);
    col.docs.set(this.id, clone(data));
    this._store._markDirty(this._name);
  }
  async update(partial) {
    const col = await this._store._load(this._name);
    this._store._applyUpdate(col, this.id, partial, this.path);
    this._store._markDirty(this._name);
  }
  async delete() {
    const col = await this._store._load(this._name);
    if (col.docs.delete(this.id)) this._store._markDirty(this._name);
  }
}

class CollectionRef extends Query {
  doc(id) {
    if (id === undefined) id = ulid();
    if (typeof id !== 'string' || id.length === 0 || id.includes('/')) {
      throw new DbError('invalid-argument', 'Document id must be a non-empty string without "/"');
    }
    return new DocRef(this._store, this._name, id);
  }
  async add(data) {
    const ref = this.doc();
    await ref.create(data);
    return ref;
  }
}

class WriteBatch {
  constructor(store) {
    this._store = store;
    this._ops = [];
  }
  set(ref, data, opts = {}) {
    this._ops.push(['set', ref, data, opts]);
    return this;
  }
  update(ref, partial) {
    this._ops.push(['update', ref, partial]);
    return this;
  }
  delete(ref) {
    this._ops.push(['delete', ref]);
    return this;
  }
  async commit() {
    // Load everything first so the apply phase is synchronous (all-or-nothing on validation errors).
    const cols = new Map();
    for (const [, ref] of this._ops) {
      if (!cols.has(ref._name)) cols.set(ref._name, await this._store._load(ref._name));
    }
    // Validate updates against current state before mutating anything.
    for (const [op, ref] of this._ops) {
      if (op === 'update' && !cols.get(ref._name).docs.has(ref.id)) {
        throw new DbError('not-found', `Document ${ref.path} not found`);
      }
    }
    const touched = new Set();
    for (const [op, ref, data, opts] of this._ops) {
      const col = cols.get(ref._name);
      if (op === 'set') this._store._applySet(col, ref.id, data, opts);
      else if (op === 'update') this._store._applyUpdate(col, ref.id, data, ref.path);
      else col.docs.delete(ref.id);
      touched.add(ref._name);
    }
    for (const name of touched) this._store._markDirty(name);
    this._ops = [];
  }
}

export class JsonStore {
  constructor({ dir, strict = false, logger = console } = {}) {
    if (!dir) throw new Error('JsonStore requires { dir }');
    this.dir = dir;
    this.strict = strict;
    this.logger = logger;
    this._cols = new Map(); // name -> { docs: Map, dirty, timer, firstDirtyAt, flushing: Promise|null, loaded: Promise }
    this._closed = false;
    fs.mkdirSync(dir, { recursive: true });
  }

  collection(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new DbError('invalid-argument', `Invalid collection name '${name}'`);
    }
    return new CollectionRef(this, name);
  }

  batch() {
    return new WriteBatch(this);
  }

  _file(name) {
    return path.join(this.dir, `${name}.json`);
  }

  _load(name) {
    let col = this._cols.get(name);
    if (col) return col.loaded.then(() => col);
    col = { docs: new Map(), dirty: false, timer: null, firstDirtyAt: 0, flushing: null, loaded: null };
    col.loaded = (async () => {
      try {
        const raw = await fsp.readFile(this._file(name), 'utf8');
        const parsed = JSON.parse(raw);
        const docs = parsed && parsed.docs ? parsed.docs : {};
        for (const [id, data] of Object.entries(docs)) col.docs.set(id, data);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    })();
    this._cols.set(name, col);
    return col.loaded.then(() => col);
  }

  _applySet(col, id, data, opts) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new DbError('invalid-argument', 'Document data must be a plain object');
    }
    if (opts.merge && col.docs.has(id)) {
      col.docs.set(id, { ...col.docs.get(id), ...clone(data) });
    } else {
      col.docs.set(id, clone(data));
    }
  }

  _applyUpdate(col, id, partial, pathLabel) {
    if (!col.docs.has(id)) throw new DbError('not-found', `Document ${pathLabel} not found`);
    if (partial === null || typeof partial !== 'object' || Array.isArray(partial)) {
      throw new DbError('invalid-argument', 'Update data must be a plain object');
    }
    col.docs.set(id, { ...col.docs.get(id), ...clone(partial) });
  }

  _markDirty(name) {
    if (this._closed) throw new DbError('failed-precondition', 'Store is closed');
    const col = this._cols.get(name);
    col.dirty = true;
    const now = Date.now();
    if (!col.firstDirtyAt) col.firstDirtyAt = now;
    if (col.timer) clearTimeout(col.timer);
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, col.firstDirtyAt + MAX_WAIT_MS - now));
    col.timer = setTimeout(() => {
      col.timer = null;
      this._flush(name).catch((err) => this.logger.error?.({ msg: 'flush failed', collection: name, err: String(err) }));
    }, wait);
    col.timer.unref?.();
  }

  _flush(name) {
    const col = this._cols.get(name);
    if (!col) return Promise.resolve();
    if (col.flushing) {
      // Chain after the in-progress flush so there is a single writer per collection.
      return col.flushing.then(() => this._flush(name));
    }
    if (!col.dirty) return Promise.resolve();
    col.dirty = false;
    col.firstDirtyAt = 0;
    const payload = JSON.stringify({ v: 1, docs: Object.fromEntries(col.docs) });
    const file = this._file(name);
    const tmp = `${file}.tmp-${process.pid}`;
    col.flushing = (async () => {
      const fh = await fsp.open(tmp, 'w');
      try {
        await fh.writeFile(payload, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fsp.rename(tmp, file);
    })().finally(() => {
      col.flushing = null;
    });
    return col.flushing;
  }

  /** Flush every dirty collection now (used by tests and shutdown). */
  async flushAll() {
    const names = [...this._cols.keys()];
    await Promise.all(
      names.map((name) => {
        const col = this._cols.get(name);
        if (col.timer) {
          clearTimeout(col.timer);
          col.timer = null;
        }
        return this._flush(name);
      }),
    );
  }

  async close() {
    await this.flushAll();
    this._closed = true;
  }
}
