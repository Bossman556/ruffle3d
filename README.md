# Ruffle3D

Ruffle3D is a parametric 3D CAD tool for product design that runs in the browser, with a history-based modelling workflow.

- **Geometry kernel:** [OpenCascade](https://dev.opencascade.org/), the same class of B-rep kernel that commercial CAD uses. It is compiled to WebAssembly and driven through [replicad](https://replicad.xyz). It runs in a Web Worker, so the UI stays responsive.
- **Sketch engine:** a geometric constraint solver (Levenberg–Marquardt, solved per connected component, with degree-of-freedom analysis) and planar region detection, both written for this project.
- **Viewport:** [Three.js](https://threejs.org), with PBR materials, a ViewCube, section analysis and edge/face picking.

## Run it

```bash
npm install
npm run dev        # then open http://localhost:5173
```

Other commands:

```bash
npm run build      # production build in dist/
npm test           # all test suites (solver, regions, kernel features, templates, measurement, units)
```

## Desktop app

Ruffle3D also ships as a normal desktop program (Electron), with a loading screen, native menus, a Start menu entry, a desktop shortcut and an uninstaller.

```bash
npm run desktop    # build and run the desktop app
npm run package    # also builds the installer for this system into website/downloads/
```

- **Windows:** `Ruffle3D-Setup-<version>.exe` (NSIS: choose the folder, Start menu and desktop shortcuts, uninstall from Settings ▸ Apps). Built locally by `npm run package`.
- **macOS and Linux:** `.dmg`, `.AppImage` and `.deb` are built on those systems by the **Desktop installers** GitHub Actions workflow (`.github/workflows/desktop.yml`); run it from the Actions tab or push a `v*` tag to attach them to a release.
- **How it works:** `electron/main.cjs` serves `dist/` from a private `app://ruffle3d` origin (so the WebAssembly kernel, workers and IndexedDB behave as in a browser), shows the window when the loading screen has painted, remembers the window size, allows one running copy and opens web links in the default browser. `electron/preload.cjs` passes menu commands to the page.
- **Loading screen:** the splash in `index.html` paints before any script loads; the CAD worker streams the kernel download and reports progress, and the splash closes when the kernel is ready.
- **Signing:** set `CSC_LINK` and `CSC_KEY_PASSWORD` (your code-signing certificate) before building and electron-builder signs the installer and the app. Unsigned builds work, but Windows SmartScreen and macOS Gatekeeper warn on first launch.
- Runtime libraries are listed as devDependencies on purpose: Vite bundles them into `dist/`, so the installer doesn't carry `node_modules`.

## Website and downloads

The product website is generated from `site/` into `website/`, the folder you deploy:

```bash
npm run package      # builds the app → website/app/, the download zip, then all website pages
npm run site         # serves website/ at http://localhost:5174
npm run site:build   # rebuild only the pages (after editing site/)
npm run screens      # re-capture the product screenshots with headless Chrome or Edge
```

- **Settings:** `site/site.json` holds the company name, address, jurisdiction and contact emails. Ruffle3D is free for everyone, so there are no prices or payment links. Empty company fields show as highlighted placeholders, and the build lists them.
- **Pages:** `site/pages/` contains home, features, free (pricing.html), download, release notes, docs (getting started, modelling, surfacing, files, shortcuts), support, contact, about, education, press, security and the legal pages: terms, licence agreement, privacy, cookies and open-source notices.
- **Shared layout:** `site/layout.html` holds the header and footer; `site/assets/` holds the CSS, JS, self-hosted font, screenshots and licence texts.
- **Download package:** one zip with launchers for Windows (PowerShell), macOS and Linux (Node.js or Python 3), plus the open-source licence texts.
- **Code signing:** set `RUFFLE_SIGN_PFX` (a Windows code-signing certificate) and `RUFFLE_SIGN_PASSWORD` before `npm run package` to Authenticode-sign the Windows launcher with a timestamp. On a Mac, set `RUFFLE_MAC_IDENTITY` to your Developer ID Application identity to codesign the macOS launcher. Without them, packages are unsigned.

## Interface

- **Dashboard:** recent projects with thumbnails, search, templates (blank mm / inch, mounting bracket, electronics enclosure, surfaced mouse shell), and rename / duplicate / delete.
- **Workspaces:** Design, Render and Drawing, switched from the app bar. Sketch mode swaps in its own toolbar.
- **Layout:** a contextual toolbar; a **Model / Parameters / Versions** panel on the left; an **inspector** on the right that adapts to what you're doing (command dialog, body properties with live mass and material library, measure results, section, render settings, feature health); and a timeline and status bar at the bottom.
- **Command palette:** <kbd>Ctrl K</kbd> searches commands, actions and features.
- **Preferences:** dark / light / system theme, 8 accent colours, colourful category icons (sketch / create / modify / construct / assemble / inspect each have their own colour in the toolbar and timeline), 6 viewport backdrops, four mouse presets (right orbit, Shift + middle orbit, middle orbit, right orbit with middle pan), field of view, edges, shadows, ambient occlusion, ViewCube, tooltips, autosave and document units.
- **Viewport:** an infinite adaptive grid, soft ground shadows, environment lighting, screen-space selection lines, a themed ViewCube and a floating navigation bar.

## Features

| Area | What you get |
|---|---|
| **Parametric sketching** | Sketch on the origin planes, construction planes or any planar face. Sketches follow their face or plane when the model changes. Geometry: line, 2-point and center rectangle, circle, 3-point arc, center arc, polygon, slot, spline and point. Modify tools: fillet, trim, offset, mirror, and project body edges (as fixed reference geometry). |
| **Constraints** | Coincident, point-on-curve, horizontal, vertical, parallel, perpendicular, tangent, equal, midpoint, concentric, collinear, symmetric and fix. Horizontal/vertical, coincident, on-curve and midpoint constraints are added automatically while you draw. Drag points or curves and the solver keeps every constraint. Colors: blue = free, black = fully constrained, red = conflicting. The live DOF count is shown in the palette. |
| **Driving dimensions** | One Dimension tool covers length, aligned/horizontal/vertical distance, point-to-line, line-to-line, radius, diameter and angle; where you place the label decides horizontal vs vertical. Values can be parameter expressions such as `plate_w/4`. Double-click a dimension to edit it. |
| **Profiles** | Real region detection: crossing curves and T-junctions split regions, and nested loops become holes. Click regions to choose exactly which profiles to extrude, revolve or sweep. |
| **Create** | Extrude (one side, symmetric or two sides, with twist), Revolve, Sweep (profile along a path, with holes), Loft, Box, Cylinder, Sphere, Torus, Cone, Hole (simple, counterbore or countersink; depth or through-all), Rectangular and Circular Pattern, Mirror (about any plane). Each one can create a New Body or Join, Cut or Intersect. |
| **Modify** | Press Pull (push or pull planar faces), Fillet, Chamfer, Shell, Draft, Combine, Split Body (by any plane), Move/Copy, Scale, Remove. |
| **Construct** | Offset plane, plane at angle and midplane, built from origin planes, other construction planes or faces. |
| **Assemble** | **Components** place other projects in the design. Each stores a copy of its project and can be updated when the source changes. **Mates** are solved together by a Levenberg–Marquardt solver in the kernel worker: mate, flush, concentric, distance, parallel, perpendicular and angle. Distance and angle mates can be a range (motion limits with end stops). The **Assembly** panel shows grounding, mate status (the mate that causes a conflict is reported; earlier ones stay satisfied) and the degrees of freedom left. Drag parts with the mouse along their free directions. Mated faces are stored in the part's own frame with a fingerprint and radius, so mates follow a face or hole that moved when the part was edited. The BOM groups identical components with a quantity. Joints: rigid, revolute or slider. Mate a face to a face, or a pin to a hole (cylinder axes align). You can set offset, angle and flip, and animate the motion. **Interference** check lists overlap volumes and shows them in red. |
| **Drawing** | DRAWING workspace with third-angle front, top, right and isometric views. Hidden lines come from OpenCascade's hidden-line removal. You also get automatic scale, overall dimensions, and a title block with material and computed mass, on A4, A3, A2 or Letter sheets. Section views A–A / B–B with hatched cut faces and section lines with view arrows, and a parts list for several bodies, with quantities for repeated assembly components and numbered item balloons on the front view. Export it as SVG, or print it / save it as a PDF. |
| **Parametric history** | Timeline where you can edit any feature, suppress it, roll it back, step through or play back the history, rename and delete. User parameters work everywhere: feature fields and sketch dimensions. Only changed features are recomputed (prefix cache). Errors show red in the timeline and warnings show amber. |
| **Inspect** | Measure, Section Analysis (red cut caps), Properties (volume, area, mass, bounding box, center of mass), Interference. |
| **Projects** | Stored locally in the browser (IndexedDB) and autosaved continuously, with named **versions** you can restore. You can also download and open `.ruffle3d.json` project files. |
| **Render** | Five environment presets, exposure, background (gradient, environment, solid or transparent), ground shadows, ambient occlusion, turntable, and capture at 2×, 4K or 2048² with an optional transparent background. |
| **Export / import** | STEP (multi-body), STL, 3MF, DXF, glTF binary (GLB), OBJ, PNG, WebM video, drawings as SVG/PDF. Import STEP, STL and DXF. |
| **Surface modelling** | A **Solid / Surface** toolbar switch for free-form industrial-design surfacing. Surface tools: Extrude Surface, Revolve Surface, **Skin** (loft through any number of open or closed section curves), **Rail** (profile swept along a rail), **Boundary Patch** (NURBS fill of a closed loop of sketch curves and/or model edges, with G0 or G1 tangent continuity) and Offset Surface. **Thicken** turns a surface into a solid and **Stitch** sews surfaces together; a closed set becomes a solid. Surface bodies are listed in their own tree folder, display double-sided and work with Split. Sketch curves can be picked directly in the viewport, even through solids. |
| **Free-form NURBS** | **CV Curve** (<kbd>V</kbd>): click to place control vertices in 3D. They can go on the XY, XZ or YZ plane, the view plane (through the last CV), or any construction plane, each with an optional offset. They can also snap onto faces, and a grid indicator shows the active plane. Degree 1, 2, 3 or 5, open or closed (periodic). **CV Surface**: a NURBS patch with an editable control grid. Start from a CV plane (any size, 2–40 CVs per direction) or **Rebuild** any face. **Exact** keeps the face's own NURBS: poles, weights (rational) and knots. **Refit** gives an nu × nv grid and reports its deviation. Trimmed faces keep their trim boundaries as UV trim loops, which follow the surface when you edit CVs. **Edit CVs**: drag control vertices directly in the viewport, either free in the view plane or locked to X, Y, Z or the surface normal. You can multi-select CVs, select whole rows or columns, type exact coordinates or offsets, and insert or delete CVs on curves; the shape previews live while you drag. 3D CV curves work as inputs to every surface tool. |
| **Surface fillet & trim** | **Surface Fillet**: a rolling-ball blend between two surfaces, sized by radius or by **chord length**. It can be constant or **variable**, following a linear law, a smooth S-curve, or a curved profile through a middle value (ends can be swapped). Click the part of each surface to keep; both are trimmed along the contact curves and sewn to the fillet into one surface. **Trim**: cut a surface with a sketch or CV curve projected along the curve plane normal, a world axis or **the current view direction**, then keep or remove the clicked region. Open curves split the surface; closed curves cut windows. |
| **Surface evaluation** | **Curvature map**: mean, Gaussian or maximum curvature as a colour map, computed exactly from the NURBS surface derivatives, with a sensitivity control and a radius scale. **Curvature combs** on any edge, with the minimum radius reported. Zebra and Draft analysis are also available. |
| **Threads & springs** | Modelled ISO metric threads (M2–M30, or a custom pitch) on shafts and in holes: full length or partial, right or left hand. Coil springs are set by radius, pitch, turns and wire diameter. |
| **DXF** | Import 2D DXF drawings (lines, arcs, circles, polylines with bulges, splines, ellipses and nested blocks, with $INSUNITS units) into a new sketch; export any flat face or sketch as a millimetre DXF for laser cutting and CNC. |
| **Tapped holes** | The Hole tool sets the ISO tap-drill size and models the thread to a depth or right through. |
| **Sheet metal** | Sheet Metal Base turns a sketch profile into a plate with a thickness, inside bend radius and K-factor. Flange bends straight outside edges of the plate or of another flange (lips, returns, side tabs) up or down at any angle (0–180°), with a length and corner inset. Flat Pattern unfolds the part using the bend allowance θ·(R + K·T), shows a bend table, and exports a DXF with the cut outline on layer 0 and bend lines on layer BEND. Holes cut later in the plate or flanges appear in the flat pattern. |
| **Simulation** | SIMULATE workspace: static stress on one solid body, linear or with **material yielding** (bilinear elastic–plastic, secant iterations, collapse detection). **Buckling** (eigenvalue, geometric stiffness from the static stresses, subspace iteration; within 1% of Euler). **Transient thermal** (implicit Euler with lumped heat capacity, time slider and chart). Fixed supports, forces (N, along an axis or normal to the faces) and pressures (MPa). The body's surface mesh is voxelised with partial-volume cells and meshed into 8-node bricks with Wilson incompatible modes (condensed), assembled into a 27-point stencil and solved with flexible CG preconditioned by a geometric multigrid V-cycle (about 30 iterations whatever the mesh size). Von Mises stress, displacement and safety factor (from the material's yield or tensile strength) are shown on a refined display mesh, with true or exaggerated deformation. Peak stress is reported away from the supports and at them. HTML report export. Checked against beam theory (deflection within 1–5%, bending stress within a few percent). |
| **Modal and generative studies** | The Simulate workspace also finds natural frequencies (subspace iteration on K⁻¹M with lumped masses, Rayleigh–Ritz, multigrid solves; mass participation per mode; animated mode shapes; first bending mode of a steel cantilever within 1% of theory) and runs generative design: SIMP topology optimisation (penalty 3, sensitivity filter, optimality-criteria updates, solid material kept at supports and loads) with the result turned into a closed surface by surface nets and smoothing, then added to the model (via the STL importer) or exported as STL. |
| **Manufacture (CAM)** | MANUFACTURE workspace: stock from the part's bounding box with margins; tool library (flat and ball end mills, face mills, drills with rpm, feed, plunge, step-down, step-over, peck); 3D Rough (Z-level terraces following a drop-cutter envelope, with stock to leave) and 3D Parallel finish (ball-end raster on a height map of the part's mesh); Facing (zigzag), 2D Profile (OpenCascade face offsets, outside / inside / on, to depth or through), Pocket (concentric inward offsets around islands, inside-out at each stepdown) and Drill (full-retract pecking, tip allowance on through holes). Toolpath preview with rapids, animated tool, cycle-time estimates, and G-code (G21/G90, T…M6, S…M3, no canned cycles) with the work origin at the stock top corner or centre. |
| **Thermal** | Steady-state conduction on the voxel mesh (8-node bricks, Jacobi-preconditioned CG): fixed temperatures, heat power on faces and convection (h, ambient), with a heat-balance report. Checked against 1-D conduction and a convection-cooled plate (within 1%). |
| **Wall thickness** | Inspect ▸ Wall Thickness: inward ray casting from every vertex of a refined display mesh (uniform grid, Amanatides–Woo traversal, Möller–Trumbore tests, tilted retries for rays along edges) in a worker; minimum-wall colouring, thinnest wall and share of area under the minimum. |
| **Stable references** | Picks store a mesh signature of the face (centroid, normal, area, planarity, extent) or edge (midpoint, direction, length, ends). The kernel keeps a pick whose point still lies on a matching sub-shape, otherwise collects the pieces of a split face/edge (coplanar inside the old extent, collinear inside the old span) or scores every candidate by orientation, plane shift, position and size, carrying the point along. Fillet, chamfer, shell and draft use all split pieces. |
| **Drawing annotation** | Select / Dimension / Note / GD&T / Datum tools: snapping to vertices, midpoints and circle centres parsed from the projected SVG paths; linear (auto H/V or aligned), diameter, radius and angle dimensions stored in view coordinates with tolerances and text overrides. They are associative: after a model change, each anchor is carried into the new view outline and re-snapped to the nearest vertex or circle, and dimensions that lose their geometry turn red; drag, double-click to edit, Delete; saved in the project and exported with SVG/PDF. |
| **Backups** | Persistent-storage request, Back up all projects (ZIP of every project and version), Restore backup, and an optional project folder (File System Access API) written on every save. |
| **Hole callouts** | Drawings detect vertical holes (internal cylinders, merged coaxially with counterbores and countersinks), add centre marks and letter tags on the top view, and a hole table (size, THRU or depth, CBORE / CSINK, quantity). |
| **Version compare** | Versions ▸ Compare rebuilds the saved version with a separate cache and shows current − old (green) and old − current (red) per body, with volume changes. |
| **Exploded views** | Display-only explode, radial or stacked along X/Y/Z (largest part fixed, others lift away in order), in the Design workspace and optionally in the Render workspace for images and turntable videos. |
| **Decals** | Images projected onto body meshes (three.js DecalGeometry) in the Design and Render workspaces, with width, rotation, opacity and visibility; stored in the project. |
| **Text** | Raised or engraved text on a plane or flat face: built-in single-stroke engraving font (OpenCascade offsets each stroke into a round-ended outline), or any TTF/OTF font loaded through opentype.js and saved in the project. Height, alignment, position, rotation, spacing, depth and stroke weight. |
| **Canvas** | Reference images on the XY, XZ or YZ plane, calibrated by width, with position, offset, rotation, mirror and opacity. Stored in the project and shown only in the Design workspace. |
| **3D print check** | Inspect ▸ 3D Print Check colours overhangs beyond a limit angle for a chosen build direction, and reports per body: size, fit in a chosen build volume, watertightness (open mesh edges), overhang area and an estimated filament mass and length for PLA, PETG, ABS or TPU at a given infill. |
| **Configurations** | Named design variants with a parameter table (empty cells inherit the Default value), switched from the Parameters tab or the viewport chip, with STEP export of every variant. |
| **Turntable video** | Frame-exact WebM export (VP9/VP8 via WebCodecs) at 1080p, 720p, square or vertical sizes. |
| **Manufacturing outputs** | Bill of materials (material, volume, mass, area, size per body; CSV export) and 3MF export with colours, in millimetres. 3MF meshes are welded so slicers see a closed solid. |
| **Appearance** | Appearance editor (<kbd>A</kbd>): paint whole bodies or individual faces, with 24 colour swatches, a custom colour/hex picker and 10 finishes (matte, satin, gloss, car paint with clear coat, metallic, brushed, anodized, chrome, soft-touch, transparent). It also has roughness / metalness / clear-coat / opacity sliders, a 44-entry appearance library (paint, metal, plastic, other), an eyedropper (Alt-click) and "colour each body differently". Appearance is separate from the physical material, so repainting never changes the mass. |
| **Materials** | 28 physical materials in 5 categories (metals, plastics, elastomers, natural, composites), each with a density and a PBR look. |
| **Surface analysis** | Zebra stripes (reflection continuity), isophotes (lines of constant light angle) and Draft analysis (green / yellow / red against a pull direction and minimum angle). Visual styles: shaded with edges, shaded, X-ray and wireframe. |
| **Units** | mm, cm, m or in per document. Plain numbers are read in document units, while parameters and suffixed values (`1 in`) stay exact. |
| **Measure** | Edge length, line/circle type and radius, face area and type, minimum distance and angle between two entities, plus ΔX/ΔY/ΔZ. |

