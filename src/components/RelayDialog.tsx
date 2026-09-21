import { useEffect, useState } from 'react';
import type { BeatMap, Project, VoicePart } from '../types';
import { beatToTime, timeToBeat } from '../lib/tempo';
import {
  absToMeasureBeat,
  measureBeatToAbs,
  planAssignments,
  type RelayFailure,
  type RelayPlan,
} from '../lib/relay';
import { fmtSec } from '../lib/format';

interface Props {
  project: Project;
  /** 初始选中的声部（侧栏「接力排程」入口可预填） */
  initialPartId: string | null;
  /** 最近一次搜索的结果（与当前表单参数一致时展示） */
  plan: RelayPlan | null;
  onSearch: (partId: string, startBeat: number, endBeat: number, breathBeats: number) => void;
  /** 表单任意字段发生变化（用于使旧的搜索结果失效） */
  onDirty: () => void;
  onApply: () => void;
  onClose: () => void;
}

/** 全曲时长内最后一个整拍（拍域结束的默认值）。 */
function lastWholeBeat(project: Project): number {
  return Math.floor(timeToBeat(project.duration, project.beatMap));
}

function fmtBeat(beatMap: BeatMap, b: number): string {
  const loc = absToMeasureBeat(beatMap, b);
  return `${loc.measure}:${loc.beatInBar}`;
}

