// Sirve la consola web compilada (apps/web/dist) como lo hará el despliegue:
// archivos estáticos + `config.json` del ambiente + proxies del MISMO ORIGEN
// `/graphql` → graphql-api y `/auth/cognito` → Cognito (Floci). El navegador
// nunca conoce URLs internas ni credenciales.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Compila apps/web con Vite (build de producción, el mismo artefacto que se despliega). */
export function buildWebConsole(webDir: string): string {
  const result = spawnSync(
    process.execPath,
    [join(webDir, 'node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'warn'],
    {
      cwd: webDir,
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(`vite build falló:\n${result.stdout}\n${result.stderr}`);
  }
  return join(webDir, 'dist');
}

export interface WebConsoleOptions {
  readonly distDir: string;
  readonly port: number;
  readonly runtimeConfig: Record<string, unknown>;
  readonly graphqlTarget: string;
  readonly cognitoTarget: string;
}

const FORWARDED = ['content-type', 'authorization', 'x-correlation-id', 'x-amz-target'];

export class WebConsoleServer {
  private readonly server: Server;
  private readonly root: string;

  private readonly options: WebConsoleOptions;

  constructor(options: WebConsoleOptions) {
    this.options = options;
    this.root = resolve(options.distDir);
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        res.writeHead(502).end();
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((done, fail) => {
      this.server.once('error', fail);
      this.server.listen(this.options.port, '127.0.0.1', done);
    });
    return `http://127.0.0.1:${String(this.options.port)}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((done) =>
      this.server.close(() => {
        done();
      }),
    );
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/config.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(this.options.runtimeConfig));
      return;
    }
    if (path === '/graphql') {
      await this.proxy(req, res, `${this.options.graphqlTarget}/graphql`);
      return;
    }
    if (path === '/auth/cognito') {
      await this.proxy(req, res, `${this.options.cognitoTarget}/`);
      return;
    }
    await this.serveStatic(path, res);
  }

  private async proxy(req: IncomingMessage, res: ServerResponse, target: string): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const headers: Record<string, string> = {};
    for (const name of FORWARDED) {
      const value = req.headers[name];
      if (typeof value === 'string') {
        headers[name] = value;
      }
    }
    const upstream = await fetch(target, {
      method: req.method ?? 'GET',
      headers,
      ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
    });
    const responseHeaders: Record<string, string> = {};
    for (const name of ['content-type', 'x-correlation-id']) {
      const value = upstream.headers.get(name);
      if (value !== null) {
        responseHeaders[name] = value;
      }
    }
    res.writeHead(upstream.status, responseHeaders);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  }

  private async serveStatic(path: string, res: ServerResponse): Promise<void> {
    const relative = normalize(path === '/' ? '/index.html' : path).replace(/^([/\\])+/, '');
    const file = resolve(this.root, relative);
    if (file !== this.root && !file.startsWith(this.root + sep)) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  }
}
