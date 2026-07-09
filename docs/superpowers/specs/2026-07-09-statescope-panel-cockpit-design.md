# StateScope Panel Cockpit Redesign

Date: 2026-07-09
Status: Approved design, ready for implementation planning

## Goal

Redesign the StateScope DevTools Panel into a professional dark-mode inspection cockpit that is easier to understand and operate, while preserving every existing capability and every piece of currently displayed information.

This redesign is a re-architecture of information hierarchy, interaction flow, and visual presentation. It is not a scope reduction. No existing runtime metadata, debugging status, epoch evidence, diff detail, regression workflow, issue workflow, settings capability, export capability, or Jira configuration may be removed. Information may be regrouped, summarized, collapsed, or reached through a new interaction path, but it must remain accessible.

## Success Criteria

1. A first-time user can tell whether the tool is ready to use within a few seconds of opening the panel.
2. The panel preserves all current information and functionality across all 7 tabs.
3. The Overview tab becomes the primary cockpit for readiness, latest evidence, risk queue, and quick actions.
4. Session identity information remains permanently visible and never gets buried under secondary cards.
5. The visual language feels like a professional engineering inspection console, not a generic dashboard and not a flashy sci-fi panel.

## Non-Goals

- No backend or data-model redesign.
- No removal of tabs.
- No removal of existing export, copy, filter, sign-off, sync, or settings features.
- No new product features beyond the UI/UX reorganization needed for the redesign.

## Constraints

- Keep the existing 7 tabs:
  - Overview
  - Epoch Timeline
  - Diff
  - Cutover Report
  - Scenario Regression
  - Issues
  - Settings
- Preserve all currently visible information.
- Interaction patterns may change.
- The visual direction is a dark professional cockpit.
- The initial emphasis on open is readiness, not mismatch count and not raw latest epoch detail.

## Design Direction

The redesign uses a “start-gated cockpit” model.

The panel should feel like a diagnostic control surface:

- Top level: identify the current session and runtime line immediately.
- Next level: confirm readiness before trusting the data.
- Next level: show the latest evidence gathered by the session.
- Next level: isolate actionable risk.
- Final level: provide quick copy/export/utilities and links into deeper workspaces.

This establishes a clean operator mental model:

1. What am I looking at?
2. Is the tool actually ready?
3. What just happened?
4. What needs my attention?
5. Where do I go next?

## Information Architecture

### Global Structure

The panel keeps the existing left navigation and the existing 7 tabs, but the perceived priority changes:

- Primary workflow tabs:
  - Overview
  - Epoch Timeline
  - Diff
- Extended validation tabs:
  - Cutover Report
  - Scenario Regression
  - Issues
- Control surface tab:
  - Settings

This is a hierarchy change, not a navigation deletion. All tabs remain visible and directly accessible.

### Overview Tab

The Overview tab becomes the cockpit homepage and has four stacked layers:

1. Session Identity
2. Session Readiness
3. Latest Evidence
4. Risk Queue + Quick Utilities

#### 1. Session Identity

This is the topmost persistent block in the Overview tab. It must not be replaced by status cards.

It contains:

- Current BO name, for example `OutsourceIssue`
- Effective profile, for example `lowcode`
- Profile confidence
- Chain status indicators such as `old ✓`, `shadow ✓`
- Activation state such as `已激活`
- Other currently surfaced runtime identity or chain metadata from the header

This section answers “what session am I inspecting?” before anything else.

#### 2. Session Readiness

This section answers “can I trust this panel yet?”

It aggregates readiness checks that are currently scattered across the header, empty states, settings, and activation banner.

It contains explicit readiness cards for:

- `bizDebug`
- hook attachment
- profile mapping / effective profile confirmation
- allowlist readiness

Each card exposes:

- current state
- short human-readable explanation
- severity semantics
- direct CTA if action is needed

Actions such as enable-and-reload, rediscover hooks, and apply profile remain available from this layer.

#### 3. Latest Evidence

This section summarizes the most recent epoch without replacing the Timeline tab.

It contains:

- latest epoch id
- changed count
- snapshot/final count
- mismatch count
- concise summary sentence for the selected/latest epoch
- a compressed timeline preview
- a preview of the selected epoch detail area

This section gives a clear summary, but full epoch browsing remains in the Timeline tab.

#### 4. Risk Queue and Quick Utilities

The right side of the Overview tab contains two focused panels:

- Risk Queue
- Quick Utilities

Risk Queue contains the highest-priority anomaly or mismatch items and preserves jump-to-Diff behavior.

Quick Utilities preserves:

- copy diagnose output
- copy console filter
- export epoch JSON

No utility is removed. The interaction is only regrouped.

## Seven-Tab Behavior Model

### Overview

Purpose: cockpit homepage.

Primary content:

- session identity
- readiness gate
- latest evidence
- risk queue
- quick utilities

Interaction role:

- entry point
- summary layer
- cross-tab launcher

### Epoch Timeline

Purpose: full investigation timeline.

Primary content stays intact:

- timeline list
- epoch selection
- detailed epoch drilldown
- verdict state where applicable
- changed/main/detail sections

Interaction role:

- deeper inspection workspace for chronological investigation
- destination from Overview timeline preview

### Diff

Purpose: focused comparison workspace.

Primary content stays intact:

- diff counters
- main/detail diff groups
- mismatch filtering
- search
- focused path jumping
- new-track/pending warnings

Interaction role:

- destination from Risk Queue
- field-level validation workspace

