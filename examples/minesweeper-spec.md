# Minesweeper Clone Web App

Build a classic Minesweeper game as a single-page web application using vanilla HTML, CSS, and TypeScript.

## Background

Minesweeper is a puzzle game where players reveal cells on a grid, avoiding hidden mines. Numbers indicate adjacent mine counts. The goal is to reveal all non-mine cells without triggering a mine.

## Requirements

### Project Setup

1. Initialize a new project with `package.json` in the project root
2. Configure TypeScript with `tsconfig.json` targeting ES2020, strict mode enabled
3. Use Vite as the build tool for fast development and bundling
4. Create `index.html` as the entry point with a game container div

### Game Board

5. Create `src/board.ts` with a `Board` class that manages the game grid
6. Support configurable grid dimensions (rows, columns) and mine count
7. Implement mine placement using Fisher-Yates shuffle for random distribution
8. Calculate adjacent mine counts for each non-mine cell
9. Store cell state: revealed, flagged, mine, adjacentCount

### Cell Rendering

10. Create `src/cell.ts` with a `Cell` class for individual cell logic
11. Render cells as clickable div elements with appropriate CSS classes
12. Display numbers 1-8 with distinct colors (blue, green, red, purple, etc.)
13. Show mine icon (emoji or SVG) when a mine is revealed
14. Show flag icon when cell is flagged

### Game Logic

15. Create `src/game.ts` with a `Game` class coordinating gameplay
16. Left-click reveals a cell; if mine, game over
17. Right-click toggles flag on unrevealed cells
18. Auto-reveal adjacent cells when clicking a cell with 0 adjacent mines (flood fill)
19. First click is always safe - relocate mine if first click hits one
20. Win condition: all non-mine cells revealed
21. Track game state: playing, won, lost

### UI Components

22. Create `src/ui.ts` for UI management
23. Display remaining mine count (total mines minus flags placed)
24. Add timer showing elapsed seconds since first click
25. Add reset button with smiley face that changes based on game state
26. Show "You Win!" or "Game Over" message overlay on game end

### Difficulty Presets

27. Create `src/config.ts` with difficulty presets:
    - Beginner: 9x9 grid, 10 mines
    - Intermediate: 16x16 grid, 40 mines
    - Expert: 30x16 grid, 99 mines
28. Add difficulty selector buttons in the UI
29. Reset game when difficulty changes

### Styling

30. Create `src/styles.css` with responsive grid layout using CSS Grid
31. Style cells with 3D beveled borders (classic Windows look)
32. Add hover effects on unrevealed cells
33. Animate cell reveal with subtle transition
34. Make layout responsive - scale cells on smaller screens

### Keyboard Support

35. Add keyboard navigation with arrow keys to move focus between cells
36. Space bar to reveal focused cell
37. F key to toggle flag on focused cell

### Tests

38. Create `src/board.test.ts` - test mine placement and adjacency calculation
39. Create `src/game.test.ts` - test win/lose conditions, first-click safety
40. Create `src/cell.test.ts` - test cell state transitions

## Non-Goals

- Multiplayer or online leaderboards
- Custom themes or skins
- Mobile touch gestures beyond basic tap
- Undo/redo functionality
- Saving game state to localStorage

## Example Usage

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Run tests
npm test
```

## Technical Notes

- Use event delegation on the board container for efficient click handling
- Implement flood fill iteratively (not recursively) to avoid stack overflow on large boards
- Use CSS custom properties for theming number colors
- Keep game logic separate from rendering for testability
