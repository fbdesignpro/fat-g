// K3, sizes: `marked`, its lexer alone. The renderer of fat-g's own is not counted: it is fat-g's code.
import { createRoot } from 'react-dom/client';
import { Lexer } from 'marked';

createRoot(document.getElementById('root')).render(<p>{new Lexer({ gfm: true }).lex('# text').length}</p>);
