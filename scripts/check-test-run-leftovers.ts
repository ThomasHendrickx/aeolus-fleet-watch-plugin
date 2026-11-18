/**
 * CI check: a test job leaves no container and no volume behind, also when a
 * test failed or the job was interrupted. It runs after the job, on a runner
 * that had neither before it, so each one it finds is the job's. A run's
 * sweeper removes the containers only after the run's process ended, so the
 * check waits for it.
 *
 * Usage: node scripts/check-test-run-leftovers.ts
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { getContainerRuntimeClient } from 'testcontainers';

/** The label core's test setup puts on every container of a test run, its value the run. */
export const TEST_RUN_LABEL = 'aeolus-fleet.test-run';

/** How long the check waits for a sweeper to finish. */
const SWEEP_WAIT_MS = 30_000;

/** The part of the container runtime the check reads. */
export interface ContainerRuntime {
  /** Every container, running or not, that carries the label. */
  containers(label: string): Promise<{ id: string; image: string; state: string; run: string }[]>;
  /** The names of the volumes no container uses. */
  danglingVolumes(): Promise<string[]>;
}

/** What the test runs left on this machine: every container a run started, and every volume no container uses. */
export async function testRunLeftovers(runtime: ContainerRuntime): Promise<string[]> {
  const containers = await runtime.containers(TEST_RUN_LABEL);
  const volumes = await runtime.danglingVolumes();
  return [
    ...containers.map((c) => `container ${c.id} (${c.image}, ${c.state}) of test run ${c.run}`),
    ...volumes.map((name) => `volume ${name}, used by no container`),
  ];
}

async function dockerRuntime(): Promise<ContainerRuntime> {
  const { dockerode } = (await getContainerRuntimeClient()).container;
  return {
    containers: async (label) =>
      (await dockerode.listContainers({ all: true, filters: { label: [label] } })).map((c) => ({
        id: c.Id,
        image: c.Image,
        state: c.State,
        run: c.Labels[label] ?? '',
      })),
    danglingVolumes: async () =>
      (await dockerode.listVolumes({ filters: { dangling: ['true'] } })).Volumes.map((v) => v.Name),
  };
}

if (import.meta.main) {
  const runtime = await dockerRuntime();
  const deadline = Date.now() + SWEEP_WAIT_MS;
  let leftovers = await testRunLeftovers(runtime);
  while (leftovers.length > 0 && Date.now() < deadline) {
    await sleep(1_000);
    leftovers = await testRunLeftovers(runtime);
  }
  if (leftovers.length === 0) {
    console.log('The test run left no container and no volume behind.');
  } else {
    console.error(`The test run left ${String(leftovers.length)} behind:`);
    for (const leftover of leftovers) {
      console.error(`- ${leftover}`);
    }
    process.exitCode = 1;
  }
}
