import type { EmbeddingProvider } from '@rag/ai';
import {
  addProcessingEvent,
  buildContextHeader,
  completeVersion,
  ensureVectorIndex,
  failVersion,
  getActiveEmbeddingModel,
  getDocumentRow,
  getVersionChunksForEmbedding,
  getVersionRow,
  promoteVersion,
  replaceChunks,
  replacePages,
  updateStage,
  type Database,
  type EmbeddingModelRow,
} from '@rag/database';
import { isAppError, stageProgress, type FileFormat, type ProcessingStatus, type RagSettings } from '@rag/shared';
import type { Logger } from '@rag/shared/server';
import type { StorageAdapter } from '@rag/storage';
import type { Sql } from 'postgres';
import { finalizeChunks } from '../chunking/finalize';
import { createChunker } from '../chunking/strategies';
import { embedChunks } from '../embedding/embedder';
import type { ExtractorRegistry } from './extractors/index';
import { isUnreadableText, pageText, usableChars, type ExtractedPage } from './extractors/types';
import { validateUpload } from './file-validation';
import { cleanLine, normalizePages } from './normalization';
import type { OcrEngine } from './ocr';
import { buildUnits, parseElements } from './structure';
import { plainTextToLines } from './extractors/text';

/** Falha que não deve ser repetida (arquivo inválido, sem texto etc.). */
export class PermanentIngestionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentIngestionError';
  }
}

export interface IngestionDeps {
  db: Database;
  sql: Sql;
  storage: StorageAdapter;
  extractors: ExtractorRegistry;
  ocr: OcrEngine;
  embeddingProviderFor: (model: EmbeddingModelRow) => EmbeddingProvider;
  getSettings: () => Promise<RagSettings>;
  embeddingBatchSize: number;
  logger: Logger;
}

export interface IngestionResult {
  versionId: string;
  pages: number;
  ocrPages: number;
  chunks: number;
  embedded: number;
  cacheHits: number;
  durationMs: number;
  qualityFlags: string[];
}

/** Atualiza o progresso no banco com limitação de frequência (no máximo a cada 400 ms). */
class ProgressReporter {
  private last = 0;
  constructor(
    private readonly db: Database,
    private readonly ids: { jobId: string; versionId: string },
  ) {}

  async stage(stage: ProcessingStatus, detail?: string): Promise<void> {
    this.last = Date.now();
    await updateStage(this.db, this.ids, stage, stageProgress(stage, 0, 1), detail);
    await addProcessingEvent(this.db, this.ids, stage, detail ?? stage);
  }

  async progress(stage: ProcessingStatus, done: number, total: number, detail?: string): Promise<void> {
    const now = Date.now();
    if (done < total && now - this.last < 400) return;
    this.last = now;
    await updateStage(this.db, this.ids, stage, stageProgress(stage, done, total), detail);
  }
}

export class IngestionPipeline {
  constructor(private readonly deps: IngestionDeps) {}

