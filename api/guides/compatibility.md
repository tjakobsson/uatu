# Compatibility and revisions

UatuCode separates product identity from wire compatibility. A version or commit identifies a build; `hubApiRevision` and `workspaceApiRevision` identify incompatible public API generations. The bundled web-client freshness revision is unrelated to native-client compatibility.

`hubApiRevision` covers the Hub's operations, including the personal-state operations it serves under `/s/{workspaceId}/`, and the envelopes of its streams. `workspaceApiRevision` covers the workspace payloads the live stream forwards: `WorkspaceState` on the document topic, `ConversationInventoryEvent` on the inventory topic, and `ChatEvent` and `ChatResyncEvent` on the conversation topic. Since workspace revision 16 the routes the Hub proxies under `/s/{workspaceId}/` are internal, and no public revision describes them.

Record the revision pair used to generate or validate a client. At connection time, fetch authenticated Hub state and compare both reported public revisions with the pinned [contract metadata](../contract.json). Each workspace entry also reports the `workspaceApiRevision` its child speaks. It equals the top-level value for the local backend but may differ for backends running children of other builds, so a client reading one workspace's live payloads should compare the per-entry value.

Equal revisions mean the published wire contract is the intended baseline. A higher server revision requires checking the [API changelog](../CHANGELOG.md) and comparing your recorded copy of the contract with the current publication. Additive changes can occur without a revision increase, so clients must ignore unknown optional object fields where schemas permit them.

A lower or unknown revision is not proven compatible. Re-fetch the published contract, regenerate affected client types if needed, apply migration guidance, and rerun integration tests before updating the pinned pair.

The site publishes one contract, built from `main`, and it may document behavior not yet in any product release. Its metadata reports the `sourceCommit` it was built from; record that commit with your copy of the artifacts so the baseline you validated against stays identifiable.
