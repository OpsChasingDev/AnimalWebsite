# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Trail world

### Trail
The single scroll-driven path a visitor walks from the trailhead to today, laid out in world coordinates on a tilted ground plane. Scroll position maps to a distance along the Trail; the camera glides toward that distance rather than tracking the scrollbar exactly.

### Band
One horizontal slice of the ground, rendered as its own SVG element so the ground never exists as a single raster surface. Bands overlap their neighbours by a sliver so seams vanish, are culled (hidden) when far from the camera, and are the unit that iOS memory budgets are counted in.

### Cull window
The range of Trail distance around the camera within which Bands, groves and props are kept visible; everything outside it is hidden so it holds no GPU surface. The window is asymmetric: more is kept ahead of the camera than behind it, because the current point on the Trail rides low on the screen and most of the tilted view is the valley ahead rather than ground already walked.

### Lookahead
The extra Band on each side of the Cull window whose painted art has its image references attached before the Band becomes visible, so the art is decoded by the time it shows. Lookahead is one Band in either direction by default (a debug switch can widen or remove it), so the number of Bands with art attached at once is bounded by the window plus one on each side.

### Flat mode
The rollback state of the ground in which no painted art is built at all and only the Season gradient shows, selected by a URL switch or by a missing art manifest. Flat mode must construct none of the painted elements, because a dormant element can still cost GPU memory.

### Season gradient
The vertical colour gradient every Band is filled with, whose stops follow the season of the photos along the Trail. It is the colour source for the ground in every mode; painted overlays add texture and ink over it rather than replacing it, and only the winter overlay carries colour of its own.

### Lite tier
The reduced-effect profile the site selects on coarse-pointer or mobile devices. The painted art is the same on the Lite tier; only motion and blend effects are dropped.

## Flagged ambiguities

- "Overlay" is used both for the painted ground textures inside a Band and for the screen-space UI layers (photo fan, lightbox, sky tint). In ground work it means the painted texture; the UI layers are overlays only in the interface sense.
