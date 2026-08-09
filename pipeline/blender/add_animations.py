"""Merge Mixamo FBX animations onto the base mesh and re-export the GLB.

Mixamo animations cannot be fetched automatically: mixamo.com requires an
interactive Adobe login, so downloading the FBX files is a manual, one-time step
(see README below). This script does everything after that.

Because the base rig (`rig.mixamo.json`) uses Mixamo's own bone names
("mixamorig:Hips", etc.) with no retargeting, a Mixamo FBX's action can be
copied onto our armature directly -- the fcurves reference pose bones by name,
and the names already match.

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
6. Run: blender --background --python pipeline/blender/add_animations.py

--------------------------------------------------------------------------------

Run:
    blender --background --python pipeline/blender/add_animations.py
"""

import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(__file__))
import build_basemesh as bb  # noqa: E402

ANIM_SOURCE_DIR = os.path.join(bb.REPO_ROOT, "assets", "source", "mixamo")


def find_new_objects(before: set):
    return [obj for obj in bpy.data.objects if obj not in before]


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
