"""Merge Mixamo FBX animations onto the base mesh and re-export the GLB.

Mixamo animations cannot be fetched automatically: mixamo.com requires an
interactive Adobe login, so downloading the FBX files is a manual, one-time step
(see README below). This script does everything after that.

The base rig (`rig.mixamo.json`) uses Mixamo's own bone NAMES and hierarchy, so
a Mixamo FBX's action can be attached to our armature without retargeting the
skeleton itself. Its bone REST ORIENTATIONS ("roll") do differ from real
Mixamo's, though, which is not visually obvious until you look closely: a
bone's rotation animation is defined relative to its own rest orientation, so
applying Mixamo's rotation values directly computes each rotation in the wrong
local frame. The error is small near the root (the torso looks mostly fine)
and compounds through long chains, which is why fingers -- the deepest chains
in the rig -- rendered as melted, dangling strands. Four corrections are
applied before an action is usable: normalizing Mixamo's per-session bone
namespace (mixamorig10: -> mixamorig:), rescaling location curves by the
source armature's object scale (Mixamo skeletons are authored ~100x larger and
rely on object.scale=0.01 to present as metres, which is lost when only the
action is copied), retargeting rotation values into our rig's rest orientation
via a per-bone quaternion correction (see compute_rotation_corrections), and
removing net root drift so a travelling clip like Walking loops in place
instead of exiting the frame.

--- How to get animation files -------------------------------------------------

1. Go to https://www.mixamo.com and sign in (free Adobe account).
2. Use the default "Y Bot" or "X Bot" character -- the skeleton, not the mesh,
   is what matters, and Mixamo's skeleton naming is consistent across
   characters.
3. Search for and select an animation (start with "Idle" and "Walking").
4. Download settings: Format = FBX (.fbx), Skin = WITHOUT SKIN (this animation
   is applied to our own mesh, so we don't need Mixamo's). Frames per Second
   30, Keyframe Reduction = none.
5. Save the file into `assets/source/mixamo/`, named after the animation, e.g.
   `assets/source/mixamo/idle.fbx`, `assets/source/mixamo/walk.fbx`.
   This folder is gitignored: Mixamo's license covers using the animation in
   your project, but not redistributing the raw FBX file itself, so it must
   never be committed (especially to a public repo). The merged result lives
   only in the exported GLB, which is also gitignored and rebuilt by anyone
   who needs it.
6. Run: blender --background --python pipeline/blender/add_animations.py

--------------------------------------------------------------------------------

Run:
    blender --background --python pipeline/blender/add_animations.py
"""

import os
import re
import sys

import bpy
from mathutils import Quaternion

sys.path.insert(0, os.path.dirname(__file__))
import build_basemesh as bb  # noqa: E402

ANIM_SOURCE_DIR = os.path.join(bb.REPO_ROOT, "assets", "source", "mixamo")


def find_new_objects(before: set):
    return [obj for obj in bpy.data.objects if obj not in before]


# Mixamo increments this per download session to avoid bone-name collisions
# when several characters are combined in one scene (mixamorig:, mixamorig1:,
# mixamorig10:, ...). Our rig always uses the un-numbered form, so any numbered
# variant is normalized back to it before the action is attached.
_MIXAMO_NAMESPACE = re.compile(r"mixamorig\d*:")


def location_scale_factor(armature_obj) -> float:
    """Uniform object-space scale baked into a freshly-imported Mixamo armature.

    Mixamo's FBX skeletons store bone rest data in a raw ~100-units-tall space
    and rely on the armature OBJECT's scale (typically 0.01) to present as real
    metres in the scene. Action fcurves for bone location are keyframed in that
    same raw space. Our own rig has no such object scale -- its bones are
    already authored in metres -- so copying an action across without correcting
    for this turns a real ~0.1 m stride into a many-metre teleport every frame.
    """
    x, y, z = armature_obj.scale
    if max(abs(x - y), abs(y - z), abs(x - z)) > 1e-4:
        raise RuntimeError(f"Expected a uniform armature scale, got {tuple(armature_obj.scale)}")
    return x


