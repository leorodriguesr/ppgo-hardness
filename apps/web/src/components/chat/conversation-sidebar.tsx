'use client';

import type { ConversationDto, Paginated } from '@rag/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, MessageSquarePlus, MoreHorizontal, Pencil, Search, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { DropdownMenu } from 'radix-ui';
import { useDeferredValue, useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';
import { Button } from '../ui/button';
import { ConfirmDialog, Dialog, DialogContent, DialogFooter } from '../ui/dialog';
import { Input, Skeleton } from '../ui/primitives';

export function ConversationSidebar({ mobileOpen = false, onNavigate }: { mobileOpen?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const [renaming, setRenaming] = useState<ConversationDto | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [deleting, setDeleting] = useState<ConversationDto | null>(null);
  const list = useQuery({
    queryKey: ['conversations', q],
    queryFn: () => api<Paginated<ConversationDto>>(`/conversations?pageSize=100${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  });

  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api(`/conversations/${id}`, { method: 'PATCH', json: { title } }),
    onSuccess: () => {
      setRenaming(null);
      void qc.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: (_d, id) => {
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      if (pathname === `/chat/${id}`) router.push('/chat');
      toast.success('Conversa removida do histórico.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <aside
      className={cn('w-72 shrink-0 flex-col border-r bg-muted/30 md:static md:flex', mobileOpen ? 'fixed top-12 bottom-0 left-0 z-30 flex bg-background pt-10' : 'hidden')}
      aria-label="Histórico de conversas"
      onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}
    >
      <div className="space-y-2 p-3">
        <Button asChild className="w-full justify-start" variant="outline">
          <Link href="/chat">
            <MessageSquarePlus /> Nova conversa
          </Link>
        </Button>
        <div className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar conversas" className="pl-8" aria-label="Buscar conversas" />
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        {list.isLoading && [1, 2, 3].map((i) => <Skeleton key={i} className="mx-1 mb-2 h-10" />)}
        {list.isError && <p className="px-2 text-xs text-destructive">{errorMessage(list.error)}</p>}
        {list.data?.items.length === 0 && <p className="px-2 py-4 text-center text-xs text-muted-foreground">{q ? 'Nenhuma conversa encontrada.' : 'Suas conversas aparecerão aqui.'}</p>}
        <ul className="space-y-0.5">
          {list.data?.items.map((c) => {
            const active = pathname === `/chat/${c.id}`;
            return (
              <li key={c.id} className={cn('group flex items-center rounded-md hover:bg-accent', active && 'bg-accent')}>
                <Link href={`/chat/${c.id}`} className="min-w-0 flex-1 px-2 py-1.5" aria-current={active ? 'page' : undefined}>
                  <p className="truncate text-sm">{c.title}</p>
                  <p className="truncate text-[11px] text-muted-foreground">{formatDateTime(c.updatedAt)}</p>
                </Link>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <Button variant="ghost" size="icon-sm" className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100" aria-label={`Ações da conversa ${c.title}`}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content align="end" className="z-50 min-w-36 rounded-md border bg-popover p-1 text-sm shadow-md">
                      <DropdownMenu.Item
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-highlighted:bg-accent"
                        onSelect={() => {
                          setNewTitle(c.title);
                          setRenaming(c);
                        }}
                      >
                        <Pencil className="size-4" /> Renomear
                      </DropdownMenu.Item>
                      <DropdownMenu.Item className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-destructive outline-none data-highlighted:bg-accent" onSelect={() => setDeleting(c)}>
                        <Trash2 className="size-4" /> Excluir
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </li>
            );
          })}
        </ul>
      </nav>
      <Dialog open={!!renaming} onOpenChange={(v) => !v && setRenaming(null)}>
        <DialogContent title="Renomear conversa">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (renaming && newTitle.trim()) rename.mutate({ id: renaming.id, title: newTitle.trim() });
            }}
          >
            <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} maxLength={200} autoFocus aria-label="Novo título" />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenaming(null)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={!newTitle.trim() || rename.isPending}>
                Salvar
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="Excluir conversa?"
        description={`"${deleting?.title ?? ''}" sairá do seu histórico e não poderá ser reaberta. O registro é mantido no servidor para auditoria, conforme a política de retenção.`}
        confirmLabel="Excluir"
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </aside>
  );
}

/** Histórico como coluna fixa em telas médias+ e como gaveta em telas estreitas. */
export function ResponsiveConversationSidebar() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="icon-sm"
        className="fixed top-14 left-2 z-40 bg-background md:hidden"
        aria-label={open ? 'Fechar histórico' : 'Abrir histórico de conversas'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <X /> : <History />}
      </Button>
      {open && <div className="fixed inset-0 top-12 z-20 bg-black/40 md:hidden" onClick={() => setOpen(false)} aria-hidden />}
      <ConversationSidebar mobileOpen={open} onNavigate={() => setOpen(false)} />
    </>
  );
}
