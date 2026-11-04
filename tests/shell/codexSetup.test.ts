import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { codexSetupInvocation, probeCodexInitialization } from '../../src/shell/electron/codexSetup.ts';

const source = `
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const spec=JSON.parse(process.env.FAKE_CODEX_SPEC), log=process.env.FAKE_CODEX_LOG;
if(spec.descendant){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(log+'.child',String(child.pid));}
const lines=createInterface({ input:process.stdin });
lines.on('line',line=>{
 const frame=JSON.parse(line); appendFileSync(log,JSON.stringify(frame)+'\\n');
 if(!frame.id)return;
 if(spec.overflow){process.stdout.write('x'.repeat(2*1024*1024));return;}
 if(spec.hang)return;
 if(spec.exit){process.exit(1);return;}
 let result=frame.method==='initialize'?{}:frame.method==='windowsSandbox/readiness'?{status:spec.readiness}:
  {thread:{id:'private-test-thread'},sandbox:{type:spec.sandbox??'workspaceWrite'},approvalPolicy:'never'};
 const reply=JSON.stringify(spec.unsupported?{id:frame.id,error:{code:-32601}}:{id:frame.id,result});
 process.stdout.write(JSON.stringify({method:'thread/started',params:{}})+'\\n'+JSON.stringify({id:999,result:{status:'ready'}})+'\\n');
 process.stdout.write(reply.slice(0,9));setTimeout(()=>process.stdout.write(reply.slice(9)+'\\n'),2);
});
process.stdin.on('end',()=>process.exit(0));
`;

async function probe(spec: object, signal?: AbortSignal, afterSpawn?: () => void) {
  const root=mkdtempSync(join(tmpdir(),'cats-codex-readiness-test-'));
  const script=join(root,'server.mjs'),log=join(root,'requests.jsonl');
  writeFileSync(script,source); writeFileSync(log,'');
  let closed=false;
  const launch=((command: string,args: string[],options: object)=>{
    const child=spawn(command,args,options); child.once('close',()=>{closed=true;}); child.once('spawn',()=>afterSpawn?.()); return child;
  }) as typeof spawn;
  try {
    const result=await probeCodexInitialization(undefined,signal,{cwd:root,launch,timeoutMs:1000,
      invocation:{command:process.execPath,args:[script],env:{...process.env,FAKE_CODEX_SPEC:JSON.stringify(spec),FAKE_CODEX_LOG:log}}});
    const frames=readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
    assert.equal(closed,true,'probe reaps its owned process before returning');
    if(existsSync(log+'.child')) assert.throws(()=>process.kill(Number(readFileSync(log+'.child','utf8')),0),'owned descendant is also reaped');
    assert.ok(frames.every(frame=>['initialize','initialized','windowsSandbox/readiness'].includes(frame.method)));
    return {result,frames};
  } finally {
    try { assert.equal(closed,true,'cancellation also waits for the owned child to close'); }
    finally {rmSync(root,{recursive:true,force:true});}
  }
}

test('ready sandbox passes fragmented replies and notifications without creating a Codex thread',async()=>{
  const {result,frames}=await probe({readiness:'ready'});
  assert.equal(result.status,'ready');
  assert.deepEqual(frames.map(frame=>frame.method),['initialize','initialized','windowsSandbox/readiness']);
});

for(const readiness of ['notConfigured','updateRequired']) test(`${readiness} still needs official initialization without starting a thread`,async()=>{
  const {result,frames}=await probe({readiness}); assert.equal(result.status,'required');
  assert.ok(!frames.some(frame=>frame.method==='thread/start'));
});

for(const spec of [{readiness:'unknown'},{unsupported:true},{exit:true},{hang:true},{overflow:true},{readiness:'ready',descendant:true}]) {
  test(`unknown, unsupported, exit and timeout cannot look ready: ${JSON.stringify(spec)}`,async()=>{
    assert.equal((await probe(spec)).result.status,'readiness' in spec && spec.readiness==='ready'?'ready':'unavailable');
  });
}

test('an aborted probe rejects and a missing CLI invocation cannot start anything',async()=>{
  const controller=new AbortController(); controller.abort();
  await assert.rejects(probeCodexInitialization(undefined,controller.signal),{name:'AbortError'});
  assert.deepEqual(await probeCodexInitialization(undefined),{status:'unavailable'});
});

test('cancelling an in-progress check reaps the child before rejecting',async()=>{
  const controller=new AbortController();
  await assert.rejects(probe({hang:true},controller.signal,()=>controller.abort()),{name:'AbortError'});
});

function put(file: string, contents: string | Buffer) { mkdirSync(dirname(file),{recursive:true});writeFileSync(file,contents); }
function nodeHeader(arch: 'x64' | 'arm64'): Buffer {
  const bytes=Buffer.alloc(80);bytes.writeUInt16LE(0x5a4d);bytes.writeUInt32LE(64,60);bytes.writeUInt32LE(0x4550,64);bytes.writeUInt16LE(arch==='x64'?0x8664:0xaa64,68);return bytes;
}

for(const arch of ['x64','arm64'] as const) for(const extension of ['cmd','ps1'] as const) test(`official ${extension} shim uses its Node ${arch} architecture, independent of Electron`,()=>{
  const root=mkdtempSync(join(tmpdir(),'cats-codex-launcher-'));
  try {
    const packageRoot=join(root,'node_modules','@openai','codex'),shim=join(root,`codex.${extension}`);
    const vendor=join(root,'node_modules','@openai',`codex-win32-${arch}`,'vendor');
    const native=join(vendor,arch==='x64'?'x86_64-pc-windows-msvc':'aarch64-pc-windows-msvc','bin','codex.exe');
    put(join(packageRoot,'package.json'),JSON.stringify({name:'@openai/codex',bin:{codex:'bin/codex.js'}}));
    put(join(dirname(vendor),'package.json'),JSON.stringify({name:`@openai/codex-win32-${arch}`}));
    put(join(packageRoot,'bin','codex.js'),'// official launcher fixture');
    put(native,'');
    const node=extension==='cmd'?join(root,'node.exe'):join(root,'Node on PATH','node.exe');
    put(node,nodeHeader(arch));
    put(shim,extension==='cmd'?'"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*':'& "$basedir/node$exe" "$basedir/node_modules/@openai/codex/bin/codex.js" $args');
    const env={Path:dirname(node),CODEX_HOME:join(root,'private-profile')};
    const invocation=codexSetupInvocation(shim,env)!;
    // require.resolve canonicalizes macOS /var -> /private/var; compare the actual file.
    assert.equal(realpathSync(invocation.command),realpathSync(native));assert.deepEqual(invocation.args,['app-server']);
    assert.equal(invocation.env.CODEX_HOME,env.CODEX_HOME);
    assert.equal(invocation.env.CODEX_MANAGED_PACKAGE_ROOT,packageRoot);
    put(node,'not a PE executable');assert.equal(codexSetupInvocation(shim,env),null);
    put(node,nodeHeader(arch));put(shim,'echo node_modules/@openai/codex/bin/codex.js');assert.equal(codexSetupInvocation(shim,env),null);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('standalone Codex exe stays the exact resolved executable and environment',()=>{
  const env={CODEX_HOME:'selected-profile'};
  assert.deepEqual(codexSetupInvocation('C:\\Codex\\codex.exe',env),{command:'C:\\Codex\\codex.exe',args:['app-server'],env});
});
