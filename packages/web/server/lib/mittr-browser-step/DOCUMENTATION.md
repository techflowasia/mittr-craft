# Mittr Browser Step module

Asks the Mittr platform which step to take next on a Chrome page, for the
`chrome.do` action in `../mittrcraft-control`.

## Scope

- `service.js` owns the one outbound call, `POST /desktop/browser/next-step`,
  authorised with the desktop session that already gates the app. It sends the
  goal, the page snapshot, the steps taken so far and any values the platform
  handed back earlier.
- The platform owns the decision model, its credentials and its settings (the
  "Fast decisions" card on the Studio admin page). This install never holds a
  model key.

## Invariants

- No session means `401`, and a platform that is not configured for this
  install means the stepper is absent (`null`), so `chrome.do` can say which
  one it is.
- A step is used only if it is complete: an action from the fixed set, an
  element ref for click/fill/select, and a value for fill/select. Anything else
  is a `502`, never a guessed step.
- The platform's own error message is passed through unchanged.
