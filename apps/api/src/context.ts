import type { Runtime } from '@rag/rag';
import type { Principal } from '@rag/shared';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export interface Queues {
  ingestion: Queue;
  embeddings: Queue;
  evaluation: Queue;
}

export interface AppDeps {
  runtime: Runtime;
  queues: Queues;
  redis: Redis;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}
