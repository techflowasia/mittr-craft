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

### Secrets from a file

`MITTR_AD_CLIENT_SECRET_FILE` and `MITTR_AD_BIND_PASSWORD_FILE` name a file that holds the client secret or the bind password, for example a mounted container secret. The server reads each file once at start. One trailing line break is dropped. A `_FILE` setting wins over the plain variable, and a file that cannot be read refuses the start.

With the `_FILE` form, the secret is never in any process environment. A process listing such as `ps eww` cannot show it, and nothing the server starts inherits it. The file stays readable by the account the server runs as, and agents run as that account too, so keep the file outside the projects people open.

Set only the `_FILE` variable, not the plain one as well. The plain copy would stay in the server's starting environment, where `ps eww` shows it, even though the file wins.

`mittrcraft startup install` writes the current environment into the launchd plist, or into the `startup.env` file that the systemd unit reads. A plain secret would be stored in that file. For a startup service, use the `_FILE` form.

### Kept from the engine

The engine runs agents' shell commands, so it never sees the sign-in settings. At start the server plugin takes every `MITTR_AD_*` variable out of the server's own environment. Then, on every engine start, version probe, install and upgrade, it sets each of them to unset. This removes the copy that upstream's login-shell snapshot took before the plugin loaded.

A `MITTR_AD_*` variable set only in the login shell is taken the same way: upstream copies the snapshot into the server's environment as it loads, before any plugin starts. Any `MITTR_AD_*` name still in the server's environment when the engine starts is unset by its prefix too.

The same happens to the server's other secrets:
- `OPENCHAMBER_UI_PASSWORD`, `MITTRCRAFT_UI_PASSWORD` and `OPENCODE_UI_PASSWORD`
- `OPENCODE_JWT_SECRET`
- `OPENCHAMBER_TUNNEL_TOKEN` and `NGROK_AUTHTOKEN`
- `OPENCHAMBER_APNS_P8`, `OPENCHAMBER_APNS_KEY_ID` and `OPENCHAMBER_APNS_TEAM_ID`
- `OPENCHAMBER_LINEAR_CLIENT_SECRET`
- `OPENCHAMBER_JEV_API_KEY`

The server keeps these secrets, and only the engine loses them. A contract check fails when upstream starts reading a secret that is on neither this list nor the list of those it means its children to have. The agent tool's token and URL, the engine's own password, provider keys and the broker settings still reach the engine.

Under Bun, a variable taken out of `process.env` still reaches a child process started without an explicit environment. For that reason, `mittrcraft` runs the server on Node (see below). When `mittrcraft` itself is run by Bun and `MITTR_AD_CLIENT_SECRET` or `MITTR_AD_BIND_PASSWORD` is set, it refuses to start, and says to run it with Node or to use the `_FILE` form.

## The directory's TLS certificate

The directory's certificate is verified. If it comes from an internal CA, sign-in fails, and the log names the TLS error code (for example `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `SELF_SIGNED_CERT_IN_CHAIN`).

To fix it, start the server with `NODE_EXTRA_CA_CERTS=/path/to/internal-ca.pem`. Do not turn verification off.

The log never shows a password, the bind password or anything the person typed. That includes the user name and any DN they typed.

## Routes

These routes sit outside `/api`. Each one refuses tunnel and unknown-public requests with 403.

- `GET /auth/ad/status`
- `GET /auth/ad/login`: limited to 20 unfinished sign-ins per address. A slot is held from the moment a start begins, and released when the start fails, when the callback finishes (whether it succeeds or fails), or after 10 minutes. Each address may also start at most 60 sign-ins per 10 minutes, finished or not. At most 1000 sign-ins can be in progress at once; a new one is refused when that many are open, and no sign-in in progress is pushed out.
- `GET /auth/ad/callback`
- `POST /auth/ad/session`: LDAP only. Limited to 10 failed attempts per address per 5 minutes, then a 15-minute lockout. With `issueClientToken: true` in the body it also answers `clientToken` for a desktop app that cannot send the session cookie to another site; the token lasts as long as the session (12 hours, or 7 days on a trusted device), it is labelled "MittrCraft Desktop (<username>)", with control and format characters dropped from the username and the name shortened (never inside a character) so the label fits the 80 UTF-16 units the client store keeps, or plain "MittrCraft Desktop" when nothing of the name is left, and the person does not choose its kind.
  A desktop client token survives sign-out and sign-out everywhere until it expires (7 days at most) or is revoked in the device list, so a directory user who is disabled keeps desktop access to this server until then.
