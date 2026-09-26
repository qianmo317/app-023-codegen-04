// 整台编排用例 —— 接头过渡小节、多速度时间轴、段时间/小节号、抽段重排、退回快照
import { describe, expect, it } from 'vitest';
import {
  TICKS_PER_BEAT,
  type Program,
  type ProgramItem,
  type Score,
} from '../src/types';
import { barTicks, isBarFull } from '../src/lib/grid';
import { tickSeconds } from '../src/lib/audio';
import {
  addSegment,
  buildProgramTimeline,
  buildTransitionBar,
  computeProgramEvents,
  downbeatHits,
  emptyProgram,
  formatSeconds,
  moveItem,
  programInstruments,
  removeItem,
  resolveSegments,
  restoreProgram,
  snapshotProgram,
  toggleItemIncluded,
} from '../src/lib/program';
import { scoreFromPattern, PATTERNS, newEmptyScore, DEFAULT_INSTRUMENTS } from '../src/lib/factory';

const findPattern = (name: string) => PATTERNS.find((p) => p.name === name)!;
const gu = DEFAULT_INSTRUMENTS.find((i) => i.id === 'gu')!;
const daluo = DEFAULT_INSTRUMENTS.find((i) => i.id === 'daluo')!;

/** 构造一个 bpb 一致、可在指定拍位放 hit 的简单段 */
function makeScore(id: string, bpm: number, bpb: number, barCount: number): Score {
  const s = newEmptyScore(id, bpb, barCount);
  s.id = id;
  s.bpm = bpm;
  return s;
}

/** 在某小节某拍（整拍）放一击 */
function putBeat(s: Score, bar: number, beat: number, glyph = '咚', inst = gu): Score {
  const step = s.bars[bar].steps[beat]; // emptyBar 每步恰为整拍 4 格
  step.hits.push({ instrumentId: inst.id, velocity: 2, glyph });
  return s;
}

function itemFor(score: Score, overrides: Partial<ProgramItem> = {}): ProgramItem {
  return {
    key: `k_${score.id}`,
    scoreId: score.id,
    title: score.title,
    bpm: score.bpm,
    beatsPerBar: score.bars[0]?.beatsPerBar ?? 4,
    bars: score.bars.length,
    included: true,
    ...overrides,
  };
}

function timelineOf(items: ProgramItem[], scores: Score[]) {
  return buildProgramTimeline(resolveSegments(items, scores));
}

describe('过渡小节构造', () => {
  it('拍数相同 → 不补过渡（返回 null）', () => {
    const a = makeScore('a', 120, 4, 2);
    const b = makeScore('b', 100, 4, 2);
    expect(buildTransitionBar(4, b, 0)).toBeNull();
    void a;
  });

  it('2/4 接 4/4：过渡小节按后段 4/4 凑满整小节', () => {
    const b = makeScore('b', 100, 4, 2);
    const t = buildTransitionBar(2, b, 5)!;
    expect(t).not.toBeNull();
    expect(t.beatsPerBar).toBe(4);
    expect(t.index).toBe(5);
    expect(isBarFull(t)).toBe(true);
    expect(t.steps).toHaveLength(4);
    expect(t.tempoNote).toBe('过渡');
  });

  it('只留强拍（首拍）的字，其余各拍补休止', () => {
    const b = makeScore('b', 100, 4, 2);
    putBeat(b, 0, 0, '哐', daluo); // 强拍
    putBeat(b, 0, 1, '咚', gu); // 次拍 → 过渡里不应出现
    putBeat(b, 0, 2, '咚', gu);
    putBeat(b, 0, 3, '咚', gu);
    const t = buildTransitionBar(2, b, 0)!;
    const strong = t.steps[0];
    expect(strong.beats).toBe(TICKS_PER_BEAT);
    expect(strong.rest).not.toBe(true);
    expect(strong.hits.map((h) => h.glyph)).toEqual(['哐']);
    for (let i = 1; i < 4; i++) {
      expect(t.steps[i].rest).toBe(true);
      expect(t.steps[i].hits).toHaveLength(0);
      expect(t.steps[i].beats).toBe(TICKS_PER_BEAT);
    }
  });

  it('后段首拍本就无声 → 强拍也补休止（整小节全休）', () => {
    const b = makeScore('b', 100, 3, 1); // 全空
    const t = buildTransitionBar(4, b, 0)!;
    expect(t.beatsPerBar).toBe(3);
    expect(t.steps).toHaveLength(3);
    expect(t.steps.every((s) => s.rest === true && s.hits.length === 0)).toBe(true);
    expect(isBarFull(t)).toBe(true);
  });

  it('downbeatHits 只取从小节第 0 格起的首步击点', () => {
    const b = makeScore('b', 100, 4, 1);
    putBeat(b, 0, 0, '哐', daluo);
    expect(downbeatHits(b.bars[0]).map((h) => h.glyph)).toEqual(['哐']);
    const empty = makeScore('e', 100, 4, 1);
    expect(downbeatHits(empty.bars[0])).toEqual([]);
  });
});

