import { underCoveredSegments, totalSeconds, mergeSegments } from '../src/lib/coverage';
import { findBestMove } from '../src/lib/optimize';
import { createSampleProject } from '../src/lib/sample';
import {
  beatTicks,
  beatToTime,
  fmtLocation,
  measureBeatToTime,
  normalizeBeatMap,
  snapTimeToBeat,
  timeToBeat,
  timeToLocation,
  updateBeatMap,
} from '../src/lib/tempo';
import { placeNewIntervalOnBeat } from '../src/lib/constraints';
import { uid } from '../src/lib/id';
import { applyRelay, measureBeatToAbs, planRelay } from '../src/lib/relay';
import type { Project } from '../src/types';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function near(name: string, actual: number, expected: number, eps = 1e-9) {
  check(name, Math.abs(actual - expected) < eps, true);
}

// 1. 半开区间相邻不重叠：[0,2) 与 [2,4) 同一时刻最多 1 人换气 → 2 人声部 min 1 达标
check('half-open adjacency', underCoveredSegments([{ start: 0, end: 2 }, { start: 2, end: 4 }], 2, 1, 10), []);

// 2. 合并相接的不足时段：3 人 min 2（允许 1 人换气），[0,2)[1,3)[2,4) → [1,3)
{
  const segs = underCoveredSegments(
    [{ start: 0, end: 2 }, { start: 1, end: 3 }, { start: 2, end: 4 }],
    3, 2, 10,
  );
  check('merge touching', segs.map((s) => [s.start, s.end]), [[1, 3]]);
  check('merge stats', [segs[0].minSinging, segs[0].deficit], [1, 1]);
}

// 3. 歌手总数低于最低要求 → 全曲不足
{
  const segs = underCoveredSegments([], 1, 2, 10);
  check('always short', segs.map((s) => [s.start, s.end, s.deficit]), [[0, 10, 1]]);
}

// 4. minSingers = 0 → 无要求
check('no requirement', underCoveredSegments([{ start: 0, end: 5 }], 1, 0, 10), []);

// 5. 示例工程基线：女高 4s + 女低 5s + 男高 2s = 11s
{
  const p = createSampleProject();
  const perPart = p.parts.map((part) => {
    const breaths = p.singers.filter((s) => s.partId === part.id).flatMap((s) => s.breaths);
    const n = p.singers.filter((s) => s.partId === part.id).length;
    return totalSeconds(underCoveredSegments(breaths, n, part.minSingers, p.duration));
  });
  check('sample per-part under', perPart, [4, 5, 2, 0]);
  check('sample baseline', perPart.reduce((a, b) => a + b, 0), 11);
}

// 6. 寻优：李雪 [19,22) ±10 → 最优 +2s，全曲未达标 11 → 9
{
  const p = createSampleProject();
  const li = p.singers.find((s) => s.name === '李雪')!;
  const iv = li.breaths[0]; // [19,22)
  const r = findBestMove(p, li.id, iv.id, 10)!;
  check('optimize baseline', r.baseline, 11);
  check('optimize best offset', r.best.offset, 2);
  check('optimize best under', r.best.underSeconds, 9);
  check('optimize best range', [r.best.start, r.best.end], [21, 24]);
  check('optimize current', r.current.offset, 0);
}

// 7. 寻优平局取更早时刻：赵敏 [44,46) ±10 → -2 与 +3 同为 9s，|−2| 更小 → -2
{
  const p = createSampleProject();
  const zhao = p.singers.find((s) => s.name === '赵敏')!;
  const iv = zhao.breaths[0]; // [44,46)
  const r = findBestMove(p, zhao.id, iv.id, 10)!;
  check('tie-break offset', r.best.offset, -2);
  check('tie-break under', r.best.underSeconds, 9);
}

// 8. 寻优不重叠约束：移动后不得与同歌手其它区间重叠（王芳 [18,21) 不能移到 [44,47) 附近）
{
  const p = createSampleProject();
  const wang = p.singers.find((s) => s.name === '王芳')!;
  const iv = wang.breaths[0]; // [18,21)
  const r = findBestMove(p, wang.id, iv.id, 30)!;
  const overlaps = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;
  const bad = r.candidates.filter((c) =>
    wang.breaths.filter((b) => b.id !== iv.id).some((o) => overlaps(c.start, c.end, o.start, o.end)),
  );
  check('no-overlap candidates', bad.length, 0);
  check('overlap skipped counted', r.infeasible.overlap > 0, true);
}

