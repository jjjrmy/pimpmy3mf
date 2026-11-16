# Assemble mode

Status: feature-complete on branch `captain/assemble-mode` (rebased on main); browser check pending.

Goal: load several model files, mate them face to face into their final configuration, then paint, texture and export
the assembly as one Bambu project. Each part can still print on its own plate with the camo lined up across the seams.

Reference: BuildBench (`guncad-bench`). The face-mate math and pick flow are ported from
`packages/geometry/src/solve.ts` (`solveMate`, `seatStart`) and `apps/desktop/src/renderer/assembly/mateFlow.ts`.
Bambu Studio's Assemble tool (face-to-face and point-to-point) is the second reference for the UX.

## UX

**Loading**
- Drop or upload several STL/3MF/OBJ files at once. Every file becomes one assembly item.
- With a model already loaded, a new model file is **added**, not swapped in. "Replace all" and "Clear all" in the
  parts list cover the old behaviour.
- A new item is placed beside the current assembly: +X of its bounding box with a 10 mm gap, min Z aligned, Y centred.
  So it never lands inside another part.

**Files list** (PAINT tab's Model section, replaces the single model row)
- One row per file: name, part count, eye (visibility), select (makes it the moving part), ✕ delete.
- "Add model", "Replace all", "Clear all".
- Hiding a file only affects the preview and picking. Export keeps every part unless the file is deleted.

**Assemble tool** (viewport toolbar, next to Lay on face / Paint face / Texture face; needs at least 2 files)
1. **Pick the moving face.** Click a face on the part that should move. The whole file it belongs to moves.
2. **Pick the target face** on a different file.
3. The moving part **snaps flush**:
   - its face normal is turned to oppose the target's;
   - the planes are made coincident;
   - the centroids are placed on each other;
   - for two elongated faces, their long directions line up.
4. **Adjust** in the mate panel:
   - **Flip**: same-facing instead of opposed, e.g. to stack a part the other way round.
   - **Offset**: gap along the target normal, 0–20 mm (default 0), applied when you let go. Re-picking only the target
     face keeps the gap; flip, spin and slide start over.
   - **Rotate**: −90° / +90° buttons plus a free angle box, spinning about the target normal.
   - **Mate gizmo**: a ring about the target normal (feeds the angle) and two in-plane slide arrows on the target face.
   - Snapping always uses the full seat (centroid on centroid, long directions lined up); the slide moves off it.
5. **Apply** commits the placement. **Cancel** restores the part.
6. **Undo** (button, or Ctrl/Cmd+Z while the tool is active) steps back through mates, gizmo moves, adds and removes.
   An undone remove puts the file back at its old list position, with its painted faces and textures.

Highlights: hover is the existing pick highlight and follows a previewed part. The chosen moving face and target face
each keep their own colour until Apply or Cancel.

**Move / rotate gizmo** (ported from BuildBench `gizmo.ts` + `gizmoMath.ts`)
- Shown when the Assemble tool is active, a file is selected (parts list "select", or its face picked) and no mate
  is half picked or previewed: X/Y/Z arrows and rings about X/Y/Z at the file's bbox centre.
- Snapping: 1 mm steps for arrows, 15° for rings; hold Shift for free values.
- During a drag only the display meshes move (client side); one `setPlacements` on release, one undo step.
  OrbitControls is off while dragging; Esc cancels a drag.
- In a mate preview the gizmo switches to the mate frame: a ring about the target normal (mate angle) and two slide
  arrows along `planeBasis(targetNormal)` (mate slide u/v). These only change the preview; Apply commits.
- Gizmo drags are allowed while a pipeline run is in flight (they're computed client side and stale-safe); face picks
  are paused with the other tools, as on main.

**Lay on face and assembling**
- `params.orientation` applies to the whole composed assembly, like any model. Entering Assemble keeps it.
- Item transforms always stay in assembly (unoriented) space. The pipeline reports the lay-on-face motion as
  `result.orientPlace` (rotation about the bbox centre + re-centre / drop, x' = R·x + t).
- Picks are read off the displayed result and mapped into current assembly space by
  `Tcur ∘ Tres⁻¹ ∘ orientPlace⁻¹` per file, where `Tres` is the placement the displayed result was computed for
  (the worker echoes the run's layout with `run:ok`). So picks also work on a result that lags the layout (a run in
  flight or cancelled). The mate is solved in assembly space; the preview is shown as `orientPlace ∘ M ∘ orientPlace⁻¹`.
- A displayed gizmo motion G commits as `orientPlace⁻¹ ∘ G ∘ orientPlace` on top of the file's transform.
- Proven in `scripts/test-assembly-solver.ts`: orient, mate on the laid pose, un-orient: faces coincident and opposed.

## Data model

```ts
interface AssemblyItem {
  id: string;            // stable across moves and reloads
  fileName: string;
  model: Model;          // as loaded: objects/parts in the file's own coordinates
  transform: { R: number[]; t: Vec3 };  // rigid, row-major 3x3 + translation, assembly space
}
```

- `composeAssembly(items)` builds the pipeline's `Model`:
  - **one object, "Assembly"**, whose parts are every item's parts with the item transform applied, in item order;
  - part names are the file name, or `file / part` for multi-part files;
  - a part → item map lets a pick on any part find the file that moves.
- Lay-on-face (`params.orientation`) is applied on top of the composed model, as today.
- Painted faces and textures keep pointing at `objectIndex` / `partIndex` / triangles:
  - **moving a part** leaves them valid, because the transform doesn't change topology;
  - **removing a file** drops entries on its parts and shifts the part indices after it;
  - **adding a file** appends parts, so existing indices are unchanged.

## Main features with an assembly

- **What counts as inside** (per-triangle openness slider): runs per part of the composed, assembled (and laid)
  model, like any multi-part upload, at every paint depth.
- **Texture mapping / unwrap modes**: textures index composed parts, so any part of the assembly can be textured.
- **Loading pill + tool pausing**: Assemble face picks pause with the other tools while a run is in flight. A mate
  preview survives a run (its picks index the result's parts; they reset only when the part structure changes).
- **Modifier prisms**: shown for the assembly. During a preview / gizmo drag (or while the view lags a move), per-part
  prisms move with their part; object-wide prisms (Per-part OFF) hide until the re-run lands.

## How it plugs into the pipeline

The composed model is exactly what a multi-part 3MF upload produces today. The rest of the pipeline is unchanged and
the camo is projected over the **assembled** pose:

- **Per-part modifiers.** Off: one object with N parts sharing one set of modifiers. On: each part becomes its own
  object with modifiers cropped to it, so parts can be laid out and printed apart without the pattern shifting.
- **Paint depth, inside detection.** Run per part on the composed meshes. A mating face buried against another part
  is still an outer face of its own part. "Leave mating faces plain" is a follow-up: faces in contact within ~0.1 mm
  could be treated like inside surfaces.
- **Painted faces, textures.** Index into the composed parts; the tools work on any part of the assembly.
- **Lay on face, cylindrical projection.** Apply to the whole assembly.

Worker API (the client keeps every file's bytes and the current placements, and replays them when it respawns a
worker):

| Request | Effect |
|---|---|
| `addModelFile(bytes, filename, { index?, transform? })` | parse, store as an item, place beside the assembly (or at `transform`), append (or insert at `index`) |
| `removeModelFile(itemId)` | drop the item |
| `setPlacements([{ itemId, R, t }])` | update transforms |
| `setModel(bytes, filename)` | unchanged: replaces the assembly with one file |

Each request recomposes the model and replies with `ModelInfo`, like `setModel`. `run:ok` also carries the
`RunLayout` (every file's placement and the part sources) the run painted.

## Export

- **Names**: one file keeps its stem. With 2+ files the stem is `<first>+<second>` (+ `+N` when N more follow, e.g.
  `grip+mount+2`), each part sanitized like a single file's stem and the pair capped at 60 chars. Then the usual
  `-<image stem>-<N>colors` suffix: `.3mf` (Bambu), `-plain.3mf`, `-stls.zip`, `-preview.png`
  (`assemblyStem` + `exportFilename` in `src/core/assembly.ts`).

- **One Bambu project**, assembled layout.
  - Per-part ON: one object per part with its own modifiers. Assembled parts usually overlap in XY, so the existing
    layout lays them out flat to print separately (shown as an info toast: "Parts are laid out to print separately; the
    camo still lines up when assembled"). Each object's modifiers move with it, verified to within 4.3e-6 mm.
  - Per-part OFF: one "Assembly" object with N parts, kept in the mated pose.
- The plain 3MF and STL zip follow the same structure.
- Recommended default for assemblies: **Per-part ON**. Assembled parts usually overlap in XY, and printing apart is
  the point.

## Persistence

- **Auto-save** (`src/ui/sessionStore.ts`, IndexedDB database `pimpmy3mf-session`, separate from the pattern library):
  - store `files`: each file's bytes + name, written once per file;
  - store `state`: item order, transforms, files hidden in the view, painted faces, textures, lay-on-face
    orientation, and the camo image (blob + name + preset id; cheap, so it's included).
  - Writes are debounced (1 s) and capped at 200 MB total (files + image); over the cap a warning toast says the
    session won't come back, and the saved copy is cleared.
  - Single-file loads persist the same way (one item).
- **Restore**: on load, a saved session is restored automatically, with an info toast "Restored your last assembly"
  (or "…model") and a **Start fresh** action (= Clear all).
- **Clear all** also clears the saved session.
- Not stored: mates (only the resulting transforms), paint depth / colors / other settings (they have their own
  localStorage defaults or reset per model).
- Later: save/load an assembly as a `.pimp.json` or a 3MF with the transforms in metadata, for sharing.

## Effort and risks

| Piece | Effort |
|---|---|
| Items, compose, worker API, parts list, face mate with flip/offset/rotate/slide, undo | done |
| Client-side preview (display meshes move, one recompute on Apply / release) | done |
| Gizmo (mate ring and slides plus free move/rotate) | done |
| Persistence (IndexedDB auto-save + restore) | done |
| Keep lay-on-face while assembling | done |
| Interference check (BuildBench `interference.ts`) and "leave mating faces plain" | later, 2–3 days |

**Risks**
- **Recompute cost.** Every placement change reruns the full pipeline, including the paint-depth shell carve
  (~25 s on big models). Mitigation: preview moves client-side and run the pipeline once on Apply. Paint depth stays
  commit-on-release.
- **Large assemblies.** Several 100k-triangle files make the worker heavy. Texture relief and shells multiply that.
- **Index drift.** Painted faces and textures address parts by index. Remove/reorder must remap them; the prototype
  handles remove, a reorder UI would need the same.
- **Coincident faces.** Mated faces that touch exactly can confuse the per-part bbox crop and the inside detection.
  An offset of 0.05–0.1 mm is a safe default for parts that print apart.
- **Plates.** Assembled parts often overlap in XY, so Per-part OFF can't lay them out without overlap on one plate. The
  UI should nudge users to Per-part ON.