describe('整台时间轴：小节号与多速度时间', () => {
  it('同拍号两段直接相接，无过渡块', () => {
    const a = makeScore('a', 120, 2, 4);
    const b = makeScore('b', 100, 2, 6);
    const tl = timelineOf([itemFor(a), itemFor(b)], [a, b]);
    expect(tl.blocks.every((bl) => bl.kind === 'segment')).toBe(true);
    expect(tl.totalBars).toBe(10);
    const [ta, tb] = tl.segments;
    expect(ta.fromBar).toBe(1);
    expect(ta.toBar).toBe(4);
    expect(tb.fromBar).toBe(5);
    expect(tb.toBar).toBe(10);
  });

  it('2/4 → 4/4：中间恰补 1 个过渡小节，全局小节号连续', () => {
    const a = makeScore('a', 120, 2, 4); // 4 小节
    const b = makeScore('b', 100, 4, 2); // 2 小节
    const tl = timelineOf([itemFor(a), itemFor(b)], [a, b]);
    const joints = tl.blocks.filter((bl) => bl.kind === 'transition');
    expect(joints).toHaveLength(1);
    const joint = joints[0];
    expect(joint.barCount).toBe(1);
    expect(joint.fromBar).toBe(5);
    expect(joint.toBar).toBe(5);
    expect(joint.joint).toEqual({ from: 2, to: 4 });
    expect(tl.totalBars).toBe(4 + 1 + 2);
    const tb = tl.segments[1];
    expect(tb.fromBar).toBe(6);
    expect(tb.toBar).toBe(7);
    expect(tb.transitionBefore).toBe(true);
  });

  it('每段按各自 bpm 计时；过渡小节按后段 bpm；起止秒数独立可验', () => {
    const a = makeScore('a', 120, 2, 4); // 4 小节 × 8 格 = 32 格
    const b = makeScore('b', 60, 4, 2); // 2 小节 × 16 格 = 32 格
    const tl = timelineOf([itemFor(a), itemFor(b)], [a, b]);

    const durA = 32 * tickSeconds(120); // 32 * 0.125 = 4s
    const durJoint = barTicks(4) * tickSeconds(60); // 16 * 0.25 = 4s
    const durB = 32 * tickSeconds(60); // 8s

    expect(tl.blocks[0].durationS).toBeCloseTo(durA, 12);
    expect(tl.blocks[0].startS).toBeCloseTo(0, 12);
    expect(tl.blocks[1].kind).toBe('transition');
    expect(tl.blocks[1].durationS).toBeCloseTo(durJoint, 12);
    expect(tl.blocks[1].bpm).toBe(60); // 过渡随后段
    expect(tl.blocks[1].startS).toBeCloseTo(durA, 12);
    expect(tl.blocks[2].startS).toBeCloseTo(durA + durJoint, 12);
    expect(tl.blocks[2].durationS).toBeCloseTo(durB, 12);
    expect(tl.totalDurationS).toBeCloseTo(durA + durJoint + durB, 12);

    // 段表时间（段范围不含过渡）
    expect(tl.segments[0].startS).toBeCloseTo(0, 12);
    expect(tl.segments[1].startS).toBeCloseTo(durA + durJoint, 12);
  });

  it('三段 2/4→4/4→2/4：两个接头各补一过渡', () => {
    const a = makeScore('a', 120, 2, 2);
    const b = makeScore('b', 90, 4, 2);
    const c = makeScore('c', 140, 2, 2);
    const tl = timelineOf([itemFor(a), itemFor(b), itemFor(c)], [a, b, c]);
    expect(tl.blocks.filter((bl) => bl.kind === 'transition')).toHaveLength(2);
    // 2 + 1 + 2 + 1 + 2 = 8
    expect(tl.totalBars).toBe(8);
  });

  it('位置一变时间跟着重算：交换两段顺序后段时间与过渡位置变化', () => {
    const a = makeScore('a', 120, 2, 4);
    const b = makeScore('b', 60, 4, 2);
    const items = [itemFor(a), itemFor(b)];
    const tl1 = timelineOf(items, [a, b]);
    expect(tl1.segments[0].key).toBe('k_a');
    const moved = [moveItem({ ...emptyProgram('p'), items }, 'k_b', -1).items][0];
    const tl2 = timelineOf(moved, [a, b]);
    // 现在 b(4/4) 在前、a(2/4) 在后：过渡应改成 4→2 且属于 a
    const joint = tl2.blocks.find((bl) => bl.kind === 'transition')!;
    expect(joint.joint).toEqual({ from: 4, to: 2 });
    expect(joint.itemKey).toBe('k_a');
    expect(tl2.segments[0].key).toBe('k_b');
    expect(tl2.segments[0].startS).toBeCloseTo(0, 12);
    // b 在前，第一段起始时间不再是原来的 4s 节奏
    expect(tl2.totalDurationS).not.toBeCloseTo(tl1.totalDurationS, 9);
  });
});

