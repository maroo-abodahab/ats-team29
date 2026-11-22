// Builds dist/<service>.zip: exactly the code one Lambda function runs.
//   node scripts/build-lambda.js jobs-service      (or: cd services/jobs-service && npm run zip)
//
// Included:  src/, package.json, node_modules (with @ats/shared copied in)
// Excluded:  .env files (secrets), tests, and the AWS SDK (already built into the
//            Lambda Node.js runtime, so leaving it out keeps the zip small)
// Based on the Lab 7 zip script: writes a standard .zip with no extra tools.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const service = process.argv[2];
const root = path.join(__dirname, '..', 'services', service || '');
if (!service || !fs.existsSync(path.join(root, 'package.json'))) {
  console.error('Usage: node scripts/build-lambda.js <jobs-service|candidates-service|pipeline-service|notifier>');
  process.exit(1);
}
if (!fs.existsSync(path.join(root, 'node_modules', '@ats', 'shared'))) {
  console.error(`Run "npm install" in services/${service} first.`);
  process.exit(1);
}

const SKIP_DIRS = new Set(['.bin', '@aws-sdk', '@smithy', '@aws-crypto', '@aws', 'test', 'tests', '.cache']);
const SKIP_FILES = /(^\.env($|\.)|\.md$|\.map$|\.ts$|^\.package-lock\.json$|^LICENSE|\.zip$)/i;

const files = [];
function collect(p) {
  const stat = fs.statSync(p);
  const name = path.basename(p);
  if (stat.isDirectory()) {
    if (SKIP_DIRS.has(name)) return;
    for (const child of fs.readdirSync(p).sort()) collect(path.join(p, child));
  } else if (stat.isFile() && !SKIP_FILES.test(name)) {
    files.push(p);
  }
}
['src', 'package.json', 'node_modules'].forEach((n) => fs.existsSync(path.join(root, n)) && collect(path.join(root, n)));

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const parts = [];
const central = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(path.relative(root, file).split(path.sep).join('/'));
  const data = fs.readFileSync(file);
  const packed = zlib.deflateRawSync(data);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8); local.writeUInt16LE(0x5021, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  parts.push(local, name, packed);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(0x5021, 14);
  entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
  central.push(entry, name);
  offset += local.length + name.length + packed.length;
}
const centralSize = central.reduce((s, b) => s + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);

const outDir = path.join(__dirname, '..', 'dist');
fs.mkdirSync(outDir, { recursive: true });
const output = path.join(outDir, `${service}.zip`);
fs.writeFileSync(output, Buffer.concat([...parts, ...central, end]));
const mb = (fs.statSync(output).size / 1024 / 1024).toFixed(2);
console.log(`dist/${service}.zip  ${files.length} files, ${mb} MB  (no .env, no AWS SDK)`);