// 9. 边界：区间不能移出 [0, duration)
{
  const p = createSampleProject();
  const zheng = p.singers.find((s) => s.name === '郑伟')!;
  const iv = zheng.breaths[0]; // [10,13)
  const r = findBestMove(p, zheng.id, iv.id, 20)!;
  const out = r.candidates.filter((c) => c.start < 0 || c.end > p.duration);
  check('bounds respected', out.length, 0);
  check('bounds skipped counted', r.infeasible.bounds > 0, true);
}

// 10. mergeSegments 基本行为
check(
  'mergeSegments',
  mergeSegments([{ start: 5, end: 6 }, { start: 1, end: 2 }, { start: 2, end: 3 }, { start: 2.5, end: 4 }]),
  [{ start: 1, end: 4 }, { start: 5, end: 6 }],
);

// ---------- 节拍图：默认值、拍↔秒换算、跨变速点吸附 ----------

// 11. 旧工程缺少节拍图 → 默认 4/4、120 BPM（每拍 0.5s、每小节 2s）
check('default beatmap', normalizeBeatMap(undefined), {
  beatsPerBar: 4,
  beatUnit: 4,
  startBpm: 120,
  changes: [],
});

{
  const bm = normalizeBeatMap(undefined);
  near('constant beatToTime beat0', beatToTime(0, bm), 0);
  near('constant beatToTime beat4', beatToTime(4, bm), 2); // 第 2 小节首拍
  near('constant beatToTime beat12', beatToTime(12, bm), 6);
  near('constant timeToBeat 3s', timeToBeat(3, bm), 6);
  check('constant location 0', fmtLocation(timeToLocation(0, bm)), '1:1');
  check('constant location 2s', fmtLocation(timeToLocation(2, bm)), '2:1');
  check('constant location 3.5s', fmtLocation(timeToLocation(3.5, bm)), '2:4');
}

// 12. 分段恒速：4/4，第 3 小节首拍（绝对拍 8，t=4s）从 120 → 60 BPM
{
  const bm = normalizeBeatMap({ startBpm: 120, changes: [{ id: uid(), measure: 3, bpm: 60 }] });
  near('tempo change at beat 8', timeToBeat(4, bm), 8);
  near('post-change 1 beat = 1s: t=5 → beat9', timeToBeat(5, bm), 9);
  near('post-change beat10 → t=6', beatToTime(10, bm), 6);
  // 第 4 小节首拍 = 绝对拍 12 = 4 + 4*1 = 8s
  near('bar4 downbeat at 8s', measureBeatToTime(4, 1, bm), 8);
  check('location at 8s', fmtLocation(timeToLocation(8, bm)), '4:1');
  // 换算可逆
  near('roundtrip t=7.3', beatToTime(timeToBeat(7.3, bm), bm), 7.3);
}

// 13. 跨变速点吸附：t=3.9（变速前 120）最近拍是 4.0（变速点本身）；t=4.4（变速后 60）最近拍是 5.0
{
  const bm = normalizeBeatMap({ startBpm: 120, changes: [{ id: uid(), measure: 3, bpm: 60 }] });
  near('snap just before change', snapTimeToBeat(3.9, bm), 4);
  near('snap just after change', snapTimeToBeat(4.6, bm), 5); // beat 8.6 → 9
  near('snap mid post-segment', snapTimeToBeat(6.6, bm), 7); // 最近拍 11 → t=7
}

// 14. 变速点规范化：按拍位排序、重复拍位保留首个；measure=1 并入起始 BPM
{
  const bm = normalizeBeatMap({
    startBpm: 100,
    changes: [
      { id: 'b', measure: 5, bpm: 140 },
      { id: 'a', measure: 3, bpm: 80 },
      { id: 'dup', measure: 3, bpm: 200 },
      { id: 'one', measure: 1, bpm: 110 },
    ],
  });
  check('sorted unique changes', bm.changes.map((c) => [c.measure, c.bpm]), [[3, 80], [5, 140]]);
  check('measure1 folds into startBpm', bm.startBpm, 110);
  // 非法字段回退默认
  const junk = normalizeBeatMap({ beatsPerBar: 99, beatUnit: 0, startBpm: -5, changes: [{ measure: 0 }] });
  check('junk beatmap sanitized', junk, { beatsPerBar: 4, beatUnit: 4, startBpm: 120, changes: [] });
}

