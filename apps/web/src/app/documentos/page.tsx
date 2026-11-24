'use client';

import { Upload } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useMe } from '@/lib/hooks';
import { AcervoPanel } from './acervo';

export default function DocumentsPage() {
  const { can } = useMe();

  return (
    <div className="mx-auto flex h-full max-w-7xl flex-col gap-4 overflow-y-auto p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Documentos</h1>
          <p className="text-sm text-muted-foreground">Portarias, atos e documentos enviados</p>
        </div>
        {can('admin') && (
          <Button asChild>
            <Link href="/documentos/enviar">
              <Upload /> Enviar documentos
            </Link>
          </Button>
        )}
      </div>
      <AcervoPanel />
    </div>
  );
}