def scale_location_curves(action, factor: float) -> int:
    """Rescales every bone LOCATION fcurve (not rotation/scale) by `factor`."""
    scaled = 0
    for fcurve in action.fcurves:
        if not fcurve.data_path.endswith(".location"):
            continue
        for keyframe in fcurve.keyframe_points:
            keyframe.co.y *= factor
            keyframe.handle_left.y *= factor
            keyframe.handle_right.y *= factor
        fcurve.update()
        scaled += 1
    return scaled


def normalize_mixamo_namespace(action) -> int:
    """Rewrites fcurve data paths to use the un-numbered `mixamorig:` namespace.

    Returns how many paths were changed, purely so the caller can log it.
    """
    changed = 0
    for fcurve in action.fcurves:
        normalized = _MIXAMO_NAMESPACE.sub("mixamorig:", fcurve.data_path)
        if normalized != fcurve.data_path:
            fcurve.data_path = normalized
            changed += 1
    return changed


def compute_rotation_corrections(target_armature, source_armature) -> dict:
    """Per-bone quaternion correcting for a REST ORIENTATION mismatch between
    two skeletons that share hierarchy and bone positions but not bone "roll".

    MPFB's rig.mixamo.json has the same bone names, hierarchy and (correctly,
    fitted to our specific mesh) positions as a real Mixamo skeleton, but a
    DIFFERENT per-bone rest orientation convention. `pose_bone.rotation_quaternion`
    is defined relative to a bone's own rest orientation, so directly copying
    Mixamo's animated quaternions onto our differently-rolled bones evaluates
    each rotation in the wrong local frame -- correct-looking on bones near the
    root (small effective error) but compounding to grotesque, melted-looking
    results through long chains, which is exactly why fingers (the deepest
    chains in the rig) broke first and worst while the torso looked mostly
    fine.

    (An earlier attempt fixed this by swapping in Mixamo's own skeleton
    wholesale, which fixes orientation but breaks POSITION: Mixamo's stock
    skeleton is sized for Mixamo's generic character, not fitted to this mesh,
    so even the rest pose came out with the hand stretched to ~50 cm. Keeping
    our rig's positions and only correcting the rotation VALUES avoids that.)

    For a rotation defined in one bone-local frame to be reinterpreted in
    another frame attached to the same physical bone, the standard change-of-
    basis is conjugation: corrected = C * source * C.inverted(), where C is the
    rotation that maps the source frame's axes onto the target frame's axes,
    i.e. C = target_rest.inverted() @ source_rest (both rest orientations taken
    in armature space, `bone.matrix_local.to_quaternion()`).
    """
    # The source armature's own bone DATA is never renamed -- only the action's
    # fcurve path STRINGS get normalized elsewhere -- so bones must be matched
    # up by normalized name here too, rather than looked up directly by our
    # (already-normalized) bone.name against the source's still-numbered names.
    source_by_normalized_name = {
        _MIXAMO_NAMESPACE.sub("mixamorig:", b.name): b for b in source_armature.data.bones
    }

    corrections = {}
    for bone in target_armature.data.bones:
        source_bone = source_by_normalized_name.get(bone.name)
        if source_bone is None:
            continue
        target_rest = bone.matrix_local.to_quaternion()
        source_rest = source_bone.matrix_local.to_quaternion()
        corrections[bone.name] = target_rest.inverted() @ source_rest
    return corrections


