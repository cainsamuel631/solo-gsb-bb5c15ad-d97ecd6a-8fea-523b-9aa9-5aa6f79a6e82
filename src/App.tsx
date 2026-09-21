import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, Selection } from './types';
import { createSampleProject } from './lib/sample';
import { loadProject, sanitizeProject, saveProject, uid } from './lib/storage';
import { normalizeBeatMap } from './lib/tempo';
import { partUnder, totalSeconds, type Segment } from './lib/coverage';
import { applyMove, findBestMove, type OptimizeResult } from './lib/optimize';
import { MIN_DURATION, clamp } from './lib/constraints';
import { fmtClock, fmtOffset } from './lib/format';
import Sidebar from './components/Sidebar';
import Timeline, { type Ghost } from './components/Timeline';
import OptimizerPanel from './components/OptimizerPanel';

export default function App() {
  const [project, setProject] = useState<Project>(() => loadProject() ?? createSampleProject());
  const [selection, setSelection] = useState<Selection | null>(null);
  const [range, setRange] = useState(10);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [previewOffset, setPreviewOffset] = useState<number | null>(null);
  const [pxPerSec, setPxPerSec] = useState(10);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 本地自动保存（刷新后自动恢复）
  useEffect(() => {
    saveProject(project);
    setSavedAt(new Date());
  }, [project]);

  const clearOptimization = useCallback(() => {
    setResult(null);
    setPreviewOffset(null);
  }, []);

  /** 所有工程修改的统一入口：修改后寻优结果即失效 */
  const mutate = useCallback(
    (fn: (p: Project) => Project) => {
      clearOptimization();
      setProject(fn);
    },
    [clearOptimization],
  );

  /**
   * 仅修改节拍图：换气段的实际秒位置保持不变（仅重新显示对应拍位），
   * 因此不影响寻优结果（寻优基于秒），无需清空预览。
   */
  const mutateBeatMap = useCallback((fn: (b: Project['beatMap']) => Project['beatMap']) => {
    setProject((p) => ({ ...p, beatMap: normalizeBeatMap(fn(p.beatMap)) }));
  }, []);

  // 选中的换气段被删除后，清空选择
  useEffect(() => {
    if (!selection) return;
    const s = project.singers.find((x) => x.id === selection.singerId);
    if (!s || !s.breaths.some((b) => b.id === selection.intervalId)) {
      setSelection(null);
      clearOptimization();
    }
  }, [project, selection, clearOptimization]);

  const previewing = result !== null && previewOffset !== null;

  /** 预览时：把选中换气段按预览位移临时移动后的工程 */
  const effectiveProject = useMemo(
    () => (previewing && result ? applyMove(project, result.singerId, result.intervalId, previewOffset) : project),
    [project, previewing, result, previewOffset],
  );

  const coverage = useMemo(() => {
    const m = new Map<string, ReturnType<typeof partUnder>>();
    for (const p of effectiveProject.parts) m.set(p.id, partUnder(effectiveProject, p.id));
    return m;
  }, [effectiveProject]);

  const totalUnder = useMemo(
    () => [...coverage.values()].reduce((acc, segs) => acc + totalSeconds(segs), 0),
    [coverage],
  );
  const underCount = useMemo(() => [...coverage.values()].reduce((acc, segs) => acc + segs.length, 0), [coverage]);

  const ghost: Ghost | null = useMemo(() => {
    if (!previewing || !result) return null;
    const s = project.singers.find((x) => x.id === result.singerId);
    const b = s?.breaths.find((x) => x.id === result.intervalId);
    if (!s || !b) return null;
    return { singerId: s.id, start: b.start + previewOffset, end: b.end + previewOffset };
  }, [previewing, result, project, previewOffset]);

  // ---------- 换气段操作 ----------
  const updateInterval = useCallback(
    (singerId: string, intervalId: string, start: number, end: number) => {
      mutate((p) => ({
        ...p,
        singers: p.singers.map((s) =>
          s.id !== singerId
            ? s
            : { ...s, breaths: s.breaths.map((b) => (b.id !== intervalId ? b : { ...b, start, end })) },
        ),
      }));
    },
    [mutate],
  );

  const addInterval = useCallback(
    (singerId: string, seg: Segment) => {
      if (seg.end - seg.start < MIN_DURATION) return;
      mutate((p) => ({
        ...p,
        singers: p.singers.map((s) =>
          s.id !== singerId ? s : { ...s, breaths: [...s.breaths, { id: uid(), ...seg }] },
        ),
      }));
    },
    [mutate],
  );

  const deleteInterval = useCallback(
    (singerId: string, intervalId: string) => {
      mutate((p) => ({
        ...p,
        singers: p.singers.map((s) =>
          s.id !== singerId ? s : { ...s, breaths: s.breaths.filter((b) => b.id !== intervalId) },
        ),
      }));
    },
    [mutate],
  );

  // Delete / Backspace 删除选中换气段
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (selection) deleteInterval(selection.singerId, selection.intervalId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, deleteInterval]);

  // ---------- 寻优 ----------
  const runOptimize = () => {
    if (!selection) return;
    const r = findBestMove(project, selection.singerId, selection.intervalId, Math.max(0, Math.round(range)));
    if (!r) return;
    setResult(r);
    setPreviewOffset(r.best.offset);
  };

  const applyPreview = () => {
    if (!result || previewOffset === null) return;
    setProject((p) => applyMove(p, result.singerId, result.intervalId, previewOffset));
    clearOptimization();
  };

  // ---------- 导入 / 导出 ----------
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name || 'breath-relay'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importJson = (file: File) => {
    file
      .text()
      .then((txt) => {
        const p = sanitizeProject(JSON.parse(txt));
        if (!p) throw new Error('invalid');
        clearOptimization();
        setSelection(null);
        setProject(p);
      })
      .catch(() => alert('无法导入：文件不是有效的工程 JSON'));
  };

  const loadSample = () => {
    clearOptimization();
    setSelection(null);
    setProject(createSampleProject());
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          🎵 换气接力 <span>合唱排练换气规划</span>
        </div>
        <div className="header-actions">
          <button onClick={loadSample}>载入示例数据</button>
          <button onClick={exportJson}>导出 JSON</button>
          <button onClick={() => fileRef.current?.click()}>导入 JSON</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importJson(f);
              e.target.value = '';
            }}
          />
          {savedAt && <span className="saved">已自动保存到本地 {fmtClock(savedAt)}</span>}
        </div>
      </header>

      <div className="layout">
        <Sidebar project={project} coverage={coverage} mutate={mutate} mutateBeatMap={mutateBeatMap} />

        <main className="main">
          <div className="toolbar">
            <div className="stat">
              全曲未达标：
              <b className={totalUnder > 0 ? 'bad' : 'ok'}>{totalUnder.toFixed(1)}s</b>
              <span className="muted">（{underCount} 处{previewing ? ' · 预览中' : ''}）</span>
            </div>
            <div className="zoom">
              <span className="muted">缩放</span>
              <button onClick={() => setPxPerSec((v) => clamp(v / 1.25, 3, 40))}>−</button>
              <button onClick={() => setPxPerSec((v) => clamp(v * 1.25, 3, 40))}>＋</button>
            </div>
          </div>

          {previewing && result && (
            <div className="preview-banner">
              预览中：选中换气段位移 <b>{fmtOffset(previewOffset)}</b>
              ，红色为修复后仍不足的时段；虚线框为新位置，半透明块为原位置。
              <button className="primary" onClick={applyPreview}>
                应用
              </button>
              <button onClick={clearOptimization}>取消</button>
            </div>
          )}

          <Timeline
            project={project}
            coverage={coverage}
            selection={selection}
            ghost={ghost}
            pxPerSec={pxPerSec}
            onSelect={(sel) => {
              clearOptimization();
              setSelection(sel);
            }}
            onUpdateInterval={updateInterval}
            onAddInterval={addInterval}
          />

          <OptimizerPanel
            project={project}
            selection={selection}
            range={range}
            onRangeChange={setRange}
            result={result}
            previewOffset={previewOffset}
            onRun={runOptimize}
            onPreview={setPreviewOffset}
            onApply={applyPreview}
            onCancel={clearOptimization}
            onDelete={() => selection && deleteInterval(selection.singerId, selection.intervalId)}
          />
        </main>
      </div>
    </div>
  );
}
