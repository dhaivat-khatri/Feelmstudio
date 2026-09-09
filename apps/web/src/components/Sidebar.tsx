import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Plus } from 'lucide-react';
import type { ProjectListing } from '@osai/persistence';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { BrandLockup } from '@/components/Wordmark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

const LIFECYCLE_DOT: Record<string, string> = {
  draft: 'bg-muted-foreground/50',
  active: 'bg-status-queued',
  published: 'bg-status-approved',
  archived: 'bg-muted-foreground/30',
};

export interface SidebarProps {
  readonly projects: readonly ProjectListing[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onCreated: (id: string) => void;
  readonly onRefresh: () => void;
}

export function Sidebar({ projects, selectedId, onSelect, onCreated, onRefresh }: SidebarProps) {
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    onRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    if (!title.trim()) return;
    setCreating(true);
    try {
      const project = await api.createProject(title.trim());
      setTitle('');
      onRefresh();
      onCreated(project.projectId);
    } catch (e) {
      toast.error('Could not create project', { description: String(e) });
    } finally {
      setCreating(false);
    }
  };

  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <motion.div
        className="flex items-center gap-2 px-4 py-4"
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.3 }}
      >
        <BrandLockup markSize={22} className="text-sidebar-foreground [&>svg]:text-primary" />
      </motion.div>

      <div className="flex items-center gap-1.5 px-3 pb-3">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
          placeholder="New project"
          className="h-8 text-sm"
        />
        <Button size="icon" className="size-8 shrink-0" disabled={creating || !title.trim()} onClick={create}>
          <Plus className="size-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1 px-2">
        <nav className="flex flex-col gap-0.5 pb-4">
          {projects.map((p, i) => (
            <motion.button
              key={p.id}
              onClick={() => onSelect(p.id)}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2, delay: Math.min(i, 8) * 0.03 }}
              whileHover={{ x: 2 }}
              className={cn(
                'flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                selectedId === p.id
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/50',
              )}
            >
              <span className={cn('size-1.5 shrink-0 rounded-full', LIFECYCLE_DOT[p.lifecycle] ?? LIFECYCLE_DOT.draft)} />
              <span className="truncate">{p.title}</span>
            </motion.button>
          ))}
          {projects.length === 0 && (
            <p className="px-2.5 py-2 text-xs text-muted-foreground">No projects yet.</p>
          )}
        </nav>
      </ScrollArea>
    </aside>
  );
}