describe('临时抽段 / 缺失 / 段占小节', () => {
  it('临时抽掉的段不计时间不补接头，放回后恢复', () => {
    const a = makeScore('a', 120, 2, 2);
    const b = makeScore('b', 60, 4, 2);
    const c = makeScore('c', 132, 2, 2);
    let items = [itemFor(a), itemFor(b), itemFor(c)];
    const full = timelineOf(items, [a, b, c]);
    expect(full.blocks.filter((x) => x.kind === 'transition')).toHaveLength(2);

    items = toggleItemIncluded({ ...emptyProgram('p'), items }, 'k_b').items;
    const pulled = timelineOf(items, [a, b, c]);
    // b 抽掉后 a、c 同为 2/4 → 无过渡
    expect(pulled.blocks.filter((x) => x.kind === 'transition')).toHaveLength(0);
    expect(pulled.segments.find((s) => s.key === 'k_b')!.fromBar).toBe(0);
    expect(pulled.totalBars).toBe(4);

    items = toggleItemIncluded({ ...emptyProgram('p'), items }, 'k_b').items;
    const restored = timelineOf(items, [a, b, c]);
    expect(restored.blocks.filter((x) => x.kind === 'transition')).toHaveLength(2);
    expect(restored.totalBars).toBe(full.totalBars);
  });

  it('参演段源曲目缺失：列入 missingKeys 且不参与时间轴', () => {
    const a = makeScore('a', 120, 2, 2);
    const ghost = itemFor(makeScore('ghost', 100, 4, 2), { key: 'k_g' });
    const tl = timelineOf([itemFor(a), ghost], [a]); // ghost 的 score 不在库
    expect(tl.missingKeys).toEqual(['k_g']);
    expect(tl.blocks).toHaveLength(1);
    expect(tl.segments.find((s) => s.key === 'k_g')!.missing).toBe(true);
  });

  it('段表列出每段占多少小节、从第几到第几小节', () => {
    const a = makeScore('a', 100, 2, 3);
    const b = makeScore('b', 100, 2, 5);
    const tl = timelineOf([itemFor(a), itemFor(b)], [a, b]);
    expect(tl.segments.map((s) => [s.ownBars, s.fromBar, s.toBar])).toEqual([
      [3, 1, 3],
      [5, 4, 8],
    ]);
  });

  it('彻底移出后段消失', () => {
    const a = makeScore('a', 120, 2, 2);
    const items = removeItem({ ...emptyProgram('p'), items: [itemFor(a)] }, 'k_a').items;
    expect(items).toHaveLength(0);
  });
});

