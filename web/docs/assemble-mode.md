# Assemble mode

Status: prototype on branch `captain/assemble-mode`. Not shipped.

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
   - **Offset**: gap along the target normal, 0–20 mm, applied when you let go.
   - **Rotate**: −90° / +90° buttons plus a free angle box, spinning about the target normal.
5. **Apply** commits the placement. **Cancel** restores the part.
6. **Undo** (button, or Ctrl/Cmd+Z while the tool is active) steps back through mates, adds and removes.

Highlights: hover is the existing pick highlight. The chosen moving face and target face each keep their own colour
until Apply or Cancel.

**Later: move/rotate gizmo** (designed, not in the prototype)
- Port BuildBench's `gizmo.ts` + `gizmoMath.ts`: a ring to spin about the mate normal, plus two in-plane slide arrows,
  shown on the target face while a mate is previewed.
- A free-placement gizmo (XYZ arrows + 3 rings) for parts with no good face to mate.
- Both write the same transform as the mate panel, and both are undoable.

**Lay on face and assembling**
- Mates are solved in assembly space.
- If a lay-on-face orientation is set, entering the Assemble tool resets it, with a toast. Lay it down again once the
  assembly is done.
- Composing the two later (keep the orientation and map picks back through it) is a follow-up.

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
| `addModelFile(bytes, filename)` | parse, store as an item, place beside the assembly → `{ itemId, info }` |
| `removeModelFile(itemId)` | drop the item |
| `setPlacements([{ itemId, R, t }])` | update transforms |
| `setModel(bytes, filename)` | unchanged: replaces the assembly with one file |

Each request recomposes the model and replies with `ModelInfo`, like `setModel`.

## Export

- **One Bambu project**, assembled layout.
  - Per-part ON: one object per part with its own modifiers. Assembled parts usually overlap in XY, so the existing
    layout lays them out flat to print separately (shown as an info toast: "Parts are laid out to print separately; the
    camo still lines up when assembled"). Each object's modifiers move with it, verified to within 4.3e-6 mm.
  - Per-part OFF: one "Assembly" object with N parts, kept in the mated pose.
- The plain 3MF and STL zip follow the same structure.
- Recommended default for assemblies: **Per-part ON**. Assembled parts usually overlap in XY, and printing apart is
  the point.

## Persistence (not in the prototype)

- **Auto-save.** Every item's file bytes and transform go into IndexedDB, alongside painted faces, textures and settings.
  Restore on reload ("Restore last assembly?").
- **Save/load assembly.** A `.pimp.json`, or a 3MF with the transforms in metadata, for sharing.
- Mates aren't stored, only the resulting transforms. A stored mate graph that re-solves (like BuildBench) is more than
  this tool needs.

## Effort and risks

| Piece | Effort |
|---|---|
| Prototype: items, compose, worker API, parts list, face mate with flip/offset/rotate, undo | done on the branch |
| Polish to ship: instant client-side preview while adjusting (move the part's display mesh, recompute once on Apply), edge cases, tests | 2–3 days |
| Gizmo (mate ring and slides plus free move/rotate) | 2 days |
| Persistence (IndexedDB auto-save + restore) | 1 day |
| Keep lay-on-face while assembling | 0.5 day |
| Interference check (BuildBench `interference.ts`) and "leave mating faces plain" | 2–3 days |

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
