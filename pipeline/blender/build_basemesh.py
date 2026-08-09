"""Build the shared base GLB: one mesh, one skeleton, an independent morph basis.

MPFB shapes the body by blending 349 combinatorial macro targets (names like
"female-young-averagemuscle-maxheight"). That is unusable for live editing in a
browser, so this script converts it into an INDEPENDENT morph basis: each macro
parameter is driven to its extremes, the resulting vertex positions are diffed
against neutral, and each difference is stored as one shape key. The browser can
then blend those linearly and get an instant preview.

The tradeoff is deliberate and worth stating: linear blending of independent
morphs is an approximation of MPFB's true combinatorial blend, and the two
diverge most when several parameters sit at once at their extremes. For a
stylized game that is an acceptable error, and it is how game character
creators generally work.

Height needs calibrating rather than assuming: MPFB's `height` macro is a 0..1
dial, not centimetres, so this script measures the mesh and emits a lookup table
that lets "175 cm" actually mean 175 cm.

Run:
    blender --background --python pipeline/blender/build_basemesh.py
"""

import json
import os
import sys

import bpy

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DIST_DIR = os.path.join(REPO_ROOT, "assets", "dist")
GLB_PATH = os.path.join(DIST_DIR, "basemesh.glb")
MANIFEST_PATH = os.path.join(DIST_DIR, "basemesh.manifest.json")

RIG_NAME = "mixamo"

# MakeHuman's age dial is piecewise: 0 -> 1 year, 0.5 -> 25 years, 1 -> 90 years.
AGE_NEUTRAL_YEARS = 25
AGE_MIN_YEARS = 1
AGE_MAX_YEARS = 90
# The youngest age the recipe schema allows, expressed on MPFB's dial.
AGE_DIAL_AT_13 = (13 - AGE_MIN_YEARS) / ((AGE_NEUTRAL_YEARS - AGE_MIN_YEARS) * 2)

EVEN_ANCESTRY = {"african": 1 / 3, "asian": 1 / 3, "caucasian": 1 / 3}


def ancestry(african: float, asian: float, caucasian: float) -> dict:
    return {"african": african, "asian": asian, "caucasian": caucasian}


# Each entry becomes one shape key on the exported mesh. Names are the contract
# with the TypeScript runtime and must not change without a manifest bump.
MORPH_BASIS = [
    ("gender_feminine", {"gender": 0.0}),
    ("gender_masculine", {"gender": 1.0}),
    ("age_young", {"age": AGE_DIAL_AT_13}),
    ("age_old", {"age": 1.0}),
    ("height_short", {"height": 0.0}),
    ("height_tall", {"height": 1.0}),
    ("weight_light", {"weight": 0.0}),
    ("weight_heavy", {"weight": 1.0}),
    ("muscle_low", {"muscle": 0.0}),
    ("muscle_high", {"muscle": 1.0}),
    ("proportions_uncommon", {"proportions": 0.0}),
    ("proportions_ideal", {"proportions": 1.0}),
    ("cupsize_small", {"cupsize": 0.0}),
    ("cupsize_large", {"cupsize": 1.0}),
    ("firmness_soft", {"firmness": 0.0}),
    ("firmness_firm", {"firmness": 1.0}),
    ("ancestry_african", {"race": ancestry(1.0, 0.0, 0.0)}),
    ("ancestry_asian", {"race": ancestry(0.0, 1.0, 0.0)}),
    ("ancestry_caucasian", {"race": ancestry(0.0, 0.0, 1.0)}),
]

# Height dial values sampled per gender to build the cm lookup table.
HEIGHT_SAMPLES = [0.0, 0.25, 0.5, 0.75, 1.0]
GENDER_SAMPLES = [0.0, 0.5, 1.0]


def import_mpfb(module: str):
    """MPFB is `bl_ext.blender_org.mpfb` as an extension, `mpfb` as a legacy addon."""
    import importlib

    for prefix in ("bl_ext.blender_org.mpfb", "mpfb"):
        try:
            return importlib.import_module(f"{prefix}.{module}")
        except ModuleNotFoundError:
            continue
    raise RuntimeError("MPFB not installed")


