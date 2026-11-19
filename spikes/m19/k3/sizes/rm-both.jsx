// K3, sizes: the component and the packages under it, both used.
import { createRoot } from 'react-dom/client';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toHast } from 'mdast-util-to-hast';
import { gfm } from 'micromark-extension-gfm';

const tree = fromMarkdown('# text', { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
createRoot(document.getElementById('root')).render(<><Markdown remarkPlugins={[remarkGfm]}>{'# text'}</Markdown>{toJsxRuntime(toHast(tree), { Fragment, jsx, jsxs })}</>);
