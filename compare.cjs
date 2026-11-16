const fs = require('fs');
const expected = JSON.parse(fs.readFileSync('/home/hatch/workspace/makefun-markdown-render-speed/markdown-render-speed-02-kit/practice/reference/expected.json', 'utf8'));
const actual = JSON.parse(fs.readFileSync('/home/hatch/workspace/makefun-markdown-render-speed/output/html.json', 'utf8'));

const mismatches = [];
for (let i = 0; i < expected.cases.length; i++) {
    if (expected.cases[i].html !== actual[i]) {
        mismatches.push({ ...expected.cases[i], index: i });
    }
}

console.log('Total cases:', expected.cases.length);
console.log('Mismatches:', mismatches.length);

const byGroup = {};
for (const m of mismatches) {
    const key = m.group;
    byGroup[key] = byGroup[key] || { count: 0, ids: [] };
    byGroup[key].count++;
    byGroup[key].ids.push(m.id);
}
console.log('By group:');
for (const k of Object.keys(byGroup).sort()) {
    console.log(k, byGroup[k].count, byGroup[k].ids.join(','));
}
