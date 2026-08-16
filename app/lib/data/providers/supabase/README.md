# Supabase adapter (designed-in — Section 6B)

Provider-specific Supabase code lives ONLY in this folder. Planned mapping
(implemented later):

- `objects` / `object_types` / `settings` — Postgres tables mirroring the same
  logical records as `om_objects{ext}` / `om_object_types` / `settings`.
- Supabase Realtime replaces Firestore listeners for `DataProvider.subscribe`.
- Supabase Storage replaces Firebase Storage for `DataProvider.uploadFile`.
- Supabase Auth replaces Firebase Auth (Section 6B auth abstraction).

Hard rules:

- This folder must NEVER import `firebase-admin` or any Firestore code.
- The Firestore adapter folder must NEVER import Supabase code.
- Both adapters share only the `DataProvider` contract and `lib/data/common/`.
