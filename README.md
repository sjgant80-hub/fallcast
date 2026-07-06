# FallCast

**Federated signed broadcast. Timeline bound to your FallID. No server, no algorithm, no ads.**

FallCast is a Nostr-style timeline that runs entirely in your browser. Every post is signed by your FallID. Posts propagate through the FallLink peer mesh. Others follow you by your DID.

This is Berners-Lee's original blog vision — one voice, one signature, addressable and portable — sovereign.

## What it is

- **Signed** — every post, like, and delete is signed with your FallID key.
- **Federated** — no central server. Posts gossip across peers via FallLink.
- **Portable** — your DID is your identity. Move devices, take your feed.
- **Silent by default** — no algorithm ranks you, no ads sell you.
- **Private storage** — everything lives in IndexedDB on your device.

## Try it

Open [https://sjgant80-hub.github.io/fallcast/](https://sjgant80-hub.github.io/fallcast/).

On first load, FallCast tries to bind to your real FallID and FallLink modules. If they aren't present, it spins up a local key + a cross-tab BroadcastChannel mesh so you can play with the surface immediately.

- Type a message → **Post**. It's signed, saved, and broadcast.
- Copy your DID from the sidebar. Share it. Anyone who pastes it under **Follow** starts pulling your posts.
- Tap a post to reply, like, or open its thread.
- Tombstone (delete) your own posts — the tombstone propagates and other peers drop the message.

## The library

```javascript
import FallCast from 'https://sjgant80-hub.github.io/fallcast/fallcast.js';

const cast = new FallCast({
  fallidInstance: window.FallID,
  falllinkInstance: window.FallLink
});
await cast.ready();

await cast.post("Hello, sovereign timeline.");
await cast.subscribe("did:key:z6Mk…");

const feed = await cast.timeline({ limit: 50 });
```

### API

| Method | Purpose |
|---|---|
| `new FallCast({ fallidInstance, falllinkInstance })` | Construct. FallID required for signing; FallLink optional for propagation. |
| `ready()` | Await IndexedDB + mesh subscription setup. |
| `post(text, { replyTo?, attachments? })` | Sign, store, broadcast a post. |
| `reply(postId, text)` | Signed reply. |
| `like(postId)` | Signed like. |
| `likes(postId)` | Distinct-actor like count. |
| `delete(postId)` | Signed tombstone. |
| `subscribe(did)` | Follow a DID; request a backfill from the mesh. |
| `unsubscribe(did)` | Stop following. |
| `subscriptions()` | List follows. |
| `myPosts()` | Everything you've authored, newest first. |
| `timeline({ from?, limit? })` | Merged feed of self + subscriptions, newest first. |
| `thread(postId)` | `{ root, replies }`. |
| `onChange(fn)` | Subscribe to local change events. |
| `exportAll()` | Full dump for backup / migration. |

## Post format

```json
{
  "id": "sha256(canonical + | + signature)",
  "authorDid": "did:key:z…",
  "text": "…",
  "timestamp": "ISO-8601",
  "replyTo": "post-id or null",
  "attachments": ["cid:sha256:… (FallStore blobs)"],
  "signature": "base58/64(sig)"
}
```

The signed payload is a canonical JSON view of `{authorDid, text, timestamp, replyTo, attachments}` — deterministic, so peers get the same digest.

## Federation model

- Posts are broadcast on `fallcast:post`.
- Likes on `fallcast:like`. Tombstones on `fallcast:tomb`.
- When you follow a new DID, FallCast emits a `fallcast:request` gossip so peers can hydrate you with that author's history.
- A peer only stores a post if you follow the author (or it's a reply to something you already hold).

Nothing is authoritative except signatures.

## Estate primitives used

- **[FallID](https://sjgant80-hub.github.io/fallid/)** — DIDs, signing, verification.
- **[FallLink](https://sjgant80-hub.github.io/falllink/)** — peer gossip mesh.
- **[FallStore](https://sjgant80-hub.github.io/fallstore/)** — optional, for media attachments larger than an inline post.

## License

MIT. Fork it. Host it. Sign under your own DID.

## Provenance

Part of the AI-Native Solutions estate — sovereign primitives that compose. See [fallcolony](https://sjgant80-hub.github.io/fallcolony/) for the fork lineage.
