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
# MPFB's weight and muscle macros are deliberately subtle: at full extreme they
# displace vertices only ~2 cm, which reads as almost no change. MakeHuman's
# DETAIL targets carry the real range -- `stomach-pregnant-incr` alone moves
# vertices 9.3 cm. The fat and muscle morphs are therefore composites: the macro
# extreme plus a stack of anatomically authored detail targets.
#
# Both sides of the body are listed explicitly; a missing target is a hard error
# rather than a silent no-op, because that failure mode already cost us once.
_LIMBS = ["upperarm", "lowerarm", "upperleg", "lowerleg"]


def _sided(pattern: str) -> list:
    return [f"{side}-{pattern}" for side in ("l", "r")]


def fat_details(direction: str) -> list:
    """Targets that add or remove fat bulk. `direction` is "incr" or "decr"."""
    targets = [
        f"stomach-pregnant-{direction}",
        f"measure-waist-circ-{direction}",
        f"measure-hips-circ-{direction}",
        f"torso-scale-depth-{direction}",
        f"buttocks-volume-{direction}",
        f"measure-upperarm-circ-{direction}",
    ]
    for limb in _LIMBS:
        targets += _sided(f"{limb}-fat-{direction}")
    return targets


def muscle_details(direction: str) -> list:
    """Targets that add or remove muscle mass."""
    targets = [
        f"torso-muscle-dorsi-{direction}",
        f"torso-muscle-pectoral-{direction}",
        f"torso-vshape-{direction}",
        f"stomach-tone-{direction}",
        f"measure-shoulder-dist-{direction}",
    ]
    for limb in _LIMBS:
        targets += _sided(f"{limb}-muscle-{direction}")
    targets += _sided(f"upperarm-shoulder-muscle-{direction}")
    return targets


# Each entry is (shape key name, macro axis, value at full influence,
# macro overrides, detail targets applied at full strength).
# `age_young` is extracted at 0.25 rather than 0 because the schema's minimum age
# is 13 and a dial of 0 is an infant.
MORPH_BASIS = [
    ("gender_feminine", "gender", 0.0, {"gender": 0.0}, []),
    ("gender_masculine", "gender", 1.0, {"gender": 1.0}, []),
    ("age_young", "age", AGE_DIAL_AT_13, {"age": AGE_DIAL_AT_13}, []),
    ("age_old", "age", 1.0, {"age": 1.0}, []),
    ("height_short", "height", 0.0, {"height": 0.0}, []),
    ("height_tall", "height", 1.0, {"height": 1.0}, []),
    ("weight_light", "weight", 0.0, {"weight": 0.0}, fat_details("decr")),
    ("weight_heavy", "weight", 1.0, {"weight": 1.0}, fat_details("incr")),
    ("muscle_low", "muscle", 0.0, {"muscle": 0.0}, muscle_details("decr")),
    ("muscle_high", "muscle", 1.0, {"muscle": 1.0}, muscle_details("incr")),
    ("proportions_uncommon", "proportions", 0.0, {"proportions": 0.0}, []),
    ("proportions_ideal", "proportions", 1.0, {"proportions": 1.0}, []),
    ("cupsize_small", "cupsize", 0.0, {"cupsize": 0.0}, []),
    ("cupsize_large", "cupsize", 1.0, {"cupsize": 1.0}, []),
    ("firmness_soft", "firmness", 0.0, {"firmness": 0.0}, []),
    ("firmness_firm", "firmness", 1.0, {"firmness": 1.0}, []),
    ("ancestry_african", "race.african", 1.0, {"race": ancestry(1.0, 0.0, 0.0)}, []),
    ("ancestry_asian", "race.asian", 1.0, {"race": ancestry(0.0, 1.0, 0.0)}, []),
    ("ancestry_caucasian", "race.caucasian", 1.0, {"race": ancestry(0.0, 0.0, 1.0)}, []),
]

# Neutral value of each macro axis, i.e. the shape the Basis key represents.
MACRO_NEUTRALS = {
    "gender": 0.5,
    "age": 0.5,
    "height": 0.5,
    "weight": 0.5,
    "muscle": 0.5,
    "proportions": 0.5,
    "cupsize": 0.5,
    "firmness": 0.5,
    "race.african": 1 / 3,
    "race.asian": 1 / 3,
    "race.caucasian": 1 / 3,
}

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


