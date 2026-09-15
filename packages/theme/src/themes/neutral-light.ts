import type { ThemeDoc } from '../types.js';

/** The MVP default theme (DD-04 §7). */
export const neutralLight: ThemeDoc = {
  id: 'neutral-light',
  name: 'Neutral Light',
  schemaVersion: 1,
  extends: null,

  tokens: {
    'bg': '#F7F8FA',
    'surface': '#FFFFFF',
    'surface.sunken': '#EEF1F5',
    'ink': '#1B2330',
    'ink.muted': '#5B6675',
    'line': '#8A96A8',
    'accent': '#1F5F80',
    'danger': '#A8323F',
    'font.sans': "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  },

  rules: {
    'node': { fill: '@surface', stroke: '@line', strokeWidth: 1.5, radius: 6, padding: [8, 12], minWidth: 72, minHeight: 36 },
    'node.title': { fontFamily: '@font.sans', fontSize: 13, fontWeight: 500, lineHeight: 1.3, color: '@ink' },
    'container': { fill: '@surface.sunken', stroke: '@line', strokeWidth: 1, radius: 10, padding: [16, 16, 16, 16], titleGap: 6 },
    'container.title': { fontFamily: '@font.sans', fontSize: 12, fontWeight: 600, lineHeight: 1.3, color: '@ink.muted' },
    'edge': { stroke: '@line', strokeWidth: 1.5, arrowhead: 'triangle', arrowSize: 8, labelGap: 4, labelPlate: '@bg' },
    'edge.label': { fontFamily: '@font.sans', fontSize: 11, fontWeight: 400, lineHeight: 1.3, color: '@ink.muted' },
  },

  byShape: { cylinder: { fill: '@surface.sunken' } },
  byClass: {},
  canvas: { background: '@bg' },
};
