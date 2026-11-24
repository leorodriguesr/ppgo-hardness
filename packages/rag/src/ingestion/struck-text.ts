/**
 * O PDF consolidado do Legisla risca a redação antiga em vermelho e sublinha a nota
 * de alteração em azul. O texto vermelho com um traço vermelho por cima sai da
 * extração. Texto só vermelho, sem o traço, permanece.
 */

export interface PositionedTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

interface OperatorList {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown[] | null>;
}

interface PdfOps {
  showText: number;
  setFillRGBColor: number;
  setStrokeRGBColor: number;
  setTextMatrix: number;
  setFont: number;
  constructPath: number;
  stroke: number;
}

interface RedRun {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Segment {
  x1: number;
  y: number;
  x2: number;
}

const MOVE_TO = 0;
const LINE_TO = 1;

function asNumbers(value: unknown): number[] {
  if (!value || typeof value !== 'object') return [];
  const list = value as ArrayLike<unknown>;
  if (typeof list.length !== 'number') return [];
  return Array.from(list, (item) => Number(item));
}

function colorOf(args: unknown[] | null): string {
  const value = args?.[0];
  if (typeof value === 'string') return value.toLowerCase();
  if (Array.isArray(value) && value.length >= 3 && value[0] === 1 && value[1] === 0 && value[2] === 0) return '#ff0000';
  return '';
}

function isRed(color: string): boolean {
  return color === '#ff0000' || color === '#f00';
}

function segmentsOf(data: unknown): Segment[] {
  let nums = asNumbers(data);
  if (nums.length < 4 && data && typeof data === 'object') {
    const nested = asNumbers((data as ArrayLike<unknown>)[0]);
    if (nested.length > nums.length) nums = nested;
  }
  const segments: Segment[] = [];
  let x = 0;
  let y = 0;
  let hasPoint = false;
  for (let i = 0; i < nums.length; ) {
    const op = nums[i++];
    if (op === MOVE_TO && i + 1 < nums.length) {
      x = nums[i++]!;
      y = nums[i++]!;
      hasPoint = true;
    } else if (op === LINE_TO && i + 1 < nums.length) {
      const x2 = nums[i++]!;
      const y2 = nums[i++]!;
      if (hasPoint && Math.abs(y2 - y) < 0.8 && Math.abs(x2 - x) > 1) {
        segments.push({ x1: Math.min(x, x2), y, x2: Math.max(x, x2) });
      }
      x = x2;
      y = y2;
      hasPoint = true;
    } else if (op === 2 && i + 5 < nums.length) {
      i += 4;
      x = nums[i++]!;
      y = nums[i++]!;
      hasPoint = true;
    } else if (op === 3 && i + 3 < nums.length) {
      i += 2;
      x = nums[i++]!;
      y = nums[i++]!;
      hasPoint = true;
    }
  }
  return segments;
}

function covers(segment: Segment, run: RedRun): boolean {
  const overlapsX = segment.x1 <= run.x + 1 && segment.x2 >= run.x + Math.max(run.width, 1) - 1;
  const throughGlyph = segment.y <= run.y + 1 && segment.y >= run.y - run.height * 0.85;
  return overlapsX && throughGlyph;
}

/** Itens de texto da página, sem a redação riscada. Null quando a página não tem risco vermelho. */
export function textItemsSkippingStruck(ops: OperatorList, op: PdfOps): PositionedTextItem[] | null {
  let fill = '';
  let stroke = '';
  let fontSize = 12;
  let x = 0;
  let y = 0;
  const items: PositionedTextItem[] = [];
  const redRuns: RedRun[] = [];
  const strikes: Segment[] = [];

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]!;
    const args = ops.argsArray[i] ?? [];
    if (fn === op.setFillRGBColor) fill = colorOf(args);
    else if (fn === op.setStrokeRGBColor) stroke = colorOf(args);
    else if (fn === op.setFont) {
      const size = Number(args[1]);
      if (Number.isFinite(size) && size > 0) fontSize = size;
    } else if (fn === op.setTextMatrix) {
      const matrix = asNumbers(args[0]);
      if (matrix.length >= 6) {
        x = matrix[4]!;
        y = matrix[5]!;
        const scale = Math.abs(matrix[0]!) || 1;
        fontSize = Math.max(fontSize, 1) * (scale === 1 ? 1 : scale);
      }
    } else if (fn === op.constructPath && args[0] === op.stroke && isRed(stroke)) {
      strikes.push(...segmentsOf(args[1]));
    } else if (fn === op.showText) {
      const glyphs = (args[0] ?? []) as ArrayLike<{ unicode?: string; width?: number } | number>;
      let text = '';
      let width = 0;
      const scale = fontSize / 1000;
      for (let g = 0; g < glyphs.length; g++) {
        const glyph = glyphs[g];
        if (typeof glyph === 'number') {
          width += -glyph * scale;
          continue;
        }
        if (!glyph) continue;
        text += glyph.unicode ?? '';
        width += (glyph.width ?? 0) * scale;
      }
      if (!text) continue;
      // A matriz deste PDF cresce para baixo. O agrupador de linhas espera o contrário.
      const item: PositionedTextItem = {
        str: text,
        transform: [1, 0, 0, fontSize, x, -y],
        width: Math.max(width, 0),
        height: fontSize,
        hasEOL: false,
      };
      if (isRed(fill)) redRuns.push({ index: items.length, x, y, width: Math.max(width, 0), height: fontSize });
      items.push(item);
    }
  }

  const struck = new Set<number>();
  for (const run of redRuns) {
    if (strikes.some((segment) => covers(segment, run))) struck.add(run.index);
  }
  if (struck.size === 0) return null;
  return items.filter((_, index) => !struck.has(index));
}