// 15. 编辑节拍图后已有换气段秒位置不变，仅拍位重新显示
{
  const p = createSampleProject();
  const before = JSON.stringify(p.singers.map((s) => s.breaths));
  const edited = { ...p, beatMap: updateBeatMap(p.beatMap, { startBpm: 60 }) };
  const after = JSON.stringify(edited.singers.map((s) => s.breaths));
  check('breath seconds untouched by beatmap edit', after, before);
  // 王芳首段 [18,21)：120 BPM 时起点为 10:1；改成 60 BPM 后为 5:3
  check('beat display at 120bpm', fmtLocation(timeToLocation(18, p.beatMap)), '10:1');
  check('beat display at 60bpm', fmtLocation(timeToLocation(18, edited.beatMap)), '5:3');
}

// 16. 按拍放置新换气段：跨变速点仍落在整拍；默认一个小节时长（拍数）
{
  const bm = normalizeBeatMap({ startBpm: 120, changes: [{ id: uid(), measure: 3, bpm: 60 }] });
  // 变速点在 t=4。双击 t=3.0 → 起点 3s（拍6），放 4 拍跨变速：拍 6→10 = 3s→6s
  const seg = placeNewIntervalOnBeat(3.0, [], 20, bm)!;
  near('on-beat start', seg.start, 3);
  near('on-beat end across change', seg.end, 6);
  near('start on integer beat', timeToBeat(seg.start, bm), 6);
  near('end on integer beat', timeToBeat(seg.end, bm), 10);

  // 空隙不足一小节：缩短到放得下的整拍数
  const tight = placeNewIntervalOnBeat(0, [{ start: 2, end: 20 }], 20, bm)!;
  near('tight start', tight.start, 0);
  near('tight end', tight.end, 2); // 4 拍 × 0.5s
  check('tight endpoints integer beats', [
    Number.isInteger(timeToBeat(tight.start, bm)),
    Number.isInteger(timeToBeat(tight.end, bm)),
  ], [true, true]);

  // 空隙小于最小长度 → null
  check('too-small gap', placeNewIntervalOnBeat(0, [{ start: 0.3, end: 20 }], 20, bm), null);
}

// 17. beatTicks 标注变速点：t=4 的刻度标记 tempoChange 且 bpm=60
{
  const bm = normalizeBeatMap({ startBpm: 120, changes: [{ id: uid(), measure: 3, bpm: 60 }] });
  const ticks = beatTicks(bm, 8);
  const at4 = ticks.find((tk) => Math.abs(tk.time - 4) < 1e-9)!;
  check('tick tempoChange flag', at4.tempoChange, true);
  check('tick bpm after change', at4.bpm, 60);
  check('tick measure after change', at4.measure, 3);
  check('first tick flag', ticks[0].tempoChange, true);
}

// ---------- 声部接力排程：拍域枚举、回溯、无解分类 ----------

/** 构造测试工程：n 位同声部歌手（minSingers 门槛），已有换气秒区间按人给出。 */
function relayProject(
  n: number,
  minSingers: number,
  existing: [number, number][][],
  opts: { duration?: number; bpm?: number; changes?: { measure: number; bpm: number }[] } = {},
): Project {
  const partId = uid();
  return {
    name: 'relay-test',
    duration: opts.duration ?? 96,
    beatMap: { beatsPerBar: 4, beatUnit: 4, startBpm: opts.bpm ?? 120, changes: opts.changes ?? [] },
    parts: [{ id: partId, name: '声部', color: '#60a5fa', minSingers }],
    singers: Array.from({ length: n }, (_, i) => ({
      id: uid(),
      name: `歌${i + 1}`,
      partId,
      breaths: (existing[i] ?? []).map(([start, end]) => ({ id: uid(), start, end })),
    })),
  };
}

const nearRelay = (name: string, actual: number, expected: number) =>
  near(name, actual, expected, 1e-9);

