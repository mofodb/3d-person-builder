# 3D Person Builder

A parametric 3D character builder for browser games. Set body, face, skin, hair,
and clothing parameters — optionally guided by a photo — and export a rigged,
animation-ready model.

**Status:** early development. Phase 1 (parametric body) in progress.

## Design

The core idea is that a character is **data, not a model**.

A `CharacterRecipe` is a small (< 1 KB) JSON document describing a character as
normalized parameters. At runtime the app loads **one shared base GLB** (mesh +
skeleton + morph targets + animations) and applies a recipe to it. A game can
therefore transmit a character as ~1 KB of JSON rather than a multi-megabyte
model, and every character shares one cached asset and one animation set.

Baking a standalone `.glb` is an *export* feature, not the runtime path.

### Model format

Output is **glTF 2.0 binary (`.glb`)** — the de facto standard for web 3D.
It carries skinning, morph targets, and animation in a single file, loads
natively in Babylon.js/three.js/PlayCanvas, and imports into Unity/Godot/Unreal.
Geometry is compressed with Draco/Meshopt and textures with KTX2/Basis.

## Budgets

| Target | Value |
|---|---|
| LOD0 / LOD1 / LOD2 | 8k / 4k / 1.5k triangles |
| Skeleton | ~55 bones, Mixamo-compatible naming |
| Textures | 1K KTX2 atlas, one material per character |
| Base GLB | < 3 MB compressed |
| Recipe payload | < 1 KB JSON |

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
