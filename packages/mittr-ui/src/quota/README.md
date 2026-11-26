# Mittr AI refresh

`MittrAIRefresh` mounts inside the sign-in gate and registers a provider refresh hook with the shared quota store. Usage refresh and the existing reference-counted three-minute quota cadence force a fresh alias-status read. Catalog discovery posts `{ "force": false }` to `/api/mittr/catalog/sync`; the server owns the 60-second successful-apply freshness gate. Catalog events reload providers through the existing config event path, not `initializeApp`.

The open model picker and mounted Today page participate in the existing cadence. Picker opening also requests catalog discovery. Focus and visibility return revalidate quota after 30 seconds and request catalog discovery. Catalog and quota failures settle independently. No image meter or overall quota calculation changes here.

`quotaMeStore` parses explicit alias status first, then fills missing aliases from chat-line `agents[].key`, retaining direct `modelKey` lookup for older callers. Today alerts iterate only aliases from the reactive provider catalog, so raw backend buckets do not appear as agents.

Account and runtime transitions abort catalog requests and advance the quota controller generation. A previous A request cannot commit after A to B to A. Shared provider invalidation aborts and clears only the affected provider. Unmount removes the hook, listeners and owner watches. Web, Electron, hosted mobile and Capacitor use `runtimeFetch`; VS Code keeps its existing unsupported-route behavior. The server remains responsible for authentication and enterprise policy enforcement.
