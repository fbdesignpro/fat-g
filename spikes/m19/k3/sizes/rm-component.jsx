// K3, sizes: `react-markdown` with `remark-gfm`, used as its component.
import { createRoot } from 'react-dom/client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

createRoot(document.getElementById('root')).render(<Markdown remarkPlugins={[remarkGfm]}>{'# text'}</Markdown>);
