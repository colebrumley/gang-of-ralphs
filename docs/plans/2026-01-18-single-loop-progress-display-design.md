# Single-Loop Phase Progress Display Design

## Problem

ENUMERATE and PLAN phases run single loops without the column view. Users just see a spinner with generic text and only the last 5 lines of output. During these phases, Claude's thinking and actions could be much more visible to help users understand progress.

## Solution

Expand the StatusArea during single-loop phases to fill available terminal space, showing more output lines dynamically based on terminal height.

## Design

### Layout Change

**Current (ENUMERATE/PLAN):**
```
┌─ Status Area ─────────────────────────────────┐
│ ⠋ enumerate • Reading spec and identifying... │
│                                               │
│ [only last 5 lines, truncated to 120 chars]   │
└───────────────────────────────────────────────┘
[rest of terminal unused]
```

**Proposed:**
```
┌─ Status Area (expanded) ──────────────────────┐
│ ⠋ enumerate • Reading spec and identifying... │
├───────────────────────────────────────────────┤
│ [output line 1]                               │
│ [output line 2]                               │
│ ...                                           │
│ [fills to terminal height - header - borders] │
└───────────────────────────────────────────────┘
```

### Implementation

#### 1. StatusArea.tsx

Accept terminal height and compute available lines:

```typescript
interface StatusAreaProps {
  // ... existing props
  terminalHeight?: number;
}

// In render:
const isSingleLoopPhase = ['enumerate', 'plan'].includes(phase);
const availableLines = isSingleLoopPhase && terminalHeight
  ? Math.max(5, terminalHeight - 4)  // 4 = header + borders + padding
  : 5;  // default for other phases

const linesToShow = output.slice(-availableLines);
```

#### 2. App.tsx

Dynamic buffer sizing based on terminal dimensions:

```typescript
const { rows } = useStdoutDimensions();

// In onOutput callback, buffer based on terminal height
setPhaseOutput((prev) => {
  const bufferSize = Math.max(10, rows);
  const lines = splitLines(text);
  return [...prev.slice(-(bufferSize - lines.length)), ...lines];
});
```

#### 3. Layout.tsx

Pass terminal height to StatusArea:

```typescript
<StatusArea
  // ... existing props
  terminalHeight={rows}
/>
```

### Edge Cases

| Case | Handling |
|------|----------|
| Small terminal (< 10 rows) | Minimum 5 lines always shown |
| Terminal resize | `useStdoutDimensions` triggers re-render automatically |
| Phase transitions | Buffer resets on phase change (existing behavior) |
| Long lines | Truncated at terminal width (existing behavior) |

### No Changes To

- BUILD phase layout (loop columns already fill space)
- Spinner animation or phase colors
- Thinking output styling (`[thinking]` prefix, magenta, dimmed)
- Activity indicator in header
- REVIEW, REVISE, CONFLICT phases (brief, don't need expansion)

### Files Changed

| File | Change |
|------|--------|
| `src/tui/StatusArea.tsx` | Accept height prop, compute available lines, expand output display |
| `src/tui/App.tsx` | Dynamic buffer sizing based on terminal height |
| `src/tui/Layout.tsx` | Pass terminal height to StatusArea |

## Success Criteria

- During ENUMERATE/PLAN, output fills available terminal space
- Buffer matches display capacity (no wasted memory)
- Graceful handling of small terminals
- No regression in BUILD phase or other views
