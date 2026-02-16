const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Create a temporary package.json for hardhat compilation
const tempDir = path.join(__dirname, '.hardhat-temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Copy necessary files
fs.writeFileSync(
  path.join(tempDir, 'package.json'),
  JSON.stringify({
    name: 'hardhat-temp',
    version: '1.0.0',
    private: true,
    type: 'module',
  }, null, 2)
);

fs.writeFileSync(
  path.join(tempDir, 'hardhat.config.mjs'),
  `import "@nomicfoundation/hardhat-toolbox";

export default {
  solidity: {
    version: "0.8.27",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  paths: {
    sources: "${path.join(__dirname, 'contracts').replace(/\\/g, '/')}",
    artifacts: "${path.join(tempDir, 'artifacts').replace(/\\/g, '/')}",
  },
};`
);

// Copy contracts
if (!fs.existsSync(path.join(tempDir, 'contracts'))) {
  fs.mkdirSync(path.join(tempDir, 'contracts'), { recursive: true });
}
fs.copyFileSync(
  path.join(__dirname, 'contracts', 'Token.sol'),
  path.join(tempDir, 'contracts', 'Token.sol')
);

// Install dependencies in temp dir
console.log('Installing Hardhat in temp directory...');
process.chdir(tempDir);
execSync('npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox @openzeppelin/contracts', { stdio: 'inherit' });

// Compile
console.log('Compiling contract...');
execSync('npx hardhat compile', { stdio: 'inherit' });

// Read the artifact
const artifactPath = path.join(tempDir, 'artifacts', 'contracts', 'Token.sol', 'Token.json');
const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

// Extract bytecode
const bytecode = artifact.bytecode;

// Save bytecode to file
const outputPath = path.join(__dirname, 'contracts', 'Token.bytecode.txt');
fs.writeFileSync(outputPath, bytecode);

console.log('\n✅ Compilation successful!');
console.log(`📄 Bytecode saved to: ${outputPath}`);
console.log(`\n📋 Bytecode (copy this):\n${bytecode}`);

