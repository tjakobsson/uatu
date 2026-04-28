# Markdown Cross-Document Links

This fixture exercises the cross-document link path for Markdown — the
rendered `<a href>` MUST keep the original `.md` extension so the in-app
static-file fallback can resolve the link against the watched root.

## Sibling document

See the [main README](README.md) for the project intro.

## Nested document

See [the setup guide](guides/setup.md) for the run-through.

## External

External links are unaffected: <https://example.com>.
