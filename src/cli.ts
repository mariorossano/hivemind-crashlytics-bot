import { main } from './runtime.ts';
main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : 'CrashlyticsBot failed');
  process.exitCode = 1;
});
