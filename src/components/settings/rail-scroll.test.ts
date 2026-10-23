import { describe, expect, it } from 'vitest';

import { scrollEdges } from './rail-scroll';

describe('scrollEdges', () => {
  it('reports nothing hidden when the content fits', () => {
    expect(scrollEdges(0, 400, 400)).toEqual({ moreStart: false, moreEnd: false });
  });

  it('shows only the end hint at the start of an overflowing row', () => {
    expect(scrollEdges(0, 375, 900)).toEqual({ moreStart: false, moreEnd: true });
  });

  it('shows both hints in the middle', () => {
    expect(scrollEdges(200, 375, 900)).toEqual({ moreStart: true, moreEnd: true });
  });

  it('shows only the start hint at the end', () => {
    expect(scrollEdges(525, 375, 900)).toEqual({ moreStart: true, moreEnd: false });
  });

  it('absorbs sub-pixel rounding at both ends', () => {
    expect(scrollEdges(1, 375, 900)).toEqual({ moreStart: false, moreEnd: true });
    expect(scrollEdges(523.5, 375, 900)).toEqual({ moreStart: true, moreEnd: false });
  });
});
