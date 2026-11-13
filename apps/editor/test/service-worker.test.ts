import { describe, expect, it } from 'vitest';
import { serviceWorkerFiles, serviceWorkerSource } from '../serviceWorker';

/**
 * The worker is generated as text, so these tests run that text against stand-ins for the three
 * things it talks to: its own global, the cache storage and the network.
 */
const SCOPE = 'https://tandem.example/app/';
const at = (path: string): string => new URL(path, SCOPE).href;

type Answer = Response | null;
type Server = (url: string) => Answer;

interface FetchEvent {
  request: { url: string; method: string; mode: string; headers: Headers };
  respondWith(answer: Promise<Response>): void;
}

const html = (body = '<!doctype html><div id="root"></div>'): Response =>
  new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const file = (body: string, type: string): Response =>
  new Response(body, { headers: { 'content-type': type } });

function world(
  build: Parameters<typeof serviceWorkerSource>[0],
  server: Server,
  stored = new Map<string, Map<string, Response>>(),
) {
  const fetched: { url: string; cache: string }[] = [];
  const fetch = async (input: string | { url: string; cache?: string }): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.url;
    fetched.push({ url, cache: typeof input === 'string' ? 'default' : (input.cache ?? 'default') });
    const answer = server(url);
    if (!answer) throw new TypeError('Failed to fetch');
    return answer;
  };
  const urlOf = (key: string | { url: string }): string => (typeof key === 'string' ? key : key.url);
  const cache = (entries: Map<string, Response>) => ({
    match: async (key: string | { url: string }) => entries.get(urlOf(key))?.clone(),
    put: async (key: string | { url: string }, response: Response) => void entries.set(urlOf(key), response),
    add: async (key: string | { url: string }) => {
      const response = await fetch(key);
      if (!response.ok) throw new TypeError('bad response');
      entries.set(urlOf(key), response);
    },
  });
  const caches = {
    keys: async () => [...stored.keys()],
    open: async (name: string) => {
      if (!stored.has(name)) stored.set(name, new Map());
      return cache(stored.get(name)!);
    },
    delete: async (name: string) => stored.delete(name),
    match: async (key: string | { url: string }) => {
      for (const entries of stored.values()) {
        const hit = entries.get(urlOf(key));
        if (hit) return hit.clone();
      }
      return undefined;
    },
  };
  const listeners: Record<string, (event: never) => void> = {};
  const self = {
    registration: { scope: SCOPE },
    addEventListener: (type: string, listener: (event: never) => void) => void (listeners[type] = listener),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  new Function('self', 'caches', 'fetch', serviceWorkerSource(build))(self, caches, fetch);

  const lifecycle = async (type: 'install' | 'activate'): Promise<void> => {
    let done: Promise<unknown> = Promise.resolve();
    listeners[type]!({ waitUntil: (p: Promise<unknown>) => void (done = p) } as never);
    await done;
  };
  /** The worker's answer to a request, or `undefined` when it leaves the request to the browser. */
  const ask = async (
    path: string,
    init: { mode?: string; method?: string; range?: boolean } = {},
  ): Promise<Response | undefined> => {
    let answer: Promise<Response> | undefined;
    const event: FetchEvent = {
      request: {
        url: path.startsWith('http') ? path : at(path),
        method: init.method ?? 'GET',
        mode: init.mode ?? 'cors',
        headers: new Headers(init.range ? { range: 'bytes=0-' } : {}),
      },
      respondWith: (p) => void (answer = p),
    };
    listeners.fetch!(event as never);
    const response = await answer;
    // What the worker keeps, it keeps without making the page wait for it.
    await new Promise((resolve) => setTimeout(resolve));
    return response;
  };
  const kept = (name: string): string[] =>
    [...(stored.get(name)?.keys() ?? [])].map((url) => url.slice(SCOPE.length)).sort();
  return {
    fetched,
    stored,
    lifecycle,
    ask,
    kept,
    navigate: (path: string) => ask(path, { mode: 'navigate' }),
  };
}

