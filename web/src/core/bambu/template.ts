// Per-printer Bambu Studio project templates, captured from the CLI by
// scripts/capture-bambu-templates.py. Each template is a full N=1 project_settings dict plus the
// rules to grow the N-dependent keys to the requested filament count. Templates are loaded lazily
// via dynamic import() so each becomes its own chunk and none weigh on the initial bundle.

/** How a project_settings key grows with the filament count N. */
export type ResizeRule = 'repeat' | 'selfIndex' | 'padEmpty' | 'matrix' | 'matrixDual';

import { TEMPLATE_LOADERS } from './loaders';

export interface BambuTemplate {
  id: string;
  label: string;
  /** Printer model without nozzle, e.g. 'Bambu Lab P2S'. */
  printer: string;
  /** Nozzle diameter, e.g. '0.4'. */
  nozzle: string;
  /** Dual-nozzle (H2 series) machine. */
  dual: boolean;
  /** Printable bed size in mm. */
  bed: [number, number];
  /** Default bed plate (curr_bed_type). */
  plate: string;
  /** Bambu Studio version string used for the project metadata. */
  appVersion: string;
  /** Flush-matrix min offset and max clamp. */
  flush: { min: number; max: number };
  /** key -> how to resize it for N filaments. Keys not listed stay at the base value. */
  resize: Record<string, ResizeRule>;
  /** Full N=1 project_settings.config. */
  base: Record<string, unknown>;
}

export const TEMPLATE_IDS = Object.keys(TEMPLATE_LOADERS);

export async function loadTemplate(printerId: string): Promise<BambuTemplate> {
  const loader = TEMPLATE_LOADERS[printerId];
  if (!loader) throw new Error(`no Bambu template for printer ${printerId}`);
  const mod = (await loader()) as { default: BambuTemplate };
  return mod.default;
}
