# The MittrCraft engine

MittrCraft runs a coding agent engine in a child process. That engine is a fork
of an upstream MIT-licensed project, built here from source with a small patch
set rather than downloaded as a prebuilt binary.

## Why a fork at all

Two things a user sees are baked into the engine and reachable no other way:

- **Identity.** Nine prompt files tell the model what it is, one per provider
  family. Left alone, a user who asks "who are you" is told the upstream
  product's name.
- **The project directory.** The engine reads `.opencode/` in a repository for
  agents, commands, plugins, skills and config. The name is a literal in the
  source and no environment variable overrides it.

The alternative was stripping the engine's behavioural prompt at runtime to hide
the name, which trades away the instructions that teach the model to call tools —
the part a coding agent is made of.

## Why the patch set stays thin

Upstream ships roughly every 1.4 days. Keeping our changes to string literals and
one small helper means moving to a newer tag is a mechanical step we choose to
take, not a merge we are forced through. **Resist adding behaviour here.** Work
that belongs to MittrCraft belongs in `packages/`, where it costs nothing at
upgrade time.

If a patch stops applying cleanly, that is information: read what upstream
changed before reaching for `--3way`.

## What the patch changes

| | |
| --- | --- |
| Identity | 9 prompt files, first line of each |
| Project directory | `.mittr` is read first, `.opencode` still read |
| Config file | `mittr.json` / `mittr.jsonc` alongside the upstream names |
| New files | written to `.mittr` — plans, agents, plugins, themes, tui config |

`.opencode/` stays readable on purpose: a developer who already has one keeps
working, and a repository can carry both while a team moves across.

Left alone deliberately: the installer's own `~/.opencode/bin` paths. They
describe where the upstream CLI installs itself, which is not something we
distribute.

## Building

```bash
node scripts/build-engine.mjs
```

Clones the pinned tag from `engine/UPSTREAM_VERSION`, applies every patch in
`engine/patches/`, installs, typechecks and builds. It then reads the binary back
and fails if the identity strings are not ours — the build script's own smoke
test proves the binary runs, not that our patches took.

Requires Bun 1.3+; upstream pins the same version this repository does.

## Moving to a newer upstream

1. Change `engine/UPSTREAM_VERSION`.
2. Run the build. If every patch applies, you are done.
3. If one conflicts, open the file upstream changed and rewrite that hunk. Then
   regenerate the patch from the working tree:

   ```bash
   git -C <work>/opencode diff > engine/patches/0001-mittrcraft-identity-and-project-directory.patch
   ```

4. Verify against a real model before shipping. The identity check in the build
   script proves the strings changed; it does not prove the engine still drives a
   session correctly.

## Building every target

```bash
node scripts/build-engine.mjs --all
```

Bun cross-compiles: one machine produces all twelve targets upstream defines —
linux, darwin and windows, arm64 and x64, plus musl and baseline variants. This is
measured, not assumed: all twelve were built from a single macOS machine, and the
identity patch is present in each. Two gigabytes in total.

The binary reports the version in `engine/UPSTREAM_VERSION`, because the build
script passes it as `OPENCODE_VERSION`. Without that it stamps a `0.0.0-` string
and the packaging step rejects it — correctly, since it verifies the prepared
engine reports the pinned version.

## Getting a built engine into the desktop app

`packages/electron/scripts/prepare-opencode-cli.mjs` downloads a release from
upstream by default. Set `MITTRCRAFT_ENGINE_BINARY` to a path and it installs that
instead, keeping the version verification that a download would get.

```bash
MITTRCRAFT_ENGINE_BINARY=/path/to/opencode bun run --cwd packages/electron build
```

`.github/workflows/engine.yml` builds every target and publishes one artifact per
platform the desktop ships. It is a separate workflow from Release on purpose: it
has never run, and a mistake in it must not be able to break a release. Once it
passes, the desktop jobs in `release.yml` can download the artifact for their
platform and set `MITTRCRAFT_ENGINE_BINARY` before packaging.

Signing needs nothing new. The engine ships through `extraResources`, and the app
is built with `hardenedRuntime`, `notarize` and `entitlementsInherit`, so nested
binaries are signed with it.

## Known gaps

- Cross-compilation is proven from a macOS host. The workflow runs on Linux, and
  that first run is the test.
- The engine is built but not yet consumed by `release.yml`. Until that is wired,
  releases still bundle the upstream binary — with the upstream identity.

## Attribution

The upstream project is MIT licensed and its notice ships in
`THIRD-PARTY-NOTICES.md`. Forking does not remove that obligation.
