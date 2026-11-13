// Run after `npm run build`: the suite frame must be in the static HTML, and no masthead of our own.
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const fail = [];
for (const tag of ['<sjl-suite-bar', '<sjl-product-header', '<sjl-claims', '<sjl-footer']) if (!html.includes(tag)) fail.push(`missing ${tag}`);
if (/<header class/.test(html.replace(/<template[\s\S]*?<\/template>/g, ''))) fail.push('a masthead <header class> of our own is present');
if (html.includes('x-sjl-preview')) fail.push('x-sjl-preview present');
if (fail.length) { console.error(fail.join('\n')); process.exit(1); }
console.log('check-frame: ok');

// One mark: the favicon is the frame's own logo, byte for byte.
const fav = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8');
const brand = readFileSync(new URL('../node_modules/@superjackfruit/frontdoor/src/brand/superexchange.svg', import.meta.url), 'utf8');
if (fav !== brand) { console.error('public/favicon.svg differs from frontdoor brand/superexchange.svg: copy it again'); process.exit(1); }
console.log('check-frame: favicon is the frame mark');
