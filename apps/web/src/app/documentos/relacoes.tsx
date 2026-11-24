'use client';

import type { CatalogRelationAct, CatalogRelationsDto } from '@rag/shared';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/utils';

function RelationLine({ act, label }: { act: CatalogRelationAct; label: string }) {
  const title = act.documentId ? (
    <Link href={`/documentos/${act.documentId}`} className="font-medium hover:underline">
      {act.title}
    </Link>
  ) : (
    <span className="font-medium">{act.title}</span>
  );
  return (
    <li className="text-sm">
      <span className="text-muted-foreground">{label} · </span>
      {title}
      {act.publicationDate ? <span className="text-muted-foreground"> · {formatDate(act.publicationDate)}</span> : null}
    </li>
  );
}

/** Atos que alteram este documento ou que ele revogou, e o ato principal quando este é uma alteração. */
export function RelatedActs({ documentId }: { documentId: string }) {
  const related = useQuery({
    queryKey: ['catalog-links', 'document', documentId],
    queryFn: () => api<CatalogRelationsDto>(`/catalog/links?documentId=${documentId}`),
  });
  const data = related.data;
  if (!data || (data.children.length === 0 && data.parents.length === 0)) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Atos vinculados</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-1.5">
          {data.parents.map((act) => (
            <RelationLine
              key={`pai-${act.source}-${act.externalId}`}
              act={act}
              label={act.linkKind === 'revogacao' ? 'Revogada por' : act.incorporated ? 'Incorporada a' : 'Altera'}
            />
          ))}
          {data.children.map((act) => (
            <RelationLine
              key={`filho-${act.linkKind}-${act.source}-${act.externalId}`}
              act={act}
              label={act.linkKind === 'revogacao' ? 'Revoga' : act.incorporated ? 'Alteração incorporada' : 'Alterada por'}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