const BUILD = {
  version: 'one',
  precache: ['assets/Editor-aaa.js', 'assets/index-bbb.css', 'assets/index-ccc.js'],
  onUse: ['assets/inter-ddd.woff2', 'assets/pacifico-eee.woff2'],
};
const site: Server = (url) => {
  const path = url.slice(SCOPE.length).split('?')[0]!;
  if (path === '' || path === 'index.html' || !path.split('/').pop()!.includes('.')) return html();
  if (path === 'favicon.svg') return file('<svg/>', 'image/svg+xml');
  if (path.endsWith('.js')) return file(`// ${path}`, 'text/javascript');
  if (path.endsWith('.css')) return file(`/* ${path} */`, 'text/css');
  if (path.endsWith('.woff2')) return file(path, 'font/woff2');
  return new Response('{"error":"not found"}', {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
};
const offline: Server = () => null;

describe('the files of a build', () => {
  it('are sorted into what is fetched at install and what is kept on first use', () => {
    const files = serviceWorkerFiles([
      'index.html',
      'sw.js',
      'assets/index-ccc.js',
      'assets/index-ccc.js.map',
      'assets/inter-ddd.woff2',
      'assets/index-bbb.css',
      'favicon.svg',
    ]);
    expect(files).toEqual({
      precache: ['assets/index-bbb.css', 'assets/index-ccc.js'],
      onUse: ['assets/inter-ddd.woff2'],
    });
  });

  it('survive a `$` in a name', () => {
    const source = serviceWorkerSource({
      version: 'v',
      precache: ['assets/a$&b.js'],
      onUse: ["assets/c$'d.woff2"],
    });
    expect(source).toContain('const PRECACHE = ["assets/a$&b.js"];');
    expect(source).toContain(`const ON_USE = ["assets/c$'d.woff2"];`);
  });
});

describe('installing the worker', () => {
  it('asks the server for the page afresh, and for code and styles the way the page did', async () => {
    const w = world(BUILD, site);
    await w.lifecycle('install');
    expect(w.fetched).toEqual(
      expect.arrayContaining([
        { url: SCOPE, cache: 'reload' },
        ...BUILD.precache.map((path) => ({ url: at(path), cache: 'default' })),
      ]),
    );
    expect(w.fetched).toHaveLength(4);
    expect(w.kept('tandem-one')).toEqual(['', ...BUILD.precache]);
  });

  it('takes over what the version before it holds and fetches only what changed', async () => {
    const first = world(BUILD, site);
    await first.lifecycle('install');
    await first.ask('assets/inter-ddd.woff2');
    expect(first.kept('tandem-one')).toContain('assets/inter-ddd.woff2');

    const next = {
      version: 'two',
      precache: ['assets/Editor-aaa.js', 'assets/index-NEW.css', 'assets/index-ccc.js'],
      onUse: BUILD.onUse,
    };
    const second = world(next, site, first.stored);
    await second.lifecycle('install');
    expect(second.fetched.map((f) => f.url).sort()).toEqual([SCOPE, at('assets/index-NEW.css')]);
    expect(second.kept('tandem-two')).toEqual([
      '',
      'assets/Editor-aaa.js',
      'assets/index-NEW.css',
      'assets/index-ccc.js',
      'assets/inter-ddd.woff2',
    ]);

    first.stored.set('somebody-elses', new Map());
    await second.lifecycle('activate');
    expect([...second.stored.keys()].sort()).toEqual(['somebody-elses', 'tandem-two']);
  });

  it('fails, and so leaves the worker before it in charge, when a file is missing or the page is not the page', async () => {
    const missing = world(BUILD, (url) =>
      url.endsWith('index-ccc.js') ? new Response('', { status: 404 }) : site(url),
    );
    await expect(missing.lifecycle('install')).rejects.toThrow();
    const portal = world(BUILD, (url) =>
      url === SCOPE ? file('{"login":"please"}', 'application/json') : site(url),
    );
    await expect(portal.lifecycle('install')).rejects.toThrow('the editor page could not be fetched');
    expect(portal.kept('tandem-one')).not.toContain('');
  });
});

describe('opening a page', () => {
  it('answers the editor’s page from the network and keeps it for when there is none', async () => {
    const w = world(BUILD, site);
    const online = await w.navigate('?from=link');
    expect(await online!.text()).toContain('id="root"');
    expect(w.kept('tandem-one')).toEqual(['']);

    const gone = world(BUILD, offline, w.stored);
    for (const path of ['', 'index.html', '?x=1', 'some/client/route', 'folder/']) {
      const answer = await gone.navigate(path);
      expect(await answer!.text(), path).toContain('id="root"');
    }
  });

  it('never keeps anything but the page as the page', async () => {
    const w = world(BUILD, site);
    await w.lifecycle('install');
    const before = await w.stored.get('tandem-one')!.get(SCOPE)!.clone().text();

    // A link to a file of the build, to the API of a server that hosts the editor at its root, or
    // to a path that names no file: none of them is the page, whatever comes back.
    for (const path of [
      'favicon.svg',
      'assets/index-ccc.js',
      'samples/dusk.mp4',
      'api/projects/abc123/media/def456',
      'ws/abc123/project',
    ]) {
      expect(await w.navigate(path), path).toBeUndefined();
    }
    await w.navigate('some/client/route');
    expect(await w.stored.get('tandem-one')!.get(SCOPE)!.clone().text()).toBe(before);
    expect(w.kept('tandem-one')).toEqual(['', ...BUILD.precache]);
  });

  it('does not keep an answer for the page that is an error or not a page', async () => {
    const down = world(
      BUILD,
      () => new Response('<h1>Bad gateway</h1>', { status: 502, headers: { 'content-type': 'text/html' } }),
    );
    expect((await down.navigate(''))!.status).toBe(502);
    expect(down.kept('tandem-one')).toEqual([]);
    const odd = world(BUILD, () => file('{}', 'application/json'));
    await odd.navigate('');
    expect(odd.kept('tandem-one')).toEqual([]);
  });

  it('is a network error offline when no page was ever kept', async () => {
    const w = world(BUILD, offline);
    expect((await w.navigate(''))!.type).toBe('error');
  });
});

describe('files under assets/', () => {
  it('come from the cache when they are there and are kept when they were fetched', async () => {
    const w = world(BUILD, site);
    await w.lifecycle('install');
    w.fetched.length = 0;
    expect(await (await w.ask('assets/index-ccc.js'))!.text()).toBe('// assets/index-ccc.js');
    expect(w.fetched).toEqual([]);

    expect(await (await w.ask('assets/pacifico-eee.woff2'))!.text()).toBe('assets/pacifico-eee.woff2');
    expect(w.fetched.map((f) => f.url)).toEqual([at('assets/pacifico-eee.woff2')]);
    expect(w.kept('tandem-one')).toContain('assets/pacifico-eee.woff2');

    const gone = world(BUILD, offline, w.stored);
    expect(await (await gone.ask('assets/pacifico-eee.woff2'))!.text()).toBe('assets/pacifico-eee.woff2');
  });

  it('are not kept when the server did not have them', async () => {
    const w = world(BUILD, site);
    expect((await w.ask('assets/gone-fff.png'))!.status).toBe(404);
    expect(w.kept('tandem-one')).toEqual([]);
  });
});

describe('what the worker leaves alone', () => {
  it('is everything that is not a plain GET for the page or a hashed file', async () => {
    const w = world(BUILD, site);
    expect(await w.ask('assets/index-ccc.js', { range: true })).toBeUndefined();
    expect(await w.ask('assets/index-ccc.js', { method: 'HEAD' })).toBeUndefined();
    expect(await w.ask('', { mode: 'navigate', method: 'POST' })).toBeUndefined();
    expect(await w.ask('samples/dusk.mp4')).toBeUndefined();
    expect(await w.ask('api/health')).toBeUndefined();
    expect(await w.ask('manifest.webmanifest')).toBeUndefined();
    expect(await w.ask('https://tandem.example/', { mode: 'navigate' })).toBeUndefined();
    expect(await w.ask('https://tandem.example/api/projects/abc123')).toBeUndefined();
    expect(w.fetched).toEqual([]);
  });
});
