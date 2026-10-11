/**
 * Golden token ids, generated from `@huggingface/transformers`' own
 * `AutoTokenizer` for `Xenova/bge-small-en-v1.5` while that package was still
 * a dependency (`AutoTokenizer(text, { truncation: true })`).
 *
 * They are the record of the contract `src/memory/wordpiece.ts` replaced:
 * brane's `memory_vec` holds vectors embedded through the old tokenizer, so a
 * disagreement here is not a style difference — it silently moves query
 * vectors away from the stored ones. Regenerate ONLY if the model itself
 * changes, and expect to reindex if you do.
 *
 * A .ts module rather than .json so `tsc` carries it into `dist/test/`.
 */
export interface GoldenCase {
  text: string;
  ids: number[];
}

export const WORDPIECE_GOLDEN: GoldenCase[] = [
  {
    text: "",
    ids: [101, 102],
  },
  {
    text: "   ",
    ids: [101, 102],
  },
  {
    text: "\n\t ",
    ids: [101, 102],
  },
  {
    text: "a",
    ids: [101, 1037, 102],
  },
  {
    text: "hello world",
    ids: [101, 7592, 2088, 102],
  },
  {
    text: "The quick brown fox jumps over the lazy dog.",
    ids: [101, 1996, 4248, 2829, 4419, 14523, 2058, 1996, 13971, 3899, 1012, 102],
  },
  {
    text: "Brane is a TypeScript reimagining of the organelle system.",
    ids: [101, 24905, 2063, 2003, 1037, 4127, 23235, 24964, 2863, 11528, 2075, 1997, 1996, 5812, 14774, 2291, 1012, 102],
  },
  {
    text: "caf\u00e9 na\u00efve r\u00e9sum\u00e9",
    ids: [101, 7668, 15743, 13746, 102],
  },
  {
    text: "\u00dcn\u00efc\u00f6d\u00e9 \u00e0cc\u00e9nts \u00e9verywhere",
    ids: [101, 27260, 24947, 7249, 102],
  },
  {
    text: "ZALGO Z\u0338\u0327\u034eA\u0334L\u0337G\u0336O\u0335",
    ids: [101, 23564, 2140, 3995, 23564, 2140, 3995, 102],
  },
  {
    text: "\u4e2d\u6587\u5b57\u7b26\u6d4b\u8bd5",
    ids: [101, 1746, 1861, 100, 100, 100, 100, 102],
  },
  {
    text: "\u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8",
    ids: [101, 1864, 1876, 1950, 1671, 30239, 30227, 30233, 30240, 102],
  },
  {
    text: "\ud55c\uad6d\uc5b4 \ud14d\uc2a4\ud2b8",
    ids: [101, 1469, 30006, 30021, 29991, 30014, 30020, 29999, 30008, 1467, 30009, 30020, 29997, 30017, 30003, 30017, 102],
  },
  {
    text: "\uff26\uff35\uff2c\uff2c\uff37\uff29\uff24\uff34\uff28 \uff21\uff22\uff23",
    ids: [101, 100, 100, 102],
  },
  {
    text: "emoji \ud83c\udf89\ud83d\udd25 mixed with text",
    ids: [101, 7861, 29147, 2072, 100, 3816, 2007, 3793, 102],
  },
  {
    text: "\ud83c\uddfa\ud83c\uddf8 flag sequences \ud83c\uddec\ud83c\udde7",
    ids: [101, 100, 5210, 10071, 100, 102],
  },
  {
    text: "\ufffd replacement char",
    ids: [101, 6110, 25869, 102],
  },
  {
    text: "soft\u00adhyphen",
    ids: [101, 3730, 10536, 8458, 2368, 102],
  },
  {
    text: "[CLS] literal [SEP] and [MASK] and [PAD] and [UNK]",
    ids: [101, 101, 18204, 102, 1998, 103, 1998, 0, 1998, 100, 102],
  },
  {
    text: "snake_case camelCase kebab-case SCREAMING_SNAKE",
    ids: [101, 7488, 1035, 2553, 19130, 18382, 17710, 3676, 2497, 1011, 2553, 7491, 1035, 7488, 102],
  },
  {
    text: "https://example.com/a?b=c#d&e=f",
    ids: [101, 16770, 1024, 1013, 1013, 2742, 1012, 4012, 1013, 1037, 1029, 1038, 1027, 1039, 1001, 1040, 1004, 1041, 1027, 1042, 102],
  },
  {
    text: "$1,234.56 \u2014 em-dash \u2026 ellipsis \u00ab guillemets \u00bb",
    ids: [101, 1002, 1015, 1010, 22018, 1012, 5179, 1517, 7861, 1011, 11454, 1529, 3449, 15000, 6190, 1077, 26458, 6216, 11368, 2015, 1090, 102],
  },
  {
    text: "e.g. i.e. etc. Dr. Smith went to Washington, D.C.",
    ids: [101, 1041, 1012, 1043, 1012, 1045, 1012, 1041, 1012, 4385, 1012, 2852, 1012, 3044, 2253, 2000, 2899, 1010, 1040, 1012, 1039, 1012, 102],
  },
  {
    text: "```js\nconst x = 1;\n```",
    ids: [101, 1036, 1036, 1036, 1046, 2015, 9530, 3367, 1060, 1027, 1015, 1025, 1036, 1036, 1036, 102],
  },
  {
    text: "tab\there\nnewline\r\ncarriage",
    ids: [101, 21628, 2182, 2047, 4179, 9118, 102],
  },
  {
    text: "supercalifragilisticexpialidocious antidisestablishmentarianism",
    ids: [101, 3565, 9289, 10128, 29181, 24411, 4588, 10288, 19312, 21273, 10085, 6313, 3424, 10521, 4355, 7875, 13602, 3672, 12199, 2964, 102],
  },
  {
    text: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    ids: [101, 22038, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 2595, 102],
  },
  {
    text: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    ids: [101, 22038, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 20348, 102],
  },
  {
    text: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    ids: [101, 100, 102],
  },
  {
    text: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ids: [101, 100, 102],
  },
  {
    text: "SELECT * FROM events WHERE seq > 42 ORDER BY seq ASC;",
    ids: [101, 7276, 1008, 2013, 2824, 2073, 7367, 4160, 1028, 4413, 2344, 2011, 7367, 4160, 2004, 2278, 1025, 102],
  },
  {
    text: "0x1F 0b1010 1e-9 3.14159 -273.15",
    ids: [101, 1014, 2595, 2487, 2546, 1014, 2497, 10790, 10790, 1015, 2063, 1011, 1023, 1017, 1012, 15471, 28154, 1011, 25371, 1012, 2321, 102],
  },
  {
    text: "he said \"don't\" \u2014 she said 'won't'",
    ids: [101, 2002, 2056, 1000, 2123, 1005, 1056, 1000, 1517, 2016, 2056, 1005, 2180, 1005, 1056, 1005, 102],
  },
  {
    text: "multiple     internal    spaces",
    ids: [101, 3674, 4722, 7258, 102],
  },
  {
    text: "  leading and trailing  ",
    ids: [101, 2877, 1998, 12542, 102],
  },
  {
    text: "MixedCASE WoRdS wItH nUmBeRs 123abc abc123",
    ids: [101, 3816, 18382, 2616, 2007, 3616, 13138, 7875, 2278, 5925, 12521, 2509, 102],
  },
  {
    text: "@mention #hashtag $TICKER %percent ^caret &amp",
    ids: [101, 1030, 5254, 1001, 23325, 15900, 1002, 16356, 2121, 1003, 3867, 1034, 2729, 2102, 1004, 23713, 102],
  },
  {
    text: "one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three one two three ",
    ids: [101, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028, 2048, 2093, 2028],
  },
  {
    text: "narrative claude-51qrhege:34 reference",
    ids: [101, 7984, 8149, 1011, 4868, 4160, 25032, 24746, 1024, 4090, 4431, 102],
  },
  {
    text: "\ud83e\uddec protein folding: \u03b1-helix and \u03b2-sheet structures",
    ids: [101, 100, 5250, 12745, 1024, 1155, 1011, 25743, 1998, 1156, 1011, 7123, 5090, 102],
  },
  {
    text: "\u03a9 \u03bc \u03c0 \u2211 \u222b \u221a \u221e \u2248 \u2260 \u2264 \u2265",
    ids: [101, 1179, 1166, 1170, 100, 100, 1600, 1601, 1606, 1027, 1608, 1609, 102],
  },
];
