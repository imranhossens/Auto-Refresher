# TODO

## Pending

### Set up Cloudflare Worker backend for cross-browser sync

**Why:** Cross-Device Sync works today only between devices on the *same browser,
same account* (via `chrome.storage.sync`). Linking **different** browsers needs a
network endpoint. The old kvdb.io backend is dead — it returns `HTTP 403` on every
write, which is what made the feature silently do nothing.

The extension side is already finished. The sync field accepts any `https://`
endpoint, so this is a paste, not a code change.

**Steps:**

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** →
   **Create** → **Worker** → deploy the starter.
2. **Storage & Databases** → **KV** → **Create namespace**, name `autorefresh-sync`.
3. Worker → **Settings** → **Bindings** → **Add** → KV namespace.
   Variable name **must** be `SYNC`.
4. Worker → **Edit code**, replace with the snippet below, Deploy.
5. Copy the worker URL and append a random secret word:
   `https://autorefresh-sync.<you>.workers.dev/k7fq2x`
6. Paste that full URL into **Sync Token or Endpoint URL** — identical text in
   *every* browser to be linked. Do **not** press Generate (that overwrites it
   with a kvdb.io token).

```js
export default {
  async fetch(request, env) {
    const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (!key) return new Response("", { status: 400, headers: cors });

    if (request.method === "POST") {
      await env.SYNC.put(key, await request.text(), { expirationTtl: 3600 });
      return new Response("ok", { headers: cors });
    }
    const value = await env.SYNC.get(key);
    return new Response(value ?? "", { status: value ? 200 : 404, headers: cors });
  },
};
```

**Endpoint contract** (if swapping in a different backend later):
- `GET <base>/<domain>` → returns stored string; `404` or empty = no activity.
- `POST <base>/<domain>` with body `<deviceId>|<timestamp>` → stores it.

**Verify:** popup sync panel shows `Sync OK`. Refresh a tracked site in browser B
→ browser A flips to `Paused — <domain> in use on another device`.

**Unverified:** the Worker snippet was never run against a live deployment — it
matches the extension's contract but step 6's status line is the real proof.

**Security note:** `Access-Control-Allow-Origin: "*"` plus open KV means the secret
path segment is the only access control. Fine for activity timestamps; don't store
anything else in that namespace.

---

## Done

- [x] Fix Cross-Device Sync not pausing auto-refresh. Root causes: the extension's
      own auto-reload registered as "user activity" so a job blocked itself; no
      device identity, so a device couldn't tell its own activity from another's;
      and failed network writes were swallowed instead of surfaced. Added a sync
      status line in the popup, and automatic fallback to browser sync.
