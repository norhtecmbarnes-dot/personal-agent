const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
test('required public workload is tracked Markdown with explicit safety and evidence gates', () => {
 const file = 'public/workloads/consistent-character-producer.md';
 const text = fs.readFileSync(path.join(__dirname, file), 'utf8');
 assert.match(text, /^# Consistent-character producer/);
 for (const phrase of ['UNSPECIFIED', 'per-action approval', 'explicitly select', 'BLOCKED', 'VERIFIED THROUGH PERSONAL AGENT']) assert.ok(text.includes(phrase), phrase);
 const files = cp.execFileSync('git', ['ls-files'], { cwd: __dirname, encoding: 'utf8' }).split('\n');
 assert.ok(files.includes(file), 'workload must be included in the release commit');
 for (const f of files) assert.ok(!/(^|\/)(?:\.localpilot|\.env(?:\.|$)|browser-profile)(?:\/|$)/i.test(f), 'private runtime path: ' + f);
});
