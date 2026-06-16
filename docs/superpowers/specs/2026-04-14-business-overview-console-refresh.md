# Business Overview Console Refresh

**Date:** 2026-04-14  
**Route:** `/overview`  
**Scope:** `dashboard/app/src/pages/BusinessOverview.tsx`

## Intent

The overview page should feel like the operator's front door for the entire FMD workbench.
It should answer three questions immediately:

1. What is the estate posture right now?
2. Which workspace should I enter next?
3. Is there anything operationally wrong that needs attention before I move?

The page should work in both Business and Engineering personas without becoming generic dashboard chrome.

## Design Direction

- Treat the page as a `system overview`, not a portal billboard.
- Keep the visual language already established in the repo: warm paper surfaces, copper accent, borders-only depth, dense hierarchy, status rails.
- Make `Data Estate` the dominant center surface.
- Keep motion local to the estate map only. The rest of the page should remain steady.

## Layout

### 1. Title Band

- Eyebrow: `PRIMARY KPIS`
- Title: `System Overview`
- One compact sentence explaining that the page orients users before they move into Estate, Load Center, Mission Control, Explore, or Gold Studio.
- Right side keeps only a latest-signal receipt and refresh action.

### 2. KPI Control Band

- Four KPI cards.
- Mobile: 2x2 grid.
- Desktop: single horizontal strip.
- Metrics should come from the existing metric contract only:
  - Landing Loaded
  - Bronze Loaded
  - Silver Loaded
  - Tool-Ready
- Each KPI includes a quiet progress rail tied to truthful denominators.

### 3. Primary Worksurface Grid

- Desktop:
  - Left stack: Load Center, Mission Control
  - Center: oversized Data Estate card spanning both rows
  - Right stack: Explore, Gold Studio
- Mobile:
  - Data Estate first
  - Then a true 2x2 grid of the four workspace cards

### 4. Operations Strip

- Bottom row stays receipt-oriented:
  - Recent Alerts
  - Source Health
- No third bottom panel. Recent activity moves into the title band as a latest-change receipt.

## Data Estate Card

The Data Estate card is the signature surface on the page.

- It should show:
  - healthy sources summary
  - outstanding / blocked count
  - a simplified topology of source -> landing -> bronze -> silver -> usable
  - three supporting stat bubbles around the topology
  - quick chips for source posture, layer coverage, and governance map
  - a single primary CTA into `/estate`

## Motion Rules

- Only animate active estate paths.
- Use the existing `flowDash` animation for path movement.
- Allow one low-opacity pulse on active nodes or glows.
- No card shimmer, no parallax, no whole-page floating motion.
- Hover feedback stays structural: border emphasis and slight translation only.

## Implementation Plan

1. Add overview-specific card components so the page can diverge from the generic launch-tile pattern without affecting Explore Hub.
2. Refactor `BusinessOverview.tsx` into the new center-heavy layout.
3. Keep all data wired to the current `useMetricContract`, `/api/overview/sources`, and `/api/overview/activity` endpoints.
4. Verify with a production build and browser screenshot at `/overview`.
