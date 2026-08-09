import type { GarmentSlot } from "@tpb/avatar-runtime";

/**
 * Known garments for this early slice of Phase 2. Slot is a GarmentSlot; name
 * matches the `<name>` in `clothing.<slot>.<name>.glb` from build_clothing.py.
 *
 * Hardcoded rather than discovered at runtime because there is no asset
 * catalog yet -- each entry here corresponds to one specific downloaded
 * MakeHuman Community asset pack item. A real wardrobe browser is later work;
 * this exists to prove the fitting pipeline end to end.
 */
const KNOWN_GARMENTS: ReadonlyArray<{ slot: GarmentSlot; name: string; label: string }> = [
  { slot: "torso", name: "tshirt", label: "T-Shirt" },
  { slot: "legs", name: "cargo_pants", label: "Cargo Pants" },
];

export interface OutfitProps {
  equipped: ReadonlySet<GarmentSlot>;
  pending: ReadonlySet<GarmentSlot>;
  error: string | null;
  onToggle: (slot: GarmentSlot, name: string) => void;
}

export function Outfit({ equipped, pending, error, onToggle }: OutfitProps) {
  return (
    <section>
      <h2>Outfit</h2>
      <div className="button-row">
        {KNOWN_GARMENTS.map(({ slot, name, label }) => {
          const isOn = equipped.has(slot);
          const isBusy = pending.has(slot);
          return (
            <button
              key={slot}
              type="button"
              className={isOn ? "" : "secondary"}
              disabled={isBusy}
              onClick={() => onToggle(slot, name)}
            >
              {isBusy ? "…" : isOn ? `${label} ✓` : label}
            </button>
          );
        })}
      </div>
      {error ? <p className="warning">{error}</p> : null}
      <p className="note">
        Garments are fitted from real MakeHuman Community assets and reuse the body's own morph
        weights, so they follow height, weight, muscle and gender changes exactly like the body
        does.
      </p>
    </section>
  );
}
