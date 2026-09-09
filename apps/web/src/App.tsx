import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { ProjectListing } from '@osai/persistence';

import { api } from '@/lib/api';
import { Sidebar } from '@/components/Sidebar';
import { StudioHome } from '@/components/StudioHome';
import { ProjectPage } from './ProjectPage';

export default function App() {
  const [projects, setProjects] = useState<readonly ProjectListing[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);

  const refreshProjects = () => api.listProjects().then(setProjects).catch(() => {});

  return (
    <div className="studio-bg flex h-screen text-foreground">
      <Sidebar
        projects={projects}
        selectedId={projectId}
        onSelect={setProjectId}
        onCreated={setProjectId}
        onRefresh={refreshProjects}
      />
      <AnimatePresence mode="wait">
        {projectId ? (
          <motion.div
            key={projectId}
            className="flex flex-1 overflow-hidden"
            initial={{ opacity: 0, scale: 0.99 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          >
            <ProjectPage projectId={projectId} />
          </motion.div>
        ) : (
          <motion.div
            key="home"
            className="flex flex-1 overflow-hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <StudioHome projects={projects} onSelect={setProjectId} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
