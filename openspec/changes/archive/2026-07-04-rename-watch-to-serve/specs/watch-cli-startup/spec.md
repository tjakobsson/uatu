## REMOVED Requirements

### Requirement: Start a local document watch session
**Reason**: Superseded in full by the `serve-cli-startup` capability — the command surface is renamed from `uatu watch` to `uatu serve`, with a bare-invocation default.
**Migration**: Use `uatu serve [PATH...]` (or bare `uatu [PATH...]`). `uatu watch` continues to work for one release as a deprecated alias that forwards to `serve` with a stderr warning; see `serve-cli-startup`'s "Deprecated `watch` alias" requirement.

### Requirement: Configure startup browser behavior
**Reason**: Superseded by the identically named requirement in `serve-cli-startup`; behavior is unchanged, only the command verb in the contract moves to `serve`.
**Migration**: None — `--no-open` and `--no-follow` behave identically under `uatu serve`.

### Requirement: Configure startup diagnostic behavior
**Reason**: Superseded by the identically named requirement in `serve-cli-startup`; behavior is unchanged, only the command verb in the contract moves to `serve`.
**Migration**: None — `--debug`, `--no-watchdog`, `--watchdog-timeout`, and the corresponding environment variables behave identically under `uatu serve`.
