import { describe, expect, it } from 'vitest';

import { TEST_RUN_LABEL, testRunLeftovers, type ContainerRuntime } from './check-test-run-leftovers.ts';

type Containers = Awaited<ReturnType<ContainerRuntime['containers']>>;

function runtime(found: { containers?: Containers; volumes?: string[] }): ContainerRuntime & { filters: unknown[] } {
  const filters: unknown[] = [];
  return {
    filters,
    containers: (filter) => {
      filters.push(filter);
      return Promise.resolve(found.containers ?? []);
    },
    danglingVolumes: () => Promise.resolve(found.volumes ?? []),
  };
}

describe('the test run leftovers check', () => {
  it('finds nothing when no container and no volume is left', async () => {
    expect(await testRunLeftovers(runtime({}))).toEqual([]);
  });

  it('asks only for the containers a test run labelled', async () => {
    const containers = runtime({});

    await testRunLeftovers(containers);

    expect(containers.filters).toEqual([TEST_RUN_LABEL]);
  });

  it('names a container of a run, running or not', async () => {
    const leftovers = await testRunLeftovers(
      runtime({ containers: [{ id: 'abc', image: 'postgres:18', state: 'exited', run: 'run-1' }] }),
    );

    expect(leftovers).toEqual(['container abc (postgres:18, exited) of test run run-1']);
  });

  it('names a volume no container uses', async () => {
    expect(await testRunLeftovers(runtime({ volumes: ['data'] }))).toEqual(['volume data, used by no container']);
  });
});
