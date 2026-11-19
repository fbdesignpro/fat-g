// K3, sizes: the packages `react-markdown` is made of, used without its component (block by block).
import { createRoot } from 'react-dom/client';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toHast } from 'mdast-util-to-hast';
import { gfm } from 'micromark-extension-gfm';

const tree = fromMarkdown('# text', { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
createRoot(document.getElementById('root')).render(toJsxRuntime(toHast(tree), { Fragment, jsx, jsxs }));
