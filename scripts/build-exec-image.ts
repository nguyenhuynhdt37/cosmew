/**
 * Host setup (ADR 0034): build the optional git-enabled command image from the pinned base and the
 * exact Debian package in the dependency catalog. This is the only step that uses the network; the
 * command runtime never builds or pulls. The runtime accepts the result only after verifying its
 * layer chain extends the pinned base by exactly one layer and carries the recipe hash.
 */
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {GIT_IMAGE_RECIPE, GIT_IMAGE_RECIPE_HASH, GIT_IMAGE_TAG, EXECUTION_IMAGE} from '../packages/tools/src/index';
const docker = ['/opt/homebrew/bin/docker', '/usr/bin/docker', '/usr/local/bin/docker'].find(existsSync);
if (!docker) { console.error('docker CLI not found'); process.exit(2); }
const run = (args: string[], input?: string) => spawnSync(docker, args, { input, stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'], encoding: 'utf8' });
if (run(['image', 'inspect', EXECUTION_IMAGE], undefined).status !== 0) { console.error(`Pull the pinned base first: docker pull ${EXECUTION_IMAGE}`); process.exit(2); }
const built = run(['build', '--pull=false', '--label', `futryn.exec.recipe=${GIT_IMAGE_RECIPE_HASH}`, '-t', GIT_IMAGE_TAG, '-'], GIT_IMAGE_RECIPE);
if (built.status !== 0) process.exit(built.status ?? 1);
console.log(`Built ${GIT_IMAGE_TAG}`);
