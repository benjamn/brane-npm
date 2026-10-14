import type { MembraneVoice } from "@shared/membrane-motion";

// Native stub. The membrane — the 膜 glyph as a WebGL mask over a thin-film
// surface — lives in Membrane.web.tsx; metro picks that for web and this for
// native, so no shader or canvas code reaches a native bundle.
export type MembraneProps = {
  /** What the motion means: whether the brane's voice is live (`awake`, the
   *  default) or would need waking (`dormant`). See src/shared/membrane-motion.ts. */
  voice?: MembraneVoice;
  /** Explicit rates, each overriding the `voice` preset. Changes ease in. */
  lift?: number;
  sway?: number;
  churn?: number;
  /** Called on each tap of the glyph (or Enter/Space on it) — not a hold, not
   *  a drag. The caption under it cycles on this (MembraneEmpty.web.tsx). */
  onTap?: () => void;
};

export default function Membrane(_props: MembraneProps) {
  return null;
}
