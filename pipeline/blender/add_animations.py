"""Merge Mixamo FBX animations onto the base mesh and re-export the GLB.

Mixamo animations cannot be fetched automatically: mixamo.com requires an
interactive Adobe login, so downloading the FBX files is a manual, one-time step
(see README below). This script does everything after that.

Because the base rig (`rig.mixamo.json`) uses Mixamo's own bone names
("mixamorig:Hips", etc.) with no retargeting, a Mixamo FBX's action can be
copied onto our armature directly -- the fcurves reference pose bones by name,
and the names already match. Three corrections are still applied before an
action is usable: normalizing Mixamo's per-session bone namespace
(mixamorig10: -> mixamorig:), rescaling location curves by the source
armature's object scale (Mixamo skeletons are authored ~100x larger and rely on
object.scale=0.01 to present as metres, which is lost when only the action is
copied), and removing net root drift so a travelling clip like Walking loops in
place instead of exiting the frame.

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


def import_mixamo_action(fbx_path: str, clip_name: str):
    """Imports a Mixamo FBX and returns its action, discarding everything else.

    The action gets a fake user so it survives deleting the imported objects
    (Blender otherwise garbage-collects an action with zero users).
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

    for obj in imported:
        bpy.data.objects.remove(obj, do_unlink=True)

    return action


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
    rest_height = hips.head_local[2]

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

        action = import_mixamo_action(path, clip_name)
        coverage = validate_bone_coverage(armature, action)
        print(f"ANIM {clip_name} bone coverage: {coverage}")

        if coverage["coverage"] < 0.9:
            raise RuntimeError(
                f"{filename}: only {coverage['coverage']:.0%} of animated bones matched "
                f"our rig ({coverage['matched_bones']}/{coverage['animated_bones']}). "
                "The FBX skeleton probably doesn't use Mixamo's 'mixamorig:' bone names."
            )

        worst_hips = validate_hips_translation(armature, action, clip_name)
        print(f"ANIM {clip_name} worst Hips translation magnitude: {worst_hips:.3f}")

        drift_corrected = remove_root_drift(action)
        print(f"ANIM {clip_name} removed net drift on {drift_corrected} Hips axis curve(s)")

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
