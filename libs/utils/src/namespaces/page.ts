export const pageSizeMap = {
  a4: {
    width: 210,
    height: 297,
  },
  letter: {
    width: 216,
    height: 279,
  },
} as const;

// Millimeter to pixel conversion factor, assuming a resolution of 96 DPI (CSS reference pixel).
// Shared by the artboard renderer (screen sizing) and the server-side printer (PDF page sizing)
// so both always agree on exactly how big an "A4" or "Letter" page is.
export const MM_TO_PX = 3.78;
