# Narrow Terminal Column Layout Design

## Problem

With 4 loops on a narrow terminal, columns become too compressed to read output meaningfully. Each column may only get ~20 characters of usable width, making the output unreadable.

## Solution

Automatically reduce visible columns based on terminal width with page-based navigation to access all loops.

## Core Logic

```typescript
const MIN_COLUMN_WIDTH = 60; // characters
const visibleColumns = Math.max(1, Math.min(maxLoops, Math.floor(terminalWidth / MIN_COLUMN_WIDTH)));
```

Width thresholds:
- 240+ chars → 4 columns
- 180-239 chars → 3 columns
- 120-179 chars → 2 columns
- <120 chars → 1 column

## Page Navigation

When `visibleColumns < totalLoops`:
- Track `currentPage` state (0-indexed)
- `totalPages = Math.ceil(totalLoops / visibleColumns)`
- Display loops: `currentPage * visibleColumns` to `(currentPage + 1) * visibleColumns - 1`
- Keys: `[` previous page, `]` next page (with wrap-around)

## Focus Key Behavior

Number keys are relative to visible columns on the current page:
- Keys `1-N` where N = visible columns count
- Translation: `globalIndex = currentPage * visibleColumns + (keyPressed - 1)`
- When page changes, focus is cleared

Example with 4 loops, 2 visible:
- Page 1: Loops 0,1 visible → `1` focuses loop 0, `2` focuses loop 1
- Page 2: Loops 2,3 visible → `1` focuses loop 2, `2` focuses loop 3

## UI Changes

### Footer
Dynamic footer based on pagination state:
```
[q]uit [p]ause [r]eview [t]asks [1-2] focus [/] page    (when paginated, 2 columns)
[q]uit [p]ause [r]eview [t]asks [1-4] focus             (when all columns visible)
```

### Page Indicator
When paginated, show in footer: `Page 1/2`

## State Changes

### App.tsx
- Add `currentPage: number` state (default 0)
- Reset `currentPage` to 0 when loops change significantly
- Pass `currentPage`, `setCurrentPage`, `visibleColumns` to Layout

### Layout.tsx
- Calculate `visibleColumns` from terminal width
- Slice `sortedLoops` based on current page and visible columns
- Pass `visibleColumns` to Column components

### Input Handling
- `[` → previous page (wrap to last)
- `]` → next page (wrap to first)
- `1-4` → focus based on visible columns only, mapped to global index

## Files to Modify

1. `src/tui/App.tsx` - Add page state, update input handling
2. `src/tui/Layout.tsx` - Calculate visible columns, slice loops, update footer