def neutral_macros() -> dict:
    return {
        "gender": 0.5,
        "age": 0.5,
        "muscle": 0.5,
        "weight": 0.5,
        "proportions": 0.5,
        "height": 0.5,
        "cupsize": 0.5,
        "firmness": 0.5,
        "race": dict(EVEN_ANCESTRY),
    }


def evaluated_coords(obj) -> list:
    """World-space-free vertex positions with all shape keys applied.

    Reading `obj.data.vertices` would return the undeformed base, so the mesh
    must be evaluated through the dependency graph.
    """
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    coords = [tuple(v.co) for v in mesh.vertices]
    evaluated.to_mesh_clear()
    return coords


def build_variant(macros: dict):
    """Creates a throwaway human with the given macro settings."""
    HumanService = import_mpfb("services.humanservice").HumanService
    return HumanService.create_human(
        mask_helpers=False,
        detailed_helpers=True,
        feet_on_ground=True,
        scale=0.1,
        macro_detail_dict=macros,
    )


def delete_object(obj) -> None:
    mesh = obj.data
    bpy.data.objects.remove(obj, do_unlink=True)
    if mesh.users == 0:
        bpy.data.meshes.remove(mesh)


def capture_variant(macros: dict) -> list:
    obj = build_variant(macros)
    coords = evaluated_coords(obj)
    delete_object(obj)
    return coords


def body_vertex_indices(obj) -> list:
    """Indices of real body vertices, excluding helper geometry.

    Height must be measured on the body alone. MakeHuman's helper meshes and
    joint cubes extend past the scalp and below the soles, so including them
    overstates standing height by several centimetres -- enough to make a
    requested "175 cm" visibly wrong.
    """
    helper_groups = {
        g.index for g in obj.vertex_groups if g.name.lower().startswith(("helper", "joint"))
    }
    return [
        v.index
        for v in obj.data.vertices
        if not any(g.group in helper_groups for g in v.groups)
    ]


def measure_height_cm(coords: list, indices: list) -> float:
    """Standing height from the body bounds. Scale 0.1 puts us in metres."""
    zs = [coords[i][2] for i in indices]
    return (max(zs) - min(zs)) * 100.0


def calibrate_height(body_indices: list) -> dict:
    """Measures real height across the dial so cm can be inverted to a weight.

    The dial is markedly non-linear -- roughly 18 cm per quarter-turn below the
    midpoint and 35 cm above it -- so the runtime interpolates this table rather
    than assuming a straight line.
    """
    table = []
    for gender in GENDER_SAMPLES:
        for dial in HEIGHT_SAMPLES:
            macros = neutral_macros()
            macros["gender"] = gender
            macros["height"] = dial
            cm = measure_height_cm(capture_variant(macros), body_indices)
            table.append({"gender": gender, "dial": dial, "cm": round(cm, 2)})
            print(f"CALIBRATE gender={gender} dial={dial} -> {cm:.2f} cm")
    return {"samples": table, "measuredOn": "body vertices only, helpers excluded"}


def strip_helpers(obj) -> dict:
    """Removes MakeHuman's helper geometry, which must never ship.

    Helpers exist to fit clothing to the body and are invisible in-game, but they
    are ~8.7k triangles. They are kept in the source .blend and removed only here
    at export time, because Phase 2 clothing fitting still needs them.
    """
    before = len(obj.data.vertices)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    try:
        bpy.ops.mpfb.delete_helpers()
        method = "mpfb.delete_helpers"
    except (RuntimeError, AttributeError) as exc:
        print("STRIP fallback, MPFB operator failed:", exc)
        method = "manual"
        helper_groups = {
            g.index for g in obj.vertex_groups if g.name.lower().startswith(("helper", "joint"))
        }
        doomed = [
            v.index
            for v in obj.data.vertices
            if any(g.group in helper_groups for g in v.groups)
        ]
        import bmesh

        mesh_data = bmesh.new()
        mesh_data.from_mesh(obj.data)
        mesh_data.verts.ensure_lookup_table()
        bmesh.ops.delete(
            mesh_data,
            geom=[mesh_data.verts[i] for i in doomed],
            context="VERTS",
        )
        mesh_data.to_mesh(obj.data)
        mesh_data.free()

    after = len(obj.data.vertices)
    print(f"STRIP method={method} verts {before} -> {after}")
    return {"method": method, "vertices_before": before, "vertices_after": after}


