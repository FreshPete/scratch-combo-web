# Design system

## Surface

Scratch Combo is an Operate surface: a DJ working through a practice preset should be able to import files, scan a compact sequence, inspect sample settings, and start or stop a preview with minimal searching.

## Visual direction

A precise practice workspace built from graphite and slate surfaces, warm off-white type, and a restrained acid-lime action color. Timing ticks and numeric readouts use a compact system monospace. The interface feels like a focused instrument panel through spacing and alignment, not through ornament.

The first viewport places a slim navigation rail beside one working column. A compact header identifies the practice workspace, followed by local import controls and a session strip. The sequence timeline is the primary reading surface; the complete sample metadata table follows directly below. There is no marketing hero, decorative gradient, generic card grid, or badge-shaped control.

## Tokens

- Canvas: `#171B1C`
- Raised surface: `#202627`
- Recessed surface: `#111516`
- Subtle border: `#343D3E`
- Strong border: `#4A5555`
- Primary text: `#EEECE2`
- Secondary text: `#A5AEAA`
- Muted text: `#78827E`
- Primary action: `#C4D94B`
- Primary action ink: `#202517`
- Warning: `#E3B263`
- Error: `#EF7770`
- Body face: local system sans-serif stack
- Timing face: local system monospace stack
- Spacing rhythm: 4px base with 8px, 12px, 16px, 24px, 32px steps
- Corners: 3px for controls and 5px for major work surfaces

## Interaction

Actions are plain rectangular controls with visible text and a clear keyboard focus ring. The lime color is reserved for the primary preview-building action and active sequence markers. Secondary controls stay slate. Import errors name the missing or ambiguous file and keep the relevant control nearby. Playback state is visible in the transport and announced through a polite live region. Preview, sample, and session edits last only for the open browser session.

## Responsive behavior

At wide desktop widths, the workspace uses a narrow rail and a single main column, with controls aligned on one line when they fit. At tablet and phone widths, the rail becomes a compact top row, controls wrap, and the sample table scrolls horizontally without hiding columns or changing the underlying information hierarchy. Interactive targets remain at least 40px high.

## Asset policy

Use CSS and locally available system fonts. The Pages build downloads the checksummed built-in preset archive from the public release; keep that media out of the source checkout. Do not add remote fonts or runtime service dependencies.
