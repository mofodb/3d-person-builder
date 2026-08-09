"""Report the MPFB base mesh's real cost, available rigs, and morph target names.

This drives two decisions: which rig to standardise on, and how to get the
body inside the triangle budget. Run it before changing the asset pipeline.

Run:
    blender --background --python pipeline/blender/inspect_basemesh.py
"""

import json
import os
import sys
from collections import defaultdict

import bpy

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
REPORT_PATH = os.path.join(REPO_ROOT, "assets", "basemesh_report.json")


def import_mpfb(module: str):
    """MPFB is `bl_ext.blender_org.mpfb` as an extension, `mpfb` as a legacy addon."""
    import importlib

    for prefix in ("bl_ext.blender_org.mpfb", "mpfb"):
        try:
            return importlib.import_module(f"{prefix}.{module}")
        except ModuleNotFoundError:
            continue
    raise RuntimeError("MPFB not installed")


def triangle_count(mesh) -> int:
    """Triangles after triangulation, which is what a GPU actually draws."""
    return sum(len(polygon.vertices) - 2 for polygon in mesh.polygons)


def classify_vertex_groups(obj) -> dict:
    groups = defaultdict(list)
    for group in obj.vertex_groups:
        name = group.name
        if name.startswith("helper") or name.startswith("joint") or "helper" in name:
            groups["helper"].append(name)
        elif name.startswith("body") or name.startswith("Mid") or name.startswith("Left") or name.startswith("Right"):
            groups["body"].append(name)
        else:
            groups["other"].append(name)
    return {key: sorted(value) for key, value in groups.items()}


def measure_helper_geometry(obj) -> dict:
    """Helper geometry drives clothing fitting but must never ship. Measure it."""
    helper_group_indices = {
        group.index for group in obj.vertex_groups if "helper" in group.name.lower()
    }
    if not helper_group_indices:
        return {"detected": False}

    helper_verts = {
        vertex.index
        for vertex in obj.data.vertices
        if any(g.group in helper_group_indices for g in vertex.groups)
    }
    helper_polys = [
        polygon
        for polygon in obj.data.polygons
        if all(v in helper_verts for v in polygon.vertices)
    ]
    helper_tris = sum(len(p.vertices) - 2 for p in helper_polys)

    return {
        "detected": True,
        "vertices": len(helper_verts),
        "polygons": len(helper_polys),
        "triangles": helper_tris,
        "shipping_vertices": len(obj.data.vertices) - len(helper_verts),
        "shipping_triangles": triangle_count(obj.data) - helper_tris,
    }


def inspect_rigs() -> dict:
    """Bone count per available rig. Fewer bones means cheaper skinning."""
    location = import_mpfb("services.locationservice").LocationService
    rig_dir = location.get_mpfb_data("rigs")

    rigs = {}
    for root, _dirs, files in os.walk(rig_dir):
        for filename in sorted(files):
            if not filename.startswith("rig.") or not filename.endswith(".json"):
                continue
            path = os.path.join(root, filename)
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    data = json.load(handle)
            except (OSError, json.JSONDecodeError) as exc:
                rigs[filename] = {"error": str(exc)}
                continue
            bones = data.get("bones", {})
            rigs[filename] = {
                "bones": len(bones),
                "family": os.path.basename(root),
                "sample_bones": sorted(bones.keys())[:8],
            }
    return rigs


def inspect_targets() -> dict:
    location = import_mpfb("services.locationservice").LocationService
    target_dir = location.get_mpfb_data("targets")

    categories = {}
    macro_names = []
    for entry in sorted(os.listdir(target_dir)):
        category_path = os.path.join(target_dir, entry)
        if not os.path.isdir(category_path):
            continue
        names = []
        for root, _dirs, files in os.walk(category_path):
            for filename in files:
                if filename.endswith((".target", ".target.gz")):
                    names.append(filename.split(".target")[0])
        categories[entry] = len(names)
        if entry == "macrodetails":
            macro_names = sorted(names)

    return {"counts": categories, "macrodetails": macro_names}


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)

    HumanService = import_mpfb("services.humanservice").HumanService
    basemesh = HumanService.create_human(mask_helpers=False, detailed_helpers=True)

    mesh = basemesh.data
    report = {
        "basemesh": {
            "name": basemesh.name,
            "vertices": len(mesh.vertices),
            "polygons": len(mesh.polygons),
            "triangles": triangle_count(mesh),
            "quads": sum(1 for p in mesh.polygons if len(p.vertices) == 4),
            "uv_layers": [layer.name for layer in mesh.uv_layers],
            "shape_keys": (
                [kb.name for kb in mesh.shape_keys.key_blocks] if mesh.shape_keys else []
            ),
            "vertex_group_count": len(basemesh.vertex_groups),
        },
        "helpers": measure_helper_geometry(basemesh),
        "vertex_groups": classify_vertex_groups(basemesh),
        "rigs": inspect_rigs(),
        "targets": inspect_targets(),
    }

    os.makedirs(os.path.dirname(REPORT_PATH), exist_ok=True)
    with open(REPORT_PATH, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)

    base = report["basemesh"]
    print("REPORT verts:", base["vertices"])
    print("REPORT polys:", base["polygons"], "quads:", base["quads"])
    print("REPORT tris:", base["triangles"])
    print("REPORT uv_layers:", base["uv_layers"])
    print("REPORT helpers:", json.dumps(report["helpers"]))
    print("REPORT target_total:", sum(report["targets"]["counts"].values()))
    for name, info in sorted(report["rigs"].items()):
        print(f"REPORT rig {name}: {info.get('bones', '?')} bones")
    print("REPORT written:", REPORT_PATH)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        import traceback

        traceback.print_exc()
        print("REPORT FAILED:", exc)
        sys.exit(1)