def triangle_count(mesh) -> int:
    return sum(len(p.vertices) - 2 for p in mesh.polygons)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    HumanService = import_mpfb("services.humanservice").HumanService

    print("BUILD capturing neutral")
    base = build_variant(neutral_macros())
    neutral = evaluated_coords(base)
    vertex_count = len(neutral)
    body_indices = body_vertex_indices(base)
    print("BUILD neutral verts:", vertex_count, "body verts:", len(body_indices))
    print("BUILD neutral height:", round(measure_height_cm(neutral, body_indices), 2), "cm")

    # Rebase the mesh onto the evaluated neutral shape and drop MPFB's own macro
    # shape keys, so our extracted basis is the only thing driving deformation.
    base.shape_key_clear()
    for index, coord in enumerate(neutral):
        base.data.vertices[index].co = coord

    basis = base.shape_key_add(name="Basis", from_mix=False)
    basis.interpolation = "KEY_LINEAR"

    extracted = []
    for name, overrides in MORPH_BASIS:
        macros = neutral_macros()
        for key, value in overrides.items():
            macros[key] = value

        coords = capture_variant(macros)
        if len(coords) != vertex_count:
            raise RuntimeError(
                f"{name}: topology changed ({len(coords)} vs {vertex_count} verts); "
                "morph extraction assumes a fixed vertex order"
            )

        key_block = base.shape_key_add(name=name, from_mix=False)
        key_block.interpolation = "KEY_LINEAR"
        max_delta = 0.0
        for index, coord in enumerate(coords):
            key_block.data[index].co = coord
            delta = max(abs(coord[axis] - neutral[index][axis]) for axis in range(3))
            max_delta = max(max_delta, delta)

        extracted.append({"name": name, "max_delta_cm": round(max_delta * 100, 3)})
        print(f"BUILD morph {name}: max delta {max_delta * 100:.2f} cm")

    print("BUILD calibrating height")
    calibration = calibrate_height(body_indices)

    print("BUILD adding rig:", RIG_NAME)
    HumanService.add_builtin_rig(base, RIG_NAME, import_weights=True)
    armature = base.parent
    bone_count = len(armature.data.bones) if armature else 0
    print("BUILD bones:", bone_count)

    helper_stats = strip_helpers(base)

    mesh = base.data
    stats = {
        "vertices": len(mesh.vertices),
        "polygons": len(mesh.polygons),
        "triangles": triangle_count(mesh),
        "shape_keys": len(mesh.shape_keys.key_blocks) if mesh.shape_keys else 0,
        "uv_layers": [layer.name for layer in mesh.uv_layers],
    }
    print("BUILD final:", json.dumps(stats))

    os.makedirs(DIST_DIR, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=GLB_PATH,
        export_format="GLB",
        export_morph=True,
        export_skins=True,
        export_apply=False,
        export_yup=True,
    )

    manifest = {
        "generator": "pipeline/blender/build_basemesh.py",
        "rig": {"name": RIG_NAME, "bones": bone_count},
        "mesh": stats,
        "helpers": helper_stats,
        "morphs": extracted,
        "heightCalibration": calibration,
        "ageDial": {
            "neutralYears": AGE_NEUTRAL_YEARS,
            "minYears": AGE_MIN_YEARS,
            "maxYears": AGE_MAX_YEARS,
            "dialAt13": round(AGE_DIAL_AT_13, 6),
        },
    }
    with open(MANIFEST_PATH, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)

    print("BUILD glb:", GLB_PATH, os.path.getsize(GLB_PATH))
    print("BUILD manifest:", MANIFEST_PATH)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        import traceback

        traceback.print_exc()
        print("BUILD FAILED:", exc)
        sys.exit(1)
