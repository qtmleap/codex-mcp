import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('model access errors produce safe actionable diagnostics without upstream text', async t => {
 const root=await mkdtemp(join(tmpdir(),'codex-error-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const cli=join(root,'codex');
 await writeFile(cli,`#!${process.execPath}
console.log(JSON.stringify({type:'turn.failed',error:{message:'Project private-id does not have access to model private-model synthetic-secret'}}));
process.exitCode=1;
`);await chmod(cli,0o700);
 const result=spawnSync(process.execPath,['src/codex-cli.mjs'],{input:'test',encoding:'utf8',env:{...process.env,CODEX_MCP_BINARY:cli,OPENAI_API_KEY:'synthetic-secret'}});
 assert.equal(result.status,1);
 const error=JSON.parse(result.stdout).errors[0];
 assert.match(error,/provider reports the selected model is not accessible/i);
 assert.doesNotMatch(error,/private-id|private-model|synthetic-secret/);
});
