# 3D Person Builder

A parametric 3D character builder for browser games. Set body, face, skin, hair,
and clothing parameters — optionally guided by a photo — and export a rigged,
animation-ready model.

**Status:** early development. Phase 1 (parametric body) in progress.

## Design

The core idea is that a character is **data, not a model**.

A `CharacterRecipe` is a small (< 1 KB) JSON document describing a character. At
runtime the app loads **one shared base GLB** (mesh + skeleton + morph targets +
animations) and applies a recipe to it. A game can therefore transmit a
character as ~1 KB of JSON rather than a multi-megabyte model, and every
character shares one cached asset and one animation set.

Baking a standalone `.glb` is an *export* feature, not the runtime path.

### Measurements

Height, mass, and age are specified in **real units** — cm/kg, or feet-inches
and pounds in the UI. Only unitless art-direction dials (muscularity, nose
width, cheekbones) are normalized 0–1.

**You set height, weight, and body fat %. Muscularity is derived.** Mass alone
doesn't determine appearance — 180 cm at 80 kg looks completely different lean
versus soft — so body fat is the second input. Lean mass and muscularity then
follow from FFMI (lean mass ÷ height²), the objective measure of muscularity.

This means a 6'2", 202 lb character can be set to 10% body fat and correctly
reads as a lean athlete (FFMI 23.3). Dragging the muscularity slider instead
back-solves body fat at the same weight, so the two views can never disagree. To
get bigger *and* leaner, raise the weight.

Impossible combinations are flagged rather than silently built, checked against
both BMI (6'8" at 30 kg) and FFMI (4'11" at 250 lb and 5% fat).

### Model format

Output is **glTF 2.0 binary (`.glb`)** — the de facto standard for web 3D.
It carries skinning, morph targets, and animation in a single file, loads
natively in Babylon.js/three.js/PlayCanvas, and imports into Unity/Godot/Unreal.
Geometry is compressed with Draco/Meshopt and textures with KTX2/Basis.

## Budgets

| Target | Goal | Current |
|---|---|---|
| LOD0 triangles | 8k | **26,756** — see below |
| LOD1 / LOD2 | 4k / 1.5k | not built yet |
| Skeleton | ~55 bones | **52** (`rig.mixamo`, exact Mixamo naming) |
| Textures | 1K KTX2 atlas, one material | not built yet |
| Base GLB | < 3 MB compressed | **5.5 MB** uncompressed, no Draco/KTX2 yet |
| Recipe payload | < 1 KB JSON | **~700 B** typical, ~1.7 KB with a photo fit |

### On the triangle count

The MakeHuman base mesh is 26,756 triangles after stripping helper geometry —
about 3.3x the eventual LOD0 goal. This is knowingly deferred, not overlooked:

- It is entirely fine for the editor and a single-player demo, which is all that
  currently renders. It would *not* be fine for 30 characters on a phone.
- Decimation is the wrong fix. It destroys morph targets and UV seams.
- The right fix is a low-poly *proxy* mesh whose vertices are bound to the base
  mesh by barycentric surface mapping, so body morphs propagate automatically.
  That is exactly the mechanism behind MakeHuman's `.mhclo` proxies. MPFB ships
  no proxy meshes, so this one has to be authored or generated.

Doing that before the parametric system works would be backwards, so it is
Phase 4 work. Nothing in the runtime depends on the current count.

## Layout

```
apps/editor/        Babylon.js character builder (web UI)
apps/demo-game/     Single-player test scene
packages/recipe/    CharacterRecipe schema + migrations  <- shared contract
packages/avatar-runtime/  base GLB + recipe -> live Babylon avatar
packages/exporter/  recipe -> standalone GLB
services/face/      FastAPI photo -> face parameters (local GPU)
pipeline/blender/   Headless Blender asset authoring
pipeline/optimize/  gltf-transform compression + LOD generation
assets/             Source .blend files and built output
```

## Getting started

Requires Node 24+, pnpm 11+, Blender 4.5 LTS, and Python 3.12.
See [AGENTS.md](AGENTS.md) for full environment setup.

```bash
pnpm install
pnpm test
pnpm dev
```

## Licensing

This project is MIT licensed. It builds on third-party assets with their own terms:

| Component | License | Notes |
|---|---|---|
| MakeHuman / MPFB assets | CC0 | Base mesh, targets, proxies, clothing. No restrictions. |
| MPFB source code | GPLv3 | Used only as a build-time tool in `pipeline/`. Not linked by the app. |
| Face reconstruction models | varies, often CC BY-NC | **Non-commercial.** See `services/face/`. |

> **This project is configured for non-commercial use.** The photo-to-face
> models are research releases under non-commercial licenses. Going commercial
> would require replacing them; the fitter sits behind an interface to keep that
> change contained.

## Privacy

Uploaded photos are processed locally and deleted after fitting. No face data is
retained. Face imagery is regulated as biometric data in several jurisdictions —
do not add photo retention without understanding the obligations.
