'use client';

import { BarChart3, FileText, FlaskConical, MessagesSquare, Moon, ScrollText, Settings, ShieldAlert, Sun } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import type { ReactNode } from 'react';
import { ACCESS_LEVEL_LABELS } from '@rag/shared';
import { useMe } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';

const NAV = [
  { href: '/chat', label: 'Consultar', icon: MessagesSquare, role: 'viewer' },
  { href: '/documentos', label: 'Biblioteca', icon: FileText, role: 'viewer' },
  { href: '/admin', label: 'Painel', icon: BarChart3, role: 'analyst' },
  { href: '/admin/avaliacoes', label: 'Avaliações', icon: FlaskConical, role: 'analyst' },
  { href: '/admin/configuracoes', label: 'Configurações', icon: Settings, role: 'analyst' },
  { href: '/admin/auditoria', label: 'Auditoria', icon: ScrollText, role: 'admin' },
] as const;

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Alternar tema claro/escuro" onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>
      <Sun className="hidden dark:block" />
      <Moon className="dark:hidden" />
    </Button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { principal, can, isError } = useMe();
  const active = (href: string) => (href === '/admin' ? pathname === '/admin' : pathname === href || pathname.startsWith(`${href}/`));
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <Link href="/chat" className="flex items-center gap-2 font-semibold">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">PP</span>
          <span className="hidden text-sm sm:inline">Assistente Documental</span>
        </Link>
        <nav className="flex flex-1 items-center gap-0.5 overflow-x-auto" aria-label="Navegação principal">
          {NAV.filter((n) => can(n.role)).map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={active(href) ? 'page' : undefined}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-foreground',
                active(href) && 'bg-accent font-medium text-foreground',
              )}
            >
              <Icon className="size-4" />
              <span className="hidden md:inline">{label}</span>
            </Link>
          ))}
        </nav>
        {principal && (
          <span className="hidden items-center gap-1 text-xs text-muted-foreground lg:flex" title="Identidade local (sem login institucional)">
            <ShieldAlert className="size-3.5" />
            {principal.displayName} · {ACCESS_LEVEL_LABELS[principal.clearance]}
          </span>
        )}
        <ThemeToggle />
      </header>
      {isError && (
        <div className="border-b bg-destructive/10 px-3 py-1.5 text-center text-xs text-destructive" role="alert">
          Não foi possível contatar a API. Verifique se o serviço está em execução.
        </div>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
