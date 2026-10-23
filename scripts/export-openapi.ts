import { mkdir, writeFile } from 'node:fs/promises';
import { buildServer } from '../src/server.js';
const server = await buildServer();
await mkdir('contract', { recursive: true });
await writeFile('contract/openapi.json', `${JSON.stringify(server.swagger(), null, 2)}\n`);
await server.close();
console.log('Exported contract/openapi.json');
