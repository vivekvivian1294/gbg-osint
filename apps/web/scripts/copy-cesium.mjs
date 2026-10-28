// Copies Cesium's runtime assets (workers, widgets, textures) into public/cesium.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkgPath = require.resolve('cesium/package.json');
const { version } = JSON.parse(await readFile(pkgPath, 'utf8'));
const source = join(dirname(pkgPath), 'Build', 'Cesium');
const target = fileURLToPath(new URL('../public/cesium/', import.meta.url));
const stamp = join(target, 'VERSION');

const current = await readFile(stamp, 'utf8').catch(() => '');
if (current !== version) {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const dir of ['Workers', 'ThirdParty', 'Assets', 'Widgets']) {
    await cp(join(source, dir), join(target, dir), { recursive: true });
  }
  await writeFile(stamp, version);
  console.log(`Copied Cesium ${version} assets to public/cesium`);
}
