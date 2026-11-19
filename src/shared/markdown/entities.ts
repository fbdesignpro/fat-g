// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Character references in Markdown text (docs/planning/_archive/M19.md, Design 6; C28): `&amp;`, `&#35;`,
// `&#x1F600;`. The parser fat-g bundles leaves the named ones to an HTML renderer, which fat-g has
// none of: a message is drawn as elements and text, never as an HTML string, so a reference is
// decoded here, into the character it names, before it becomes a text node.
//
// Pure, and it imports nothing. The names are HTML 4's 252 and `apos`: the ones a chat meets. A
// name that is not among them is left as it was written, as CommonMark leaves a name that is none.

/** The Latin-1 names, in the order of their code points from U+00A0 on. */
const LATIN_1 = (
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest '
  + 'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig '
  + 'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'
).split(' ');

/** Every other name, each with its code point. */
const OTHERS = (
  'quot:34 amp:38 apos:39 lt:60 gt:62 OElig:338 oelig:339 Scaron:352 scaron:353 Yuml:376 fnof:402 circ:710 tilde:732 '
  + 'Alpha:913 Beta:914 Gamma:915 Delta:916 Epsilon:917 Zeta:918 Eta:919 Theta:920 Iota:921 Kappa:922 Lambda:923 Mu:924 Nu:925 Xi:926 Omicron:927 Pi:928 Rho:929 Sigma:931 Tau:932 Upsilon:933 Phi:934 Chi:935 Psi:936 Omega:937 '
  + 'alpha:945 beta:946 gamma:947 delta:948 epsilon:949 zeta:950 eta:951 theta:952 iota:953 kappa:954 lambda:955 mu:956 nu:957 xi:958 omicron:959 pi:960 rho:961 sigmaf:962 sigma:963 tau:964 upsilon:965 phi:966 chi:967 psi:968 omega:969 '
  + 'thetasym:977 upsih:978 piv:982 ensp:8194 emsp:8195 thinsp:8201 zwnj:8204 zwj:8205 lrm:8206 rlm:8207 ndash:8211 mdash:8212 lsquo:8216 rsquo:8217 sbquo:8218 ldquo:8220 rdquo:8221 bdquo:8222 '
  + 'dagger:8224 Dagger:8225 bull:8226 hellip:8230 permil:8240 prime:8242 Prime:8243 lsaquo:8249 rsaquo:8250 oline:8254 frasl:8260 euro:8364 image:8465 weierp:8472 real:8476 trade:8482 alefsym:8501 '
  + 'larr:8592 uarr:8593 rarr:8594 darr:8595 harr:8596 crarr:8629 lArr:8656 uArr:8657 rArr:8658 dArr:8659 hArr:8660 '
  + 'forall:8704 part:8706 exist:8707 empty:8709 nabla:8711 isin:8712 notin:8713 ni:8715 prod:8719 sum:8721 minus:8722 lowast:8727 radic:8730 prop:8733 infin:8734 ang:8736 and:8743 or:8744 cap:8745 cup:8746 int:8747 '
  + 'there4:8756 sim:8764 cong:8773 asymp:8776 ne:8800 equiv:8801 le:8804 ge:8805 sub:8834 sup:8835 nsub:8836 sube:8838 supe:8839 oplus:8853 otimes:8855 perp:8869 sdot:8901 '
  + 'lceil:8968 rceil:8969 lfloor:8970 rfloor:8971 lang:9001 rang:9002 loz:9674 spades:9824 clubs:9827 hearts:9829 diams:9830'
).split(' ');

const NAMED: ReadonlyMap<string, string> = new Map<string, string>([
  ...LATIN_1.map((name, index): [string, string] => [name, String.fromCodePoint(0xa0 + index)]),
  ...OTHERS.map((entry): [string, string] => { const [name, code] = entry.split(':'); return [name ?? '', String.fromCodePoint(Number(code))]; }),
]);

/** A named reference, a decimal one of up to seven digits, or a hexadecimal one of up to six: CommonMark's three. */
const REFERENCE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g;
const REPLACEMENT = '�';

/** What a numeric reference names: U+FFFD for zero, for a surrogate and for a number past the last code point. */
function numbered(code: number): string {
  return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? REPLACEMENT : String.fromCodePoint(code);
}

/**
 * `text` with each character reference replaced by the character it names, once: what a reference
 * decodes to is never read again, so `&amp;lt;` is `&lt;`, as text. A string with no `&` is returned as it is.
 */
export function decodeReferences(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(REFERENCE, (whole: string, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (decimal !== undefined) return numbered(Number.parseInt(decimal, 10));
    if (hex !== undefined) return numbered(Number.parseInt(hex, 16));
    return NAMED.get(name ?? '') ?? whole;
  });
}

/** How many names are known: for the test that holds the table to HTML 4's. */
export const NAMED_REFERENCES = NAMED.size;
