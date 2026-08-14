# Compatibility and revisions

UatuCode separates product identity from wire compatibility. A version or commit identifies a build; `hubApiRevision` and `workspaceApiRevision` identify incompatible public API generations. The bundled web-client freshness revision is unrelated to native-client compatibility.

Record the revision pair used to generate or validate a client. At connection time, fetch authenticated Hub state and compare both reported public revisions with the pinned [contract metadata](../contract.json). Each workspace entry also reports its own `workspaceApiRevision` — the revision spoken by that workspace's child — which equals the top-level value for the local backend but may diverge for backends running children of other builds; per-workspace integrations should compare the per-entry value. A direct workspace client compares the workspace revision reported by workspace state.

Equal revisions mean the corresponding published wire contract is the intended baseline. A higher server revision requires checking the [API changelog](../CHANGELOG.md) and comparing the pinned immutable contract with the target publication. Additive changes can occur without a revision increase, so clients must ignore unknown optional object fields where schemas permit them.

A lower or unknown revision is not proven compatible. Select the matching immutable revision artifact, regenerate affected client types if needed, apply migration guidance, and rerun integration tests before updating the pinned pair.

`edge` tracks validated source from `main`; `latest` tracks the newest release; numbered revision snapshots are immutable. Production clients should pin a released snapshot rather than `edge`.
