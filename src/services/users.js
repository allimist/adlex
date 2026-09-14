import bcrypt from 'bcryptjs';
import { getDb } from '../db/index.js';
import { toList, toObj } from '../db/adapter.js';
import { HttpError } from '../lib/http.js';

const col = () => getDb().collection('users');
export const ROLES = ['admin', 'user'];

function norm(email) {
  return String(email || '').trim().toLowerCase();
}

export async function list() {
  const rows = toList(await col().get());
  return rows.sort((a, b) => a.email.localeCompare(b.email));
}

export async function count() {
  return (await col().limit(1).get()).size;
}

export async function getById(id) {
  return toObj(await col().doc(id).get());
}

export async function getByEmail(email) {
  const qs = await col().where('email', '==', norm(email)).limit(1).get();
  return qs.empty ? null : toObj(qs.docs[0]);
}

function validate({ email, name, role, password }, { requirePassword }) {
  if (!norm(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm(email))) throw new HttpError(400, 'Valid email required');
  if (!ROLES.includes(role)) throw new HttpError(400, 'Invalid role');
  if (requirePassword && (!password || password.length < 8)) throw new HttpError(400, 'Password must be at least 8 characters');
  if (name && name.length > 80) throw new HttpError(400, 'Name too long');
}

export async function create({ email, name = '', role = 'user', password }) {
  validate({ email, name, role, password }, { requirePassword: true });
  if (await getByEmail(email)) throw new HttpError(400, 'Email already in use');
  const now = Date.now();
  const ref = await col().add({
    email: norm(email),
    name: String(name || '').trim(),
    passwordHash: await bcrypt.hash(password, 10),
    role,
    disabled: false,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
  });
  return getById(ref.id);
}

async function adminCount() {
  const qs = await col().where('role', '==', 'admin').get();
  return qs.docs.filter((d) => !d.data().disabled).length;
}

export async function update(id, { email, name, role }, actor) {
  const existing = await getById(id);
  if (!existing) throw new HttpError(404, 'User not found');
  validate({ email, name, role, password: 'x'.repeat(8) }, { requirePassword: false });
  const other = await getByEmail(email);
  if (other && other.id !== id) throw new HttpError(400, 'Email already in use');
  if (existing.role === 'admin' && role !== 'admin') {
    if (actor && actor.id === id) throw new HttpError(400, 'You cannot demote yourself');
    if ((await adminCount()) <= 1) throw new HttpError(400, 'Cannot demote the last admin');
  }
  await col().doc(id).update({ email: norm(email), name: String(name || '').trim(), role, updatedAt: Date.now() });
  return getById(id);
}

export async function setDisabled(id, disabled, actor) {
  const existing = await getById(id);
  if (!existing) throw new HttpError(404, 'User not found');
  if (disabled) {
    if (actor && actor.id === id) throw new HttpError(400, 'You cannot disable yourself');
    if (existing.role === 'admin' && (await adminCount()) <= 1) throw new HttpError(400, 'Cannot disable the last admin');
  }
  await col().doc(id).update({ disabled: !!disabled, updatedAt: Date.now() });
}

export async function resetPassword(id, password) {
  if (!password || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const existing = await getById(id);
  if (!existing) throw new HttpError(404, 'User not found');
  await col().doc(id).update({ passwordHash: await bcrypt.hash(password, 10), updatedAt: Date.now() });
}

export async function verifyLogin(email, password) {
  const user = await getByEmail(email);
  if (!user || user.disabled) return null;
  const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
  if (!ok) return null;
  await col().doc(user.id).update({ lastLoginAt: Date.now() });
  return user;
}
