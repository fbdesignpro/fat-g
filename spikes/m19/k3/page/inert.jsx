// What a message never makes (M19, C31 to C33, C61), shared by the two renderers of the spike: a
// link is its text and its address, an image its alternative text and its address, a task's box a
// drawn box. None is a control, and none has an address that is loaded.

const flat = (children) => (typeof children === 'string' || typeof children === 'number' ? String(children) : Array.isArray(children) ? children.map(flat).join('') : children?.props?.children !== undefined ? flat(children.props.children) : '');

export function Link({ href, children, ...rest }) {
  // What remark's own footnotes make: the mark keeps its number, the way back is not drawn.
  if ('data-footnote-ref' in rest) return <>{children}</>;
  if ('data-footnote-backref' in rest) return null;
  const text = flat(children);
  return <span className="md-link">{children}{href && href !== text ? <span className="md-addr"> ({href})</span> : null}</span>;
}

export function Image({ alt, src }) {
  return <span className="md-image">[image{alt ? `: ${alt}` : ''}]{src ? <span className="md-addr"> ({src})</span> : null}</span>;
}

export function TaskBox({ checked }) {
  return <span className="md-box" role="img" aria-label={checked ? 'done' : 'not done'}>{checked ? '☑' : '☐'}</span>;
}

export function Table({ children }) {
  return <div className="md-table"><table>{children}</table></div>;
}

/** For the renderer that maps HTML element names to components. */
export const COMPONENTS = { a: Link, img: Image, input: ({ checked }) => <TaskBox checked={checked} />, table: Table };