export default function RelayDialog(props: Props) {
  const { project } = props;
  const beatMap = project.beatMap;
  const bpb = beatMap.beatsPerBar;

  const [partId, setPartId] = useState<string>(() => props.initialPartId ?? project.parts[0]?.id ?? '');
  const [startMB, setStartMB] = useState(() => ({ m: '1', b: '1' }));
  const [endMB, setEndMB] = useState(() => {
    const loc = absToMeasureBeat(beatMap, Math.max(1, lastWholeBeat(project)));
    return { m: String(loc.measure), b: String(loc.beatInBar) };
  });
  const [breathBeats, setBreathBeats] = useState('1');

  // Esc 关闭（取消，不改工程）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const part: VoicePart | undefined = project.parts.find((p) => p.id === partId);
  const singers = part ? project.singers.filter((s) => s.partId === part.id) : [];

  const parsed = {
    sm: Math.round(Number(startMB.m)),
    sb: Math.round(Number(startMB.b)),
    em: Math.round(Number(endMB.m)),
    eb: Math.round(Number(endMB.b)),
    bb: Math.round(Number(breathBeats)),
  };

  const error = (() => {
    if (!part) return '请选择声部';
    if (singers.length === 0) return '该声部暂无歌手，无法排程';
    const { sm, sb, em, eb, bb } = parsed;
    if (![sm, sb, em, eb, bb].every(Number.isFinite)) return '请完整填写拍位与换气拍数';
    if (sm < 1 || em < 1) return '小节号须 ≥ 1';
    if (sb < 1 || sb > bpb || eb < 1 || eb > bpb) return `小节内拍位须在 1 – ${bpb} 之间`;
    if (bb < 1 || bb > 64) return '每人换气拍数须为 1 – 64 的正整数';
    const startBeat = measureBeatToAbs(beatMap, sm, sb);
    const endBeat = measureBeatToAbs(beatMap, em, eb);
    if (endBeat <= startBeat) return '结束拍位必须晚于起始拍位';
    if (bb > endBeat - startBeat) return '拍域短于每人换气拍数，无法容纳一人的换气';
    const winEnd = beatToTime(endBeat, beatMap);
    if (winEnd > project.duration + 1e-6) {
      return `结束拍位（${fmtSec(winEnd)}）已超出全曲时长 ${fmtSec(project.duration)}`;
    }
    return null;
  })();

  const validBeat = (() => {
    const { sm, sb, em, eb, bb } = parsed;
    if (error || !part) return null;
    return {
      startBeat: measureBeatToAbs(beatMap, sm, sb),
      endBeat: measureBeatToAbs(beatMap, em, eb),
      breathBeats: bb,
    };
  })();

  /** 当前表单参数与已搜索方案是否一致；一致才展示其结果/预览。 */
  const shownPlan: RelayPlan | null = (() => {
    if (!props.plan || !validBeat) return null;
    const { req } = props.plan;
    return req.partId === partId &&
      req.startBeat === validBeat.startBeat &&
      req.endBeat === validBeat.endBeat &&
      req.breathBeats === validBeat.breathBeats
      ? props.plan
      : null;
  })();

  const run = () => {
    if (!validBeat) return;
    props.onSearch(partId, validBeat.startBeat, validBeat.endBeat, validBeat.breathBeats);
  };

  const failureText = (r: RelayFailure): { title: string; detail: string } => {
    const cap = singers.length - (part?.minSingers ?? 0);
    switch (r.kind) {
      case 'no-slot':
        return {
          title: `无解 · 歌手无可用拍位：${r.singerName}`,
          detail:
            '该歌手在所选拍域内找不到「放得下整段换气、且不与其已有换气重叠」的整拍位置。可缩短每人换气拍数、扩大拍域，或先在时间轴上移开冲突的换气段。',
        };
      case 'threshold':
        if (r.preexisting) {
          return {
            title: '无解 · 覆盖门槛冲突（拍域内现有换气已不达标）',
            detail: `即使不新增任何换气，拍域内已有 ${fmtSec(r.detailSeconds ?? 0)} 时段同时换气人数超过上限（歌手数 ${singers.length} − 门槛 ${part?.minSingers ?? 0} = ${cap}），或声部歌手总数低于门槛。请先调整已有换气或声部设置。`,
          };
        }
        if (r.exhausted) {
          return {
            title: '无解 · 覆盖门槛冲突（搜索空间过大，已触安全上限）',
            detail: '在安全节点数内未找到可行组合；请缩短拍域或减少每人换气拍数后重试。',
          };
        }
        return {
          title: '无解 · 覆盖门槛冲突',
          detail: `无法为所有歌手各安排一段换气而不使拍域内某时刻发声人数低于 ${part?.minSingers ?? 0} 人门槛（即同时换气人数超过 ${cap}）。可缩短每人换气拍数、扩大拍域，或降低该声部的最低发声人数。`,
        };
      default:
        return { title: `参数无效：${r.message}`, detail: '' };
    }
  };

  const cap = singers.length - (part?.minSingers ?? 0);

  return (
    <div className="relay-overlay" onClick={props.onClose}>
      <div className="relay-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>🔀 声部接力排程</h3>
        <p className="hint">
          在指定拍域内为声部<strong>每位歌手</strong>各安排一段新换气；回溯搜索同时保证区间不越窗、不与本人已有换气重叠、
          任一时刻发声人数不低于声部门槛。跨变速点按拍位枚举并换算为秒。
        </p>

        <div className="relay-form">
          <label className="field">
            <span>声部</span>
            <select
              value={partId}
              onChange={(e) => {
                setPartId(e.target.value);
                props.onDirty();
              }}
            >
              {project.parts.map((p) => {
                const n = project.singers.filter((s) => s.partId === p.id).length;
                return (
                  <option key={p.id} value={p.id}>
                    {p.name}（{n} 人 · 需≥{p.minSingers}人发声）
                  </option>
                );
              })}
            </select>
          </label>

          <div className="relay-beat-row">
            <span className="relay-label">拍域</span>
            <label>
              起
              <input
                type="number"
                min={1}
                value={startMB.m}
                onChange={(e) => {
                  setStartMB((x) => ({ ...x, m: e.target.value }));
                  props.onDirty();
                }}
              />
              :
              <input
                type="number"
                min={1}
                max={bpb}
                value={startMB.b}
                onChange={(e) => {
                  setStartMB((x) => ({ ...x, b: e.target.value }));
                  props.onDirty();
                }}
              />
            </label>
            <span className="muted">至</span>
            <label>
              止
              <input
                type="number"
                min={1}
                value={endMB.m}
                onChange={(e) => {
                  setEndMB((x) => ({ ...x, m: e.target.value }));
                  props.onDirty();
                }}
              />
              :
              <input
                type="number"
                min={1}
                max={bpb}
                value={endMB.b}
                onChange={(e) => {
                  setEndMB((x) => ({ ...x, b: e.target.value }));
                  props.onDirty();
                }}
              />
            </label>
            <span className="muted">（小节:拍）</span>
          </div>

          <label className="field">
            <span>每人换气</span>
            <input
              type="number"
              min={1}
              max={64}
              value={breathBeats}
              onChange={(e) => {
                setBreathBeats(e.target.value);
                props.onDirty();
              }}
            />
            <span className="muted">拍</span>
          </label>

          {validBeat && part && (
            <div className="relay-summary muted">
              拍域 {fmtBeat(beatMap, validBeat.startBeat)} – {fmtBeat(beatMap, validBeat.endBeat)}（共{' '}
              {validBeat.endBeat - validBeat.startBeat} 拍）· 秒域 {fmtSec(beatToTime(validBeat.startBeat, beatMap))} –{' '}
              {fmtSec(beatToTime(validBeat.endBeat, beatMap))} · {singers.length} 位歌手各 {validBeat.breathBeats} 拍 ·
              同时换气上限 {cap} 人
            </div>
          )}
          {error && <div className="relay-error-inline">{error}</div>}
        </div>

        <div className="relay-actions">
          <button className="primary" disabled={!validBeat} onClick={run}>
            搜索排程
          </button>
          {shownPlan &&
            (shownPlan.result.ok ? (
              <span className="relay-ok">
                ✓ 已为 {planAssignments(shownPlan).length} 位歌手找到方案（时间轴金色虚线幽灵块预览）
              </span>
            ) : (
              (() => {
                const f = failureText(shownPlan.result.reason);
                return (
                  <span className="relay-fail">
                    ✗ {f.title}
                    {f.detail && <em className="relay-fail-detail">{f.detail}</em>}
                  </span>
                );
              })()
            ))}
        </div>

        {shownPlan?.result.ok && (
          <>
            <table className="cand-table relay-table">
              <thead>
                <tr>
                  <th>歌手</th>
                  <th>拍位</th>
                  <th>秒区间</th>
                </tr>
              </thead>
              <tbody>
                {planAssignments(shownPlan).map((a) => {
                  const s = project.singers.find((x) => x.id === a.singerId);
                  return (
                    <tr key={a.singerId}>
                      <td>{s?.name ?? a.singerId}</td>
                      <td>
                        {fmtBeat(beatMap, a.startBeat)} – {fmtBeat(beatMap, a.endBeat)}
                      </td>
                      <td>
                        [{fmtSec(a.start)}, {fmtSec(a.end)})
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="relay-actions">
              <button className="primary" onClick={props.onApply}>
                确认写入（{planAssignments(shownPlan).length} 段）
              </button>
              <button onClick={props.onClose}>取消</button>
              <span className="muted">取消不改动工程；确认后一次写入并自动保存。</span>
            </div>
          </>
        )}

        {!(shownPlan?.result.ok) && (
          <div className="relay-actions">
            <button onClick={props.onClose}>取消</button>
          </div>
        )}
      </div>
    </div>
  );
}