def apply_detail_targets(obj, targets: list) -> None:
    """Loads MakeHuman detail targets onto a mesh at full strength.

    `TargetService.set_target_value` only adjusts an ALREADY loaded shape key and
    silently does nothing otherwise, which made an earlier version of this script
    apply fourteen targets to no effect whatsoever. `load_target` is the call that
    actually loads and weights a target, and a missing file is raised rather than
    skipped so that a typo can never again pass unnoticed.
    """
    TargetService = import_mpfb("services.targetservice").TargetService

    for name in targets:
        path = TargetService.target_full_path(name)
        if not path or not os.path.exists(path):
            raise RuntimeError(f"Detail target not found: {name}")
        TargetService.load_target(obj, path, weight=1.0, name=name)
        if not TargetService.has_target(obj, name):
            raise RuntimeError(f"Detail target failed to load: {name}")


def build_variant(macros: dict, detail_targets: list = ()):
    """Creates a throwaway human with the given macro settings and details."""
    HumanService = import_mpfb("services.humanservice").HumanService
    obj = HumanService.create_human(
        mask_helpers=False,
        detailed_helpers=True,
        feet_on_ground=True,
        scale=0.1,
        macro_detail_dict=macros,
    )
    if detail_targets:
        apply_detail_targets(obj, list(detail_targets))
    return obj


def delete_object(obj) -> None:
    mesh = obj.data
    bpy.data.objects.remove(obj, do_unlink=True)
    if mesh.users == 0:
        bpy.data.meshes.remove(mesh)


def capture_variant(macros: dict, detail_targets: list = ()) -> list:
    obj = build_variant(macros, detail_targets)
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


def survey_height_dial(body_indices: list) -> list:
    """Records MPFB's own dial-to-centimetre response.

    Informational only. The runtime does NOT invert this table, because the
    runtime blends the extracted morphs linearly whereas these numbers come from
    MPFB's combinatorial blend -- two different functions of the same dial.
    Kept because the non-linearity is worth documenting: roughly 18 cm per
    quarter turn below the midpoint against 35 cm above it.
    """
    table = []
    for gender in GENDER_SAMPLES:
        for dial in HEIGHT_SAMPLES:
            macros = neutral_macros()
            macros["gender"] = gender
            macros["height"] = dial
            cm = measure_height_cm(capture_variant(macros), body_indices)
            table.append({"gender": gender, "dial": dial, "cm": round(cm, 2)})
            print(f"SURVEY gender={gender} dial={dial} -> {cm:.2f} cm")
    return table


def verify_blend_linearity(obj, body_indices: list, morph_name: str, height_delta_cm: float,
                           neutral_cm: float) -> dict:
    """Checks that height really is linear in morph influence.

    The runtime solves the height morph weight from a linear equation, which is
    only valid if interpolating vertex positions interpolates the bounding box
    too. That holds as long as the same vertices stay extremal, so it is worth
    measuring rather than trusting.
    """
    key_blocks = obj.data.shape_keys.key_blocks
    if morph_name not in key_blocks:
        return {"checked": False}

    results = []
    for influence in (0.25, 0.5, 0.75):
        key_blocks[morph_name].value = influence
        measured = measure_height_cm(evaluated_coords(obj), body_indices)
        predicted = neutral_cm + influence * height_delta_cm
        results.append(
            {
                "influence": influence,
                "predicted_cm": round(predicted, 2),
                "measured_cm": round(measured, 2),
                "error_cm": round(measured - predicted, 3),
            }
        )
        print(
            f"LINEARITY {morph_name}@{influence}: predicted {predicted:.2f} "
            f"measured {measured:.2f} error {measured - predicted:+.3f} cm"
        )
    key_blocks[morph_name].value = 0.0

    worst = max(abs(r["error_cm"]) for r in results)
    return {"checked": True, "morph": morph_name, "samples": results, "worst_error_cm": worst}


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


def validate_shape_keys(obj, extracted: list) -> None:
    """Confirm every authored morph still holds data immediately before export.

    Morph deltas have been silently lost between authoring and export before, so
    this measures the shape keys as they will be written and fails the build
    rather than shipping a mesh whose sliders do nothing.
    """
    blocks = obj.data.shape_keys.key_blocks
    basis = blocks[0]
    empty = []

    for info in extracted:
        name = info["name"]
        key = blocks.get(name)
        if key is None:
            empty.append(f"{name} (missing)")
            continue
        worst = 0.0
        for i in range(len(key.data)):
            a, b = key.data[i].co, basis.data[i].co
            worst = max(worst, max(abs(a[k] - b[k]) for k in range(3)))
        worst_cm = worst * 100
        info["exported_delta_cm"] = round(worst_cm, 3)
        print(f"VALIDATE {name}: {worst_cm:.2f} cm")
        if worst_cm < 0.01:
            empty.append(name)

    if empty:
        raise RuntimeError(
            "These morphs carry no deformation and would be dead sliders: "
            + ", ".join(empty)
        )