  async run(input: { jobId: string; versionId: string; signal?: AbortSignal }): Promise<IngestionResult> {
    const { db, logger } = this.deps;
    const ids = { jobId: input.jobId, versionId: input.versionId };
    const started = Date.now();
    const reporter = new ProgressReporter(db, ids);
    const qualityFlags = new Set<string>();

    const version = await getVersionRow(db, input.versionId);
    if (!version) throw new PermanentIngestionError('Versão do documento não encontrada');
    const doc = await getDocumentRow(db, version.documentId);
    if (!doc) throw new PermanentIngestionError('Documento excluído antes do processamento');
    const settings = await this.deps.getSettings();

    try {
      // 1. Extração
      await reporter.stage('extracting', 'Lendo arquivo e extraindo texto');
      const data = await this.deps.storage.get(version.storageKey);
      try {
        validateUpload(
          { fileName: version.fileName, data },
          { maxBytes: Number.MAX_SAFE_INTEGER, allowedFormats: [version.format as FileFormat] },
        ).warnings.forEach((w) => qualityFlags.add(w));
      } catch (err) {
        throw new PermanentIngestionError(isAppError(err) ? err.message : 'Arquivo inválido', { cause: err });
      }
      const extractor = this.deps.extractors.get(version.format as FileFormat);
      let extracted;
      try {
        extracted = await extractor.extract(data, {
          minCharsPerPage: settings.processing.ocrMinCharsPerPage,
          signal: input.signal,
          onProgress: (d, t) => reporter.progress('extracting', d, t, `Página ${d} de ${t}`),
        });
      } catch (err) {
        if (isAppError(err)) throw new PermanentIngestionError(err.message, { cause: err });
        throw err;
      }
      extracted.warnings.forEach((w) => qualityFlags.add(w));
      let pages = extracted.pages;
      const unreadablePages = pages.filter((p) => p.unreadableTextLayer).map((p) => p.pageNumber);
      await addProcessingEvent(db, ids, 'extracting', `Extração concluída: ${pages.length} página(s)`, 'info', {
        pages: pages.length,
        pagesWithoutText: pages.filter((p) => p.needsOcr).length,
        unreadableTextLayer: unreadablePages.length,
      });
      if (unreadablePages.length) {
        qualityFlags.add('unreadable_text_layer');
        await addProcessingEvent(
          db,
          ids,
          'extracting',
          `Camada de texto ilegível (fonte sem mapa de caracteres) em ${unreadablePages.length} página(s); serão lidas por OCR`,
          'warn',
          { pages: unreadablePages },
        );
      }

      // 2. OCR para páginas sem camada de texto
      const ocrTargets = pages.filter((p) => p.needsOcr).map((p) => p.pageNumber);
      let ocrPages = 0;
      if (ocrTargets.length > 0 && extracted.format === 'pdf') {
        if (!settings.processing.ocrEnabled) {
          qualityFlags.add('ocr_disabled');
        } else if (!(await this.deps.ocr.available())) {
          qualityFlags.add('ocr_unavailable');
          await addProcessingEvent(db, ids, 'ocr', 'OCR necessário, mas o mecanismo não está disponível', 'warn');
        } else {
          await reporter.stage('ocr', `Executando OCR em ${ocrTargets.length} página(s)`);
          const results = await this.deps.ocr.recognizePdfPages(data, ocrTargets, {
            signal: input.signal,
            onPage: (d, t) => reporter.progress('ocr', d, t, `OCR: página ${d} de ${t}`),
          });
          const byPage = new Map(results.map((r) => [r.pageNumber, r]));
          const lowConfidence: number[] = [];
          pages = pages.map((p): ExtractedPage => {
            const r = byPage.get(p.pageNumber);
            if (!r) return p;
            const ocrText = r.lines.join(' ');
            const ocrUnreadable = isUnreadableText(ocrText);
            // Página com texto digital legível (apenas curta) não é trocada por OCR pior
            if (ocrUnreadable && !p.unreadableTextLayer) return p;
            ocrPages++;
            if (r.confidence < settings.processing.ocrMinConfidence) lowConfidence.push(p.pageNumber);
            return {
              ...p,
              lines: ocrUnreadable ? [] : plainTextToLines(r.lines.map(cleanLine).join('\n')),
              ocr: true,
              ocrConfidence: Math.round(r.confidence * 10) / 10,
              needsOcr: ocrUnreadable || usableChars(ocrText) < settings.processing.ocrMinCharsPerPage,
              unreadableTextLayer: false,
            };
          });
          if (lowConfidence.length) {
            qualityFlags.add('low_ocr_confidence');
            await addProcessingEvent(db, ids, 'ocr', `Baixa confiança de OCR nas páginas ${lowConfidence.join(', ')}`, 'warn', { pages: lowConfidence });
          }
          await addProcessingEvent(db, ids, 'ocr', `OCR concluído em ${ocrPages} página(s)`, 'info', {
            avgConfidence: results.length ? results.reduce((s, r) => s + r.confidence, 0) / results.length : null,
          });
        }
      }
      // Texto embaralhado que não pôde ser substituído por OCR não é indexado
      pages = pages.map((p) => (p.unreadableTextLayer ? { ...p, lines: [] } : p));
      const stillEmpty = pages.filter((p) => p.needsOcr).length;
      if (stillEmpty > 0) qualityFlags.add('pages_without_text');

      // 3. Normalização
      await reporter.stage('normalizing', 'Normalizando texto');
      const normalized = normalizePages(pages);
      pages = normalized.pages;
      const totalChars = usableChars(pages.map(pageText).join(' '));
      if (totalChars < Math.max(20, settings.processing.ocrMinCharsPerPage)) {
        throw new PermanentIngestionError(
          ocrTargets.length > 0 && qualityFlags.has('ocr_unavailable')
            ? 'Documento digitalizado sem texto utilizável e OCR indisponível'
            : 'Documento sem texto utilizável',
        );
      }
      await replacePages(
        db,
        version.id,
        pages.map((p) => ({ pageNumber: p.pageNumber, text: pageText(p), ocr: p.ocr, ocrConfidence: p.ocrConfidence })),
      );

      // 4. Estruturação e chunking
      await reporter.stage('chunking', `Gerando chunks (estratégia ${settings.chunking.strategy})`);
      const elements = parseElements(pages, extracted.paginated);
      const units = buildUnits(elements);
      const model = await getActiveEmbeddingModel(db);
      if (!model) throw new Error('Nenhum modelo de embedding ativo. Execute o seed ou configure um modelo.');
      const provider = this.deps.embeddingProviderFor(model);
      const chunker = createChunker(settings.chunking.strategy);
      const drafts = await chunker.chunk({
        units,
        elements,
        settings: settings.chunking,
        embed: async (texts) => (await provider.embed(texts, { signal: input.signal, operation: 'embedding_chunking' })).vectors,
      });
      const contextHeader = buildContextHeader(doc);
      const { chunks, stats } = finalizeChunks(drafts, settings.chunking, { contextHeader });
      if (chunks.length === 0) throw new PermanentIngestionError('Nenhum chunk válido gerado a partir do documento');
      if (stats.injectionFlagged > 0) qualityFlags.add('possible_prompt_injection');
      await replaceChunks(db, version.id, doc.id, chunks);
      await addProcessingEvent(db, ids, 'chunking', `${chunks.length} chunk(s) gerado(s)`, 'info', { ...stats, units: units.length, elements: elements.length });

      // 5. Embeddings
      await reporter.stage('embedding', `Gerando embeddings (${model.model})`);
      const embeddable = await getVersionChunksForEmbedding(db, version.id);
      const emb = await embedChunks({
        db,
        provider,
        modelId: model.id,
        chunks: embeddable,
        batchSize: this.deps.embeddingBatchSize,
        signal: input.signal,
        onProgress: (d, t) => reporter.progress('embedding', d, t, `Embeddings: ${d} de ${t}`),
      });
      await addProcessingEvent(db, ids, 'embedding', `Embeddings gerados: ${emb.embedded} (cache: ${emb.cacheHits})`, 'info', { ...emb });

      // 6. Indexação e disponibilização
      await reporter.stage('indexing', 'Atualizando índices');
      await ensureVectorIndex(this.deps.sql, model.id, model.dimensions);
      const current = await getDocumentRow(db, doc.id);
      if (!current) throw new PermanentIngestionError('Documento excluído durante o processamento');
      const durationMs = Date.now() - started;
      await completeVersion(db, version.id, {
        pageCount: pages.length,
        extractionMethod: ocrPages === 0 ? 'text' : ocrPages === pages.length ? 'ocr' : 'mixed',
        ocrPages,
        qualityFlags: [...qualityFlags],
        processingConfig: { chunking: settings.chunking, embeddingModelId: model.id, ocr: this.deps.ocr.name },
        processingMs: durationMs,
      });
      await promoteVersion(db, version.id);
      await addProcessingEvent(db, ids, 'completed', `Documento disponível para consulta (${(durationMs / 1000).toFixed(1)} s)`);
      logger.info({ versionId: version.id, chunks: chunks.length, durationMs }, 'ingestion completed');
      return {
        versionId: version.id,
        pages: pages.length,
        ocrPages,
        chunks: chunks.length,
        embedded: emb.embedded,
        cacheHits: emb.cacheHits,
        durationMs,
        qualityFlags: [...qualityFlags],
      };
    } catch (err) {
      const message =
        err instanceof PermanentIngestionError || isAppError(err)
          ? err.message
          : `Falha no processamento: ${err instanceof Error ? err.message : String(err)}`;
      await failVersion(db, version.id, message).catch(() => {});
      await addProcessingEvent(db, ids, 'error', message, 'error').catch(() => {});
      logger.error({ versionId: version.id, err: err instanceof Error ? { name: err.name, message: err.message } : err }, 'ingestion failed');
      throw err;
    }
  }
}
