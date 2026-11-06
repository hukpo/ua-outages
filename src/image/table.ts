import type { IntervalKind } from '../types.js'
import { classify, findGrids, sample, type Rgb } from './grid.js'
import type { RgbaImage } from './png.js'

export interface TableLayout {
  /** Time cells per table row */
  columns: number
  /** Group rows per table */
  rows: number
  /** Tables stacked top to bottom that together cover the day (e.g. 00–12 and 12–24) */
  tables: number
  /** Each cell is split in half (an hour cell can be off for its first or second 30 min) */
  halves: boolean
  palette: { on: Rgb; off: Rgb; maybe?: Rgb }
}

/**
 * Reads a schedule table image into one row of cells per group, covering the whole day in
 * order: `null` = power on, `off`, `maybe`. Throws when the table isn't where the layout says
 * or a cell has a colour outside the palette, so a changed template is reported, not misread.
 */
export function readScheduleTable(img: RgbaImage, layout: TableLayout): (IntervalKind | null)[][] {
  const grids = findGrids(img, layout.columns, layout.rows)
  if (grids.length !== layout.tables)
    throw new Error(
      `expected ${layout.tables} table(s) of ${layout.rows}×${layout.columns}, found ${grids.length}`,
    )

  const palette: Record<string, Rgb> = { on: layout.palette.on, off: layout.palette.off }
  if (layout.palette.maybe) palette.maybe = layout.palette.maybe
  const groups: (IntervalKind | null)[][] = Array.from({ length: layout.rows }, () => [])
  for (const grid of grids)
    grid.rows.forEach((row, r) => {
      const y = (row.start + row.end) / 2
      for (const col of grid.columns) {
        const w = col.end - col.start
        const xs = layout.halves ? [col.start + w * 0.25, col.start + w * 0.75] : [col.start + w / 2]
        for (const x of xs) {
          const c = sample(img, x, y)
          const kind = classify(c, palette)
          if (!kind)
            throw new Error(
              `unexpected cell colour rgb(${c.map(Math.round).join(',')}) at ${Math.round(x)},${Math.round(y)}`,
            )
          groups[r]!.push(kind === 'on' ? null : (kind as IntervalKind))
        }
      }
    })
  return groups
}

/** Row order of the standard 6 queues × 2 subqueues tables */
export const STANDARD_GROUPS = [
  '1.1',
  '1.2',
  '2.1',
  '2.2',
  '3.1',
  '3.2',
  '4.1',
  '4.2',
  '5.1',
  '5.2',
  '6.1',
  '6.2',
]
