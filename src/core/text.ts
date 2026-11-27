const characters = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const truncateCharacters = (text: string, limit: number) => {
  let remaining = limit;
  for (const { index } of characters.segment(text)) {
    if (remaining === 0) return text.slice(0, index);
    remaining -= 1;
  }
  return text;
};
