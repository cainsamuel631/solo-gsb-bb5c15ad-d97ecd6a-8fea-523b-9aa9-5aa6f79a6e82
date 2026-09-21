import type { BeatMap, Project } from '../types';
import { beatToTime, timeToBeat } from './tempo';
import { uid } from './id';

/**
 * 声部接力排程：在给定拍域内，为声部每位歌手各安排一段等长（整拍数）的新换气。
 * 全部候选位置在拍域按整拍枚举，再经节拍图换算为秒（跨变速点拍长自动变化），
 * 用回溯搜索同时满足：
 *   1. 区间不越出拍域（半开 [startBeat, endBeat)）；
 *   2. 不与该歌手已有换气重叠（半开区间相邻允许）；
 *   3. 拍域内任一时刻同时换气人数 ≤ 歌手总数 − 最低发声人数。
 */

const EPS = 1e-6;
/** 回溯节点安全上限（常规合唱规模远不会触及）。 */
const NODE_CAP = 1_000_000;

export interface RelayRequest {
  partId: string;
  /** 拍域起始绝对拍（0 起算整数，含） */
  startBeat: number;
  /** 拍域结束绝对拍（0 起算整数，不含） */
  endBeat: number;
  /** 每人换气拍数（正整数） */
  breathBeats: number;
}

export interface RelayAssignment {
  singerId: string;
  /** 起始绝对拍（整数） */
  startBeat: number;
  /** 结束绝对拍（整数，不含） */
  endBeat: number;
  /** 起始秒（跨变速点换算） */
  start: number;
  /** 结束秒（不含） */
  end: number;
}

/** 无解原因：歌手无可用拍位 / 覆盖门槛冲突 / 入参不合法。 */
export type RelayFailure =
  | { kind: 'no-slot'; singerId: string; singerName: string }
  | {
      kind: 'threshold';
      /** true：拍域内现有换气（或歌手总数本身不足）已导致不达标，非接力排布造成 */
      preexisting: boolean;
      /** 触及回溯安全上限（搜索空间过大） */
      exhausted?: boolean;
      /** 不达标时段总秒数（仅 preexisting） */
      detailSeconds?: number;
    }
  | { kind: 'invalid'; message: string };

export type RelayResult = { ok: true; assignments: RelayAssignment[] } | { ok: false; reason: RelayFailure };

export interface RelayPlan {
  req: RelayRequest;
  result: RelayResult;
}

/** 成功方案的便捷取法。 */
export function planAssignments(plan: RelayPlan): RelayAssignment[] {
  return plan.result.ok ? plan.result.assignments : [];
}

interface BInterval {
  s: number;
  e: number;
}

/** 小节号 / 小节内拍（均 1 起算）→ 绝对拍。 */
export function measureBeatToAbs(beatMap: BeatMap, measure: number, beatInBar: number): number {
  return (measure - 1) * beatMap.beatsPerBar + (beatInBar - 1);
}

/** 绝对拍 → 小节号 / 小节内拍（均 1 起算）。 */
export function absToMeasureBeat(beatMap: BeatMap, abs: number): { measure: number; beatInBar: number } {
  const bpb = beatMap.beatsPerBar;
  const measure = Math.floor(abs / bpb) + 1;
  return { measure, beatInBar: abs - (measure - 1) * bpb + 1 };
}

/** 拍域对应的秒域。 */
export function relayWindowSeconds(
  beatMap: BeatMap,
  startBeat: number,
  endBeat: number,
): { start: number; end: number } {
  return { start: beatToTime(startBeat, beatMap), end: beatToTime(endBeat, beatMap) };
}