def retarget_rotations(action, corrections: dict) -> int:
    """Applies compute_rotation_corrections()'s per-bone conjugation to every
    keyframe of every animated bone's rotation_quaternion curves.

    Blender stores a quaternion property as 4 separate FCurves (one per
    array_index, in (w, x, y, z) order) sharing one data_path, so a frame's
    full rotation has to be reassembled across all 4 curves, corrected as one
    quaternion, and scattered back -- correcting each component fcurve in
    isolation would not be meaningful.
    """
    by_bone: dict[str, dict[int, "bpy.types.FCurve"]] = {}
    for fcurve in action.fcurves:
        if not fcurve.data_path.endswith(".rotation_quaternion"):
            continue
        bone_name = fcurve.data_path.split('"')[1]
        by_bone.setdefault(bone_name, {})[fcurve.array_index] = fcurve

    retargeted = 0
    for bone_name, curves in by_bone.items():
        correction = corrections.get(bone_name)
        if correction is None or set(curves.keys()) != {0, 1, 2, 3}:
            continue

        frame_counts = {axis: len(curve.keyframe_points) for axis, curve in curves.items()}
        if len(set(frame_counts.values())) != 1:
            raise RuntimeError(
                f"{bone_name}: rotation_quaternion axes have mismatched keyframe "
                f"counts {frame_counts}; cannot safely pair them up frame-by-frame."
            )

        count = next(iter(frame_counts.values()))
        for index in range(count):
            points = {axis: curves[axis].keyframe_points[index] for axis in (0, 1, 2, 3)}
            frame = points[0].co.x
            if any(abs(points[axis].co.x - frame) > 1e-4 for axis in (1, 2, 3)):
                raise RuntimeError(
                    f"{bone_name}: rotation_quaternion axes are keyed at different "
                    f"frames at index {index}; cannot safely pair them up."
                )

            raw = Quaternion((points[0].co.y, points[1].co.y, points[2].co.y, points[3].co.y))
            fixed = correction @ raw @ correction.inverted()

            for axis, value in zip((0, 1, 2, 3), (fixed.w, fixed.x, fixed.y, fixed.z)):
                delta = value - points[axis].co.y
                points[axis].co.y = value
                points[axis].handle_left.y += delta
                points[axis].handle_right.y += delta

        for curve in curves.values():
            curve.update()
        retargeted += 1

    return retargeted


def import_mixamo_action(fbx_path: str, clip_name: str, target_armature):
    """Imports a Mixamo FBX and returns its action, discarding everything else.

    The action gets a fake user so it survives deleting the imported objects
    (Blender otherwise garbage-collects an action with zero users). Rotation
    retargeting happens here, before the source armature -- needed to compute
    the per-bone corrections -- is deleted.
    """
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=fbx_path, automatic_bone_orientation=False)
    imported = find_new_objects(before)

    armature = next((o for o in imported if o.type == "ARMATURE"), None)
    if armature is None or not armature.animation_data or not armature.animation_data.action:
        for obj in imported:
            bpy.data.objects.remove(obj, do_unlink=True)
        raise RuntimeError(f"{fbx_path}: no animated armature found in the FBX")

    action = armature.animation_data.action
    action.name = clip_name
    action.use_fake_user = True

    renamed = normalize_mixamo_namespace(action)
    if renamed:
        print(f"ANIM normalized {renamed} fcurve paths to the 'mixamorig:' namespace")

    scale = location_scale_factor(armature)
    rescaled = scale_location_curves(action, scale)
    print(f"ANIM rescaled {rescaled} location fcurve(s) by {scale} (source armature object scale)")

    corrections = compute_rotation_corrections(target_armature, armature)
    retargeted = retarget_rotations(action, corrections)
    print(f"ANIM retargeted rotation for {retargeted} bone(s) into our rig's rest orientation")

    for obj in imported:
        bpy.data.objects.remove(obj, do_unlink=True)

    return action


def strip_redundant_location_curves(action, keep_suffix: str = ":Hips") -> int:
    """Removes every bone's `.location` fcurves except Hips's, from the ACTION.

    Blender's FBX importer bakes a location keyframe for every bone in the
    rig, even ones the mocap never actually moved -- confirmed empirically
    (`worst=0.0000` for every sampled non-Hips bone). Only Hips carries genuine
    positional animation (root motion).

    NOTE: this alone does not stop the no-op channels from reappearing in the
    exported GLB. `export_nla_strips=True` (needed to export Idle and Walking
    as separate named clips) makes Blender's glTF exporter SAMPLE the
    evaluated pose every frame rather than serialize each action's fcurves
    directly, and it samples position/rotation/scale uniformly for every
    animated bone regardless of what the source action contains. The actual
    fix is stripping these tracks again on the Babylon side, in
    stripNonHipsPositionTracks() in babylon.ts -- see the comment there for
    why it matters (`applyBoneCorrections()`). This function still earns its
    keep as validation: it is where an unexpectedly-real motion curve would be
    caught and raised, and it keeps the .blend's own action data honest for
    anyone opening it directly.
    """
    to_remove = []
    for fcurve in action.fcurves:
        if not fcurve.data_path.endswith(".location"):
            continue
        bone_name = fcurve.data_path.split('"')[1]
        if bone_name.endswith(keep_suffix):
            continue
        worst = max((abs(kp.co.y) for kp in fcurve.keyframe_points), default=0.0)
        if worst > 0.001:  # 1 mm: real motion, not exporter noise.
            raise RuntimeError(
                f"{bone_name}: expected a no-op .location curve but found "
                f"{worst:.4f} m of real motion. Stripping it would be wrong -- "
                "investigate before proceeding."
            )
        to_remove.append(fcurve)

    for fcurve in to_remove:
        action.fcurves.remove(fcurve)
    return len(to_remove)


