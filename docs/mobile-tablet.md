# Android architecture and tablet layout

This page explains the Android app's responsibility boundaries and why its phone and tablet surfaces share one workspace model. The [file tree](file-structure.md#android-app-android) covers source layout; [the Android README](../android/README.md) covers build and design-system rules.

## Responsibility boundaries

| Boundary | Responsibility | Why it stays here |
|---|---|---|
| Link core and domain clients | HelmClient owns call correlation and the shared transfer path. Session, Artifact, Plan, and Workspace clients group calls by domain. | One correlation point keeps reply ownership and failure handling consistent as features grow. |
| Data repositories | Repositories parse and retain session, chat, artifact, plan, context, sequence, and workspace data. | Layouts observe the same domain records without parallel copies or wire parsing in Compose. |
| Shared workspace state | HelmHomeState owns selected-session navigation and tab state. HelmHome assembles client-backed data and typed state/actions for the shells. | Selection survives layout changes because its owner sits above either presenter. |
| Presenters | PhoneScaffold renders phone surfaces; TabletScaffold arranges the session workspace at tablet widths. | Layout-specific composition stays separate while both presenters receive the same session state and actions. |
| Shared components | Session rows, context ring, chat/composer, and SessionActions are reused where their interactions mean the same thing. | One row, ring, composer, and action catalogue prevent phone and tablet behavior from drifting. |
| Tablet-only layout | The collapsed picker and todo sheet, plus the expanded session/todo splitter, live in the tablet presentation. | These controls solve space constraints; they do not create a second session model. |

## Dependency direction

The UI asks domain clients to perform work. Domain clients use the one link core and relevant repositories; the core routes incoming records to those repositories. Transport and server-side authorization remain in the [BLE/LAN](mobile-ble-transport.md) and [call-boundary](mobile-gate.md) guides.

~~~mermaid
flowchart LR
  subgraph UI["Shared workspace"]
    H[HelmHome]
    S[HelmHomeState]
    P[PhoneScaffold]
    T[TabletScaffold]
    H --> S
    H --> P
    H --> T
  end
  subgraph Link["Domain and link"]
    D[Session / Artifact / Plan / Workspace clients]
    C[HelmClient core]
    R[Data repositories]
    D --> C
    D --> R
    C --> R
  end
  H --> D
~~~

The core is deliberately shared: it correlates each reply once and keeps the transfer/backpressure path out of individual screens. Domain clients keep feature calls legible without cloning wire plumbing. Repositories keep decoded domain state out of Compose.

## One workspace, two presentations

The current window width selects the layout live: below 600dp is phone; 600–839dp is a collapsed tablet; 840dp and above is expanded. The session workspace uses TabletScaffold at tablet widths. Other destinations continue through PhoneScaffold. Following available width means rotation and resizing do not depend on a device's smallest-width bucket.

~~~mermaid
flowchart TB
  W[Current window width] --> L[LayoutChooser]
  L --> M{Phone or tablet width?}
  M -->|below 600dp| P[PhoneScaffold]
  M -->|tablet width| S{Session workspace active?}
  S -->|no| P
  S -->|yes, 600–839dp| C[TabletScaffold · collapsed]
  S -->|yes, 840dp and above| E[TabletScaffold · expanded]
  P --> A[Shared selected-session state and actions]
  C --> A
  E --> A
~~~

| Surface | Layout-specific presentation |
|---|---|
| Phone | The session list and selected session use the phone flow; row actions open the existing action sheet. |
| Tablet, collapsed | The list gives way to a session-title picker; the open-todos chip shows the selected session's todo sheet. |
| Tablet, expanded | Sessions sit above the selected session's open and waiting todos on a draggable, height-persisted splitter. The detail pane keeps the header, action bar, Chat / Artifacts / Plans / Sequences tabs, chat, and composer together. |

Both presentations share session selection, chat/composer behavior, context-ring popovers, cache banners, and the SessionActions catalogue. The tablet action bar and phone action sheet are two presentations of that same catalogue. The todo view is scoped to the selected session and omits completed items.

## Why keep one adaptive UI

One shared state owner means a resize cannot fork session selection, navigation, or action behavior. The phone and tablet shells arrange the same work differently: the phone prioritizes one focused surface, while a wide window can keep the list, pending todos, and session detail visible together. This keeps layout choices at the presentation boundary and preserves one request and session model.

On the desktop side, MobileGate remains the single entry to Helm tools. Phone chat and dictation still travel as ordinary gated calls; tablet surfaces add no privileged route.
