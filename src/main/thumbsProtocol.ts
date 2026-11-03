import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';

const THUMBNAIL_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/i;

/** Must run before app.ready. The renderer loads thumbnails from this scheme. */
export function registerThumbScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'dance-thumb',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** Serves only JPEG files that the indexer wrote into the thumbnail directory. */
export function handleThumbProtocol(thumbsDir: string): void {
  protocol.handle('dance-thumb', (request) => {
    let name = '';
    try {
      name = path.posix.basename(new URL(request.url).pathname);
    } catch {
      return new Response('Bad thumbnail URL', { status: 400 });
    }
    if (!THUMBNAIL_NAME.test(name)) return new Response('Not found', { status: 404 });
    const filePath = path.join(thumbsDir, name);
    const relative = path.relative(thumbsDir, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).href);
  });
}