def validate_bone_coverage(armature_obj, action) -> dict:
    """Checks how many of the action's bone curves actually match our rig.

    A low match count usually means the source FBX uses a different bone
    naming convention (e.g. no "mixamorig:" prefix) and the action would
    silently animate nothing.
    """
    our_bones = {bone.name for bone in armature_obj.data.bones}
    animated_bones = set()
    for fcurve in action.fcurves:
        # Data paths look like: pose.bones["mixamorig:Hips"].location
        path = fcurve.data_path
        if path.startswith('pose.bones["'):
            animated_bones.add(path.split('"')[1])

    matched = animated_bones & our_bones
    coverage = len(matched) / len(animated_bones) if animated_bones else 0.0
    return {
        "animated_bones": len(animated_bones),
        "matched_bones": len(matched),
        "coverage": round(coverage, 3),
    }


def validate_hips_translation(armature_obj, action, clip_name: str) -> float:
    """Sanity check on the rescaled Hips curve: the whole reason this bug went
    unnoticed the first time is that a scale error produces a large but
    plausible-looking number rather than an obvious crash. Comparing against our
    own rig's rest hip height catches that class of mistake directly, rather
    than relying on someone to eyeball the character flying across the screen.
    """
    hips = next((b for b in armature_obj.data.bones if b.name.endswith(":Hips")), None)
    if hips is None:
        return 0.0
    # Distance from the armature origin rather than a specific axis component,
    # so this stays correct regardless of which axis a given rig's bone-local
    # edit space treats as "up".
    rest_height = hips.head_local.length

    worst = 0.0
    for fcurve in action.fcurves:
        if "Hips" not in fcurve.data_path or not fcurve.data_path.endswith(".location"):
            continue
        for keyframe in fcurve.keyframe_points:
            worst = max(worst, abs(keyframe.co.y))

    # A walk cycle's root bob and stride should stay within a few multiples of
    # standing hip height; anything past ~5x means a scale factor was missed.
    if worst > rest_height * 5:
        raise RuntimeError(
            f"{clip_name}: Hips translation reaches {worst:.2f}, which dwarfs our rig's "
            f"rest hip height of {rest_height:.2f}. This is the exact failure mode of the "
            "Mixamo object-scale bug -- check location_scale_factor()."
        )
    return worst


def remove_root_drift(action) -> int:
    """Converts a travelling clip (e.g. Mixamo's Walking, which moves forward
    ~1.7 m per loop) into an in-place one.

    This is a character *builder* preview, not a game with a moving camera or a
    controller driving locomotion, so a looping walk should visibly walk in
    place rather than exit the frame every couple of seconds.

    Standard root-motion removal: subtract a linear ramp from first-frame value
    to last-frame value on every Hips location axis, which cancels net drift
    while leaving the within-cycle oscillation (the vertical bob, the stride
    sway) intact. Applied uniformly to all three axes rather than trying to
    detect which axis is "forward": an axis with negligible drift (Idle, or a
    walk's vertical axis if the clip already loops cleanly) gets a near-zero
    correction, so this is a safe no-op where it isn't needed.
    """
    corrected = 0
    for fcurve in action.fcurves:
        if not (fcurve.data_path.endswith(".location") and "Hips" in fcurve.data_path):
            continue
        points = fcurve.keyframe_points
        if len(points) < 2:
            continue

        first_frame, first_value = points[0].co
        last_frame, last_value = points[-1].co
        span = last_frame - first_frame
        drift = last_value - first_value
        if span <= 0 or abs(drift) < 1e-5:
            continue

        for point in points:
            t = (point.co.x - first_frame) / span
            correction = drift * t
            point.co.y -= correction
            point.handle_left.y -= correction
            point.handle_right.y -= correction
        fcurve.update()
        corrected += 1
    return corrected


