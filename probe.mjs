import { _debugTokens } from './parse.js';
const md = "- a\n  - b\n\n    c\n- d\n";
console.log(JSON.stringify(_debugTokens(md), null, 1));
