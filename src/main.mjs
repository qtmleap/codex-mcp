import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {loadConfig} from './config.mjs';
import {createMcp,startHttp} from './server.mjs';
import {redact} from './runner.mjs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

const argv=process.argv.slice(2);
const transport=argv[0]==='--transport'?argv[1]:'stdio';
if((argv.length&&!(argv.length===2&&argv[0]==='--transport'))||!['stdio','http'].includes(transport)){
 console.error('Usage: node src/main.mjs --transport stdio|http');process.exit(1);
}
const shutdown=new AbortController();let runtime;let closing=false;
async function close(){
 if(closing)return;closing=true;shutdown.abort();
 const force=setTimeout(()=>process.exit(1),5000);force.unref();
 await runtime?.close();clearTimeout(force);
}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
try{
 const env={...process.env};
 const keyFile=env.CODEX_MCP_ENV_FILE || join(homedir(),'.config/codex-mcp/env');
 const contents=await readFile(keyFile,'utf8').catch(error=>{
  if(error.code==='ENOENT')return '';
  throw error;
 });
 env.OPENAI_API_KEY=env.OPENAI_API_KEY||parseEnv(contents).OPENAI_API_KEY||'';
 for(const [key,value] of Object.entries(env)){
  if(key.startsWith('CODEX_MCP_'))env[key.replace('CODEX_MCP_','CLAUDE_MCP_')]=value;
 }
 env.CLAUDE_MCP_COMMAND??=fileURLToPath(new URL('./codex-cli.mjs',import.meta.url));
 env.CLAUDE_MCP_JOB_DIR??=join(homedir(),'.local/state/codex-mcp/jobs');
 env.CLAUDE_MCP_PERMISSION_MODE??='default';
 env.CLAUDE_MCP_MODELS??='gpt-5.4';
 env.PORT??='8879';
 const config=loadConfig(env);
 config.codex=!process.env.CLAUDE_MCP_COMMAND;
 config.imagesDir=env.CODEX_MCP_IMAGES_DIR||join(homedir(),'.local/share/codex-mcp/images');
 if(transport==='stdio'){
  config.stateDir=join(config.stateDir,'stdio',randomUUID());
  runtime=createMcp(config,shutdown.signal);await runtime.connect(new StdioServerTransport());
  process.stdin.on('end',()=>void close());
 }else{
  runtime=await startHttp(config,shutdown.signal);console.error(`codex-mcp listening on ${config.host}:${runtime.port}/mcp`);
 }
}catch(error){console.error(redact(error.message));await close();process.exitCode=1;}
