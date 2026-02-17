# Implementation Plan: Customer Project Assembly Guides

## Overview
Scale assembly guides to real customer projects with per-cabinet model files,
dynamic guide generation via part classification, admin UI for project management,
and customer-facing project pages.

## Phase 1: Part Classification Engine (`lib/classifyPart.ts`)

**New file:** `lib/classifyPart.ts`

- `normalizeName(name: string): string` — lowercase, replace `[-_\[\](){}]` with space, collapse spaces, trim
- `classifyPart(name: string): { groupKey: string, subtype?: string }` — priority-ordered rules:
  1. DRAWERS: contains "um d" token → Drawer Box subtypes
  2. BOOKCASE FACE FRAMES: contains "bookcase" + "ff" → Face Frame subtypes (ucb/lu/ru/icb)
  3. EXPLICIT FACE FRAMES: startsWith "left/right/top face frame"
  4. BACK PLINTH: startsWith "back plinth" → Plinth
  5. BACK VARIANTS: "double back", "back panel", "back" (excluding "plinth" token)
  6. REAR SUPPORTS: "rear brace", "wall bar"
  7. FILLERS: "filler side", "filler front"
  8. STANDARD CARCASS (longest-match-wins): Bottom, Plinth, Top, Left Side, Right Side,
     Vertical Division, Door, Counter Top, Shelf
- `DEFAULT_STEP_TEMPLATE` — ordered list of groupKeys for generating steps
- `DEFAULT_EXPLODE_OFFSETS` — default [x,y,z] per groupKey
- `generateGuideFromParts(partNames: string[]): { steps, explodeOffsets }` — builds guide dynamically

## Phase 2: Data Model & Persistence

**New Supabase table:** `assembly_projects`
- `id` (text PK) — e.g. "ORD-10452-a3f2b1"
- `project_id` (text) — e.g. "ORD-10452"
- `project_name` (text)
- `customer_name` (text, nullable)
- `cabinets` (jsonb) — array of CabinetInstance objects
- `created_at`, `updated_at` (timestamptz)

**New file:** `lib/projects.ts` — TypeScript types:
- `CabinetInstance { cabinetId, cabinetName, cabinetIndex, modelFileUrl?, erpParts, guideOverrides? }`
- `Project { id, projectId, projectName, customerName?, cabinets, createdAt, updatedAt }`
- `GuideOverrides { stepOrder?, stepCopy?, explodeOffsets?, matchRules? }`

**New API routes:**
- `POST /api/projects/upsert` — create/update project
- `GET /api/projects/[id]` — fetch project by ID
- `POST /api/projects/[id]/parse-erp` — parse uploaded CSV, return cabinet instances
- `POST /api/projects/[id]/cabinets/[cabinetId]/model-url` — save model file URL for a cabinet

## Phase 3: ERP CSV Parsing (`lib/parseErp.ts`)

**New file:** `lib/parseErp.ts`
- Parse CSV with columns: projectName, cabinetName, partName
- Group rows by cabinetName in contiguous blocks
- Create CabinetInstance per block with incrementing cabinetIndex
- Return parsed project structure

## Phase 4: Updated Assembly Guide Controller

**Modify:** `lib/assemblyGuideController.ts`
- Add new `initFromParts(embeddedViewer, OV, partNames, overrides?)` method
  - Uses `classifyPart()` to group meshes by groupKey
  - Generates steps from DEFAULT_STEP_TEMPLATE (filtered to available groups)
  - Applies overrides if provided
- Keep existing `init()` working for legacy guides (backward compatible)
- Change highlight callback to use `classifyPart()` matching instead of prefix matching

## Phase 5: Customer Project Page

**New files:**
- `app/project/[projectId]/page.tsx` — server component, fetches project from Supabase
- `app/project/[projectId]/project-client.tsx` — client component:
  - Shows sidebar with "This Project" section (replacing "Cabinet Tutorials")
  - Loads selected cabinet's model file
  - Runs dynamic guide generation
  - Reuses existing wizard UI from assembly-client

**Modify:** `app/assembly/side-nav.tsx`
- Accept optional `projectCabinets` prop
- When provided, replace "Cabinet Tutorials" section with "This Project" showing cabinet list
- Keep Fittings Guide and Need Help sections unchanged

## Phase 6: Admin UI for Assembly Guides

**New files:**
- `app/admin/projects/page.tsx` — project list + create form
- `app/admin/projects/[projectId]/page.tsx` — project editor:
  - Project metadata (name, customer, ID)
  - ERP CSV upload + parse button → shows parsed cabinet instances
  - Per-cabinet: model URL input, detected groups display, step editor
  - Save button persists to Supabase
- Simple auth gate: check `ADMIN_PASSPHRASE` env var via header or session

## Phase 7: Existing Route Preservation

- `/assembly/[slug]` continues to work unchanged via ASSEMBLY_GUIDES registry
- `/assembly/low-double-cupboard` test route remains functional
- No changes to existing assembly page server component

## File Summary

### New Files (10):
1. `lib/classifyPart.ts` — classification engine + guide generation
2. `lib/projects.ts` — project/cabinet TypeScript types
3. `lib/parseErp.ts` — CSV parser
4. `app/project/[projectId]/page.tsx` — customer project server page
5. `app/project/[projectId]/project-client.tsx` — customer project client
6. `app/api/projects/upsert/route.ts` — create/update project API
7. `app/api/projects/[id]/route.ts` — fetch project API
8. `app/api/projects/[id]/parse-erp/route.ts` — parse ERP CSV API
9. `app/admin/projects/page.tsx` — admin project list
10. `app/admin/projects/[projectId]/page.tsx` — admin project editor

### Modified Files (3):
1. `lib/assemblyGuideController.ts` — add initFromParts() method
2. `app/assembly/side-nav.tsx` — accept project cabinets prop
3. `lib/navigation.ts` — add helper to build project nav section
