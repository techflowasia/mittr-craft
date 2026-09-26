# Mittr Goal Judge module

Asks the Mittr platform whether each acceptance criterion of a Mittr goal is
met, for the judge step in `../session-goal`.

## Scope

- `service.js` owns the one outbound call, `POST /desktop/goal/judge`,
  authorised with the desktop session that already gates the app. It sends the
  objective, the criteria that need judgement (id and text), the tool-record
  digest and the agent's report.
- The platform owns the decision (`goal.criterion`), the fast decision model,
  its credentials and its settings (the "Fast decisions" card on the Studio
  admin page). This install never holds a model key.

## Invariants

- No platform configured for this install means the judge is absent (`null`);
  no session means `401`. Either way `session-goal` falls back to the
  session's small model, so a signed-out install still gets judged goals.
- Only results for criteria that were asked, with a verdict from the fixed set
  (`met`, `missing`, `needs_person`), are used. A criterion the platform could
  not decide is left out and judged by the fallback.
- The platform's own error message is passed through unchanged.
