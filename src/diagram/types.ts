/** The intermediate representation a ```mermaid fence parses into.
 *
 *  Deliberately small. The dialect brane renders is the one its agents
 *  actually write — measured over every mermaid fence in the archive, not
 *  taken from mermaid's manual — and anything outside it falls back to the
 *  syntax-highlighted code block the fence renders as today.
 */

import type { LabelLine, RunLine } from "./label.js";
export type { LabelLine, RunLine, TableBlock, TextRun } from "./label.js";

export type Direction = "TB" | "LR" | "RL" | "BT";

export type NodeShape =
  | "rect"
  | "round"
  | "stadium"
  | "subroutine"
  | "cylinder"
  | "circle"
  | "asymmetric"
  | "diamond"
  | "hexagon";

export type ArrowKind = "arrow" | "biarrow" | "open";
export type LineKind = "solid" | "dotted" | "thick";

export interface DiagramNode {
  id: string;
  /** Display text, one string per drawn line. Never markup. */
  lines: string[];
  /** The same lines as styled runs (`label.ts`); what layout measures and the
   *  SVG draws. */
  runs: LabelLine[];
  shape: NodeShape;
  /** `classDef` names attached via `class` / `:::`. */
  classes: string[];
  /** Inline `style` declarations, already filtered to safe properties. */
  style?: Record<string, string>;
}

export interface DiagramEdge {
  from: string;
  to: string;
  /** Plain text, lines joined by a space. */
  label?: string;
  labelRuns?: RunLine[];
  arrow: ArrowKind;
  line: LineKind;
}

export interface Subgraph {
  id: string;
  title: string;
  /** The title as one styled line. */
  titleRuns: RunLine;
  nodes: string[];
}

export interface DiagramIR {
  direction: Direction;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  subgraphs: Subgraph[];
  classDefs: Record<string, Record<string, string>>;
  /** Label markup that draws as the characters it is made of. Not a refusal:
   *  the diagram draws, and `narrate` reports these as warnings. */
  literal: LabelNote[];
}

export interface LabelNote {
  message: string;
  /** 1-based line in the fence body where the statement starts. */
  line: number;
}

/** Why a source was refused, so `narrate` can tell the author. */
export interface DiagramRefusal {
  kind: "unsupported" | "parse_error";
  message: string;
  /** 1-based line in the fence body. */
  line?: number;
}
