import { useEffect, useRef, useState } from "react";

import type { GarmentSlot, SolveResult } from "@tpb/avatar-runtime";

import { useCharacter } from "./state/useCharacter.ts";
import { Controls } from "./ui/Controls.tsx";
import { slug } from "./util/slug.ts";
import { AvatarViewer } from "./viewer/AvatarViewer.ts";

type Status =
  | { kind: "loading" }
  | { kind: "ready"; triangles: number; bones: number; animations: string[] }
  | { kind: "error"; message: string };

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<AvatarViewer | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [solve, setSolve] = useState<SolveResult | null>(null);
  const [equipped, setEquipped] = useState<ReadonlySet<GarmentSlot>>(new Set());
  const [pendingSlots, setPendingSlots] = useState<ReadonlySet<GarmentSlot>>(new Set());
  const [outfitError, setOutfitError] = useState<string | null>(null);

  const recipe = useCharacter((state) => state.recipe);

  // Create the engine once. Recreating it per render would leak WebGL contexts.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const viewer = new AvatarViewer();
    viewerRef.current = viewer;
    let cancelled = false;

    viewer
      .init(canvas)
      .then(() => {
        if (cancelled) return;
        setStatus({
          kind: "ready",
          triangles: viewer.triangleCount,
          bones: viewer.boneCount,
          animations: viewer.animationNames,
        });
        viewer.frameBody(useCharacter.getState().recipe.body.heightCm);
        setSolve(viewer.apply(useCharacter.getState().recipe));
        // Idle by default when it exists, since a static A-pose reads as broken.
        if (viewer.animationNames.includes("Idle")) viewer.playAnimation("Idle");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStatus({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  // Push recipe changes into the scene. Morph influences are cheap to set, so
  // this can run on every edit without debouncing.
  useEffect(() => {
    if (status.kind !== "ready") return;
    const result = viewerRef.current?.apply(recipe);
    if (result) setSolve(result);
  }, [recipe, status.kind]);

  const toggleGarment = (slot: GarmentSlot, name: string) => {
    const viewer = viewerRef.current;
    if (!viewer || pendingSlots.has(slot)) return;

    setOutfitError(null);
    setPendingSlots((prev) => new Set(prev).add(slot));

    const isOn = equipped.has(slot);
    const settle = () => setPendingSlots((prev) => {
      const next = new Set(prev);
      next.delete(slot);
      return next;
    });

    if (isOn) {
      viewer.unequip(slot);
      setEquipped((prev) => {
        const next = new Set(prev);
        next.delete(slot);
        return next;
      });
      settle();
      return;
    }

    viewer
      .equip(slot, name)
      .then(() => setEquipped((prev) => new Set(prev).add(slot)))
      .catch((error: unknown) => {
        setOutfitError(error instanceof Error ? error.message : String(error));
      })
      .finally(settle);
  };

  return (
    <div className="app">
      <aside className="panel">
        <Controls
          solve={solve}
          onExportGlb={() => {
            const viewer = viewerRef.current;
            if (!viewer) return Promise.resolve();
            return viewer.exportGlb(slug(recipe.name));
          }}
          outfit={{ equipped, pending: pendingSlots, error: outfitError, onToggle: toggleGarment }}
        />
      </aside>

      <main className="stage">
        <canvas ref={canvasRef} className="canvas" />

        {status.kind === "loading" ? <div className="overlay">Loading base mesh…</div> : null}

        {status.kind === "error" ? (
          <div className="overlay error">
            <h2>Could not load the base mesh</h2>
            <p>{status.message}</p>
            <p className="hint">
              If the mesh is missing, build it with:
              <code>blender --background --python pipeline/blender/build_basemesh.py</code>
            </p>
          </div>
        ) : null}

        {status.kind === "ready" ? (
          <div className="hud">
            <span>{status.triangles.toLocaleString()} tris</span>
            <span>{status.bones} bones</span>
            <div className="hud-buttons">
              <button type="button" onClick={() => viewerRef.current?.frameBody(recipe.body.heightCm)}>
                Body
              </button>
              <button type="button" onClick={() => viewerRef.current?.frameHead(recipe.body.heightCm)}>
                Head
              </button>
              {status.animations.map((name) => (
                <button key={name} type="button" onClick={() => viewerRef.current?.playAnimation(name)}>
                  {name}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
