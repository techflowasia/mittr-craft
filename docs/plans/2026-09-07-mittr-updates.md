# Mittr Update Channel Implementation Plan

> **For agentic workers:** implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the packaged application a working update button whose artifacts only somebody signed in to Mittr can download.

**Architecture:** The application already contains the whole `electron-updater` stack; only the source of updates is missing and the one configured points at a repository that does not exist. This plan points the updater at a generic feed hosted by Mittr and attaches the session the application already holds.

**Tech Stack:** Electron, electron-updater, electron-builder, vitest, bun.

**Spec:** `docs/specs/2026-09-07-mittr-platform-integration.md` (§10)

**Depends on:** `docs/plans/2026-09-07-mittr-sign-in.md`

## Global Constraints

- Packaged builds only; the feed URL ships in the build. (spec §4.1)
- No credential on disk beyond the Mittr session. No download token is embedded. (spec §4.2, §10)
- Code signing and notarisation are prerequisites, not polish. (spec §10)
- Everything in this repository is written in English. Thai appears only in UI strings.
- No mention of AI assistants in commits, code, or documentation.
- Run commands with `bun`.

---

### Task 1: Feed configuration

**Files:**
- Create: `packages/electron/update-feed.mjs`
- Test: `packages/electron/update-feed.test.mjs`

**Interfaces:**
- Produces: `buildUpdateFeed({ baseUrl, channel, accessToken }) -> { provider, url, channel, requestHeaders }`, throws when the base URL is missing or not https.

- [ ] **Step 1: Write the failing test**

```javascript
import { describe, expect, it } from 'vitest';
import { buildUpdateFeed } from './update-feed.mjs';

describe('buildUpdateFeed', () => {
  it('builds a generic feed carrying the session', () => {
    expect(buildUpdateFeed({
      baseUrl: 'https://mittr.test/desktop/updates',
      channel: 'latest',
      accessToken: 'at-1',
    })).toEqual({
      provider: 'generic',
      url: 'https://mittr.test/desktop/updates',
      channel: 'latest',
      requestHeaders: { authorization: 'Bearer at-1' },
    });
  });

  it('omits the authorization header when there is no session', () => {
    const feed = buildUpdateFeed({ baseUrl: 'https://mittr.test/desktop/updates', channel: 'latest', accessToken: '' });
    expect(feed.requestHeaders).toEqual({});
  });

  it('strips a trailing slash so the manifest path stays predictable', () => {
    expect(buildUpdateFeed({ baseUrl: 'https://mittr.test/desktop/updates/', channel: 'latest', accessToken: 'at-1' }).url)
      .toBe('https://mittr.test/desktop/updates');
  });

  it('refuses a plaintext feed, which would let anyone serve an installer', () => {
    expect(() => buildUpdateFeed({ baseUrl: 'http://mittr.test/desktop/updates', channel: 'latest', accessToken: 'at-1' }))
      .toThrow(/https/);
  });

  it('refuses a missing feed rather than silently never updating', () => {
    expect(() => buildUpdateFeed({ baseUrl: '', channel: 'latest', accessToken: 'at-1' })).toThrow(/base url/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun run --cwd packages/electron test -- update-feed
```

Expected: FAIL, cannot resolve `./update-feed.mjs`.

- [ ] **Step 3: Write the implementation**

