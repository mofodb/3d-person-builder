"""Unzips a downloaded MakeHuman asset pack and lists its .mhclo items.

Asset packs (shirts01.zip, pants01.zip, ...) are just zips of folders like
`clothes/<item_name>/<item_name>.mhclo` plus the referenced .obj/.mhmat. This
script extracts one into `.cache/mhassets/<pack_name>/` and prints every
.mhclo it finds, so a specific item can be picked for build_clothing.py without
opening Blender or a zip browser.

Run:
    blender --background --python pipeline/blender/list_clothing_pack.py -- shirts01
"""

import os
import sys
import zipfile

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CACHE_DIR = os.path.join(REPO_ROOT, ".cache", "mhassets")


def read_mhclo_header(path: str) -> dict:
    """Cheap line-based read of the small header fields at the top of a .mhclo
    file, without pulling in MPFB's full parser."""
    info = {}
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split(None, 1)
            if len(parts) == 2 and parts[0] in ("name", "obj_file", "tags", "author", "license"):
                info[parts[0]] = parts[1]
            if parts[0] == "verts":
                break
    return info


def main(pack_name: str) -> None:
    zip_path = os.path.join(CACHE_DIR, f"{pack_name}.zip")
    if not os.path.isfile(zip_path):
        raise RuntimeError(f"Expected a downloaded pack at {zip_path}")

    extract_dir = os.path.join(CACHE_DIR, pack_name)
    if not os.path.isdir(extract_dir):
        print(f"LIST extracting {zip_path}")
        with zipfile.ZipFile(zip_path) as archive:
            archive.extractall(extract_dir)

    found = []
    for root, _dirs, files in os.walk(extract_dir):
        for filename in files:
            if filename.endswith(".mhclo"):
                found.append(os.path.join(root, filename))

    if not found:
        raise RuntimeError(f"No .mhclo files found under {extract_dir}")

    print(f"LIST {len(found)} item(s) in {pack_name}:")
    for path in sorted(found):
        info = read_mhclo_header(path)
        rel = os.path.relpath(path, extract_dir)
        print(f"  {rel}  name={info.get('name', '?')}  tags={info.get('tags', '')}")


if __name__ == "__main__":
    # Blender swallows argv before "--"; everything after is ours.
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(argv) != 1:
        print("Usage: blender --background --python list_clothing_pack.py -- <pack_name>")
        sys.exit(1)

    try:
        main(argv[0])
    except Exception as exc:
        import traceback

        traceback.print_exc()
        print("LIST FAILED:", exc)
        sys.exit(1)
