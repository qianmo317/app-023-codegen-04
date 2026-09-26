// 整台编排：把几段锣鼓按顺序接成一台，处理接头（拍数不一致补过渡小节），
// 并按每段各自的速度计算起止时间与总时长。
//
// 时间原则与单段一致：格是唯一整数时间单位；每块用「自己 bpm 的每格秒数」独立换算，
// 块间只累加秒数，不在块内做浮点递推 → 无累积漂移。
import {
  TICKS_PER_BEAT,
  type Bar,
  type Hit,
  type Program,
  type ProgramBlock,
  type ProgramItem,
  type ProgramTimeline,
  type ResolvedSegment,
  type ScheduleEvent,
  type Score,
  type SegmentTiming,
  type Step,
} from '../types';
import { barTicks } from './grid';
import { tickSeconds } from './audio';

/** 取小节强拍（第 1 拍）上的击点；散板同样只取小节首拍 */
export function downbeatHits(bar: Bar): Hit[] {
  if (bar.steps.length === 0) return [];
  const first = bar.steps[0];
  if (first.rest) return [];
  // 强拍必须从小节第 0 格开始；首 step 若带连线（跨小节延续）也照用其字
  return first.hits.map((h) => ({ ...h }));
}

/**
 * 构造接头过渡小节：
 * - 拍数不同才补；过渡小节采用「后段」拍号（凑满后段整小节，让后段从自己的强拍整齐进入）；
 * - 只留后段首小节强拍（第 1 拍）上的字，其余各拍补整拍休止；
 * - 速度随后段（计时在后段块上处理）。
 * 返回 null 表示两段拍数相同、无需过渡。
 */
export function buildTransitionBar(prevBpb: number, next: Score, index: number): Bar | null {
  const nextBpb = next.bars[0]?.beatsPerBar ?? 4;
  if (prevBpb === nextBpb) return null;
  const steps: Step[] = [];
  const strong = downbeatHits(next.bars[0]);
  if (strong.length > 0) steps.push({ beats: TICKS_PER_BEAT, hits: strong });
  else steps.push({ beats: TICKS_PER_BEAT, hits: [], rest: true });
  for (let beat = 1; beat < nextBpb; beat++) steps.push({ beats: TICKS_PER_BEAT, hits: [], rest: true });
  return { index, beatsPerBar: nextBpb, steps, tempoNote: '过渡' };
}

/** 把参演段关联上现存曲目（缺失回退 null，由调用方提示） */
export function resolveSegments(items: ProgramItem[], scores: Score[]): ResolvedSegment[] {
  const byId = new Map(scores.map((s) => [s.id, s]));
  return items.map((item) => {
    const score = byId.get(item.scoreId) ?? null;
    return { item, score, missing: score === null };
  });
}

interface ActiveSegment {
  item: ProgramItem;
  score: Score;
  bpb: number;
}

/**
 * 纯函数：由参演段（按顺序）算出整台时间轴。
 * 每段按各自 bpm 计时；相邻段拍数不同时中间插 1 个过渡小节（过渡按后段 bpm）。
 * 输出：逐块时间（含过渡）+ 每段占多少小节、从第几小节到第几小节 + 总时长。
 */
export function buildProgramTimeline(segments: ResolvedSegment[]): ProgramTimeline {
  const active: ActiveSegment[] = segments
    .filter((r) => r.item.included && !r.missing && r.score)
    .map((r) => ({ item: r.item, score: r.score!, bpb: r.score!.bars[0]?.beatsPerBar ?? 4 }));

  const missingKeys = segments.filter((r) => r.item.included && r.missing).map((r) => r.item.key);

  const blocks: ProgramBlock[] = [];
  const timingMap = new Map<string, SegmentTiming>();

  let cursorBar = 0; // 整台已用小节数（0 起）
  let cursorS = 0; // 整台已用秒数

  active.forEach((seg, i) => {
    const prev = i > 0 ? active[i - 1] : null;
    let transition: Bar | null = null;
    if (prev) transition = buildTransitionBar(prev.bpb, seg.score, cursorBar);

    if (transition) {
      const tBars = [transition];
      const tDuration = (barTicks(transition.beatsPerBar) * tickSeconds(seg.score.bpm));
      blocks.push({
        kind: 'transition',
        itemKey: seg.item.key,
        title: `过渡（接 ${seg.item.title}）`,
        bars: tBars,
        bpm: seg.score.bpm,
        barCount: 1,
        fromBar: cursorBar + 1,
        toBar: cursorBar + 1,
        startS: cursorS,
        endS: cursorS + tDuration,
        durationS: tDuration,
        joint: { from: prev!.bpb, to: seg.bpb },
      });
      cursorBar += 1;
      cursorS += tDuration;
    }

    const segStartBar = cursorBar + 1;
    const segStartS = cursorS;
    const segTicks = seg.score.bars.reduce((sum, b) => sum + barTicks(b.beatsPerBar), 0);
    const segDuration = segTicks * tickSeconds(seg.score.bpm);
    const segBars = seg.score.bars.map((b, bi) => ({ ...b, index: cursorBar + bi }));

    blocks.push({
      kind: 'segment',
      itemKey: seg.item.key,
      title: seg.item.title,
      bars: segBars,
      bpm: seg.score.bpm,
      barCount: seg.score.bars.length,
      fromBar: segStartBar,
      toBar: cursorBar + segBars.length,
      startS: segStartS,
      endS: segStartS + segDuration,
      durationS: segDuration,
    });

    timingMap.set(seg.item.key, {
      key: seg.item.key,
      title: seg.item.title,
      bpm: seg.score.bpm,
      beatsPerBar: seg.bpb,
      ownBars: seg.score.bars.length,
      fromBar: segStartBar,
      toBar: cursorBar + segBars.length,
      startS: segStartS,
      endS: segStartS + segDuration,
      durationS: segDuration,
      missing: false,
      transitionBefore: transition !== null,
    });

    cursorBar += segBars.length;
    cursorS += segDuration;
  });

  // 段表按原始参演顺序输出（含被抽掉/缺失的行，由 UI 决定如何呈现）
  const segmentTimings: SegmentTiming[] = segments.map((r) => {
    const t = timingMap.get(r.item.key);
    if (t) return t;
    const bpb = r.score?.bars[0]?.beatsPerBar ?? r.item.beatsPerBar;
    return {
      key: r.item.key,
      title: r.item.title,
      bpm: r.score?.bpm ?? r.item.bpm,
      beatsPerBar: bpb,
      ownBars: r.score?.bars.length ?? r.item.bars,
      fromBar: 0,
      toBar: 0,
      startS: 0,
      endS: 0,
      durationS: 0,
      missing: r.missing,
      transitionBefore: false,
    };
  });

  return {
    blocks,
    segments: segmentTimings,
    totalBars: cursorBar,
    totalDurationS: cursorS,
    missingKeys,
  };
}