// R1. 基本可行：3 人需≥2（cap=1），拍域 0–6 拍、每人 2 拍 → 三人错开，各自不重叠
{
  const p = relayProject(3, 2, []);
  const partId = p.parts[0].id;
  const r = planRelay(p, { partId, startBeat: 0, endBeat: 6, breathBeats: 2 });
  check('R1 ok', r.ok, true);
  if (r.ok) {
    check('R1 one per singer', r.assignments.length, 3);
    check(
      'R1 starts in window',
      r.assignments.map((a) => a.startBeat).sort((a, b) => a - b),
      [0, 2, 4],
    );
    // 任意时刻至多 1 人换气（无重叠，因为相邻半开区间不冲突）
    const ivs = r.assignments.map((a) => [a.startBeat, a.endBeat]).sort((a, b) => a[0] - b[0]);
    check(
      'R1 no overlaps',
      ivs.map((a, i) => (i === 0 ? 0 : a[0] - ivs[i - 1][1])),
      [0, 0, 0],
    );
    // 秒换算：120 BPM → 每拍 0.5s
    nearRelay('R1 first start seconds', r.assignments[0].start, 0);
    nearRelay('R1 first end seconds', r.assignments[0].end, 1);
  }
}

// R2. 门槛内允许同时换气：4 人需≥2（cap=2），拍域 0–4 拍、每人 1 拍
// 任一拍同时换气人数 ≤ 2；半开相邻不计重叠
{
  const p = relayProject(4, 2, []);
  const partId = p.parts[0].id;
  const r = planRelay(p, { partId, startBeat: 0, endBeat: 4, breathBeats: 1 });
  check('R2 ok', r.ok, true);
  if (r.ok) {
    check('R2 four assignments', r.assignments.length, 4);
    const counts = [0, 0, 0, 0];
    for (const a of r.assignments) counts[a.startBeat]++;
    check('R2 within cap each beat', counts.every((c) => c <= 2), true);
  }
}

// R2b. cap=0（4 人需≥4）：不允许任何人换气 → 无解 threshold preexisting（无人可排）
{
  const p = relayProject(4, 4, []);
  const r = planRelay(p, { partId: p.parts[0].id, startBeat: 0, endBeat: 4, breathBeats: 1 });
  check('R2b cap0 threshold', r.ok ? '' : r.reason.kind, 'threshold');
}

// R3. 歌手无可用拍位：2 人 cap=1，拍域 0–2 拍、每人 2 拍
// 第一人空窗口可放，第二人只能放同一区间 → 若门槛允许 2 人同时换气本可以；minSingers=0 时两人都放 0
{
  const p0 = relayProject(2, 0, []);
  const r0 = planRelay(p0, { partId: p0.parts[0].id, startBeat: 0, endBeat: 2, breathBeats: 2 });
  check('R3 min0 both at 0 ok', r0.ok, true);

  // 一人已有换气覆盖整窗 → 本人无位置（无可用拍位）
  const p1 = relayProject(2, 0, [[[0, 10]], []]);
  const r1 = planRelay(p1, { partId: p1.parts[0].id, startBeat: 0, endBeat: 2, breathBeats: 2 });
  check('R3 no-slot kind', r1.ok ? '' : r1.reason.kind, 'no-slot');
  if (!r1.ok && r1.reason.kind === 'no-slot') {
    check('R3 no-slot singer', r1.reason.singerName, '歌1');
  }
}

// R4. 覆盖门槛冲突（组合无解）：3 人需≥2（cap=1），拍域 0–4 拍、每人 2 拍
// 长度 2 的不重叠区间只有 [0,2)、[2,4) 两个 → 第三人放不下而门槛不允许 → threshold
{
  const p = relayProject(3, 2, []);
  const r = planRelay(p, { partId: p.parts[0].id, startBeat: 0, endBeat: 4, breathBeats: 2 });
  check('R4 threshold kind', r.ok ? '' : r.reason.kind, 'threshold');
  if (!r.ok && r.reason.kind === 'threshold') check('R4 combinational', r.reason.preexisting, false);
}

// R5. 既有缺口 → preexisting threshold：cap=0（2 人需≥2）且拍域内已有一人换气
{
  const p = relayProject(2, 2, [[[0.5, 1.5]], []]);
  const r = planRelay(p, { partId: p.parts[0].id, startBeat: 0, endBeat: 4, breathBeats: 1 });
  check('R5 threshold kind', r.ok ? '' : r.reason.kind, 'threshold');
  if (!r.ok && r.reason.kind === 'threshold') check('R5 preexisting', r.reason.preexisting, true);
}

// R6. 歌手总数低于门槛 → preexisting threshold
{
  const p = relayProject(1, 2, []);
  const r = planRelay(p, { partId: p.parts[0].id, startBeat: 0, endBeat: 4, breathBeats: 1 });
  check('R6 threshold kind', r.ok ? '' : r.reason.kind, 'threshold');
  if (!r.ok && r.reason.kind === 'threshold') check('R6 preexisting', r.reason.preexisting, true);
}

