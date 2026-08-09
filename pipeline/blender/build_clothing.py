"""Build a clothing GLB that follows the base mesh's body morphs and rig.

An .mhclo file maps every clothing vertex to 3 base-mesh vertices plus
barycentric weights and an offset (see docs/entities/clothes/mhclo.md in the
MPFB source), which is exactly the mechanism that lets clothes fit MakeHuman's
body-shape targets. This script reuses that mechanism directly rather than
reimplementing the barycentric math: it fits the garment once via MPFB's own
`add_mhclo_asset` (which also sets up rig weights), then toggles the SAME base
mesh through each of its own body-morph shape keys one at a time and calls
`HumanService.refit()` to recompute the garment for that shape. The resulting
before/after vertex diffs become clothing shape keys, NAMED IDENTICALLY to the
body morphs they mirror -- so the exact same `solveMorphWeights()` output the
runtime already computes for the body can be applied to a garment's morph
targets with zero new runtime logic.

Requires the base character to already be built in the current session (this
script calls build_character() itself, so it is self-contained) and an .mhclo
file downloaded via a MakeHuman Community asset pack (see
list_clothing_pack.py to find one inside a downloaded pack).

Run:
    blender --background --python pipeline/blender/build_clothing.py -- \\
        --mhclo ".cache/mhassets/shirts01/clothes/toigo_basic_tucked_t-shirt/toigo_basic_tucked_t-shirt.mhclo" \\
        --slot torso --name tshirt
"""

import argparse
import json
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(__file__))
import build_basemesh as bb  # noqa: E402

DIST_DIR = os.path.join(bb.REPO_ROOT, "assets", "dist")
VALID_SLOTS = ("head", "torso", "legs", "feet", "hands", "back", "accessory")


def imp(module: str):
    import importlib

    for prefix in ("bl_ext.blender_org.mpfb", "mpfb"):
        try:
            return importlib.import_module(f"{prefix}.{module}")
        except ModuleNotFoundError:
            continue
    raise RuntimeError("MPFB not installed")


def evaluated_coords(obj) -> list:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    coords = [tuple(v.co) for v in mesh.vertices]
    evaluated.to_mesh_clear()
    return coords


def fit_clothing(base_obj, mhclo_path: str, *, rigged: bool):
    """Loads and fits the garment to the base mesh's CURRENT shape.

    `HumanService.refit()` was tried first and rejected: it re-resolves the
    .mhclo path through MPFB's own asset registry (populated only by
    "install asset pack"), so it cannot find a file loaded directly from our
    .cache folder even though the initial fit -- which takes the path as a
    plain argument -- works fine. Refitting is done instead by discarding the
    garment and calling `add_mhclo_asset` again with the same absolute path,
    which recomputes the barycentric fit against whatever shape the base mesh
    is CURRENTLY in (its shape key mix included; see build()'s empirical check
    of this via non-zero, morph-correlated deltas below).

    Rigging/weight interpolation are skipped for throwaway capture-only fits
    (`rigged=False`) since only vertex positions are needed and setting up an
    armature modifier for an object about to be deleted is pure overhead. The
    one instance that is actually exported is fit with `rigged=True`.
    """
    HumanService = imp("services.humanservice").HumanService
    clothing_obj = HumanService.add_mhclo_asset(
        mhclo_path,
        base_obj,
        set_up_rigging=rigged,
        interpolate_weights=rigged,
        import_subrig=rigged,
        import_weights=rigged,
    )
    if clothing_obj is None:
        raise RuntimeError(f"add_mhclo_asset returned nothing for {mhclo_path}")
    return clothing_obj


def drop_clothing(clothing_obj) -> None:
    mesh = clothing_obj.data
    bpy.data.objects.remove(clothing_obj, do_unlink=True)
    if mesh.users == 0:
        bpy.data.meshes.remove(mesh)


def set_body_morph(base_obj, morph_name: str, value: float) -> None:
    key_blocks = base_obj.data.shape_keys.key_blocks
    if morph_name not in key_blocks:
        raise RuntimeError(f"Base mesh has no shape key '{morph_name}'")
    key_blocks[morph_name].value = value


def triangle_count(mesh) -> int:
    return sum(len(p.vertices) - 2 for p in mesh.polygons)


def validate_single_mesh(glb_path: str) -> None:
    """A garment GLB must contain exactly one mesh.

    An earlier version of this script selected the garment's parent and all of
    the parent's children before exporting, which also swept up the base body
    mesh as a sibling under the same parent and shipped a full redundant copy
    of the body in every garment file. Checked directly against the exported
    bytes rather than trusted, since that bug produced no error of its own --
    the file was simply larger and wrong.
    """
    import json as _json
    import struct as _struct

    with open(glb_path, "rb") as handle:
        blob = handle.read()
    json_length = _struct.unpack_from("<I", blob, 12)[0]
    gltf = _json.loads(blob[20 : 20 + json_length].decode("utf-8"))
    mesh_count = len(gltf.get("meshes", []))
    if mesh_count != 1:
        names = [m.get("name") for m in gltf.get("meshes", [])]
        raise RuntimeError(
            f"Expected exactly 1 mesh in the exported garment GLB, found {mesh_count} "
            f"({names}). A garment file should never carry a copy of the body mesh."
        )