def match_rotation_mode(armature_obj, action) -> int:
    """Sets each pose bone's rotation_mode to match how the action animates it.

    Blender only evaluates ONE rotation property per bone -- whichever
    `rotation_mode` selects -- and silently ignores keyframes on the others.
    Our rig's bones default to Euler ('XYZ'), matching a typical hand-authored
    rig, but Mixamo's FBX skeletons animate `rotation_quaternion`. Copying the
    action across without also matching the mode meant every rotation keyframe
    was present in the data but never evaluated: only Hips translation (which
    has no mode ambiguity) ever visibly moved, which is exactly the "T-pose
    sliding around" symptom this fixes.
    """
    animated_bones = {
        fcurve.data_path.split('"')[1]
        for fcurve in action.fcurves
        if fcurve.data_path.startswith('pose.bones["') and "rotation_quaternion" in fcurve.data_path
    }
    changed = 0
    for bone_name in animated_bones:
        pose_bone = armature_obj.pose.bones.get(bone_name)
        if pose_bone and pose_bone.rotation_mode != "QUATERNION":
            pose_bone.rotation_mode = "QUATERNION"
            changed += 1
    return changed


def attach_animation(armature_obj, action, track_name: str) -> None:
    """Pushes an action onto its own NLA track, so multiple clips can coexist
    and the glTF exporter writes each track as a separate named animation."""
    if not armature_obj.animation_data:
        armature_obj.animation_data_create()

    track = armature_obj.animation_data.nla_tracks.new()
    track.name = track_name
    track.strips.new(track_name, 0, action)


def main():
    if not os.path.isdir(ANIM_SOURCE_DIR):
        raise RuntimeError(
            f"No animation source folder at {ANIM_SOURCE_DIR}. "
            "See the instructions at the top of this file for how to populate it."
        )

    fbx_files = sorted(f for f in os.listdir(ANIM_SOURCE_DIR) if f.lower().endswith(".fbx"))
    if not fbx_files:
        raise RuntimeError(
            f"{ANIM_SOURCE_DIR} exists but has no .fbx files. "
            "See the instructions at the top of this file."
        )

    print("BUILD building base character")
    base, manifest = bb.build_character()
    armature = base.parent
    if armature is None or armature.type != "ARMATURE":
        raise RuntimeError("Base character has no armature; was the rig attached?")

    animations = []
    for filename in fbx_files:
        clip_name = os.path.splitext(filename)[0]
        path = os.path.join(ANIM_SOURCE_DIR, filename)
        print(f"ANIM importing {filename} as '{clip_name}'")

        action = import_mixamo_action(path, clip_name, armature)
        coverage = validate_bone_coverage(armature, action)
        print(f"ANIM {clip_name} bone coverage: {coverage}")

        if coverage["coverage"] < 0.9:
            raise RuntimeError(
                f"{filename}: only {coverage['coverage']:.0%} of animated bones matched "
                f"our rig ({coverage['matched_bones']}/{coverage['animated_bones']}). "
                "The FBX skeleton probably doesn't use Mixamo's 'mixamorig:' bone names."
            )

        rotation_bones = {
            fc.data_path.split('"')[1]
            for fc in action.fcurves
            if fc.data_path.startswith('pose.bones["') and ".rotation_" in fc.data_path
        }
        if not rotation_bones:
            raise RuntimeError(
                f"{filename}: the action has no bone rotation curves at all. "
                "A walk/idle cycle with zero rotated bones means something upstream "
                "is broken; this would otherwise ship a limp animation silently."
            )

        worst_hips = validate_hips_translation(armature, action, clip_name)
        print(f"ANIM {clip_name} worst Hips translation magnitude: {worst_hips:.3f}")

        drift_corrected = remove_root_drift(action)
        print(f"ANIM {clip_name} removed net drift on {drift_corrected} Hips axis curve(s)")

        rotmode_changed = match_rotation_mode(armature, action)
        print(f"ANIM {clip_name} switched {rotmode_changed} bone(s) to quaternion rotation mode")

        stripped = strip_redundant_location_curves(action)
        print(f"ANIM {clip_name} stripped {stripped} no-op location curve(s), keeping Hips's")

        attach_animation(armature, action, clip_name)
        animations.append({"name": clip_name, **coverage})

    manifest["animations"] = animations
    print("ANIM attached:", [a["name"] for a in animations])

    bb.export(base, manifest)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        import traceback

        traceback.print_exc()
        print("ANIM FAILED:", exc)
        sys.exit(1)
