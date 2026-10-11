import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('Only the two isolated review branches suppress automatic deployments without disabling main or other branches',()=>{
 const config=JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
 assert.deepEqual(config.git.deploymentEnabled,{'core/review-revision-legacy':false,'core/C-41-pr45-release-remediation':false});
 assert.equal(config.git.deploymentEnabled.main,undefined);
 assert.equal(config.buildCommand,'npm run build');
 assert.equal(config.installCommand,'npm ci');
});
