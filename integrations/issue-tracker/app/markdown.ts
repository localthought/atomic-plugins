// @wc-ignore-file
/**
 * A small, safe Markdown preview for issue descriptions and comments.
 *
 * It builds DOM nodes and sets text with `textContent` only, so raw HTML in
 * the source is shown as text, never parsed. Covered: paragraphs, line
 * breaks, ATX headings, `-`/`*`/`1.` lists, `>` quotes, fenced code, inline
 * code, **bold**, *emphasis*, and `[text](http(s) URL)` links opening in a
 * new tab. Anything else stays literal text. GitHub renders the same source
 * with its own, fuller renderer; this is a preview, not a copy of it.
 */

type Inline = Node;

const SAFE_URL = /^https?:\/\/[^\s<>"']+$/i;

export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  const re =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text))) {
    if (m.index > last)
      out.push(document.createTextNode(text.slice(last, m.index)));
    const token = m[0];
    let node: Node;
    let box: HTMLElement;

    if (m[1]) {
      node = document.createElement('code');
      node.textContent = token.slice(1, -1);
    } else if (m[2]) {
      node = box = document.createElement('strong');
      box.append(...inline(token.slice(2, -2)));
    } else if (m[3]) {
      node = box = document.createElement('em');
      box.append(...inline(token.slice(1, -1)));
    } else {
      const [, label, href] = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;

      if (SAFE_URL.test(href)) {
        const a = document.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.append(...inline(label));
        node = a;
      } else node = document.createTextNode(token);
    }

    out.push(node);
    last = m.index + token.length;
  }

  if (last < text.length) out.push(document.createTextNode(text.slice(last)));

  return out;
}

const el = (tag: string, children: Node[] = []) => {
  const node = document.createElement(tag);
  node.append(...children);

  return node;
};

/** Renders `source` into a fragment of safe block elements. */
export function markdown(source: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;

  const paragraph = (buffer: string[]) => {
    if (!buffer.length) return;
    const p = el('p');
    buffer.forEach((line, n) => {
      if (n) p.append(el('br'));
      p.append(...inline(line));
    });
    frag.append(p);
    buffer.length = 0;
  };

  const buffer: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      paragraph(buffer);
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]))
        code.push(lines[i++]);
      i++;
      const pre = el('pre');
      const c = el('code');
      c.textContent = code.join('\n');
      pre.append(c);
      frag.append(pre);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);

    if (heading) {
      paragraph(buffer);
      // Headings inside an issue stay below the panel's own title level.
      frag.append(
        el(`h${Math.min(6, heading[1].length + 2)}`, inline(heading[2])),
      );
      i++;
      continue;
    }

    const bullet = /^\s*([-*+]|\d+[.)])\s+/;

    if (bullet.test(line)) {
      paragraph(buffer);
      const ordered = /^\s*\d/.test(line);
      const list = el(ordered ? 'ol' : 'ul');

      while (i < lines.length && bullet.test(lines[i])) {
        const text = lines[i].replace(bullet, '');
        const task = text.match(/^\[([ xX])\]\s+(.*)$/);
        list.append(
          el(
            'li',
            task
              ? [
                  document.createTextNode(task[1] === ' ' ? '☐ ' : '☑ '),
                  ...inline(task[2]),
                ]
              : inline(text),
          ),
        );
        i++;
      }

      frag.append(list);
      continue;
    }

    if (/^\s*>/.test(line)) {
      paragraph(buffer);
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]))
        quoted.push(lines[i++].replace(/^\s*>\s?/, ''));
      const q = el('blockquote');
      q.append(markdown(quoted.join('\n')));
      frag.append(q);
      continue;
    }

    if (!line.trim()) paragraph(buffer);
    else buffer.push(line);
    i++;
  }

  paragraph(buffer);

  return frag;
}
