import { describe, expect, it } from 'vitest';
import {
  blankHeatmapLayer,
  blankHierarchyLayer,
  blankMultiplesLayer,
  blankSurfaceLayer,
  blankInstancerLayer,
  blankLineLayer,
  blankTextLayer,
  LayerSchema,
} from '../../src/shared/layer-schema.ts';
import {
  clampParam,
  paramPatchPath,
  parameterDefs,
  parseParamId,
  readParam,
} from '../../src/shared/parameters.ts';
import { defaultProject, type Project } from '../../src/shared/project-schema.ts';

function project(): Project {
  const p = defaultProject('t');
  const layer = blankInstancerLayer('ly-1', 'Rain', 'ds');
  layer.channels.height = { ...layer.channels.height, column: 'Rainfall [mm]', domain: [0, 200] };
  const line = blankLineLayer('ln-1', 'Line', 'ds');
  line.y = { ...line.y, column: 'Rainfall [mm]', domain: [0, 100] };
  const heat = { ...blankHeatmapLayer('hm-1', 'Heat', 'ds'), valueColumn: 'Rainfall [mm]', domain: [0, 50] as [number, number] };
  return {
    ...p,
    layers: [
      layer,
      line,
      heat,
      blankTextLayer('tx-1', 'Text', null),
      blankMultiplesLayer('sm-1', 'Multiples', 'ds'),
      blankHierarchyLayer('hi-1', 'Tree', 'ds'),
      { ...blankSurfaceLayer('su-1', 'Surface', 'ds'), valueColumn: 'Rainfall [mm]', domain: [0, 80] as [number, number] },
    ],
  };
}

describe('parameter registry', () => {
  it('lists camera and layer parameters with unique ids', () => {
    const defs = parameterDefs(project());
    const ids = defs.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('camera.yaw');
    expect(ids).toContain('camera.target.2');
    expect(ids).toContain('layer.ly-1.opacity');
    expect(ids).toContain('layer.ly-1.rows.1');
    expect(ids).toContain('layer.ly-1.channels.height.range.1');
    expect(ids).toContain('layer.ly-1.channels.height.domain.0');
    // Unmapped channels have no range parameters.
    expect(ids).not.toContain('layer.ly-1.channels.y.range.0');
  });

  it('covers every layer type, transforms and the cloner', () => {
    const ids = parameterDefs(project()).map((d) => d.id);
    for (const id of [
      'layer.ly-1.transform.rotation.1',
      'layer.ly-1.cloner.count',
      'layer.ly-1.cloner.dataStep',
      'layer.ln-1.width',
      'layer.ln-1.y.range.1',
      'layer.ln-1.y.domain.0',
      'layer.hm-1.domain.1',
      'layer.hm-1.cell.0',
      'layer.tx-1.row',
      'layer.tx-1.transform.scale.0',
      'layer.ln-1.cloner.dataStep',
      'layer.ln-1.fill.opacity',
      'layer.sm-1.panelSize.1',
      'layer.hi-1.linkWidth',
      'layer.su-1.height.1',
      'layer.su-1.domain.0',
      'layer.ly-1.effects.glow.strength',
      'layer.hi-1.effects.glow.threshold',
      'layer.ln-1.effects.trails.persistence',
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(ids.some((id) => id.startsWith('output.'))).toBe(false);
    for (const l of project().layers) expect(LayerSchema.safeParse(l).success, l.type).toBe(true);
  });

  it('every listed parameter resolves to a number in the project', () => {
    const p = project();
    for (const d of parameterDefs(p)) expect(typeof readParam(p, d.id), d.id).toBe('number');
  });

  it('parses ids and builds patch paths by layer id', () => {
    expect(parseParamId('layer.ly-1.rows.1')).toEqual({ kind: 'layer', layerId: 'ly-1', path: ['rows', 1] });
    expect(parseParamId('camera.target.0')).toEqual({ kind: 'camera', path: ['target', 0] });
    expect(parseParamId('nonsense')).toBeNull();
    expect(paramPatchPath(project(), 'layer.ly-1.origin.0')).toEqual(['project', 'layers', 0, 'origin', 0]);
    expect(paramPatchPath(project(), 'layer.gone.opacity')).toBeNull();
    expect(readParam(project(), 'layer.ly-1.channels.height.domain.1')).toBe(200);
  });

  it('clamps to the valid range and rounds integers', () => {
    const defs = new Map(parameterDefs(project()).map((d) => [d.id, d]));
    expect(clampParam(defs.get('layer.ly-1.opacity')!, 1.7)).toBe(1);
    expect(clampParam(defs.get('camera.pitch')!, -200)).toBe(-89);
    expect(clampParam(defs.get('layer.ly-1.gridColumns')!, 12.6)).toBe(13);
    expect(clampParam(defs.get('layer.ly-1.gridColumns')!, -5)).toBe(1);
    expect(clampParam(defs.get('layer.ly-1.opacity')!, NaN)).toBe(0);
  });
});
