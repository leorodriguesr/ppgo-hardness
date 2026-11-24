import {
  finishCatalogSync,
  getCatalogSyncState,
  listCatalogProbe,
  markCatalogSyncRunning,
  nextUnalignedCatalogAct,
  rebuildCatalogLinks,
  saveCatalogSyncCursor,
  saveSiteAct,
  touchCatalogChecked,
  type CatalogProbeRow,
} from '@rag/database';
import { parseWpPost, type CatalogSyncDto, type WpPostInput } from '@rag/shared';
import { sha256Hex } from '@rag/shared/server';
import type { Database } from '@rag/database';
import { actFileUrl, probeFileEtag } from './files';

const SITE = 'https://www.policiapenal.go.gov.br';
const ROOT_CATEGORY = 19;
const PAGE_SIZE = 50;
const PROBE_LIMIT = 5;

export interface CatalogRefreshRequest {
  source: 'legisla' | 'site';
  externalId: number;
  etag: string | null;
  reason: 'changed' | 'align';
}

export interface CatalogSyncDeps {
  db: Database;
  enqueueRefresh: (request: CatalogRefreshRequest) => Promise<void>;
  signal?: AbortSignal;
}

interface WpPostJson {
  id: number;
  modified: string;
  link: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
  categories?: number[];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

async function wpGet(path: string, signal?: AbortSignal): Promise<{ body: string; totalPages: number }> {
  const response = await fetch(`${SITE}${path}`, {
    headers: { accept: 'application/json', 'user-agent': 'ppgo-hardness' },
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`O site da Polícia Penal respondeu HTTP ${response.status}.`);
  const totalPages = Number(response.headers.get('x-wp-totalpages') ?? 1);
  return { body: await response.text(), totalPages };
}

async function categoryNames(signal?: AbortSignal): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  const pending = [ROOT_CATEGORY];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const parent = pending.shift()!;
    if (seen.has(parent)) continue;
    seen.add(parent);
    const { body } = await wpGet(`/wp-json/wp/v2/categories?parent=${parent}&per_page=100&_fields=id,name`, signal);
    const rows = JSON.parse(body) as { id: number; name: string }[];
    for (const row of rows) {
      names.set(row.id, row.name);
      pending.push(row.id);
    }
    await sleep(200, signal);
  }
  names.set(ROOT_CATEGORY, names.get(ROOT_CATEGORY) ?? 'Atos Normativos');
  return names;
}

async function enqueueProbeChanges(deps: CatalogSyncDeps): Promise<number> {
  const rows = await listCatalogProbe(deps.db, PROBE_LIMIT);
  let queued = 0;
  for (const row of rows) {
    if (deps.signal?.aborted) break;
    const url = actFileUrl(row);
    await touchCatalogChecked(deps.db, row.source, row.externalId);
    if (!url || !row.fileEtag || row.validityStatus !== 'vigente') continue;
    const etag = await probeFileEtag(url).catch(() => null);
    if (etag && etag !== row.fileEtag) {
      await deps.enqueueRefresh({ source: row.source, externalId: row.externalId, etag, reason: 'changed' });
      queued++;
    }
    await sleep(200, deps.signal);
  }
  const align = await nextUnalignedCatalogAct(deps.db);
  if (align && actFileUrl(align)) {
    await touchCatalogChecked(deps.db, align.source, align.externalId);
    await deps.enqueueRefresh({ source: align.source, externalId: align.externalId, etag: null, reason: 'align' });
    queued++;
  }
  return queued;
}

/** Busca o que mudou no site, atualiza o acervo e enfileira no máximo as reindexações necessárias. */
export async function syncCatalogSite(deps: CatalogSyncDeps): Promise<CatalogSyncDto['stats']> {
  await markCatalogSyncRunning(deps.db);
  const stats: CatalogSyncDto['stats'] = { seen: 0, created: 0, updated: 0, revoked: 0, queued: 0 };
  try {
    const state = await getCatalogSyncState(deps.db);
    const names = await categoryNames(deps.signal);
    const ids = [ROOT_CATEGORY, ...names.keys()].filter((id, index, all) => all.indexOf(id) === index);
    const after = state.cursorAt ? `&modified_after=${encodeURIComponent(state.cursorAt)}` : '';
    let latest: string | null = null;
    for (let page = 1; ; page++) {
      if (deps.signal?.aborted) throw deps.signal.reason;
      const path =
        `/wp-json/wp/v2/posts?categories=${ids.join(',')}&per_page=${PAGE_SIZE}&page=${page}` +
        `&orderby=modified&order=asc&_fields=id,modified,link,title,content,categories${after}`;
      const { body, totalPages } = await wpGet(path, deps.signal);
      const posts = JSON.parse(body) as WpPostJson[];
      for (const post of posts) {
        const input: WpPostInput = {
          id: post.id,
          link: post.link,
          modified: post.modified,
          title: post.title?.rendered ?? '',
          html: post.content?.rendered ?? '',
          categories: (post.categories ?? []).map((id) => names.get(id) ?? ''),
        };
        const parsed = parseWpPost(input);
        const saved = await saveSiteAct(deps.db, parsed, sha256Hex(parsed.fingerprint));
        stats.seen = (stats.seen ?? 0) + 1;
        if (saved.created) stats.created = (stats.created ?? 0) + 1;
        else stats.updated = (stats.updated ?? 0) + 1;
        if (saved.revoked) stats.revoked = (stats.revoked ?? 0) + 1;
        if (saved.refresh) {
          await deps.enqueueRefresh({ source: saved.source, externalId: saved.externalId, etag: null, reason: 'changed' });
          stats.queued = (stats.queued ?? 0) + 1;
        }
        if (post.modified && (!latest || post.modified > latest)) latest = post.modified;
      }
      if (latest) await saveCatalogSyncCursor(deps.db, latest);
      if (page >= totalPages || posts.length === 0) break;
      await sleep(250, deps.signal);
    }
    stats.queued = (stats.queued ?? 0) + (await enqueueProbeChanges(deps));
    await rebuildCatalogLinks(deps.db);
    await finishCatalogSync(deps.db, stats, null);
    return stats;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Falha ao sincronizar o site.';
    await finishCatalogSync(deps.db, stats, message.slice(0, 500)).catch(() => {});
    throw err;
  }
}

export type { CatalogProbeRow };
