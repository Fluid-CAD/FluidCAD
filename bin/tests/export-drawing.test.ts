import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { DRAWING_PLANES, exportWarnings, parseDrawingOptions } from '../lib/export-drawing.js';
import { registerExportCommand } from '../commands/export.js';
import { STANDARD_PLANES, standardPlaneView } from '../../lib/dist/math/plane.js';

// `fluidcad export dxf` and `svg`: the plane flag and the request body it
// becomes, an SVG's page flags, the warnings header, and the commands' own
// surface.

describe('DRAWING_PLANES', () => {
  it('is the engine\'s twelve standard planes, each with the view the engine gives it', () => {
    expect(Object.keys(DRAWING_PLANES).sort()).toEqual([...STANDARD_PLANES].sort());
    for (const plane of STANDARD_PLANES) {
      expect(DRAWING_PLANES[plane as keyof typeof DRAWING_PLANES]).toBe(standardPlaneView(plane));
    }
  });
});

describe('parseDrawingOptions', () => {
  it('sends the plane as asked and names the view it shows', () => {
    expect(parseDrawingOptions({ plane: 'top' })).toEqual({ view: 'top', body: { plane: 'top' } });
    expect(parseDrawingOptions({ plane: 'xz' })).toEqual({ view: 'front', body: { plane: 'xz' } });
    expect(parseDrawingOptions({ plane: '-yz' })).toEqual({ view: 'left', body: { plane: '-yz' } });
    expect(parseDrawingOptions({ plane: ' Front ' })).toEqual({ view: 'front', body: { plane: 'front' } });
  });

  it('sends the edge flags only when they are set', () => {
    expect(parseDrawingOptions({ plane: 'top', hiddenLines: true }).body).toEqual({ plane: 'top', hiddenLines: true });
    expect(parseDrawingOptions({ plane: 'top', tangentEdges: true }).body).toEqual({ plane: 'top', tangentEdges: true });
    expect(parseDrawingOptions({ plane: 'top', hiddenLines: false, tangentEdges: undefined }).body).toEqual({ plane: 'top' });
  });

  it('requires the plane, and lists the planes when it is missing or unknown', () => {
    expect(() => parseDrawingOptions({})).toThrow(/--plane is required.*top, xy, bottom, -xy, front, xz, back, -xz, right, yz, left, -yz/);
    expect(() => parseDrawingOptions({ plane: '  ' })).toThrow(/--plane is required/);
    expect(() => parseDrawingOptions({ plane: 'iso' })).toThrow(/Invalid --plane "iso"\. Expected one of: top, xy/);
    // An inherited property name is not a plane.
    expect(() => parseDrawingOptions({ plane: 'constructor' })).toThrow(/Invalid --plane/);
  });
});

describe('parseDrawingOptions — an SVG\'s page', () => {
  it('sends the stroke width and margin as numbers of millimetres, only when given', () => {
    expect(parseDrawingOptions({ plane: 'top' }, 'svg')).toEqual({ view: 'top', body: { plane: 'top' } });
    expect(parseDrawingOptions({ plane: 'xz', strokeWidth: '0.5', margin: '0' }, 'svg'))
      .toEqual({ view: 'front', body: { plane: 'xz', strokeWidth: 0.5, margin: 0 } });
    expect(parseDrawingOptions({ plane: 'top', hiddenLines: true, margin: ' 2.5 ' }, 'svg').body)
      .toEqual({ plane: 'top', hiddenLines: true, margin: 2.5 });
  });

  it('refuses a stroke width that is not above zero and a margin below it, before anything is spawned', () => {
    for (const strokeWidth of ['0', '-1', 'thin', '', 'NaN', 'Infinity']) {
      expect(() => parseDrawingOptions({ plane: 'top', strokeWidth }, 'svg'))
        .toThrow(/Invalid --stroke-width ".*"\. Expected a number of millimetres greater than 0\./);
    }
    for (const margin of ['-1', 'wide', '', 'Infinity']) {
      expect(() => parseDrawingOptions({ plane: 'top', margin }, 'svg'))
        .toThrow(/Invalid --margin ".*"\. Expected a number of millimetres, 0 or more\./);
    }
  });

  it('still requires the plane', () => {
    expect(() => parseDrawingOptions({ strokeWidth: '0.5' }, 'svg')).toThrow(/--plane is required/);
  });

  it('leaves the page flags out of a DXF request: it has no page', () => {
    expect(parseDrawingOptions({ plane: 'top', strokeWidth: '0.5', margin: '2' }).body).toEqual({ plane: 'top' });
    expect(parseDrawingOptions({ plane: 'top', strokeWidth: '0.5' }, 'dxf').body).toEqual({ plane: 'top' });
  });
});