// R7. 跨变速点：4/4，第 3 小节首拍（拍 8，t=4s）120→60；拍域 6–10、每人 1 拍，3 人 cap=1
// 起点拍为整数，秒随所在段 BPM 不同
{
  const p = relayProject(
    3,
    2,
    [],
    { duration: 30, changes: [{ measure: 3, bpm: 60 }] },
  );
  const r = planRelay(p, { partId: p.parts[0].id, startBeat: 6, endBeat: 10, breathBeats: 1 });
  check('R7 ok', r.ok, true);
  if (r.ok) {
    for (const a of r.assignments) {
      check('R7 start integer beat', Number.isInteger(a.startBeat), true);
      nearRelay('R7 start beat conversion', a.start, beatToTime(a.startBeat, p.beatMap));
      nearRelay('R7 end beat conversion', a.end, beatToTime(a.endBeat, p.beatMap));
    }
    // 恰好跨变速点：拍 8 → 4s；起点 6 → 3s，拍 7 → 3.5s，拍 9 → 5s
    const at6 = r.assignments.find((a) => a.startBeat === 6)!;
    nearRelay('R7 beat6 at 3s', at6.start, 3);
    nearRelay('R7 beat7 0.5s long', beatToTime(7, p.beatMap) - beatToTime(6, p.beatMap), 0.5);
    nearRelay('R7 beat9 1s long', beatToTime(10, p.beatMap) - beatToTime(9, p.beatMap), 1);
  }
}

// R8. 与本人已有换气错开：第一人已有 [拍2,拍4)（秒 1–2s），2 人 cap=2（min0）拍域 0–6、每人2拍
// 第一人只能避开自己的 [2,4)；方案仍成立
{
  const p = relayProject(2, 0, [[[1, 2]], []]); // 秒：120bpm 下拍2=1s、拍4=2s
  const singer1 = p.singers[0].id;
  const r = planRelay(p, { partId: p.parts[0].id, startBeat: 0, endBeat: 6, breathBeats: 2 });
  check('R8 ok', r.ok, true);
  if (r.ok) {
    const a1 = r.assignments.find((a) => a.singerId === singer1)!;
    const overlap = a1.startBeat < 4 - 1e-9 && 2 < a1.endBeat - 1e-9;
    check('R8 avoids own breath', overlap, false);
  }
}

// R9. 一次写入：applyRelay 每人追加一段，其它字段不变
{
  const p = relayProject(2, 0, [[[8, 9]], []]);
  const beforeCount = p.singers.map((s) => s.breaths.length);
  const r = planRelay(p, { partId: p.parts[0].id, startBeat: 0, endBeat: 4, breathBeats: 1 });
  if (r.ok) {
    const p2 = applyRelay(p, r.assignments);
    check(
      'R9 appended',
      p2.singers.map((s) => s.breaths.length),
      [beforeCount[0] + 1, beforeCount[1] + 1],
    );
    check('R9 first keeps old', p2.singers[0].breaths.some((b) => b.start === 8 && b.end === 9), true);
    check('R9 project immutable', p.singers[0].breaths.length, beforeCount[0]);
  }
}

// R10. 拍域越出全曲 → invalid
{
  const p = relayProject(2, 1, [], { duration: 2 }); // 120bpm 2s = 4 拍
  const r = planRelay(p, { partId: p.parts[0].id, startBeat: 0, endBeat: 6, breathBeats: 1 });
  check('R10 invalid', r.ok ? '' : r.reason.kind, 'invalid');
}

// R11. no-slot 优先于 threshold：第一人无任何位置，同时组合本身也不可能满足门槛
{
  // 4 人需≥3（cap=1），拍域 0–4、每人2拍（可行组合只有 2 个位置）；
  // 且第一人已有换气占满拍域 → 其本人无位置
  const p = relayProject(4, 3, [[[0, 10]], [], [], []]);
  const r = planRelay(p, { partId: p.parts[0].id, startBeat: 0, endBeat: 4, breathBeats: 2 });
  check('R11 no-slot precedence', r.ok ? '' : r.reason.kind, 'no-slot');
}

// R12. 拍域/拍数换算辅助
{
  const bm = normalizeBeatMap({ beatsPerBar: 4 });
  check('R12 measureBeatToAbs 1:1', measureBeatToAbs(bm, 1, 1), 0);
  check('R12 measureBeatToAbs 3:2', measureBeatToAbs(bm, 3, 2), 9);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
