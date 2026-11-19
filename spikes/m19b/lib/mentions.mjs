// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// How an answer names a file (M19b's sheet, K2; C19, C22, C49): each place a known file is named,
// with the form it is named in — a Markdown link, a code span, a fenced block or prose — whether the
// path is relative or absolute and against which folder, the form of its line, its separators and
// how a space is written. Plain Node; nothing here is application code.
//
// The known files are the spike's own, written into the scratch folder before the run. A mention is
// kept as it was written with the scratch folder replaced by `<scratch>`: a name the spike made up,
// in the answer's form. Beside the mentions it keeps the answer's other code spans, cut short — what
// C49's reader must leave as code — and nothing else of an answer.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lexer } from 'marked';
import { pathForms } from '../../m10/lib/redactor.mjs';

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A line as an address carries one: `:12`, `:12:5`, `:12-20`, `#L12`, `#L12C5`, `#L12-L20`. */
const LINE = String.raw`(?::\d+(?::\d+)?(?:-\d+)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)`;
const LINE_AT_END = new RegExp(`${LINE}$`);
/** `[text](an address with a space)`: written as a link, and text to a CommonMark reader. */
const UNREAD_LINK = /\[([^\]\n]+)\]\(([^)\n<>]*\s[^)\n<>]*)\)/g;

/**
 * `root`: the folder the session runs in. `files`: the known files, relative to it, with `/`.
 * Returns `read(text)`, which answers what one message's text names.
 */
