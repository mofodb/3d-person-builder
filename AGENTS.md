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

**The MPFB base mesh is ~37k triangles**, roughly 4.5x over the 8k LOD0 budget.
Do not fix this by decimating — that wrecks morph targets and UVs. MakeHuman
ships purpose-built low-poly *proxy* meshes that automatically follow the base
mesh's morphs. Use those.

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

- Recipe values are **normalized** (0..1, or -1..1 when symmetric). Physical
  units live in `packages/recipe/src/ranges.ts` only. Changing a range must
  never invalidate a saved character.
- Cosmetics are referenced by stable string ID (`category.asset_name`), never
  by file path.
- Add a migration in `packages/recipe/src/migrate.ts` for every schema change.
- Never commit generated assets (`assets/dist/`), model weights, or uploaded
  photos.