def build(mhclo_path: str, slot: str, name: str) -> None:
    if slot not in VALID_SLOTS:
        raise RuntimeError(f"Unknown slot '{slot}'; expected one of {VALID_SLOTS}")
    if not os.path.isfile(mhclo_path):
        raise RuntimeError(f"No .mhclo file at {mhclo_path}")

    print("CLOTHING building base character")
    base, _manifest = bb.build_character()

    print("CLOTHING fitting garment (neutral, rigged):", mhclo_path)
    clothing_obj = fit_clothing(base, mhclo_path, rigged=True)
    vertex_count = len(clothing_obj.data.vertices)
    print(f"CLOTHING garment vertices: {vertex_count}")

    neutral = evaluated_coords(clothing_obj)

    clothing_obj.shape_key_clear()
    for index, coord in enumerate(neutral):
        clothing_obj.data.vertices[index].co = coord
    clothing_obj.shape_key_add(name="Basis", from_mix=False)

    extracted = []
    for morph_name, macro_axis, _macro_value, _overrides, _details in bb.MORPH_BASIS:
        set_body_morph(base, morph_name, 1.0)

        throwaway = fit_clothing(base, mhclo_path, rigged=False)
        coords = evaluated_coords(throwaway)
        drop_clothing(throwaway)

        set_body_morph(base, morph_name, 0.0)

        if len(coords) != vertex_count:
            raise RuntimeError(
                f"{morph_name}: garment vertex count changed ({len(coords)} vs "
                f"{vertex_count}); refitting is not expected to alter topology"
            )

        key_block = clothing_obj.shape_key_add(name=morph_name, from_mix=False)
        max_delta = 0.0
        for index, coord in enumerate(coords):
            key_block.data[index].co = coord
            delta = max(abs(coord[axis] - neutral[index][axis]) for axis in range(3))
            max_delta = max(max_delta, delta)

        extracted.append({"name": morph_name, "macro": macro_axis, "max_delta_cm": round(max_delta * 100, 3)})
        print(f"CLOTHING morph {morph_name}: max delta {max_delta * 100:.2f} cm")

    moving = [m for m in extracted if m["max_delta_cm"] > 0.01]
    if not moving:
        raise RuntimeError(
            "No clothing morph shows any deformation at all. This is the exact "
            "symptom of add_mhclo_asset fitting against the base mesh's "
            "UNDEFORMED rest positions rather than its current shape-key mix; "
            "see the note in fit_clothing() before assuming this is a fluke."
        )
    print(f"CLOTHING {len(moving)}/{len(extracted)} morphs produced real deformation")

    mesh = clothing_obj.data
    stats = {
        "vertices": len(mesh.vertices),
        "triangles": triangle_count(mesh),
        "shape_keys": len(mesh.shape_keys.key_blocks) if mesh.shape_keys else 0,
    }
    print("CLOTHING final:", json.dumps(stats))

    os.makedirs(DIST_DIR, exist_ok=True)
    glb_path = os.path.join(DIST_DIR, f"clothing.{slot}.{name}.glb")
    manifest_path = os.path.join(DIST_DIR, f"clothing.{slot}.{name}.manifest.json")

    # Select the garment plus its OWN armature object, and nothing else.
    # Blender's exporter does not pull in a modifier-referenced armature that
    # is not itself selected -- selecting the mesh alone silently dropped skin
    # data entirely. The earlier attempt of selecting the garment's parent plus
    # all of the parent's children happened to include the armature too, but
    # also swept up the base body mesh as a sibling under that same parent,
    # shipping a redundant full copy of the body in every garment's GLB.
    armature_obj = clothing_obj.find_armature()
    if armature_obj is None:
        raise RuntimeError(
            f"{clothing_obj.name} has no Armature modifier; it will not be skinned "
            "and will not deform with Idle/Walking at runtime."
        )

    bpy.ops.object.select_all(action="DESELECT")
    clothing_obj.select_set(True)
    armature_obj.select_set(True)
    bpy.context.view_layer.objects.active = clothing_obj
    bpy.ops.export_scene.gltf(
        filepath=glb_path,
        export_format="GLB",
        use_selection=True,
        export_morph=True,
        export_skins=True,
        export_apply=False,
        export_yup=True,
    )

    manifest = {
        "generator": "pipeline/blender/build_clothing.py",
        "slot": slot,
        "sourceMhclo": os.path.relpath(mhclo_path, bb.REPO_ROOT),
        "mesh": stats,
        "morphs": extracted,
    }
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)

    validate_single_mesh(glb_path)

    print("CLOTHING glb:", glb_path, os.path.getsize(glb_path))
    print("CLOTHING manifest:", manifest_path)


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--mhclo", required=True)
    parser.add_argument("--slot", required=True, choices=VALID_SLOTS)
    parser.add_argument("--name", required=True)
    args = parser.parse_args(argv)

    try:
        build(args.mhclo, args.slot, args.name)
    except Exception as exc:
        import traceback

        traceback.print_exc()
        print("CLOTHING FAILED:", exc)
        sys.exit(1)
