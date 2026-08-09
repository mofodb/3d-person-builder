"""Verify MPFB can generate a rigged human mesh headless and export it as GLB.

Run:
    blender --background --python pipeline/blender/smoke_test.py
"""

import os
import sys

import bpy

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "assets", "dist")


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_human_service():
    """MPFB is namespaced under bl_ext when installed as an extension (Blender 4.2+),
    but plain `mpfb` when installed as a legacy addon. Support both."""
    import importlib

    for prefix in ("bl_ext.blender_org.mpfb", "mpfb"):
        try:
            return importlib.import_module(f"{prefix}.services.humanservice").HumanService
        except ModuleNotFoundError:
            continue
    raise RuntimeError("MPFB not found. Install with: blender --online-mode --command extension install mpfb --enable")


def main():
    clear_scene()

    HumanService = import_human_service()

    basemesh = HumanService.create_human(mask_helpers=True, detailed_helpers=True)
    print("SMOKE basemesh:", basemesh.name)
    print("SMOKE verts:", len(basemesh.data.vertices))
    print("SMOKE polys:", len(basemesh.data.polygons))

    shape_keys = basemesh.data.shape_keys
    key_count = len(shape_keys.key_blocks) if shape_keys else 0
    print("SMOKE shapekeys:", key_count)

    os.makedirs(OUT_DIR, exist_ok=True)
    out_path = os.path.abspath(os.path.join(OUT_DIR, "smoke_basemesh.glb"))
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        export_morph=True,
        export_skins=True,
    )
    print("SMOKE glb:", out_path, os.path.getsize(out_path))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # surface the real error in headless output
        import traceback

        traceback.print_exc()
        print("SMOKE FAILED:", exc)
        sys.exit(1)
