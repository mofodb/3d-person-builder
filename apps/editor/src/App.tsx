import { useEffect, useRef, useState } from "react";

import type { SolveResult } from "@tpb/avatar-runtime";

import { useCharacter } from "./state/useCharacter.ts";
import { Controls } from "./ui/Controls.tsx";
import { AvatarViewer } from "./viewer/AvatarViewer.ts";

type Status =
  | { kind: "loading" }
  | { kind: "ready"; triangles: number; bones: number }
  | { kind: "error"; message: string };

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<AvatarViewer | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [solve, setSolve] = useState<SolveResult | null>(null);

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
        setStatus({ kind: "ready", triangles: viewer.triangleCount, bones: viewer.boneCount });
        viewer.frameBody(useCharacter.getState().recipe.body.heightCm);
        setSolve(viewer.apply(useCharacter.getState().recipe));
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

  return (
    <div className="app">
      <aside className="panel">
        <Controls solve={solve} />
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
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