export function createMentionReader({ root, files }) {
  const rootForms = pathForms(root);
  const rootRegex = new RegExp(rootForms.map(escapeRegExp).join('|'), 'gi');
  /** The scratch folder out, then any other absolute path: nothing of the machine's is kept. */
  const scrub = (text) => String(text).replace(rootRegex, '<scratch>').replace(/file:\/\/\/?[^\s"'<>`)]+/gi, '<path>').replace(/(?<![A-Za-z0-9<])[A-Za-z]:[\\/][^\s"'<>|*?`)]*/g, '<path>');
  const baseNames = [...new Set(files.map((file) => path.posix.basename(file)))];
  const spaced = [...new Set(files.flatMap((file) => path.posix.dirname(file).split('/')).filter((part) => part.includes(' ')))];
  // A folder whose name has a space, however the space is written, then the file's name, then a line.
  const folder = spaced.length ? `(?:(?:${spaced.map((name) => name.split(' ').map(escapeRegExp).join(String.raw`(?: |%20|\\ |\+)`)).join('|')})[\\\\/])?` : '';
  const lead = String.raw`(?:(?:file:\/\/\/?)?(?:[A-Za-z]:)?[^\s"'` + '`' + String.raw`()<>\[\]*,;]*[\\/])?`;
  const known = new RegExp(`${lead}${folder}(?:${baseNames.map(escapeRegExp).join('|')})${LINE}?`, 'g');

  function classify(address) {
    let rest = address;
    let lineForm = null;
    let line = null;
    const at = LINE_AT_END.exec(rest);
    if (at) {
      lineForm = at[0].replace(/\d+/g, 'N');
      line = Number(/\d+/.exec(at[0])[0]);
      rest = rest.slice(0, at.index);
    }
    const fileUrl = /^file:/i.test(rest);
    let decoded = rest;
    if (fileUrl) { try { decoded = fileURLToPath(rest); } catch { /* as written */ } } else if (/%[0-9A-Fa-f]{2}/.test(rest)) { try { decoded = decodeURIComponent(rest); } catch { /* as written */ } }
    decoded = decoded.replace(/\\ /g, ' ');
    // `/C:/…`: a drive path with a slash before it, as a URL's path has one. The path is what follows the slash.
    const slashBeforeDrive = !fileUrl && /^\/[A-Za-z]:[\\/]/.test(decoded);
    if (slashBeforeDrive) decoded = decoded.slice(1);
    const scrubbed = scrub(rest);
    const absolute = fileUrl || /^[A-Za-z]:[\\/]/.test(decoded) || /^[\\/]/.test(decoded);
    const inSessionFolder = absolute ? scrubbed.replace(/^\//, '').startsWith('<scratch>') : null;
    // The path from the session's folder, if it is one: what a relative path is, and what is left of an absolute one inside it.
    let relative = null;
    if (!absolute) relative = decoded.replace(/^\.[\\/]/, '');
    else if (inSessionFolder) relative = path.relative(root, decoded);
    const normal = relative === null ? null : relative.split(/[\\/]+/).filter(Boolean).join('/');
    const names = normal === null ? null : files.find((file) => file.toLowerCase() === normal.toLowerCase()) ?? null;
    const bareNameOf = names === null && normal !== null && !normal.includes('/') ? files.find((file) => path.posix.basename(file).toLowerCase() === normal.toLowerCase()) ?? null : null;
    const slashes = { forward: rest.includes('/'), back: /\\(?! )/.test(rest) };
    const space = !/field/i.test(rest) || !spaced.length ? null
      : /%20/.test(rest) ? '%20' : /\\ /.test(rest) ? 'backslash and space' : /field\+notes/i.test(rest) ? '+' : /field notes/i.test(rest) ? 'a space, as it is' : 'other';
    return {
      written: scrubbed + (at ? at[0] : ''),
      pathKind: fileUrl ? 'file URL' : absolute ? 'absolute' : 'relative',
      ...(slashBeforeDrive ? { slashBeforeDrive } : {}),
      inSessionFolder,
      names: names ?? bareNameOf,
      // A relative path that is the file's own from the session's folder; a bare name of a file in a subfolder is not.
      resolvesFromSessionFolder: names !== null,
      bareName: !fileUrl && !slashes.forward && !slashes.back,
      separators: slashes.forward && slashes.back ? 'both' : slashes.forward ? '/' : slashes.back ? '\\' : 'none',
      lineForm, line, space,
    };
  }

  function walk(tokens, visit, inLink = false) {
    for (const token of tokens ?? []) {
      visit(token, inLink);
      if (token.type === 'list') for (const item of token.items) walk(item.tokens, visit, inLink);
      else if (token.type === 'table') for (const cell of [...token.header, ...token.rows.flat()]) walk(cell.tokens, visit, inLink);
      else if (token.tokens) walk(token.tokens, visit, inLink || token.type === 'link');
    }
  }

  /** What one message's text names: `{ units, mentions, links, codeSpans, otherCodeSpans, linesInProse }`. */
  return function read(text) {
    const mentions = [];
    const otherCodeSpans = [];
    const linkRaws = new Set();
    let links = 0;
    let externalLinks = 0;
    let codeSpans = 0;
    const found = (source) => [...String(source).matchAll(known)].map((match) => match[0]);
    walk(new Lexer({ gfm: true, breaks: false }).lex(text), (token, inLink) => {
      if (token.type === 'link') {
        linkRaws.add(token.raw);
        const form = token.raw.startsWith('[') ? 'link' : token.raw.startsWith('<') ? 'address in angle brackets' : 'bare address';
        if (/^https?:/i.test(token.href)) { externalLinks += 1; return; }
        if (/^mailto:/i.test(token.href)) return;
        links += 1;
        const facts = classify(token.href);
        const inAngles = form === 'link' && /\]\(\s*</.test(token.raw);
        mentions.push({ form, ...facts, ...(inAngles ? { space: facts.space === null ? null : `${facts.space}, the address in angle brackets` } : {}), text: scrub(token.text).slice(0, 120), textIsCode: (token.tokens ?? []).some((inner) => inner.type === 'codespan'), textIsTheAddress: token.text === token.href });
      } else if (token.type === 'codespan') {
        if (inLink) return;
        codeSpans += 1;
        const hits = found(token.text);
        if (hits.length === 0) { if (otherCodeSpans.length < 40) otherCodeSpans.push(scrub(token.text).slice(0, 80)); return; }
        for (const hit of hits) mentions.push({ form: 'code span', ...classify(hit), wholeSpan: hit === token.text.trim() });
      } else if (token.type === 'code') {
        for (const hit of found(token.text)) mentions.push({ form: 'fenced code block', ...classify(hit) });
      } else if ((token.type === 'text' || token.type === 'escape' || token.type === 'html') && token.tokens === undefined && !inLink) {
        // What was written as a link and is none (below) is counted there, not as prose.
        for (const hit of found(String(token.raw ?? token.text).replace(UNREAD_LINK, ' '))) mentions.push({ form: 'prose', ...classify(hit) });
      }
    });
    // A link whose address has a space as it is: no link in CommonMark, so the lexer gave text.
    for (const match of text.matchAll(UNREAD_LINK)) {
      if (linkRaws.has(match[0])) continue;
      mentions.push({ form: 'link whose address has a space as it is: text, in CommonMark', ...classify(match[2].trim()) });
    }
    const linesInProse = [...text.matchAll(/\blines?\s+(\d+)(?:\s*(?:-|–|to)\s*(\d+))?/gi)].map((match) => match[0].replace(/\s+/g, ' '));
    return { units: text.length, mentions, links, externalLinks, codeSpans, otherCodeSpans, linesInProse };
  };
}