### Cutover Report

Purpose: accumulated allowlist validation across epochs.

Primary content stays intact:

- accumulated field reporting
- JSON/CSV export
- allowlist-driven cutover analysis

Interaction role:

- extended validation after session evidence has stabilized

### Scenario Regression

Purpose: scenario task panel for regression completion.

Primary content stays intact:

- scenario checklist
- PASS/BLOCK state
- scenario details
- field/watch status
- mark complete / sign-off
- import/export/reset actions

Interaction change:

- frame it more like a task panel than a generic data page
- keep all data and actions

### Issues

Purpose: escalation and work-tracking panel.

Primary content stays intact:

- local issues
- scenario scoping
- status filter
- sync filter
- Jira sync
- export
- close/update actions

Interaction change:

- make it feel like a downstream work queue from mismatch escalation
- keep all issue data and all Jira settings flows

### Settings

Purpose: configuration and recovery surface.

Primary content stays intact:

- debug toggles
- profile mode
- allowlist configuration
- Jira configuration
- hook recovery actions

Interaction change:

- Settings should be strongly surfaced from Overview when readiness fails
- otherwise remain a stable control panel, not the default starting point

## Cross-Tab Navigation

Cross-tab navigation becomes deliberate and visible:

- Overview risk item -> Diff
- Overview timeline preview -> Epoch Timeline
- mismatch escalation -> Issues
- scenario summary -> Scenario Regression
- readiness failure CTA -> Settings or exact settings subsection

This improves discoverability without removing direct tab switching.

## Visual System

### Tone

The UI should feel:

- dark
- precise
- dense but readable
- operator-oriented
- professional

It should not feel:

- playful
- marketing-like
- generic SaaS
- overly glossy
- sci-fi decorative

### Color Strategy

Use restrained dark surfaces with clear semantic state colors:

- canvas: near-black blue-gray
- panel surfaces: slightly lifted dark surfaces
- focus/active: cool blue
- ready/success: controlled green
- warning/verify: amber
- failure/risk: restrained red

Color is for state and emphasis, not decoration.

### Typography

Typography should prioritize readability and quick scanning:

- strong title for BO/session identity
- clear section headings
- high-contrast body text
- muted secondary text that remains readable
- compact uppercase labels only for small section markers

Avoid washed-out gray text and avoid ornamental display treatment.

### Components

All core panel components should align to one visual vocabulary:

- cards use low-radius controlled surfaces
- chips communicate state consistently
- active navigation is clear and compact
- buttons are utilitarian, not decorative
- tables and row lists retain density and legibility

### Motion

Minimal motion only:

- quick state transitions
- no theatrical entrance sequences
- no decorative movement

Motion exists only to clarify change of state or focus.

## Interaction Rules

1. Session identity remains pinned and obvious in Overview.
2. Summary cards never replace deep information, they only summarize and route.
3. Collapsed content is allowed, but no current information becomes unreachable.
4. Risk items must be actionable.
5. Empty states become executable readiness guidance instead of internal implementation prose.
6. High-value runtime metadata must never be dropped during visual simplification.

## Data Preservation Contract

During implementation, treat all currently shown information as protected:

- header metadata
- activation badge meaning
- runtime diagnostics context
- profile reason/confidence
- old/new/shadow chain state
- epoch counters and summaries
- changed/main/detail breakdowns
- diff counters and results
- allowlist state and catalog
- scenario summary/detail/sign-off data
- issues data and Jira data
- copy/export actions

If a summary view is introduced, the full original data must still be accessible in the same tab or via a direct jump.

## Technical Implementation Notes

- Prefer surgical HTML/CSS/JS refactoring inside the existing panel architecture.
- Preserve current state sources and existing runtime messaging.
- Reuse current render flows where possible, but reorganize render order and grouping.
- Extract new rendering helpers only when they directly support the cockpit hierarchy.
- Keep the existing tab model and event bindings aligned with the new layout.

## Testing Strategy

Implementation should verify both behavior and preservation:

1. Existing information preservation checks
   - each tab still shows all previous categories of information
   - no action buttons are lost
   - no export/sync flow becomes inaccessible

2. Overview usability checks
   - session identity is visible immediately
   - readiness state is understandable without opening Settings
   - latest evidence and risk queue are both visible without scrolling in typical panel sizes

3. Interaction checks
   - cross-tab jumps still work
   - anomaly jump-to-diff still works
   - settings CTAs still work
   - scenario and issues actions still work

4. Visual checks
   - contrast is sufficient
   - density remains readable
   - cards and chips remain consistent
   - dark theme is stable across the full panel

## Risks

- The redesign could accidentally hide important low-level data behind summary cards.
- The Overview tab could become too dense if every old concept is shown at equal priority.
- Existing CSS may contain brittle layout assumptions that resist reordering.
- A visual rewrite could inadvertently break event binding if structure changes too aggressively.

## Recommended Implementation Sequence

1. Rebuild Overview information hierarchy first.
2. Normalize top header/session identity treatment.
3. Refresh left nav hierarchy and styling.
4. Re-skin Timeline and Diff as consistent workspaces.
5. Re-skin extended validation tabs without changing their content model.
6. Verify that every previous information category remains accessible.

## Acceptance Summary

The redesign is complete when:

- the panel reads as a professional dark inspection cockpit
- the Overview tab clearly answers readiness first
- session identity is always obvious
- all 7 tabs remain present
- all existing information and actions remain available
- the interaction model is clearer without reducing scope
