import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerImage } from '../src/image.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mPQsooCAAFQAL/Rfn3VAAAAAElFTkSuQmCC', 'base64');

test('image generation sends the bearer key to the configured endpoint',async t=>{
 const api=createServer((req,res)=>{
  assert.equal(req.url,'/v1/images/generations');
  assert.equal(req.headers.authorization,'Bearer synthetic-key');
  res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));
 });
 await new Promise(r=>api.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>api.close(r)));
 const dir=await mkdtemp(join(tmpdir(),'image-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let handler;
 registerImage({registerTool(_name,_schema,fn){handler=fn;}},{env:{OPENAI_API_KEY:'synthetic-key',CODEX_MCP_BASE_URL:`http://127.0.0.1:${api.address().port}/v1/`},imagesDir:dir},x=>x,e=>{throw e;},()=>new AbortController().signal);
 const result=await handler({prompt:'test'},{});
 assert.deepEqual(await readFile(result.path),png);
});
