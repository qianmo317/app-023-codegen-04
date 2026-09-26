// 排台：把若干段锣鼓按顺序接成一台节目。
// 接缝处理、时间线、顺序调整全部为纯函数（不碰 IndexedDB / AudioContext），便于测试。
import { TICKS_PER_BEAT, type Bar, type Instrument, type Medley, type Score, type Step } from '../types';
import { barTicks, totalTicks } from './grid';
import { tickSeconds } from './audio';
import { newId } from './storage';

/** 强拍（含次强拍）的拍序号：4 拍 → [0, 2]（强/次强），其余 → [0]（第 1 拍必为强拍） */
export function strongBeatIndices(beatsPerBar: number): number[] {
  if (beatsPerBar >= 4) return [0, 2];
  return [0];
}

/** 不满整小节的 bar 末尾补休止凑满（接缝处不留零碎格）。返回新数组，原数据不动。 */
export function padToFullBars(bars: Bar[]): Bar[] {
  return bars.map((b) => {
    const total = b.steps.reduce((s, st) => s + st.beats, 0);
    const full = barTicks(b.beatsPerBar);
    if (total >= full) return b;
    return { ...b, steps: [...b.steps, { beats: full - total, hits: [], rest: true }] };
  });
}

/**
 * 过渡小节：插在两段拍数不同的接缝处，用下一段的拍号与速度，
 * 以下一段首小节为模板，只留强拍（含次强拍）上的字，其余一律补休止。
 */
export function transitionBar(next: Score, index: number): Bar {
  const tpl = next.bars[0];
  const bpb = tpl?.beatsPerBar ?? 4;
  const full = barTicks(bpb);
  const strong = strongBeatIndices(bpb);
  const steps: Step[] = [];
  let off = 0;
  for (const st of tpl?.steps ?? []) {
    if (off >= full) break; // 模板本身超长：只取整小节内的部分
    const onStrong = off % TICKS_PER_BEAT === 0 && strong.includes(off / TICKS_PER_BEAT);
    if (onStrong && st.hits.length > 0 && !st.rest) {
      steps.push({ beats: st.beats, hits: st.hits.map((h) => ({ ...h })) });
    } else {
      steps.push({ beats: st.beats, hits: [], rest: true });
    }
    off += st.beats;
  }
  if (steps.length === 0) steps.push({ beats: full, hits: [], rest: true });
  else if (off < full) steps.push({ beats: full - off, hits: [], rest: true });
  return { index, beatsPerBar: bpb, steps, bpm: next.bpm, tempoNote: '过渡' };
}

/**
 * 合成一台：各段小节顺接（每小节带上本段 bpm），
 * 相邻两段拍数不同则在接缝插入一小节过渡；末小节不满先补满。
 */
export function composeMedley(title: string, segments: Score[]): Score {
  const instruments: Instrument[] = [];
  const seen = new Set<string>();
  for (const seg of segments) {
    for (const inst of seg.instruments) {
      if (!seen.has(inst.id)) {
        seen.add(inst.id);
        instruments.push(inst);
      }
    }
  }
  const bars: Bar[] = [];
  segments.forEach((seg, si) => {
    if (si > 0) {
      const prev = segments[si - 1];
      const prevBpb = prev.bars[prev.bars.length - 1]?.beatsPerBar ?? 4;
      const nextBpb = seg.bars[0]?.beatsPerBar ?? 4;
      if (prevBpb !== nextBpb) bars.push(transitionBar(seg, bars.length));
    }
    for (const b of padToFullBars(seg.bars)) {
      bars.push({ ...b, index: bars.length, bpm: seg.bpm, steps: b.steps.map((st) => ({ ...st })) });
    }
  });
  return {
    id: newId(),
    title,
    bpm: segments[0]?.bpm ?? 100,
    bars,
    instruments,
    freeMeter: false,
    updatedAt: Date.now(),
  };
}

// ---------- 时间线（每段起止小节 / 起止时间，按各自速度算） ----------

/** 一段在排台中的快照信息（由 Score 提取，供时间线计算） */
export interface MedleySegment {
  scoreId: string;
  title: string;
  bpm: number;
  firstBeatsPerBar: number; // 首小节拍数（接缝判断用）
  lastBeatsPerBar: number; // 末小节拍数（接缝判断用）
  barCount: number;
  ticks: number; // 全段总格数（按各小节实际拍数求和）
}