- `GET /auth/ad/profile`
- `DELETE /auth/session`: clears this browser's session and revokes its URL tokens.

Upstream's "sign out everywhere" (`POST /api/auth/reset`) rotates the secret that sessions are signed with.

## The `mittrcraft` command

`mittrcraft` runs upstream's server CLI with the same arguments. Before handing over, it fills in each of these only when it is unset:

- `OPENCHAMBER_SERVER_PLUGINS`: this plugin.
- `OPENCHAMBER_DATA_DIR`: `~/.config/mittrcraft`.
- Every product variable from `bin/product-env.json`, a copy of the `env` block of `brand/product.prod.json` that travels with the bin (a test keeps the two equal), with `~/` read as the home folder. These variables:
  - turn off the update check and the models.dev catalog;
  - keep the engine registry and the engine config under `~/.config/mittrcraft`;
  - fix the broker to the prod Mittr.

  With its own data dir (`OPENCHAMBER_DATA_DIR` or `MITTRCRAFT_DATA_DIR` set to anything but `~/.config/mittrcraft`), the bin derives the engine from it instead, for each variable left unset:
  - `MITTRCRAFT_ENGINE_HOME` is `<data dir>/engine`, so all four engine bases sit there and none under `~/.config`, `~/.local` or `~/.cache`;
  - `OPENCODE_CONFIG_DIR` is `<data dir>/engine/opencode`;
  - `OPENCHAMBER_MANAGED_PROCESS_REGISTRY` is `<data dir>/managed-opencode`.

  `MITTRCRAFT_ENGINE_HOME` set by hand also moves `OPENCODE_CONFIG_DIR` to `<engine home>/opencode`, unless that is set too.

  `OPENCHAMBER_POLICY_FILE` names a macOS path, so it is applied on macOS only. Elsewhere upstream's fixed policy paths stay in force, such as `/etc/openchamber/policy.json` on Linux.
- `BUN_BINARY`: the Node that runs `mittrcraft`, recorded in `MITTRCRAFT_BIN_BUN_BINARY`.
  - Upstream's daemon then runs the server on Node instead of Bun, so a variable the plugin takes out of the environment reaches no child.
  - Once the server runs, the plugin removes both variables again, so neither the server's own Bun lookups nor terminals nor the engine see Node as Bun. A login-shell copy is unset for the engine too.
  - Setting `BUN_BINARY` yourself brings Bun back, and the plugin leaves your value alone.
  - On Windows, upstream checks `BUN_BINARY` by running it without `cmd.exe`, so a `bun.cmd` shim cannot be named there. To run on Bun, name `bun.exe` itself. Otherwise the daemon falls back to Node.
- The 1.22 names `MITTRCRAFT_UI_PASSWORD`, `MITTRCRAFT_ALLOW_UNAUTHENTICATED_LAN` and `MITTRCRAFT_DATA_DIR`, mapped onto their `OPENCHAMBER_*` names.

It refuses to start when a `MITTR_AD_*` setting is present but `OPENCHAMBER_SERVER_PLUGINS` does not load this plugin.

Install ripgrep on the server; MittrCraft does not let the engine fetch it from github.com unless you opt in with `MITTRCRAFT_ALLOW_RIPGREP_DOWNLOAD=1`. Without an `rg` on the `PATH` that `mittrcraft` runs with, a command that would start the server exits with an error before anything listens. With the opt-in, it starts, logs `[mittr] rg is missing; the engine will download it from github.com on first use` once, and the engine downloads `rg` on first use. The desktop app ships its own `rg` and is not affected.

Run from a source checkout (a `.git` above the package), it also refuses to start unless `OPENCHAMBER_DATA_DIR` or `MITTRCRAFT_DATA_DIR` is set. With that data dir the engine, its config and the registry follow it, as above, so a developer's machine never runs a server on the installed app's data or engine folders. A packed install has no `.git` and keeps the `~/.config/mittrcraft` default.

The bin is shipped only as this package: `npm pack` carries `bin/` whole, `product-env.json` included, and a test checks it. The desktop app packs only the plugin bundle, not this bin, and upstream's Docker image copies only `packages/web`.

A packed install that sits under a git repository (for example a HOME kept in a dotfiles repo) is treated as a checkout, so it must set `OPENCHAMBER_DATA_DIR`.