/** 整台涉及的乐器并集（过渡小节的字来自后段乐器，已含在各段内） */
export function programInstruments(segments: ResolvedSegment[]): Score['instruments'] {
  const seen = new Set<string>();
  const out: Score['instruments'] = [];
  for (const r of segments) {
    if (!r.item.included || !r.score) continue;
    for (const inst of r.score.instruments) {
      if (!seen.has(inst.id)) {
        seen.add(inst.id);
        out.push(inst);
      }
    }
  }
  return out;
}

/**
 * 纯函数：整台多速度事件展开。逐块用各自 bpm 把绝对格换算到整台秒时间轴，
 * 每击独立重算（块起点 + 块内绝对格 × 本块每格秒数），无累加漂移。
 */
export function computeProgramEvents(
  timeline: ProgramTimeline,
  instruments: Score['instruments'],
  startTime: number,
): ScheduleEvent[] {
  const instMap = new Map(instruments.map((i) => [i.id, i]));
  const events: ScheduleEvent[] = [];
  for (const block of timeline.blocks) {
    const per = tickSeconds(block.bpm);
    let blockTick = 0;
    for (const bar of block.bars) {
      let off = 0;
      for (const step of bar.steps) {
        if (!step.rest && step.hits.length > 0) {
          for (const hit of step.hits) {
            if (!instMap.has(hit.instrumentId)) continue;
            const inst = instMap.get(hit.instrumentId)!;
            events.push({
              time: startTime + block.startS + (blockTick + off) * per,
              barIndex: bar.index,
              offset: off,
              instrumentId: hit.instrumentId,
              hit: { ...hit },
              glyph: hit.glyph ?? inst.glyphs[0],
              durationTicks: step.beats,
            });
          }
        }
        off += step.beats;
      }
      blockTick += barTicks(bar.beatsPerBar);
    }
  }
  return events.sort((a, b) => a.time - b.time);
}

// ---------- 编排操作（不可变；任何改动后时间轴整体重算） ----------

export function emptyProgram(id: string, title = '未命名一台'): Program {
  return { id, title, items: [], updatedAt: Date.now() };
}

/** 加入一段（同曲可重复加入） */
export function addSegment(program: Program, score: Score): Program {
  const item: ProgramItem = {
    key: `${score.id}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    scoreId: score.id,
    title: score.title,
    bpm: score.bpm,
    beatsPerBar: score.bars[0]?.beatsPerBar ?? 4,
    bars: score.bars.length,
    included: true,
  };
  return { ...program, items: [...program.items, item], updatedAt: Date.now() };
}

/** 前移 / 后移（被抽掉的段也占位置，一并参与排序） */
export function moveItem(program: Program, key: string, dir: -1 | 1): Program {
  const idx = program.items.findIndex((i) => i.key === key);
  const j = idx + dir;
  if (idx < 0 || j < 0 || j >= program.items.length) return program;
  const items = [...program.items];
  [items[idx], items[j]] = [items[j], items[idx]];
  return { ...program, items, updatedAt: Date.now() };
}

/** 临时抽掉 / 放回（保留行与顺序） */
export function toggleItemIncluded(program: Program, key: string): Program {
  return {
    ...program,
    items: program.items.map((i) => (i.key === key ? { ...i, included: !i.included } : i)),
    updatedAt: Date.now(),
  };
}

/** 彻底移出本台 */
export function removeItem(program: Program, key: string): Program {
  return { ...program, items: program.items.filter((i) => i.key !== key), updatedAt: Date.now() };
}

/** 退回：用之前保存的编排快照整体覆盖 */
export function restoreProgram(program: Program, snapshot: Program): Program {
  return { ...program, title: snapshot.title, items: snapshot.items.map((i) => ({ ...i })), updatedAt: Date.now() };
}

/** 深拷贝快照（进入编排时存「没排之前的样子」） */
export function snapshotProgram(program: Program): Program {
  return { ...program, items: program.items.map((i) => ({ ...i })) };
}

/** mm:ss.t 时长展示（总时长与起止时间共用） */
export function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}