export function segmentOf(score: Score): MedleySegment {
  return {
    scoreId: score.id,
    title: score.title,
    bpm: score.bpm,
    firstBeatsPerBar: score.bars[0]?.beatsPerBar ?? 4,
    lastBeatsPerBar: score.bars[score.bars.length - 1]?.beatsPerBar ?? 4,
    barCount: score.bars.length,
    ticks: totalTicks(score.bars),
  };
}

/** 时间线上的一项：一段正曲，或一小节过渡 */
export interface MedleyPart {
  kind: 'segment' | 'transition';
  scoreId?: string;
  title: string;
  bpm: number;
  beatsPerBar: number;
  barCount: number;
  fromBar: number; // 在整台中的起始小节号（1 起，含）
  toBar: number; // 结束小节号（含）
  startSec: number; // 在整台中的起止时间（秒）
  endSec: number;
}

/**
 * 计算整台时间线：与 composeMedley 同一套接缝规则（拍数不同插一小节过渡，
 * 过渡用下一段拍号与速度），每段时长 = 总格数 × 每格秒数（按本段 bpm）。
 */
export function computeMedleyTimeline(segments: MedleySegment[]): {
  parts: MedleyPart[];
  totalSec: number;
  totalBars: number;
} {
  const parts: MedleyPart[] = [];
  let bar = 1;
  let t = 0;
  segments.forEach((seg, i) => {
    if (i > 0 && segments[i - 1].lastBeatsPerBar !== seg.firstBeatsPerBar) {
      const sec = barTicks(seg.firstBeatsPerBar) * tickSeconds(seg.bpm);
      parts.push({
        kind: 'transition',
        title: `过渡（${seg.firstBeatsPerBar}/4 · 只留强拍）`,
        bpm: seg.bpm,
        beatsPerBar: seg.firstBeatsPerBar,
        barCount: 1,
        fromBar: bar,
        toBar: bar,
        startSec: t,
        endSec: t + sec,
      });
      bar += 1;
      t += sec;
    }
    const sec = seg.ticks * tickSeconds(seg.bpm);
    parts.push({
      kind: 'segment',
      scoreId: seg.scoreId,
      title: seg.title,
      bpm: seg.bpm,
      beatsPerBar: seg.firstBeatsPerBar,
      barCount: seg.barCount,
      fromBar: bar,
      toBar: bar + seg.barCount - 1,
      startSec: t,
      endSec: t + sec,
    });
    bar += seg.barCount;
    t += sec;
  });
  return { parts, totalSec: t, totalBars: bar - 1 };
}

// ---------- 排台记录操作（顺序调整 / 抽掉 / 放回） ----------

export function emptyMedley(): Medley {
  return { id: 'current', title: '当前排台', items: [], removed: [], updatedAt: Date.now() };
}

/** 把一段加到台尾（已在台里或已抽掉的不重复加） */
export function medleyAdd(m: Medley, scoreId: string): Medley {
  if (m.items.includes(scoreId) || m.removed.some((r) => r.scoreId === scoreId)) return m;
  return { ...m, items: [...m.items, scoreId], updatedAt: Date.now() };
}

/** 调整前后顺序：把 from 位置的段挪到 to 位置 */
export function medleyMove(m: Medley, from: number, to: number): Medley {
  if (from === to || from < 0 || to < 0 || from >= m.items.length || to >= m.items.length) return m;
  const items = [...m.items];
  const [x] = items.splice(from, 1);
  items.splice(to, 0, x);
  return { ...m, items, updatedAt: Date.now() };
}

/** 临时抽掉一段（记录原位置，可放回） */
export function medleyRemove(m: Medley, index: number): Medley {
  if (index < 0 || index >= m.items.length) return m;
  const items = [...m.items];
  const [scoreId] = items.splice(index, 1);
  return { ...m, items, removed: [...m.removed, { scoreId, index }], updatedAt: Date.now() };
}

/** 把抽掉的段放回原位置（原位置越界则放到台尾） */
export function medleyRestore(m: Medley, scoreId: string): Medley {
  const rec = m.removed.find((r) => r.scoreId === scoreId);
  if (!rec) return m;
  const items = [...m.items];
  items.splice(Math.min(rec.index, items.length), 0, scoreId);
  return { ...m, items, removed: m.removed.filter((r) => r.scoreId !== scoreId), updatedAt: Date.now() };
}