describe('整台多速度事件展开', () => {
  it('过渡小节只在强拍发一声；事件时刻随块速度换算且整体有序', () => {
    const a = makeScore('a', 120, 2, 1); // 1 小节 2/4，空
    const b = makeScore('b', 60, 4, 1); // 1 小节 4/4
    putBeat(a, 0, 0, '咚', gu);
    putBeat(b, 0, 0, '哐', daluo); // 强拍
    putBeat(b, 0, 2, '咚', gu); // 非强拍
    const tl = timelineOf([itemFor(a), itemFor(b)], [a, b]);
    const insts = programInstruments(resolveSegments([itemFor(a), itemFor(b)], [a, b]));
    const t0 = 10;
    const evs = computeProgramEvents(tl, insts, t0);
    // 事件：a 强拍 1 声 + 过渡强拍（哐）1 声 + b 内 2 声（哐、咚）= 4
    expect(evs).toHaveLength(4);
    for (let i = 1; i < evs.length; i++) expect(evs[i].time).toBeGreaterThanOrEqual(evs[i - 1].time);

    // a 块：t0 + 0
    expect(evs[0].time).toBeCloseTo(t0, 12);
    // 过渡块起点 = a 时长 = 8 格 * 0.125 = 1s，强拍在块内 0 格 → t0+1
    const jointStart = barTicks(2) * tickSeconds(120);
    expect(evs[1].time).toBeCloseTo(t0 + jointStart, 12);
    expect(evs[1].glyph).toBe('哐');
    // b 块起点 = jointStart + 过渡(16 格 * 0.25 = 4s)
    const bStart = jointStart + barTicks(4) * tickSeconds(60);
    expect(evs[2].time).toBeCloseTo(t0 + bStart, 12); // b 强拍
    expect(evs[3].time).toBeCloseTo(t0 + bStart + 8 * tickSeconds(60), 12); // 第 3 拍(偏移 8 格)
  });

  it('同一强拍多个字（齐奏）时刻完全相同', () => {
    const p = scoreFromPattern(findPattern('急急风')); // 2/4，首拍哐才七齐奏
    const q = scoreFromPattern(findPattern('四击头')); // 4/4
    const items = [itemFor(p, { key: 'k_p' }), itemFor(q, { key: 'k_q' })];
    const tl = timelineOf(items, [p, q]);
    const insts = programInstruments(resolveSegments(items, [p, q]));
    const evs = computeProgramEvents(tl, insts, 0);
    // 过渡小节强拍应保留后段首拍的齐奏字
    const joint = tl.blocks.find((b) => b.kind === 'transition')!;
    const jointDown = evs.filter((e) => e.barIndex === joint.fromBar - 1 && e.offset === 0);
    expect(jointDown.length).toBeGreaterThanOrEqual(1);
    expect(new Set(jointDown.map((e) => e.time)).size).toBe(1);
  });
});

describe('编排操作与退回', () => {
  it('addSegment 快照段信息且默认参演；同曲可重复加入', () => {
    const s = makeScore('s', 111, 3, 7);
    let p = emptyProgram('p');
    p = addSegment(p, s);
    p = addSegment(p, s);
    expect(p.items).toHaveLength(2);
    expect(p.items[0].key).not.toBe(p.items[1].key);
    expect(p.items[0]).toMatchObject({ scoreId: 's', bpm: 111, beatsPerBar: 3, bars: 7, included: true });
  });

  it('moveItem 边界不动', () => {
    const s1 = makeScore('s1', 100, 4, 1);
    const s2 = makeScore('s2', 100, 4, 1);
    let p = emptyProgram('p');
    p = addSegment(p, s1);
    p = addSegment(p, s2);
    const first = p.items[0].key;
    expect(moveItem(p, first, -1)).toBe(p); // 已在最前
    expect(moveItem(p, 'nope', 1)).toBe(p); // 不存在
  });

  it('退回编排前：恢复进入时保存的快照（空台子）', () => {
    const s1 = makeScore('s1', 100, 2, 1);
    const s2 = makeScore('s2', 100, 4, 1);
    const baseline = emptyProgram('p'); // 进入时是空台子
    const snap = snapshotProgram(baseline);
    let working = snapshotProgram(baseline);
    working = addSegment(working, s1);
    working = addSegment(working, s2);
    expect(working.items).toHaveLength(2);
    // 听完退回
    working = restoreProgram(working, snap);
    expect(working.items).toHaveLength(0);
  });

  it('快照是深拷贝：改工作台不影响已存快照', () => {
    const s1 = makeScore('s1', 100, 4, 1);
    let p = emptyProgram('p');
    p = addSegment(p, s1);
    const snap = snapshotProgram(p);
    p = toggleItemIncluded(p, p.items[0].key);
    expect(snap.items[0].included).toBe(true);
  });
});

describe('展示与乐器并集', () => {
  it('formatSeconds 格式 m:ss.t', () => {
    expect(formatSeconds(0)).toBe('0:00.0');
    expect(formatSeconds(65.25)).toBe('1:05.3'); // 四舍五入到 0.1s
    expect(formatSeconds(4)).toBe('0:04.0');
  });

  it('乐器并集去重，被抽掉段的乐器不计入', () => {
    const a = makeScore('a', 100, 2, 1);
    a.instruments = DEFAULT_INSTRUMENTS;
    const b = makeScore('b', 100, 4, 1);
    b.instruments = DEFAULT_INSTRUMENTS.slice(0, 3);
    const items = [itemFor(a), toggleItemIncluded({ ...emptyProgram('p'), items: [itemFor(b)] }, 'k_b').items[0]];
    const insts = programInstruments(resolveSegments(items, [a, b]));
    expect(insts.map((i) => i.id)).toEqual(DEFAULT_INSTRUMENTS.map((i) => i.id));
  });
});
