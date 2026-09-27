import { spawnSync } from 'node:child_process';
if (!process.env.HIVEMIND_TEST_SOURCE) {
  console.error(
    'Set HIVEMIND_TEST_SOURCE to an installed Hivemind checkout with the composable Bot contract. This check must not silently skip.',
  );
  process.exitCode = 1;
} else {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', 'test/core-bot-tools.test.ts'],
    { stdio: 'inherit' },
  );
  process.exitCode = result.status ?? 1;
}
