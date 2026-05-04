---
this: is
  : not [valid]
: yaml
---

# Body Without a Card

The block above looks like frontmatter at first glance but is not parseable
YAML. The renderer falls back to "no metadata card" without surfacing a
parse error. The body still renders correctly — micromark's frontmatter
extension consumes the leading delimiters either way.
