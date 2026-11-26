const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

const electronDir = path.join(__dirname, '..', '..', 'packages', 'electron');
const electronScripts = path.join(electronDir, 'scripts');
const { Arch } = createRequire(path.join(electronDir, 'package.json'))('electron-builder');
const { setExecutableUuid } = require(path.join(electronScripts, 'macos-executable-uuid.cjs'));
const { readAsarFiles, findPackagedAppContentProblems } = require(path.join(electronScripts, 'packaged-app-contents.cjs'));

const readSplash = (stagingDir) => {
  const productFile = path.join(stagingDir, 'product.json');
  return fs.existsSync(productFile) ? JSON.parse(fs.readFileSync(productFile, 'utf8')).splashSvg : undefined;
};

const isProductFile = (file, splash) => file === 'product.json' || file.startsWith('product-plugins/') || (Boolean(splash) && file === splash);

const productContentProblems = (files, target, splash) => findPackagedAppContentProblems(
  files.filter((file) => !isProductFile(file.path, splash)),
  target,
);

const afterPack = (context) => {
  const { appInfo } = context.packager;
  const contentsPath = path.join(context.appOutDir, `${appInfo.productFilename}.app`, 'Contents');
  const resourcesPath = context.electronPlatformName === 'darwin'
    ? path.join(contentsPath, 'Resources')
    : path.join(context.appOutDir, 'resources');
  const asarPath = path.join(resourcesPath, 'app.asar');
  const problems = productContentProblems(
    readAsarFiles(asarPath),
    { platform: context.electronPlatformName, arch: Arch[context.arch] },
    readSplash(path.join(electronDir, '.product')),
  );
  if (problems.length > 0) throw new Error(`Packaged app contents check failed for ${asarPath}:\n- ${problems.join('\n- ')}`);
  if (context.electronPlatformName !== 'darwin') return;

  const executablePath = path.join(contentsPath, 'MacOS', appInfo.productFilename);
  setExecutableUuid(executablePath, appInfo.id);
  if (context.arch === Arch.arm64) {
    execFileSync('codesign', ['--force', '--sign', '-', executablePath], { stdio: 'inherit' });
  }
};

module.exports = afterPack;
module.exports.isProductFile = isProductFile;
module.exports.productContentProblems = productContentProblems;