/** 由现有换气秒区间生成拍域内的「同时换气人数」分段表（半开语义，同一时刻事件先结算）。 */
function sweepCounts(intervals: BInterval[]): (BInterval & { c: number })[] {
  const events: { t: number; d: number }[] = [];
  for (const it of intervals) events.push({ t: it.s, d: 1 }, { t: it.e, d: -1 });
  events.sort((a, b) => a.t - b.t);
  const out: (BInterval & { c: number })[] = [];
  let count = 0;
  let segStart: number | null = null;
  let i = 0;
  while (i < events.length) {
    const t = events[i].t;
    if (segStart !== null && t - segStart > EPS) out.push({ s: segStart, e: t, c: count });
    while (i < events.length && Math.abs(events[i].t - t) <= EPS) {
      count += events[i].d;
      i++;
    }
    segStart = count > 0 ? t : null;
  }
  return out;
}

/**
 * 执行接力排程搜索。
 * 无解分类：先逐人检查「拍域 + 本人已有换气」下的候选拍位，空集即「歌手无可用拍位」；
 * 候选均存在但回溯找不到满足人数门槛的组合，则为「覆盖门槛冲突」。
 */
export function planRelay(project: Project, req: RelayRequest): RelayResult {
  const fail = (reason: RelayFailure): RelayResult => ({ ok: false, reason });

  const part = project.parts.find((p) => p.id === req.partId);
  if (!part) return fail({ kind: 'invalid', message: '声部不存在' });
  const singers = project.singers.filter((s) => s.partId === part.id);
  if (singers.length === 0) return fail({ kind: 'invalid', message: '该声部暂无歌手' });

  const startBeat = Math.round(req.startBeat);
  const endBeat = Math.round(req.endBeat);
  const breathBeats = Math.round(req.breathBeats);
  if (
    ![startBeat, endBeat, breathBeats].every(Number.isFinite) ||
    startBeat < 0 ||
    endBeat <= startBeat ||
    breathBeats < 1 ||
    breathBeats > endBeat - startBeat
  ) {
    return fail({ kind: 'invalid', message: '拍域或每人换气拍数不合法' });
  }

  const beatMap = project.beatMap;
  const win = relayWindowSeconds(beatMap, startBeat, endBeat);
  if (win.end > project.duration + 1e-6) {
    return fail({ kind: 'invalid', message: '结束拍位已超出全曲时长' });
  }

  // 允许同时换气的最大人数
  const cap = singers.length - part.minSingers;

  // 现有换气统一换算到拍域；声部区间裁剪到拍域，供门槛扫描
  const ownOf = new Map<string, BInterval[]>();
  const partExisting: BInterval[] = [];
  for (const s of singers) {
    const list: BInterval[] = s.breaths
      .map((b) => ({ s: timeToBeat(b.start, beatMap), e: timeToBeat(b.end, beatMap) }))
      .filter((o) => o.e - o.s > EPS);
    ownOf.set(s.id, list);
    for (const o of list) {
      const cs = Math.max(o.s, startBeat);
      const ce = Math.min(o.e, endBeat);
      if (ce - cs > EPS) partExisting.push({ s: cs, e: ce });
    }
  }

  const base = sweepCounts(partExisting);

  /** 拍域内某时刻的现有换气人数（base 分段外为 0）。 */
  const baseCountAt = (x: number): number => {
    let lo = 0;
    let hi = base.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (base[mid].s <= x) lo = mid + 1;
      else hi = mid;
    }
    const seg = base[lo - 1];
    return seg && seg.s <= x && x < seg.e - EPS ? seg.c : 0;
  };

  // 歌手总数低于门槛 → 拍域全程不达标
  if (cap < 0) {
    return fail({ kind: 'threshold', preexisting: true, detailSeconds: win.end - win.start });
  }
  // 现有换气已使拍域内某时段不达标 → 接力无法修复
  const preUnder = base.filter((g) => g.c > cap);
  if (preUnder.length > 0) {
    const detailSeconds = preUnder.reduce((acc, g) => acc + (beatToTime(g.e, beatMap) - beatToTime(g.s, beatMap)), 0);
    return fail({ kind: 'threshold', preexisting: true, detailSeconds });
  }

  // 逐人枚举「几何」候选起始拍：仅受越窗与本人已有换气约束。
  // 门槛约束交给回溯中的 feasible 判定，以便区分两类无解：
  // 几何候选为空 → 歌手无可用拍位；几何候选均在但排布不满足门槛 → 覆盖门槛冲突。
  const slotsOf = new Map<string, number[]>();
  for (const s of singers) {
    const own = ownOf.get(s.id)!;
    const slots: number[] = [];
    for (let b = startBeat; b <= endBeat - breathBeats; b++) {
      if (own.some((o) => b < o.e - EPS && o.s < b + breathBeats - EPS)) continue;
      slots.push(b);
    }
    slotsOf.set(s.id, slots);
  }
  const blocked = singers.find((s) => slotsOf.get(s.id)!.length === 0);
  if (blocked) {
    return fail({ kind: 'no-slot', singerId: blocked.id, singerName: blocked.name });
  }

  // ---------- 回溯搜索（动态 MRV：每步选当前可行位置最少的歌手） ----------
  interface Placed {
    singerId: string;
    b0: number;
    b1: number;
  }
  const placed: Placed[] = [];
  let nodes = 0;
  let exhausted = false;

  /** 候选 [b, b+breathBeats) 与已放置区间叠加后，拍域内人数是否始终不超门槛。 */
  const feasible = (b: number): boolean => {
    const b1 = b + breathBeats;
    const cuts = new Set<number>([b, b1]);
    for (const p of placed) {
      if (p.b1 <= b + EPS || p.b0 >= b1 - EPS) continue;
      cuts.add(Math.max(p.b0, b));
      cuts.add(Math.min(p.b1, b1));
    }
    const xs = [...cuts].sort((a, c) => a - c);
    for (let i = 0; i + 1 < xs.length; i++) {
      const x0 = xs[i];
      const x1 = xs[i + 1];
      if (x1 - x0 <= EPS) continue;
      const mid = (x0 + x1) / 2;
      let count = baseCountAt(mid);
      for (const p of placed) {
        if (p.b0 <= mid + EPS && p.b1 > mid + EPS) count++;
      }
      if (count + 1 > cap) return false;
    }
    return true;
  };

  const dfs = (): boolean => {
    if (placed.length === singers.length) return true;
    if (++nodes > NODE_CAP) {
      exhausted = true;
      return false;
    }
    const assigned = new Set(placed.map((p) => p.singerId));
    let bestId: string | null = null;
    let bestSlots: number[] | null = null;
    for (const s of singers) {
      if (assigned.has(s.id)) continue;
      const feas = slotsOf.get(s.id)!.filter(feasible);
      if (feas.length === 0) return false; // 该分支下此歌手已无位置，整条分支必死
      if (!bestSlots || feas.length < bestSlots.length) {
        bestId = s.id;
        bestSlots = feas;
      }
    }
    if (!bestId || !bestSlots) return false;
    for (const b of bestSlots) {
      placed.push({ singerId: bestId, b0: b, b1: b + breathBeats });
      if (dfs()) return true;
      placed.pop();
    }
    return false;
  };

  if (!dfs()) {
    return fail({ kind: 'threshold', preexisting: false, exhausted });
  }

  const bySinger = new Map(placed.map((p) => [p.singerId, p]));
  const assignments: RelayAssignment[] = singers.map((s) => {
    const p = bySinger.get(s.id)!;
    return {
      singerId: s.id,
      startBeat: p.b0,
      endBeat: p.b1,
      start: beatToTime(p.b0, beatMap),
      end: beatToTime(p.b1, beatMap),
    };
  });
  return { ok: true, assignments };
}

/** 把排程结果一次性写入工程（不可变更新）：每位歌手追加一段新换气。 */
export function applyRelay(project: Project, assignments: RelayAssignment[]): Project {
  const bySinger = new Map(assignments.map((a) => [a.singerId, a]));
  return {
    ...project,
    singers: project.singers.map((s) => {
      const a = bySinger.get(s.id);
      return a ? { ...s, breaths: [...s.breaths, { id: uid(), start: a.start, end: a.end }] } : s;
    }),
  };
}
