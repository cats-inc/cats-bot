/** Identity-fenced candidate status/screenshot/stop operations. No stored PID is ever killed. */
import { open, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async filename => JSON.parse(await readFile(filename, 'utf8'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function writeJson(filename, value) { const tmp = filename + '.tmp'; await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(tmp, filename); }
export async function readCandidateControl(root) {
  const [launch, control] = await Promise.all([
    readJson(path.join(root, 'launch.json')), readJson(path.join(root, 'control.json')),
  ]);
  if (control.schemaVersion !== 1 || control.root !== root || control.launchId !== launch.launchId
    || !/^[a-f0-9]{32}$/u.test(control.instanceId)
    || !/^[a-f0-9]{64}$/u.test(control.token) || sha256(control.token) !== launch.launchId
    || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u.test(control.url)
    || new URL(control.url).port > 65535 || !Number.isSafeInteger(control.pid) || control.pid < 1) {
    throw new Error('Candidate control receipt does not match this launch.');
  }
  return { launch, control };
}

async function request(control, route, method = 'GET', body) {
  let response;
  try {
    response = await fetch(`${control.url}/${route}`, { method, redirect: 'error',
      headers: { Authorization: `Bearer ${control.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(route === 'input' ? 20_000 : 10_000) });
  } catch (error) {
    if (route === 'input') throw new Error('Candidate input outcome unconfirmed; inspect a new screenshot before deciding whether to retry.');
    throw error;
  }
  if (!response.ok) throw new Error(route === 'input'
    ? `Candidate input outcome unconfirmed (${response.status}); inspect a new screenshot before deciding whether to retry.`
    : `Candidate ${route} failed (${response.status}).`);
  return response;
}

export async function liveStatus(control) {
  const status = await (await request(control, 'status')).json();
  if (status.root !== control.root || status.launchId !== control.launchId || status.pid !== control.pid
    || status.instanceId !== control.instanceId) {
    throw new Error('Candidate response identity mismatch.');
  }
  return status;
}

async function exitReceipt(root, control) {
  try {
    const receipt = await readJson(path.join(root, `exit-${control.instanceId}.json`));
    if (receipt.launchId !== control.launchId || receipt.root !== root || receipt.pid !== control.pid
      || receipt.instanceId !== control.instanceId) throw new Error('Candidate exit identity mismatch.');
    return receipt;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function operateCandidate(command, directory, actionFile) {
  if (command === 'evidence') {
    const status = await operateCandidate('status', directory);
    if (!['running', 'drained'].includes(status.state)) throw new Error('Candidate build is unavailable.');
    const receipt = { root: status.root, launchId: status.launchId, instanceId: status.instanceId };
    const filename = path.join(status.root, 'candidate-evidence.json');
    await writeJson(filename, receipt);
    return { ...receipt, filename, purpose: 'Attach to the owning Work task; source/revision verification occurs at attachment.' };
  }
  if (!['status', 'screenshot', 'input', 'stop'].includes(command)) throw new Error('Invalid candidate operation.');
  const root = await realpath(directory);
  const { launch, control } = await readCandidateControl(root);
  const exited = await exitReceipt(root, control);
  if (exited) {
    if (command === 'screenshot' || command === 'input') throw new Error('Candidate has stopped.');
    return { state: exited.exitCode === 0 ? 'drained' : 'failed', launch, ...exited };
  }
  try {
    const status = await liveStatus(control); // Reconcile identity before any action.
    if (command === 'status') return { state: 'running', launch, ...status };
    if (command === 'input') {
      if (!actionFile) throw new Error('input requires an action JSON file.');
      const file = await open(actionFile, 'r');
      let action;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 32 * 1024) throw new Error('Action must be a JSON file of at most 32 KiB.');
        const { buffer, bytesRead } = await file.read({ buffer: Buffer.alloc(32 * 1024 + 1) });
        if (bytesRead > 32 * 1024) throw new Error('Action file is too large.');
        try { action = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); }
        catch { throw new Error('Invalid action JSON.'); } // JSON errors can contain private input text.
      } finally { await file.close(); }
      if (!action || action.instanceId !== control.instanceId || !/^[a-f0-9]{32}$/u.test(action.frameId)) {
        throw new Error('Action must include this candidate instanceId and a fresh screenshot frameId.');
      }
      const result = await (await request(control, 'input', 'POST', action)).json();
      if (result.instanceId !== control.instanceId || result.launchId !== control.launchId || result.input !== 'applied') {
        throw new Error('Candidate input response identity mismatch.');
      }
      return { ...result, next: 'Take a new screenshot and inspect the result before another action.' };
    }
    if (command === 'screenshot') {
      const response = await request(control, 'screenshot', 'POST');
      const frameId = response.headers.get('x-cats-frame-id');
      const width = Number(response.headers.get('x-cats-image-width'));
      const height = Number(response.headers.get('x-cats-image-height'));
      if (frameId && (!/^[a-f0-9]{32}$/u.test(frameId)
        || response.headers.get('x-cats-instance-id') !== control.instanceId
        || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)) {
        throw new Error('Candidate screenshot identity or dimensions mismatch.');
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const filename = path.join(root, `screenshot-${Date.now()}.png`);
      await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
      return { filename, launchId: launch.launchId, ...status, ...(frameId ? { frameId, width, height } : {}) };
    }
    await request(control, 'stop', 'POST');
  } catch (error) {
    // The window may have closed between the file read and the HTTP response.
    const receipt = await exitReceipt(root, control);
    if (!receipt || command === 'screenshot' || command === 'input') throw error;
    return { state: receipt.exitCode === 0 ? 'drained' : 'failed', ...receipt };
  }
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const receipt = await exitReceipt(root, control);
    if (receipt) return { state: receipt.exitCode === 0 ? 'drained' : 'failed', ...receipt };
    await pause(250);
  }
  throw new Error('Shutdown is not confirmed. Inspect candidate logs; no stored PID was killed.');
}
