/**
 * Which edges of a horizontal scroller still hide content. Drives the
 * fade hints on the mobile settings rail: a fade shows on a side only
 * while there is more to scroll towards it. `tolerance` absorbs the
 * sub-pixel rounding browsers apply to `scrollLeft` at fractional zoom.
 */
export function scrollEdges(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
  tolerance = 2,
): { moreStart: boolean; moreEnd: boolean } {
  const left = Math.abs(scrollLeft);
  return {
    moreStart: left > tolerance,
    moreEnd: left + clientWidth < scrollWidth - tolerance,
  };
}
