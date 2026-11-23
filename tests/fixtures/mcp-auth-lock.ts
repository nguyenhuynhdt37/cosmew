import {FileMcpAuthStore} from '@cosmew/persistence';
const directory = process.argv[2]!;
const endpoint = 'https://good.example/mcp';
const store = new FileMcpAuthStore(directory, {
  get: async () => undefined,
  delete: async () => {},
  set: async () => {
    process.stdout.write('vault-write-locked\n');
    await new Promise(() => {
      setInterval(() => {}, 1000);
    });
  },
});
const record = await store.read(endpoint);
await store.write(endpoint, {...(record as object), endpoint, bearer: 'fixture-secret'});
