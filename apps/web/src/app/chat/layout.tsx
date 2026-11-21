import type { ReactNode } from 'react';
import { ResponsiveConversationSidebar } from '@/components/chat/conversation-sidebar';

export default function ChatLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0">
      <ResponsiveConversationSidebar />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
