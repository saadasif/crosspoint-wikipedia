import { mathjax } from 'mathjax-full/js/mathjax.js';
import { MathML } from 'mathjax-full/js/input/mathml.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { browserAdaptor } from 'mathjax-full/js/adaptors/browserAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';

RegisterHTMLHandler(browserAdaptor());
const renderer = mathjax.document('', { InputJax: new MathML(), OutputJax: new SVG({ fontCache: 'local' }) });

export function typeset(source) {
  const node = renderer.convert(source, { display: true, em: 24, ex: 12, containerWidth: 448 });
  const svg = node.querySelector('svg');
  if (!svg || node.querySelector('[data-mjx-error],[data-mml-node="merror"]')) throw new Error('Could not typeset equation');
  return svg;
}
