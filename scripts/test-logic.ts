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

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
