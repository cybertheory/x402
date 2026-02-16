const solc = require('solc');
const fs = require('fs');
const path = require('path');

// Function to recursively read all Solidity files from a directory
function readSolidityFiles(dir, basePath = '') {
  const files = {};
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.join(basePath, entry.name).replace(/\\/g, '/');
    
    if (entry.isDirectory()) {
      Object.assign(files, readSolidityFiles(fullPath, relativePath));
    } else if (entry.name.endsWith('.sol')) {
      files[relativePath] = {
        content: fs.readFileSync(fullPath, 'utf8'),
      };
    }
  }
  
  return files;
}

// Read the contract
const contractPath = path.join(__dirname, 'contracts', 'Token.sol');
const contractSource = fs.readFileSync(contractPath, 'utf8');

// Read OpenZeppelin contracts
const openzeppelinPath = path.join(__dirname, 'node_modules', '@openzeppelin', 'contracts');
const openzeppelinFiles = readSolidityFiles(openzeppelinPath, '@openzeppelin/contracts');

// Prepare input for solc
const input = {
  language: 'Solidity',
  sources: {
    'Token.sol': {
      content: contractSource,
    },
    ...openzeppelinFiles,
  },
  settings: {
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode'],
      },
    },
    optimizer: {
      enabled: true,
      runs: 200,
    },
  },
};

// Compile
console.log('Compiling contract...');
const output = JSON.parse(solc.compile(JSON.stringify(input)));

// Check for errors
if (output.errors) {
  const errors = output.errors.filter(e => e.severity === 'error');
  if (errors.length > 0) {
    console.error('Compilation errors:');
    errors.forEach(error => console.error(error.formattedMessage));
    process.exit(1);
  }
}

// Extract bytecode
const contract = output.contracts['Token.sol']['Token'];
const bytecode = contract.evm.bytecode.object;

// Save bytecode to file
const outputPath = path.join(__dirname, 'contracts', 'Token.bytecode.txt');
fs.writeFileSync(outputPath, bytecode);

console.log('\n✅ Compilation successful!');
console.log(`📄 Bytecode saved to: ${outputPath}`);
console.log(`\n📋 Bytecode (copy this for ERC20_CONTRACT_BYTECODE):\n${bytecode}`);

// Also save ABI for reference
const abiPath = path.join(__dirname, 'contracts', 'Token.abi.json');
fs.writeFileSync(abiPath, JSON.stringify(contract.abi, null, 2));
console.log(`\n📄 ABI saved to: ${abiPath}`);

