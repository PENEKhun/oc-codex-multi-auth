/** Fixed Node bootstrap shared by source tests and the compiled package. */
export const ROTATION_WORKER_SOURCE = String.raw`
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
setInterval(() => {}, 1000);
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 1048576) process.exit(1);
}
try {
  const { module, context } = JSON.parse(input);
  const policy = await import(pathToFileURL(module).href);
  if (typeof policy.select !== 'function') process.exit(1);
  const id = await policy.select(context);
  if (id !== null && (typeof id !== 'string' || id.length > 256)) process.exit(1);
  await Promise.all([
    new Promise((resolve) => process.stdout.write('', resolve)),
    new Promise((resolve) => process.stderr.write('', resolve)),
  ]);
  writeSync(3, JSON.stringify({ accountId: id }));
  process.exit(0);
} catch {
  process.exit(1);
}
`;
