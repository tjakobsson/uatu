# Mermaid Shapes

Fixture exercising the diagram-viewer code path across the shapes that have
historically rendered poorly: tiny intrinsic widths (small flowchart and C4),
sequence diagrams, and a wide diagram. Each of these has a matching e2e
assertion in `tests/e2e/uatu.e2e.ts`.

## Small flowchart

```mermaid
graph TD
  A[Watch] --> B[Preview]
  B --> C[Browser]
```

## Sequence diagram

```mermaid
sequenceDiagram
  participant U as User
  participant S as SPA
  participant W as Watcher
  U->>S: Open file
  S->>W: Subscribe
  W-->>S: Update
  S-->>U: Render
```

## Small C4 context diagram

```mermaid
C4Context
  title System Context Diagram
  Person(dev, "Developer", "Browses the landscape")
  System_Boundary(b, "Developer Landscape") {
    System(spa, "Web Application", "React SPA")
    SystemDb(data, "Catalog Data", "JSON + SVG")
  }
  Rel(dev, spa, "Uses", "HTTPS")
  Rel(spa, data, "Reads", "fetch")
```

## Wide flowchart

```mermaid
graph LR
  A[Init] --> B[Fetch] --> C[Parse] --> D[Validate] --> E[Transform] --> F[Index] --> G[Render] --> H[Display] --> I[Notify] --> J[Done]
```

## Component interaction example

```mermaid
flowchart TD
  subgraph App["App (state owner)"]
    direction TB
    STATE["filterState: FilterState\nsearchQuery: string"]
  end

  subgraph Data["Data Layer"]
    HOOK_DATA["useProjectData()"]
    JSON_P["projects.json"]
    JSON_S["stewards.json"]
  end

  subgraph Filters["Filter Panel"]
    SEARCH["SearchInput"]
    FP["FilterPanel"]
    FG_S["FilterGroup\n(steward)"]
    FG_C["FilterGroup\n(category)"]
    FG_M["FilterGroup\n(maturity)"]
  end

  subgraph Display["Display"]
    HEADER["Header\n(project count)"]
    HOOK_FILTER["useFilteredProjects()"]
    GRID["ProjectGrid"]
    SECTION["CategorySection"]
    CARD["ProjectCard"]
    EMPTY["EmptyState"]
  end

  HOOK_DATA -->|fetch| JSON_P
  HOOK_DATA -->|fetch| JSON_S
  HOOK_DATA -->|"projects, stewards"| App

  App -->|"filterState, onChange"| FP
  App -->|"searchQuery, onChange"| SEARCH
  FP --> FG_S
  FP --> FG_C
  FP --> FG_M

  App -->|"projects, filterState, searchQuery"| HOOK_FILTER
  HOOK_FILTER -->|"filteredProjects"| App

  App -->|"count"| HEADER
  App -->|"filteredProjects"| GRID
  App -->|"filterState, onClear"| EMPTY
  GRID --> SECTION
  SECTION --> CARD
```
