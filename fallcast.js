// FallCast · federated signed broadcast · MIT · AI-Native Solutions
// Nostr-style timeline bound to FallID · propagates via FallLink peer mesh
// Post format: {id, authorDid, text, timestamp, replyTo, attachments, signature}

const DB_NAME = 'fallcast';
const DB_VER = 1;
const STORE_POSTS = 'posts';
const STORE_LIKES = 'likes';
const STORE_SUBS = 'subscriptions';
const STORE_TOMBS = 'tombstones';
const CHAN_POST = 'fallcast:post';
const CHAN_LIKE = 'fallcast:like';
const CHAN_TOMB = 'fallcast:tomb';
const CHAN_REQ = 'fallcast:request';
const MAX_TEXT = 4096;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_POSTS)) {
        const s = db.createObjectStore(STORE_POSTS, { keyPath: 'id' });
        s.createIndex('by_author', 'authorDid', { unique: false });
        s.createIndex('by_time', 'timestamp', { unique: false });
        s.createIndex('by_reply', 'replyTo', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_LIKES)) {
        const s = db.createObjectStore(STORE_LIKES, { keyPath: 'id' });
        s.createIndex('by_post', 'postId', { unique: false });
        s.createIndex('by_actor', 'actorDid', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_SUBS)) {
        db.createObjectStore(STORE_SUBS, { keyPath: 'did' });
      }
      if (!db.objectStoreNames.contains(STORE_TOMBS)) {
        db.createObjectStore(STORE_TOMBS, { keyPath: 'postId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, store, val) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(val);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

function idbDel(db, store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

function idbGet(db, store, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function idbAll(db, store) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}

function idbIndexAll(db, store, idx, val) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).index(idx).getAll(val);
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}

async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function canonicalPostForSig(p) {
  // deterministic serialisation for signing (excludes id + signature)
  return JSON.stringify({
    authorDid: p.authorDid,
    text: p.text,
    timestamp: p.timestamp,
    replyTo: p.replyTo || null,
    attachments: p.attachments || []
  });
}

function canonicalLikeForSig(l) {
  return JSON.stringify({ postId: l.postId, actorDid: l.actorDid, timestamp: l.timestamp });
}

function canonicalTombForSig(t) {
  return JSON.stringify({ postId: t.postId, authorDid: t.authorDid, timestamp: t.timestamp });
}

export class FallCast {
  constructor({ fallidInstance, falllinkInstance } = {}) {
    if (!fallidInstance) throw new Error('FallCast: fallidInstance required');
    this.fallid = fallidInstance;
    this.link = falllinkInstance || null;
    this.db = null;
    this.listeners = new Set();
    this._ready = this._init();
  }

  async _init() {
    this.db = await openDB();
    if (this.link && typeof this.link.on === 'function') {
      this.link.on(CHAN_POST, (msg) => this._ingestPost(msg).catch(() => {}));
      this.link.on(CHAN_LIKE, (msg) => this._ingestLike(msg).catch(() => {}));
      this.link.on(CHAN_TOMB, (msg) => this._ingestTomb(msg).catch(() => {}));
      this.link.on(CHAN_REQ, (msg) => this._handleRequest(msg).catch(() => {}));
    }
  }

  async ready() { await this._ready; return this; }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(evt) { for (const fn of this.listeners) { try { fn(evt); } catch (_) {} } }

  _broadcast(channel, payload) {
    if (this.link && typeof this.link.broadcast === 'function') {
      try { this.link.broadcast(channel, payload); } catch (_) {}
    } else if (this.link && typeof this.link.send === 'function') {
      try { this.link.send(channel, payload); } catch (_) {}
    }
  }

  async _sign(canonical) {
    if (typeof this.fallid.sign === 'function') return await this.fallid.sign(canonical);
    if (this.fallid.signer && typeof this.fallid.signer.sign === 'function') return await this.fallid.signer.sign(canonical);
    throw new Error('FallCast: fallid has no sign()');
  }

  async _verify(canonical, sig, did) {
    try {
      if (typeof this.fallid.verify === 'function') return await this.fallid.verify(canonical, sig, did);
      if (this.fallid.verifier && typeof this.fallid.verifier.verify === 'function') return await this.fallid.verifier.verify(canonical, sig, did);
    } catch (_) { return false; }
    return true; // if no verify available, accept (best-effort federation)
  }

  async _myDid() {
    if (typeof this.fallid.did === 'function') return await this.fallid.did();
    if (this.fallid.did) return this.fallid.did;
    if (typeof this.fallid.getDid === 'function') return await this.fallid.getDid();
    throw new Error('FallCast: cannot resolve did from fallid');
  }

  async post(text, opts = {}) {
    await this._ready;
    if (typeof text !== 'string' || !text.trim()) throw new Error('empty post');
    if (text.length > MAX_TEXT) throw new Error('post too long');
    const authorDid = await this._myDid();
    const p = {
      authorDid,
      text: text.trim(),
      timestamp: new Date().toISOString(),
      replyTo: opts.replyTo || null,
      attachments: Array.isArray(opts.attachments) ? opts.attachments : []
    };
    const canonical = canonicalPostForSig(p);
    p.signature = await this._sign(canonical);
    p.id = await sha256Hex(canonical + '|' + p.signature);
    await idbPut(this.db, STORE_POSTS, p);
    this._emit({ type: 'post', post: p });
    this._broadcast(CHAN_POST, p);
    return p;
  }

  async reply(postId, text) {
    return this.post(text, { replyTo: postId });
  }

  async delete(postId) {
    await this._ready;
    const existing = await idbGet(this.db, STORE_POSTS, postId);
    const authorDid = await this._myDid();
    if (existing && existing.authorDid !== authorDid) throw new Error('cannot delete another author');
    const tomb = { postId, authorDid, timestamp: new Date().toISOString() };
    tomb.signature = await this._sign(canonicalTombForSig(tomb));
    await idbPut(this.db, STORE_TOMBS, tomb);
    await idbDel(this.db, STORE_POSTS, postId);
    this._emit({ type: 'delete', postId });
    this._broadcast(CHAN_TOMB, tomb);
    return tomb;
  }

  async like(postId) {
    await this._ready;
    const actorDid = await this._myDid();
    const l = { postId, actorDid, timestamp: new Date().toISOString() };
    const canonical = canonicalLikeForSig(l);
    l.signature = await this._sign(canonical);
    l.id = await sha256Hex(canonical + '|' + l.signature);
    await idbPut(this.db, STORE_LIKES, l);
    this._emit({ type: 'like', like: l });
    this._broadcast(CHAN_LIKE, l);
    return l;
  }

  async likes(postId) {
    await this._ready;
    const all = await idbIndexAll(this.db, STORE_LIKES, 'by_post', postId);
    const seen = new Set();
    for (const l of all) seen.add(l.actorDid);
    return seen.size;
  }

  async likesFor(postId) {
    await this._ready;
    return idbIndexAll(this.db, STORE_LIKES, 'by_post', postId);
  }

  async subscribe(did) {
    await this._ready;
    if (!did || typeof did !== 'string') throw new Error('did required');
    await idbPut(this.db, STORE_SUBS, { did, since: new Date().toISOString() });
    this._emit({ type: 'subscribe', did });
    this._broadcast(CHAN_REQ, { authorDid: did });
    return true;
  }

  async unsubscribe(did) {
    await this._ready;
    await idbDel(this.db, STORE_SUBS, did);
    this._emit({ type: 'unsubscribe', did });
    return true;
  }

  async subscriptions() {
    await this._ready;
    return idbAll(this.db, STORE_SUBS);
  }

  async myPosts() {
    await this._ready;
    const did = await this._myDid();
    const posts = await idbIndexAll(this.db, STORE_POSTS, 'by_author', did);
    return posts.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
  }

  async timeline({ from, limit } = {}) {
    await this._ready;
    const did = await this._myDid();
    const subs = await this.subscriptions();
    const authors = new Set([did, ...subs.map(s => s.did)]);
    const all = await idbAll(this.db, STORE_POSTS);
    let out = all.filter(p => authors.has(p.authorDid));
    if (from) out = out.filter(p => (p.timestamp || '') < from);
    out.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    if (limit) out = out.slice(0, limit);
    return out;
  }

  async replies(postId) {
    await this._ready;
    const rs = await idbIndexAll(this.db, STORE_POSTS, 'by_reply', postId);
    return rs.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  }

  async getPost(postId) {
    await this._ready;
    return idbGet(this.db, STORE_POSTS, postId);
  }

  async thread(postId) {
    await this._ready;
    const root = await this.getPost(postId);
    if (!root) return null;
    const rs = await this.replies(postId);
    return { root, replies: rs };
  }

  async _ingestPost(p) {
    if (!p || !p.id || !p.authorDid || !p.signature) return;
    const tomb = await idbGet(this.db, STORE_TOMBS, p.id);
    if (tomb) return;
    const exists = await idbGet(this.db, STORE_POSTS, p.id);
    if (exists) return;
    const canonical = canonicalPostForSig(p);
    const ok = await this._verify(canonical, p.signature, p.authorDid);
    if (!ok) return;
    const subs = await this.subscriptions();
    const did = await this._myDid();
    const following = new Set([did, ...subs.map(s => s.did)]);
    if (!following.has(p.authorDid) && !p.replyTo) return; // gossip filter: only keep if we follow, or it's a reply
    await idbPut(this.db, STORE_POSTS, p);
    this._emit({ type: 'incoming', post: p });
  }

  async _ingestLike(l) {
    if (!l || !l.id || !l.postId || !l.actorDid) return;
    const exists = await idbGet(this.db, STORE_LIKES, l.id);
    if (exists) return;
    const ok = await this._verify(canonicalLikeForSig(l), l.signature, l.actorDid);
    if (!ok) return;
    await idbPut(this.db, STORE_LIKES, l);
    this._emit({ type: 'incoming-like', like: l });
  }

  async _ingestTomb(t) {
    if (!t || !t.postId || !t.authorDid) return;
    const ok = await this._verify(canonicalTombForSig(t), t.signature, t.authorDid);
    if (!ok) return;
    const p = await idbGet(this.db, STORE_POSTS, t.postId);
    if (p && p.authorDid === t.authorDid) {
      await idbDel(this.db, STORE_POSTS, t.postId);
    }
    await idbPut(this.db, STORE_TOMBS, t);
    this._emit({ type: 'tomb', postId: t.postId });
  }

  async _handleRequest(req) {
    if (!req || !req.authorDid) return;
    const did = await this._myDid();
    if (req.authorDid !== did) return;
    const mine = await this.myPosts();
    for (const p of mine) this._broadcast(CHAN_POST, p);
  }

  async exportAll() {
    await this._ready;
    return {
      posts: await idbAll(this.db, STORE_POSTS),
      likes: await idbAll(this.db, STORE_LIKES),
      subscriptions: await idbAll(this.db, STORE_SUBS),
      tombstones: await idbAll(this.db, STORE_TOMBS)
    };
  }
}

export default FallCast;
