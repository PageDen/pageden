# Public sharing and folder manuals

Pageden can publish read-only public links for canonical documents and folders. A folder share is presented as a public manual: an `index` or `readme` document is used as the landing page when present, otherwise the first canonical document in the folder subtree is used. Every canonical descendant document is available through stable document-id URLs.

Public sharing is available in the core self-host app and hosted deployments. Workspace admins can disable it for a workspace.

## Enable or disable public sharing

Workspace admins control the workspace-level kill switch:

1. Open the workspace.
2. Open **Admin**.
3. Open **Settings**.
4. In **Public sharing**, enable or disable **Allow public share links**.

When disabled:

- existing public links return the unavailable state,
- new document shares cannot be created,
- new folder manual shares cannot be created.

Re-enabling public sharing makes existing active, unexpired links resolve again.

## Publish a document

1. Open a document.
2. Open **Share** or the document permissions dialog.
3. Create a public link.
4. Optionally set a password, expiration, or search-indexing preference.
5. Copy the generated link.

Browser URL:

```text
/s/:slug
```

The public page renders the document Markdown without requiring a signed-in session. If the share has a password, visitors are prompted before the document opens.

## Publish a folder as a manual

1. In the workspace tree, open the folder action menu.
2. Choose **Publish as manual**.
3. Create a public link.
4. Optionally set a password, expiration, or search-indexing preference.
5. Copy the generated link.

Manual landing URL:

```text
/s/:slug
```

Manual page URL:

```text
/s/:slug/p/:docId
```

The `docId` route is stable across document renames and moves within the shared folder subtree. If a document is moved outside the shared subtree, the public manual page returns unavailable.

Only canonical documents are included in the manual navigation. Drafts, deleted documents, and documents outside the shared subtree are hidden.

## Passwords

Password-protected public links return a password prompt in the browser. The public JSON API returns:

- `401 { "error": "password_required" }` when no password is supplied,
- `403 { "error": "wrong_password" }` when the password is incorrect.

Passwords are not embedded in public URLs by the app. The browser keeps a successfully entered password in memory for same-session manual navigation, including protected attachment loads.

## Revoked, expired, or disabled links

The public reader shows an unavailable state when:

- the share was revoked,
- the share expired,
- the workspace public sharing setting is disabled,
- the document or folder is deleted,
- a manual page points outside the shared subtree.

These states intentionally do not reveal which condition applied.

## API contract

Browser-facing public routes are owned by the single-page app:

```text
/s/:slug
/s/:slug/p/:docId
```

JSON and attachment reads use the public API:

```text
GET /api/public/shares/:slug
GET /api/public/shares/:slug/page?docId=:docId
GET /api/public/shares/:slug/attachments/:attachmentId
```

Optional password query parameter for API clients:

```text
GET /api/public/shares/:slug?password=...
GET /api/public/shares/:slug/page?docId=:docId&password=...
GET /api/public/shares/:slug/attachments/:attachmentId?password=...
```

Public API responses include `x-robots-tag` according to the share's indexing preference.

## Self-host routing

The self-host web container serves a React single-page app through nginx. `apps/web/nginx.conf` uses:

- `location / { try_files $uri $uri/ /index.html; }` for browser routes, including `/s/:slug` and `/s/:slug/p/:docId`;
- `location /api/ { proxy_pass http://server:4000; }` for API routes, including `/api/public/shares/...`.

If you put another reverse proxy in front of the Pageden web container, send all non-API browser traffic to the web container and do not route `/s/...` directly to the server. Direct refreshes on public manual URLs must return the web app's `index.html`.

Minimum external proxy behavior:

```text
/api/*          -> Pageden web container, which proxies to the server
/mcp            -> Pageden web container, which proxies to the server
/.well-known/*  -> Pageden web container, which proxies to the server
/*              -> Pageden web container SPA
```

The recommended self-host path is to expose only the web container publicly and let its bundled nginx handle the internal server proxy.
