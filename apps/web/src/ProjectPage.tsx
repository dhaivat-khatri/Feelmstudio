import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import type { ProjectLifecycle, ProjectOverview, SceneSummary } from '@osai/core';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { TopBar } from '@/components/TopBar';
import { ScriptEditor } from '@/components/ScriptEditor';
import { ProjectWizard } from '@/components/ProjectWizard';
import { DirectorPage } from '@/components/DirectorPage';
import { WriterPage } from '@/components/WriterPage';
import { CinematographerPage } from '@/components/CinematographerPage';
import { ComposerPage } from '@/components/ComposerPage';
import { EditorPage } from '@/components/EditorPage';
import { RoomsPanel } from '@/components/RoomsPanel';
import { SceneCard } from '@/components/SceneCard';
import { ScenePanel } from '@/components/ScenePanel';
import { cn } from '@/lib/utils';

type WorkspaceView = 'director' | 'writer' | 'cinematographer' | 'composer' | 'editor' | 'rooms' | 'scenes';

export function ProjectPage({ projectId }: { projectId: string }) {
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [selectedScene, setSelectedScene] = useState<SceneSummary | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [view, setView] = useState<WorkspaceView>('scenes');
  // Captured once on load: a project that already has scenes never shows the
  // wizard, even after this component re-renders — the wizard is a one-time guided
  // setup, not a persistent mode.
  const [wizardDone, setWizardDone] = useState<boolean | null>(null);

  const refresh = () => {
    api.getProject(projectId).then((next) => {
      setOverview(next);
      setWizardDone((done) => done ?? next.scenes.length > 0);
    }).catch((e: unknown) => toast.error('Could not load project', { description: String(e) }));
    setRefreshToken((t) => t + 1);
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const approveAll = async () => {
    const result = await api.approveAll(projectId);
    setOverview(result.overview);
    toast.success(`Approved ${result.approved} item${result.approved === 1 ? '' : 's'}`);
  };

  const setLifecycle = async (lifecycle: ProjectLifecycle) => {
    const next = await api.setLifecycle(projectId, lifecycle);
    setOverview(next);
  };

  if (!overview || wizardDone === null) return null;

  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden">
      <TopBar
        projectId={projectId}
        title={overview.title}
        lifecycle={overview.lifecycle}
        onLifecycleChange={setLifecycle}
        onApproveAll={approveAll}
      />

      <div className="flex-1 overflow-y-auto p-5">
        {!wizardDone ? (
          <ProjectWizard
            projectId={projectId}
            onComplete={() => {
              setWizardDone(true);
              refresh();
            }}
          />
        ) : (
          <>
            <div className="mb-4 flex items-center justify-between">
              <div className="flex gap-1 rounded-md border p-0.5">
                {(['director', 'writer', 'cinematographer', 'composer', 'editor', 'rooms', 'scenes'] as const).map((v) => (
                  <Button
                    key={v}
                    size="sm"
                    variant={view === v ? 'secondary' : 'ghost'}
                    className={cn('h-7 capitalize', view !== v && 'text-muted-foreground')}
                    onClick={() => setView(v)}
                  >
                    {v}
                  </Button>
                ))}
              </div>
              {view === 'scenes' && <ScriptEditor projectId={projectId} onSaved={refresh} />}
            </div>

            {view === 'director' && (
              <DirectorPage
                projectId={projectId}
                overview={overview}
                onChanged={refresh}
                onContinue={() => setView('writer')}
              />
            )}
            {view === 'writer' && (
              <WriterPage
                projectId={projectId}
                overview={overview}
                onChanged={refresh}
                onContinue={() => setView('cinematographer')}
              />
            )}
            {view === 'cinematographer' && (
              <CinematographerPage
                projectId={projectId}
                overview={overview}
                onChanged={refresh}
                onContinue={() => setView('composer')}
              />
            )}
            {view === 'composer' && (
              <ComposerPage
                projectId={projectId}
                overview={overview}
                onChanged={refresh}
                onContinue={() => setView('editor')}
              />
            )}
            {view === 'editor' && <EditorPage projectId={projectId} overview={overview} onChanged={refresh} />}
            {view === 'rooms' && <RoomsPanel projectId={projectId} overview={overview} />}
            {view === 'scenes' && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {overview.scenes.map((scene, i) => (
                  <motion.div
                    key={scene.sceneId}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, delay: Math.min(i, 10) * 0.04 }}
                  >
                    <SceneCard
                      projectId={projectId}
                      scene={scene}
                      refreshToken={refreshToken}
                      onOpen={() => setSelectedScene(scene)}
                    />
                  </motion.div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <ScenePanel
        projectId={projectId}
        scene={selectedScene}
        onOpenChange={(open) => !open && setSelectedScene(null)}
        onChanged={refresh}
      />
    </div>
  );
}
