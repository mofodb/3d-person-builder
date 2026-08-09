# Project notes

Environment setup, verification commands, and hard-won gotchas.

## Toolchain

| Tool | Version | Install |
|---|---|---|
| Git | 2.55.0 | `winget install Git.Git` |
| Node.js | 24.19.0 LTS | `winget install OpenJS.NodeJS.LTS` |
| pnpm | 11.21.0 | `npm install -g pnpm@latest` |
| Python | 3.12.10 | `winget install Python.Python.3.12` |
| Blender | 4.5.10 LTS | `winget install BlenderFoundation.Blender.LTS.4.5` |
| MPFB2 | build 20260722 | see below |

Blender 4.5 LTS was chosen over 5.x because MPFB is only verified against
Blender 4.2 LTS and newer, and 5.x carries Python API breaks.

Python 3.12 is installed **alongside** the system Python 3.14. The ML stack
(PyTorch etc.) has no 3.14 wheels. Always use `py -3.12` for `services/face`.

## Verification commands

```powershell
pnpm install          # install workspace deps
pnpm typecheck        # tsc across all packages
pnpm test             # node:test across all packages
pnpm dev              # run the editor
```

Blender pipeline smoke test (should print SMOKE lines and write a GLB):

```powershell
blender --background --python pipeline/blender/smoke_test.py
```

Inspect any generated GLB without installing anything: https://sandbox.babylonjs.com

## Gotchas

**Blender defaults to offline mode.** Extension installs need `--online-mode`:

```powershell
blender --online-mode --command extension sync
blender --online-mode --command extension install mpfb --enable
```

**MPFB's Python namespace depends on install method.** As a Blender 4.2+
*extension* it is `bl_ext.blender_org.mpfb`; as a legacy addon it is `mpfb`.
Pipeline scripts must try both — see `import_human_service()` in
`pipeline/blender/smoke_test.py`.

**Blender bundles its own Python 3.11.** Pipeline scripts run under that
interpreter, not the system Python. Don't assume system packages are available.

**The MPFB base mesh is 36,972 triangles**, of which 8,716 are helper geometry.
Stripping helpers leaves **13,380 verts / 26,756 tris** — 13,380 is the known
MakeHuman body vertex count, which is a good signal the strip was correct.
Do not fix the remaining overage by decimating; that wrecks morph targets and
UVs. The fix is a proxy mesh bound by barycentric mapping. MPFB ships no proxy
meshes, so one must be authored. Deferred to Phase 4.

**Measure height on body vertices only.** MakeHuman's helper meshes and joint
cubes extend past the scalp and below the soles, so measuring the full mesh
overstates standing height by ~3.5 cm. This produced a real calibration bug:
the neutral character reported 169.4 cm while the exported GLB bounding box was
165.9 cm. `body_vertex_indices()` excludes groups starting with `helper`/`joint`.

**`bpy.ops.mpfb.delete_helpers` exists in `dir(bpy.ops.mpfb)` but is not
callable** from a background script ("could not be found" at call time,
presumably a poll/context issue). `build_basemesh.py` falls back to deleting
vertices in `helper*`/`joint*` groups via bmesh, which yields the expected
13,380 verts.

**MPFB's `height` macro is strongly non-linear** — roughly 18 cm per quarter
turn below the midpoint and 35 cm above it. Never map cm to the dial linearly;
interpolate `heightCalibration.samples` in the manifest. Height also varies with
gender, so the table is sampled per gender.

**MPFB blends 349 combinatorial macro targets**, not independent sliders.
`build_basemesh.py` extracts an independent 19-morph basis by driving each macro
to its extremes and diffing against neutral. Linear blending of these is an
approximation that diverges most when several parameters are simultaneously
extreme — an accepted tradeoff for live preview.

**MakeHuman's age dial is piecewise**: 0 -> 1 year, 0.5 -> 25 years, 1 -> 90
years. Converting years to the dial needs both branches.

**Zod 4 changed `.default()`** to expect the *output* type, so `.default({})` no
longer populates nested defaults. Use `.prefault({})` for nested object schemas.

**`packages/recipe` is consumed as TypeScript source**, never built to JS. It
uses `.ts` import extensions with `allowImportingTsExtensions` + `noEmit`.
Vite bundles it directly; Node strips types natively.

**PowerShell execution policy** was set to `RemoteSigned` for CurrentUser so
npm's `.ps1` shims run. Revert with
`Set-ExecutionPolicy Undefined -Scope CurrentUser`.

**Blender is on the user PATH**, added at
`C:\Program Files\Blender Foundation\Blender 4.5`. New shells pick it up; an
already-open shell needs a PATH refresh.

## Conventions

- **Real measurements are stored in real SI units** (cm, kg, years). Normalizing
  them would mean that widening a range later silently resized every saved
  character. Imperial units exist only at the UI boundary
  (`packages/recipe/src/units.ts`); display preference is user state, not
  character data, so it never enters a recipe.
- **Unitless art-direction values are normalized** (0..1, or -1..1 when
  symmetric about a neutral midpoint): muscularity, cheekbone prominence, nose
  width. These only mean anything relative to the art, so their ranges live in
  `ranges.ts`.
- **Body fat is derived, never stored.** Mass alone does not determine
  appearance -- 180 cm / 80 kg looks entirely different lean versus soft -- so
  body fat comes from height + mass + age + gender + muscularity via
  `deriveBodyShape()`. Storing both mass and fatness would let them contradict
  each other. Consume `deriveBodyShape()` rather than reimplementing physiology.
- **Plausibility is judged on BMI, not body fat.** Body fat percentage cannot
  express that a skeleton has a minimum mass: 203 cm at 30 kg computes to an
  ordinary ~5% body fat but is impossible. See `PLAUSIBLE_BMI`.
- Ranges come in two tiers: `HARD` bounds enforced by the schema (wide, so
  future outliers need no migration) and `SLIDER` bounds for the UI working
  span. The intended cast is 4'11"-6'8" and 95-265 lb.
- Cosmetics are referenced by stable string ID (`category.asset_name`), never
  by file path.
- Add a migration in `packages/recipe/src/migrate.ts` for every schema change.
- Never commit generated assets (`assets/dist/`), model weights, or uploaded
  photos.
