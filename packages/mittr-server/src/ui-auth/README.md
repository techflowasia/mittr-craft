# Company sign-in for hosted web

The server plugin can require a company sign-in before anyone opens the hosted web UI. It registers a UI auth provider through upstream's `context.uiAuth.registerProvider`. While that provider is registered, a server without a UI password still requires a UI session, and only this sign-in can issue one.

## Settings

Microsoft Entra is used when any of these is set. All four are required, and a partial set refuses to start the server.

- `MITTR_AD_CLIENT_ID`
- `MITTR_AD_CLIENT_SECRET`
- `MITTR_AD_TENANT_ID`: one tenant. `common`, `organizations` and `consumers` are refused.
- `MITTR_AD_REDIRECT_URI`: `https://<host>/auth/ad/callback`. Plain HTTP is accepted only on loopback. This is the only redirect URI ever sent.

Otherwise, LDAP or Active Directory is used when `MITTR_AD_ENABLED=true`. All four of these are then required:

- `MITTR_AD_URL`: `ldaps://` (recommended) or `ldap://`. With `ldap://`, passwords cross the network unencrypted, and the server warns about it on start.
- `MITTR_AD_BIND_DN`
- `MITTR_AD_BIND_PASSWORD`
- `MITTR_AD_SEARCH_BASE`

## The directory's TLS certificate

The directory's certificate is verified. If it comes from an internal CA, sign-in fails, and the log names the TLS error code (for example `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `SELF_SIGNED_CERT_IN_CHAIN`).

To fix it, start the server with `NODE_EXTRA_CA_CERTS=/path/to/internal-ca.pem`. Do not turn verification off.

The log never shows a password, the bind password or anything the person typed. That includes the user name and any DN they typed.

## Routes

These routes sit outside `/api`. Each one refuses tunnel and unknown-public requests with 403.

- `GET /auth/ad/status`
- `GET /auth/ad/login`: limited to 20 unfinished sign-ins per address. A slot is held from the moment a start begins, and released when the start fails, when the callback finishes (whether it succeeds or fails), or after 10 minutes. Each address may also start at most 60 sign-ins per 10 minutes, finished or not. At most 1000 sign-ins can be in progress at once; a new one is refused when that many are open, and no sign-in in progress is pushed out.
- `GET /auth/ad/callback`
- `POST /auth/ad/session`: LDAP only. Limited to 10 failed attempts per address per 5 minutes, then a 15-minute lockout. With `issueClientToken: true` in the body it also answers `clientToken` for a desktop app that cannot send the session cookie to another site; the token lasts as long as the session (12 hours, or 7 days on a trusted device), it is labelled "MittrCraft Desktop (<username>)" with control characters dropped from the username and at most 56 of its characters kept, and the person does not choose its kind.
  A desktop client token survives sign-out and sign-out everywhere until it expires (7 days at most) or is revoked in the device list, so a directory user who is disabled keeps desktop access to this server until then.
- `GET /auth/ad/profile`
- `DELETE /auth/session`: clears this browser's session and revokes its URL tokens.

Upstream's "sign out everywhere" (`POST /api/auth/reset`) rotates the secret that sessions are signed with.

## The `mittrcraft` command

`mittrcraft` runs upstream's server CLI with the same arguments. Before handing over, it fills in each of these only when it is unset:

- `OPENCHAMBER_SERVER_PLUGINS`: this plugin.
- `OPENCHAMBER_DATA_DIR`: `~/.config/mittrcraft`.
- The prod broker variables from `bin/product-env.json`, a copy of the `env` block of `brand/product.prod.json` that travels with the bin (a test keeps the two equal).
- The 1.22 names `MITTRCRAFT_UI_PASSWORD`, `MITTRCRAFT_ALLOW_UNAUTHENTICATED_LAN` and `MITTRCRAFT_DATA_DIR`, mapped onto their `OPENCHAMBER_*` names.

It refuses to start when a `MITTR_AD_*` setting is present but `OPENCHAMBER_SERVER_PLUGINS` does not load this plugin.

Run from a source checkout (a `.git` above the package), it also refuses to start unless `OPENCHAMBER_DATA_DIR` or `MITTRCRAFT_DATA_DIR` is set, so a developer's machine never runs a server on the installed app's data. A packed install has no `.git` and keeps the `~/.config/mittrcraft` default.

A packed install that sits under a git repository (for example a HOME kept in a dotfiles repo) is treated as a checkout, so it must set `OPENCHAMBER_DATA_DIR`.