## Controls

| Action | Input |
|---|---|
| Orbit | Right-drag, or Shift + middle-drag |
| Pan | Middle-drag, or Shift + right-drag |
| Zoom | Mouse wheel (zooms toward the cursor) |
| Standard views | Click a ViewCube face, edge or corner |
| Command search | <kbd>S</kbd> |
| Shortcuts | <kbd>E</kbd> Extrude · <kbd>Q</kbd> Press Pull · <kbd>F</kbd> Fillet · <kbd>H</kbd> Hole · <kbd>M</kbd> Move · <kbd>J</kbd> Joint · <kbd>I</kbd> Measure · <kbd>A</kbd> Appearance · <kbd>F6</kbd> Fit · <kbd>Del</kbd> Remove · <kbd>Ctrl+Z/Y</kbd> |
| In sketch | <kbd>L</kbd> line · <kbd>R</kbd> rect · <kbd>C</kbd> circle · <kbd>A</kbd> arc · <kbd>P</kbd> polygon · <kbd>S</kbd> slot · <kbd>D</kbd> dimension · <kbd>T</kbd> trim · <kbd>O</kbd> offset · <kbd>F</kbd> fillet · <kbd>X</kbd> construction · type numbers while drawing for exact sizes |

## Project layout

```
src/
  sketch/model.js      sketch data model, curve geometry, intersections, v1 migration
  sketch/solver.js     geometric constraint solver + DOF analysis
  sketch/regions.js    planarization + half-edge face detection → profiles with holes
  kernel/build.js      feature builders + cached rebuild engine (OpenCascade via replicad)
  kernel/cad.worker.js Web Worker hosting the kernel
  kernel/client.js     promise API that drops stale builds
  viewport.js          Three.js scene, camera, ViewCube, picking, highlights, section, motion
  sketcher.js          sketch mode UI and tools
  drawing.js           2D drawing workspace
  features.js          feature catalog: dialog fields and defaults
  main.js              app shell: app bar, toolbar, panels, inspector, timeline, palette, prefs, export
  home.js              project dashboard
  cvedit.js            CV curve drawing and control-vertex editing for curves and surfaces
  nurbs.js             B-spline evaluation for live CV previews
  store.js             IndexedDB projects/versions + preferences
tests/                 Node tests that run the real solver and kernel
```

## Known limitations

- **Topological naming.** Picked faces and edges are stored with a geometric fingerprint (type, normal or axis, centre, area or length) and are re-found by that fingerprint after edits, including split faces and edges. Big topology changes can still lose a pick; the feature then turns red and asks you to reselect.
- **Assemblies:** mates are solved together, with distance and angle limits, gear, rack-and-pinion and contact mates, and a collision check, but no cam mates or dynamics. Joint animation is visual only.
- **Sketch projections are associative** (re-found by fingerprint after each change); trim and offset don't apply to splines.
- **Surfaces:** Rebuild is exact for NURBS and planar faces; other analytic faces are refitted, with the deviation reported. Trim edges are exact for lines and arcs; free-form trim edges are fitted to 1e-9 in UV. Fillet size laws are linear, S-curve or through a middle value; arbitrary multi-point laws are not supported.
- **Not built:** T-splines, 4th/5th-axis CAM, contact and large-deflection simulation, and signed installers (the packaging script signs when you provide certificates; see below).
