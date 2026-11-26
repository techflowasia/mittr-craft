# Bundled macOS permission setup

`createComputerControl().requestPermissions({ signal, token, grant, directCapture })`
requests OS consent through the exact bundled `CuaDriver.app`. It returns `true`
only when the permission result names that executable, reports `driver-daemon`
attribution, and confirms the requested grant. It returns `false` for missing
consent. Errors, cancellation, unsupported platforms and malformed results reject.
The default grant is Accessibility. Screenshots set `directCapture: true` and
require Screen Recording plus a successful live capture probe.

The action layer calls setup once after a permission failure. A denied request
ends that action. A later action can request again. A successful request replays
the original driver call once, with the original stop token. It never loops on
rejection or replays an action after the Computer tool is disabled.

## Pinned private driver contract

This adapter deliberately depends on cua-driver **0.28.2**, release tag
`cua-driver-rs-v0.28.2` in `trycua/cua`. Review these upstream sources whenever the
driver pin changes:

- `libs/cua-driver/rust/crates/cua-driver/src/cli.rs`,
  `run_permissions_host_request_if_requested` and
  `request_permissions_via_launchservices`.
- `libs/cua-driver/rust/crates/platform-macos/src/tools/check_permissions.rs`,
  `PERMISSIONS_HOST_REQUEST_ARG` and `request_from_launchservices_host`.

The private entrypoint is `__permissions-host-request --result-file <path>`.
`--probe-direct-capture` opts into the additional ScreenCaptureKit consent probe.
The result file must already exist in the process's temporary directory, with a
basename starting `cua-driver-permissions-` and ending `.json`. The driver opens
it with `O_NOFOLLOW`, mode 0600, and writes a tool-result envelope with
`structuredContent`. This route does not open a daemon socket.

MittrCraft launches this entrypoint with `/usr/bin/open -W -n -g -a <exact app>`,
passing only its filtered driver environment and an explicit TMPDIR. The public
`permissions grant` command is not suitable here: 0.28.2 hardcodes
`/Applications/CuaDriver.app` and the default driver socket.

`canRequestPermissions` reports whether this control has the macOS bundled app.
Actions retain their plain permission refusal when setup is unavailable, rather
than attempting a different installation. The direct setup API still reports
unsupported platform or missing-app errors explicitly.

Only one permission request may be active per control; a concurrent request
rejects with 409 rather than raising another dialog.

A UUID result filename identifies each request. The request is bounded to 180
seconds. Abort, stop, close, timeout or protocol failure scans processes for the
exact bundled executable plus this request's complete argv and stops only that
host. Cleanup scans for one additional second to catch a LaunchServices launch
already in flight. It never kills by bundle ID, resets TCC, uses the default
socket, or changes driver authorization modes. The result file is removed on all
settled paths. macOS owns its consent dialogs; killing the requesting host does
not promise that macOS will dismiss an already displayed system dialog.

The driver requests both Accessibility and Screen Recording in this private
route even when only Accessibility is needed. That is the pinned driver's
behavior, not a grant made by MittrCraft. The direct probe can write the driver's
own `~/.cua-driver/direct-capture-verification.json` evidence file, as upstream's
explicit grant command does.

## Permission gate readiness

The private socket can bind before the daemon's fresh TCC probe finishes.
Driver 0.28.2 `serve.rs::permission_gate_response_for_state` refuses every tool
before dispatch with this exact message:

```
permissions_pending: macOS Accessibility or Screen Recording permission is still pending; no action started, retry after the permission gate completes
```

The action layer makes its initial call with `waitForPermissions:false`. This
exact refusal becomes a typed `computer_permissions_pending` error immediately,
so a brand-new install can reach explicit consent instead of waiting for the
gate to time out. The action layer handles only that code, not arbitrary 403
errors. After successful consent it retries with `waitForPermissions:true`.
Direct control callers default to waiting, preserving read-only readiness checks.

Only this complete refusal permits waiting and replay. The control polls
`check_permissions` with `prompt:false` for at most ten seconds, with the turn's
abort signal and original daemon stop token. Once a probe succeeds it sends the
original action once. Other errors are not replayed by this path. The gate is
not an OS denial or approval; the daemon has explicitly said no action began.
No permission prompt is raised by readiness polling.

## Runtime scope and validation

This setup is macOS-only and requires the bundled app. Other platforms reject
with 501; a missing app rejects with 503. Existing action availability and local
request gates are unchanged. No web, VS Code, hosted-mobile or Capacitor client
gains a new local capability.

Unit tests inject a launcher, result files and process listing. They do not open
macOS consent UI. A real packaged-app permission request must separately verify
the prompt identity, denial followed by a later request, successful capture, and
cancellation. It must never reset TCC to manufacture a test state.