```javascript
// An update feed is the most dangerous URL the application talks to: whatever it
// serves gets installed. Plaintext is refused outright rather than warned about.
export const buildUpdateFeed = ({ baseUrl, channel, accessToken }) => {
  const raw = String(baseUrl ?? '').trim();
  if (!raw) throw new Error('Update feed base url is required');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Update feed base url is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Update feed base url must use https: ${raw}`);
  }

  const token = String(accessToken ?? '').trim();
  return {
    provider: 'generic',
    url: raw.replace(/\/+$/, ''),
    channel,
    requestHeaders: token ? { authorization: `Bearer ${token}` } : {},
  };
};
```

- [ ] **Step 4: Run the tests**

```bash
bun run --cwd packages/electron test -- update-feed
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/electron/update-feed.mjs packages/electron/update-feed.test.mjs
git commit -m "feat(mittr): build an authenticated generic update feed"
```

---

### Task 2: Point the updater at Mittr

`packages/electron/main.mjs` imports `electron-updater` at line 12 and takes
`autoUpdater` at line 241, and `checkForDesktopUpdate` in `updater-check.mjs`
receives `autoUpdater` as an argument. No `setFeedURL` call exists today, so the
updater falls back to the `publish` block in `packages/electron/package.json`.

**Files:**
- Modify: `packages/electron/main.mjs` (near line 241)
- Modify: `packages/electron/package.json` (the `publish` block)

- [ ] **Step 1: Correct the publish block**

`packages/electron/package.json` currently reads:

```json
"publish": {
  "provider": "github",
  "owner": "mittrcraft",
  "repo": "mittrcraft"
}
```

`github.com/mittrcraft/mittrcraft` does not exist. Replace it with the generic
provider so the packaged manifest matches the feed the application asks for:

```json
"publish": {
  "provider": "generic",
  "url": "https://mittr.asia/desktop/updates",
  "channel": "latest"
}
```

Confirm the host with whoever owns update hosting before committing; open
question 1 in the spec has not been answered yet, and this URL is the answer.

- [ ] **Step 2: Set the feed at runtime**

In `main.mjs`, beside the `const { autoUpdater } = updaterPkg;` line, add the
import:

```javascript
import { buildUpdateFeed } from './update-feed.mjs';
```

and the feed base url, which ships with the build rather than being read from the
environment (spec §4.1):

```javascript
// Keep this in step with the `publish.url` in package.json. The packaged
// manifest and the runtime feed must name the same host, or the application
// checks one place while releases land in another.
const UPDATE_FEED_BASE_URL = 'https://mittr.asia/desktop/updates';
```

and set the feed before any update check runs, refreshing the header whenever the
session changes:

```javascript
const applyUpdateFeed = (accessToken) => {
  try {
    const feed = buildUpdateFeed({
      baseUrl: UPDATE_FEED_BASE_URL,
      channel: resolveUpdaterChannel({ platform: process.platform, architecture: process.arch }),
      accessToken,
    });
    autoUpdater.setFeedURL(feed);
    // electron-updater reads requestHeaders separately from the feed object for
    // the artifact download, so setting it on the feed alone is not enough.
    autoUpdater.requestHeaders = feed.requestHeaders;
  } catch (error) {
    log.warn('[electron] update feed unavailable:', error?.message ?? error);
  }
};
```

`resolveUpdaterChannel` is already exported from `./updater-channel.mjs`; import
it rather than deriving the channel again.

- [ ] **Step 3: Refresh the header after sign-in**

Call `applyUpdateFeed(session.accessToken)` when the local server reports a new
session, and `applyUpdateFeed('')` on sign-out. Without this, a build that
started signed out keeps sending no authorization and every check returns 401.

- [ ] **Step 4: Verify the check reaches the feed**

Run the packaged application against a staging feed and confirm the request
carries the header:

```bash
bun run --cwd packages/electron build
```

Then trigger the in-application update check and read the server log for the
manifest request. A 401 means step 3 did not run; a 404 means the manifest is not
published at that path.

- [ ] **Step 5: Commit**

```bash
git add packages/electron/main.mjs packages/electron/package.json
git commit -m "feat(mittr): fetch updates from Mittr with the signed-in session"
```

---

### Task 3: Confirm signing, do not rebuild it

**Corrected 2026-09-08.** This task previously told you to add `hardenedRuntime`,
`gatekeeperAssess` and `notarize` to the mac build block and described signing as
a missing prerequisite. All three are already set in
`packages/electron/package.json`, `entitlementsInherit` is configured so nested
binaries in `extraResources` are signed with the app, and `release.yml` already
installs an Apple certificate into a temporary keychain and verifies signature,
entitlements and notarization after the build. Adding what is there would have
been noise at best.

The engine binary ships through `extraResources` as `resources/opencode-cli`, so
it is signed as part of the app rather than separately.

**Files:**
- Create: `docs/RELEASING.md`

- [ ] **Step 1: Confirm the secrets exist, rather than the configuration**

The configuration is in place; what cannot be read from this repository is
whether the secrets behind it are populated. Check that `APPLE_CERTIFICATE`,
`APPLE_CERTIFICATE_PASSWORD` and the notarisation credentials are set on the
repository, and that the certificate has not expired. A missing secret fails the
release job, which is the good case; an expired certificate signs nothing and is
the case worth catching before a release.

- [ ] **Step 2: Write the release document**

Create `docs/RELEASING.md` covering which secrets the release job needs, how to
confirm a build is signed, and how to confirm it is notarised.

```markdown
# Releasing MittrCraft

## Signing

Configured already: `hardenedRuntime`, `notarize` and `entitlementsInherit` in
`packages/electron/package.json`, and certificate installation plus verification
in `.github/workflows/release.yml`. The engine binary is signed with the app
because it ships inside `extraResources`.

| Secret | What it is |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of the Developer ID .p12 |
| `APPLE_CERTIFICATE_PASSWORD` | password for that certificate |

## Verifying a build before publishing

```bash
codesign --verify --deep --strict --verbose=2 "dist/mac/MittrCraft.app"
spctl --assess --type execute --verbose "dist/mac/MittrCraft.app"
xcrun stapler validate "dist/mac/MittrCraft.app"
```

All three must pass. `spctl` reporting `rejected` means the build installs once
by hand and then fails every automatic update.

## Publishing

Upload the installers together with the `latest-mac.yml` and `latest.yml`
manifests. The manifests are what the application reads; an installer published
without its manifest is invisible to every client.
```

- [ ] **Step 3: Commit**

```bash
git add docs/RELEASING.md
git commit -m "docs(release): record what signing already covers and how to verify it"
```

---

### Task 4: End-to-end verification

An update path that is only unit-tested is an update path nobody has seen work.

- [ ] **Step 1: Publish a build one version ahead**

Bump the version, build, and upload the installer with its manifest to the
staging feed.

- [ ] **Step 2: Install the older build and check for updates**

Install the previous version on a clean machine, sign in, and trigger the update
check. Expected: the update downloads, the restart prompt appears, and after the
restart the version has changed.

- [ ] **Step 3: Confirm the feed is actually protected**

```bash
curl -i https://mittr.asia/desktop/updates/latest-mac.yml
```

Expected: 401. A 200 means the artifacts are public and step 1 of Task 2 was
pointed at the wrong host.

- [ ] **Step 4: Confirm a signed-out application does not silently stop updating**

Sign out and trigger a check. Expected: a message saying sign-in is required.
Silence here is the failure this whole design is meant to avoid (spec §9).

- [ ] **Step 5: Run the whole suite**

```bash
bun run type-check && bun run lint && bun run test
```

`packages/web/server/lib/github/pr-status.test.js` fails on `develop` already and
is unrelated; everything else must pass.

- [ ] **Step 6: Commit any fixes found during verification**

```bash
git add -u
git commit -m "fix(mittr): correct update feed handling found in end-to-end verification"
```

---

## Open question this plan cannot close

Spec §14 asks where Mittr hosts update artifacts and who owns that storage. Task
2 step 1 writes a URL into the build; that URL is the answer, and it needs an
owner before the first release. Until somebody owns it, the update button points
at a host nobody maintains.