describe('exportWarnings', () => {
  const headers = (value?: string) => new Headers(value === undefined ? {} : { 'X-FluidCAD-Export-Warnings': value });

  it('reads the URI-encoded JSON list the server sends', () => {
    const warnings = ['2 curves were approximated by polylines.', 'größer — ünïcode'];
    expect(exportWarnings(headers(encodeURIComponent(JSON.stringify(warnings))))).toEqual(warnings);
  });

  it('is empty without the header, and for one that is not a list of strings', () => {
    expect(exportWarnings(headers())).toEqual([]);
    expect(exportWarnings(undefined)).toEqual([]);
    expect(exportWarnings(headers('%E0%A4%A'))).toEqual([]);
    expect(exportWarnings(headers(encodeURIComponent('{"a":1}')))).toEqual([]);
    expect(exportWarnings(headers(encodeURIComponent('["kept", 3, ""]')))).toEqual(['kept']);
  });
});

describe('fluidcad export dxf — the command', () => {
  function dxfCommand(): Command {
    const program = new Command();
    registerExportCommand(program);
    const exportCommand = program.commands.find((c) => c.name() === 'export')!;
    return exportCommand.commands.find((c) => c.name() === 'dxf')!;
  }

  it('sits beside step, stl and png', () => {
    const program = new Command();
    registerExportCommand(program);
    const exportCommand = program.commands.find((c) => c.name() === 'export')!;
    expect(exportCommand.commands.map((c) => c.name())).toEqual(['step', 'stl', 'dxf', 'svg', 'png']);
  });

  it('takes the plane, the edge flags, the selection and the configuration flags — and none of the mesh ones', () => {
    const flags = dxfCommand().options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining([
      '--plane', '--hidden-lines', '--tangent-edges', '--shapes', '--list-shapes',
      '--configuration', '--all-configurations', '--workspace', '--entry', '--out', '--port', '--timeout',
    ]));
    expect(flags).not.toContain('--resolution');
    expect(flags).not.toContain('--scale-to');
    expect(flags).not.toContain('--no-colors');
  });

  it('lists every plane with its view in the help', () => {
    let help = '';
    const command = dxfCommand();
    command.configureOutput({ writeOut: (text) => { help += text; } });
    command.outputHelp();
    for (const [view, axis] of [['top', 'xy'], ['bottom', '-xy'], ['front', 'xz'], ['back', '-xz'], ['right', 'yz'], ['left', '-yz']]) {
      expect(help).toMatch(new RegExp(`^  ${view}\\s+${axis}\\s`, 'm'));
    }
    expect(help).toContain('bracket-top.dxf');
  });
});

describe('fluidcad export svg — the command', () => {
  function svgCommand(): Command {
    const program = new Command();
    registerExportCommand(program);
    const exportCommand = program.commands.find((c) => c.name() === 'export')!;
    return exportCommand.commands.find((c) => c.name() === 'svg')!;
  }

  it('takes what dxf takes plus the page flags — and none of the mesh or screenshot ones', () => {
    const flags = svgCommand().options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining([
      '--plane', '--hidden-lines', '--tangent-edges', '--stroke-width', '--margin', '--shapes', '--list-shapes',
      '--configuration', '--all-configurations', '--workspace', '--entry', '--out', '--port', '--timeout',
    ]));
    expect(flags).not.toContain('--resolution');
    expect(flags).not.toContain('--scale-to');
    expect(flags).not.toContain('--no-colors');
    expect(flags).not.toContain('--width');
    expect(flags).not.toContain('--view');
    // The page flags have no default of their own: an absent flag leaves the page to the server.
    for (const flag of ['--stroke-width', '--margin']) {
      expect(svgCommand().options.find((o) => o.long === flag)!.defaultValue).toBeUndefined();
    }
  });

  it('lists every plane with its view, its own file names and what the page is, in the help', () => {
    let help = '';
    const command = svgCommand();
    command.configureOutput({ writeOut: (text) => { help += text; } });
    command.outputHelp();
    for (const [view, axis] of [['top', 'xy'], ['bottom', '-xy'], ['front', 'xz'], ['back', '-xz'], ['right', 'yz'], ['left', '-yz']]) {
      expect(help).toMatch(new RegExp(`^  ${view}\\s+${axis}\\s`, 'm'));
    }
    expect(help).toContain('bracket-top.svg');
    expect(help).not.toContain('.dxf');
    expect(help).toContain('millimetres on paper');
  });
});