def build_character() -> tuple:
    """Builds the rigged, morphed base mesh and its manifest, stopping short of
    export. Factored out of `main()` so other scripts (animation merging) can
    build on top of the same character before writing the GLB, rather than
    duplicating this logic or round-tripping through the exported file.

    Returns (base_object, manifest_dict).
    """
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

    neutral_height_cm = measure_height_cm(neutral, body_indices)

    extracted = []
    for name, macro_axis, macro_value, overrides, detail_targets in MORPH_BASIS:
        macros = neutral_macros()
        for key, value in overrides.items():
            macros[key] = value

        coords = capture_variant(macros, detail_targets)
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

        # How much this morph alone changes standing height. The runtime solves
        # the height morph from these, so every morph that moves the scalp or
        # soles has to contribute.
        height_delta = measure_height_cm(coords, body_indices) - neutral_height_cm

        extracted.append(
            {
                "name": name,
                "macro": macro_axis,
                "value": macro_value,
                "neutral": MACRO_NEUTRALS[macro_axis],
                "max_delta_cm": round(max_delta * 100, 3),
                "height_delta_cm": round(height_delta, 3),
                "detail_targets": len(detail_targets),
            }
        )
        print(
            f"BUILD morph {name}: max delta {max_delta * 100:.2f} cm, "
            f"height {height_delta:+.2f} cm, details {len(detail_targets)}"
        )

    print("BUILD verifying blend linearity")
    linearity = verify_blend_linearity(
        base,
        body_indices,
        "height_tall",
        next(m["height_delta_cm"] for m in extracted if m["name"] == "height_tall"),
        neutral_height_cm,
    )

    print("BUILD surveying MPFB height dial (informational)")
    dial_survey = survey_height_dial(body_indices)

    print("BUILD adding rig:", RIG_NAME)
    HumanService.add_builtin_rig(base, RIG_NAME, import_weights=True)
    armature = base.parent

    # NOTE: an earlier version of this function swapped in Mixamo's own
    # skeleton wholesale here, reasoning that it would fix a bone ROTATION
    # convention mismatch (see add_animations.py's retarget_rotations). That
    # broke something more fundamental: Mixamo's stock skeleton's bone
    # POSITIONS are sized for Mixamo's own generic character, not fitted to
    # this specific mesh, so even the REST pose (no animation at all) came out
    # with hands stretched to ~50 cm. MPFB's rig.mixamo.json is correctly
    # fitted to our mesh; only its bone ROLL differs from Mixamo's, which is
    # fixed at the animation level instead (retargeting rotation values into
    # this rig's existing, position-correct bone frames) rather than here.

    bone_count = len(armature.data.bones) if armature else 0
    print("BUILD bones:", bone_count)

    helper_stats = strip_helpers(base)

    validate_shape_keys(base, extracted)

    mesh = base.data
    stats = {
        "vertices": len(mesh.vertices),
        "polygons": len(mesh.polygons),
        "triangles": triangle_count(mesh),
        "shape_keys": len(mesh.shape_keys.key_blocks) if mesh.shape_keys else 0,
        "uv_layers": [layer.name for layer in mesh.uv_layers],
    }
    print("BUILD final:", json.dumps(stats))

    manifest = {
        "generator": "pipeline/blender/build_basemesh.py",
        "rig": {"name": RIG_NAME, "bones": bone_count},
        "mesh": stats,
        "helpers": helper_stats,
        "morphs": extracted,
        "neutralHeightCm": round(neutral_height_cm, 3),
        "blendLinearity": linearity,
        "mpfbHeightDialSurvey": {
            "note": (
                "Informational. The runtime blends morphs linearly and solves height "
                "from per-morph height_delta_cm; it does not invert this table."
            ),
            "measuredOn": "body vertices only, helpers excluded",
            "samples": dial_survey,
        },
        "ageDial": {
            "neutralYears": AGE_NEUTRAL_YEARS,
            "minYears": AGE_MIN_YEARS,
            "maxYears": AGE_MAX_YEARS,
            "dialAt13": round(AGE_DIAL_AT_13, 6),
        },
        "animations": [],
    }
    return base, manifest


def export(base, manifest: dict) -> None:
    os.makedirs(DIST_DIR, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=GLB_PATH,
        export_format="GLB",
        export_morph=True,
        export_skins=True,
        export_apply=False,
        export_yup=True,
        export_animations=True,
        export_nla_strips=True,
    )
    with open(MANIFEST_PATH, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)

    print("BUILD glb:", GLB_PATH, os.path.getsize(GLB_PATH))
    print("BUILD manifest:", MANIFEST_PATH)


def main():
    base, manifest = build_character()
    export(base, manifest)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        import traceback

        traceback.print_exc()
        print("BUILD FAILED:", exc)
        sys.exit(1)
