import { buildServer } from './server.js';

const server = await buildServer();
try {
  const address = await server.listen({ port: Number(process.env.PORT ?? 3001), host: process.env.HOST ?? '127.0.0.1' });
  console.log(`ထွယ်ဂျီဂွမ်Caculator API listening at ${address}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'API startup failed');
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { await server.close(); process.exit(0); });
