import type { StatePayload } from "../../src/shared/types";
import { renderMarkdownToHtml, renderCodeAsHtml } from "../../src/render/markdown";
import { renderAsciidocToHtml } from "../../src/render/asciidoc";

/** Literal, memory-only examples. Never resolve a fixture name against disk. */
export const previewExamples = [
  { path: "examples/START-HERE.md", kind: "markdown", source: `---
title: Preview field guide
author: Synthetic reviewer
tags: [examples, mobile]
status: draft
---
# Preview field guide

These examples are shared by every synthetic workspace. No live workspace was read.

## Choose a trail

| Example | What to explore |
| --- | --- |
| [Field notes](guides/field-notes.md) | Lists, quotes, images and typography |
| [Architecture](guides/architecture.md) | Flow and sequence diagrams |
| [Runbook](operations/runbook.adoc) | AsciiDoc tables, admonitions and code |
| [Reference](operations/reference.adoc) | Nested sections and cross-document links |
| [Release checklist](releases/2026/checklist.md) | Deep folders and task lists |

![A synthetic coastal landscape](media/coast.svg)

Return to the unchanged [workspace README](../README.md).
` },
  { path: "examples/guides/field-notes.md", kind: "markdown", source: `# Field notes

An intentionally small expedition through **bold text**, *emphasis*, ~~old plans~~ and inline <code>sample.code</code>.

> Read slowly. This landscape, its measurements and its people are invented.

## Packing list

- Notebook
  - Weather observations
  - Sketches of the shoreline
- Water and a warm layer

1. Start at the ridge.
2. Follow the marked path.
3. Record a short observation.

![Coast with mountains, sea and a sun](../media/coast.svg)

## Observations

| Station | Temperature | Visibility | Notes |
| :--- | ---: | ---: | :--- |
| Ridge | 12 °C | 18 km | Clear horizon |
| Cove | 15 °C | 9 km | Light sea mist |
| Meadow | 17 °C | 14 km | Sheltered trail |

### Small details

Typography sample: café, Ångström, 日本語, → and ½. A longer paragraph gives the reading surface enough texture to compare line wrapping on narrow screens without introducing any real project information.

[Explore the architecture](architecture.md) · [Back to the guide](../START-HERE.md)
` },
  { path: "examples/guides/architecture.md", kind: "markdown", source: `# Expedition architecture

## Document flow

~~~mermaid
flowchart TD
  Notes[Field notes] --> Review[Review observations]
  Review --> Map[Publish synthetic map]
  Review --> Notes
~~~

## A reading session

~~~mermaid
sequenceDiagram
  participant Reader
  participant Notebook
  Reader->>Notebook: Open field notes
  Notebook-->>Reader: Show observations
  Reader->>Notebook: Follow the runbook link
~~~

## Example data transformation

~~~typescript
type Station = { name: string; temperature: number };
const stations: Station[] = [{ name: "Cove", temperature: 15 }];
const summary = stations.map(({ name, temperature }) => ({
  label: name,
  comfortable: temperature >= 12 && temperature <= 22,
}));
~~~

[Read the runbook](../operations/runbook.adoc) · [Back to the guide](../START-HERE.md)
` },
  { path: "examples/operations/runbook.adoc", kind: "asciidoc", source: `= Synthetic expedition runbook
Synthetic reviewer
:toc:

NOTE: This is sample documentation, not an instruction to operate a real service.

== Before departure

. Review the observations.
. Check the fictional inventory.
. Assign a note taker.

[cols="1,2,1",options="header"]
|===
|Stage |Action |Owner
|Prepare |Review the route |Observer
|Walk |Record conditions |Recorder
|Return |Compare notes |Reviewer
|===

TIP: Switch between Source and Rendered to compare the original AsciiDoc with its preview.

== Configuration example

[source,json]
----
{
  "expedition": "synthetic-coast",
  "stations": ["ridge", "cove", "meadow"],
  "publish": false
}
----

== Decision diagram

[mermaid]
----
flowchart LR
  Check[Read observations] --> Ready{Clear weather?}
  Ready -->|Yes| Walk[Take the trail]
  Ready -->|No| Wait[Write indoor notes]
----

image::../media/coast.svg[Synthetic coastline,640]

xref:reference.adoc[Read the reference] or link:../START-HERE.md[return to the guide].
` },
  { path: "examples/operations/reference.adoc", kind: "asciidoc", source: `= Observation reference
:toc:

== Vocabulary

Station:: A fictional place where observations are recorded.
Visibility:: The estimated distance to the visible horizon.
Recorder:: The person responsible for a sample notebook entry.

== Record format

=== Required fields

[source,yaml]
----
station: cove
temperature: 15
conditions:
  - calm
  - light mist
----

=== Review policy

IMPORTANT: All values here are invented. Do not substitute private credentials or real operational data.

==== Completion

A complete record has a station, a temperature and at least one condition.

xref:runbook.adoc[Return to the runbook] or link:../releases/2026/checklist.md[open the release checklist].
` },
  { path: "examples/releases/2026/checklist.md", kind: "markdown", source: `# Sample release checklist

## Reading pass

- [x] Add representative Markdown
- [x] Add representative AsciiDoc
- [x] Keep images local
- [ ] Review tables on a narrow screen
- [ ] Open a diagram and return to the document

## Fictional release notes

### Added

A field guide, two diagram styles and a small coastal illustration.

### Verification example

~~~sh
# Illustrative text only: the reviewer does not execute this block.
printf '%s\\n' 'synthetic example'
~~~

[Back to the guide](../../START-HERE.md) · [Read field notes](../../guides/field-notes.md)
` },
] as const;

export const previewImagePath = "/examples/media/coast.svg";
export const previewImage = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="480" viewBox="0 0 960 480" role="img" aria-label="Synthetic coastal landscape"><rect width="960" height="480" fill="#d9edf4"/><circle cx="770" cy="100" r="48" fill="#f7c768"/><path d="M0 320 220 90 450 320 620 170 850 340H0" fill="#587b79"/><path d="m155 160 65-70 80 105-75-25-30 20z" fill="#f4f2e9"/><path d="M0 320Q240 280 480 335T960 310V480H0" fill="#427b9e"/><path d="M0 405Q220 325 420 420T960 400V480H0" fill="#d9bd8d"/><text x="40" y="455" font-family="sans-serif" font-size="24" fill="#263f4a">SYNTHETIC COAST · LOCAL PREVIEW EXAMPLE</text></svg>`;

export function addPreviewExamples(base: StatePayload): StatePayload {
  const state = structuredClone(base);
  const root = state.roots[0]!;
  root.docs.push(...previewExamples.map(example => ({ id: example.path, rootId: root.id, name: example.path.split("/").pop()!, relativePath: example.path, mtimeMs: state.generatedAt, kind: example.kind })));
  return state;
}

export async function renderPreviewExample(id: string, view: "source" | "rendered") {
  const example = previewExamples.find(example => example.path === id);
  if (!example) return null;
  const rendered = example.kind === "markdown" ? renderMarkdownToHtml(example.source) : await renderAsciidocToHtml(example.source);
  return { id, title: example.path.split("/").pop()!, path: example.path, kind: example.kind, language: example.kind, view, html: view === "source" ? renderCodeAsHtml(example.source, example.kind) : rendered.html, metadata: rendered.metadata };
}
