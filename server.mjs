import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, 'public');

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' || url.pathname !== '/download') {
    res.writeHead(404).end('Not found');
    return;
  }
  const name = url.searchParams.get('name');
  if (!name) {
    res.writeHead(400).end('Missing name');
    return;
  }
  try {
    const filename = path.resolve(publicRoot, name);
    const content = await readFile(filename);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(Number(process.env.PORT || 3000), '127.0.0.1');
}
