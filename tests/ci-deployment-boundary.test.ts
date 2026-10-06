import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('CI review branch suppresses automatic deployments without disabling main or other branches',()=>{
 const config=JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
 assert.deepEqual(config.git.deploymentEnabled,{'core/review-revision-legacy':false});
 assert.equal(config.git.deploymentEnabled.main,undefined);
 assert.equal(config.buildCommand,'npm run build');
 assert.equal(config.installCommand,'npm ci');
});
