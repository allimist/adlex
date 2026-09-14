import session from 'express-session';
import { getDb } from '../db/index.js';
import { logger } from '../lib/logger.js';

const SWEEP_MS = 10 * 60 * 1000;

/** express-session Store backed by the adapter (collection `sessions`). */
export class DbSessionStore extends session.Store {
  constructor({ ttlMs }) {
    super();
    this.ttlMs = ttlMs;
    this.col = () => getDb().collection('sessions');
    this.timer = setInterval(() => this.sweep().catch((e) => logger.warn({ msg: 'session sweep failed', err: String(e) })), SWEEP_MS);
    this.timer.unref?.();
  }

  _expiry(sess) {
    if (sess && sess.cookie && sess.cookie.expires) {
      const t = new Date(sess.cookie.expires).getTime();
      if (Number.isFinite(t)) return t;
    }
    return Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    this.col()
      .doc(sid)
      .get()
      .then((snap) => {
        if (!snap.exists) return cb(null, null);
        const d = snap.data();
        if (d.expiresAt <= Date.now()) {
          return this.col().doc(sid).delete().then(() => cb(null, null));
        }
        cb(null, d.data);
      })
      .catch(cb);
  }

  set(sid, sess, cb) {
    const data = JSON.parse(JSON.stringify(sess));
    this.col()
      .doc(sid)
      .set({ data, expiresAt: this._expiry(sess) })
      .then(() => cb && cb(null))
      .catch(cb);
  }

  destroy(sid, cb) {
    this.col()
      .doc(sid)
      .delete()
      .then(() => cb && cb(null))
      .catch(cb);
  }

  touch(sid, sess, cb) {
    this.col()
      .doc(sid)
      .update({ expiresAt: this._expiry(sess) })
      .then(() => cb && cb(null))
      .catch(() => cb && cb(null));
  }

  async sweep() {
    const qs = await this.col().where('expiresAt', '<', Date.now()).limit(500).get();
    if (qs.empty) return;
    const b = getDb().batch();
    qs.forEach((d) => b.delete(this.col().doc(d.id)));
    await b.commit();
  }

  close() {
    clearInterval(this.timer);
  }
}
