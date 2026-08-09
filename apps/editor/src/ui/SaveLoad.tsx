import { useRef, useState } from "react";

import { useCharacter } from "../state/useCharacter.ts";
import { slug } from "../util/slug.ts";

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export interface SaveLoadProps {
  /** Provided by the viewer; exports the currently posed mesh as a GLB. */
  onExportGlb: () => Promise<void>;
}

export function SaveLoad({ onExportGlb }: SaveLoadProps) {
  const recipe = useCharacter((s) => s.recipe);
  const setName = useCharacter((s) => s.setName);
  const exportJson = useCharacter((s) => s.exportJson);
  const importJson = useCharacter((s) => s.importJson);
  const reset = useCharacter((s) => s.reset);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const handleFile = (file: File) => {
    file
      .text()
      .then((text) => {
        const result = importJson(text);
        setError(result.ok ? null : result.error);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not read file");
      });
  };

  const handleExportGlb = () => {
    setExporting(true);
    onExportGlb()
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "GLB export failed");
      })
      .finally(() => setExporting(false));
  };

  return (
    <section>
      <h2>Character</h2>

      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="text-input"
          value={recipe.name}
          onChange={(event) => setName(event.target.value)}
          maxLength={64}
          spellCheck={false}
        />
      </label>

      {error ? <p className="warning">{error}</p> : null}

      <div className="button-row">
        <button type="button" onClick={() => downloadText(`${slug(recipe.name)}.character.json`, exportJson())}>
          Save character
        </button>
        <button type="button" onClick={() => fileInputRef.current?.click()}>
          Load character
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) handleFile(file);
            event.target.value = "";
          }}
        />
      </div>

      <div className="button-row">
        <button type="button" onClick={handleExportGlb} disabled={exporting}>
          {exporting ? "Exporting…" : "Export GLB"}
        </button>
        <button type="button" className="secondary" onClick={reset}>
          Reset
        </button>
      </div>
      <p className="note">
        Saving writes a small JSON recipe, not a 3D model &mdash; that is what a game would send
        over the network. Export GLB bakes the current pose into a standalone model file for use
        in other tools.
      </p>
    </section>
  );
}
