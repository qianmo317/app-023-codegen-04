// 排台用例 —— 接缝过渡、时间线、顺序调整/抽掉/放回、合成谱每小节各自速度
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { TICKS_PER_BEAT, type Score } from '../src/types';
import {
  composeMedley,
  computeMedleyTimeline,
  emptyMedley,
  medleyAdd,
  medleyMove,
  medleyRemove,
  medleyRestore,
  padToFullBars,
  segmentOf,
  strongBeatIndices,
  transitionBar,
} from '../src/lib/medley';
import { barsDurationSeconds, computeEvents, tickSeconds } from '../src/lib/audio';
import { isBarFull, totalTicks, validateScore } from '../src/lib/grid';
import { newEmptyScore } from '../src/lib/factory';
import { loadMedley, saveMedley } from '../src/lib/storage';

/** 造一段：拍号 bpb、barCount 小节、每拍一个击（便于断言时间） */
function seg(id: string, bpb: number, barCount: number, bpm: number): Score {
  const s = newEmptyScore(id, bpb, barCount);
  s.id = id;
  s.bpm = bpm;
  for (const b of s.bars) {
    b.steps = Array.from({ length: bpb }, () => ({
      beats: TICKS_PER_BEAT,
      hits: [{ instrumentId: 'gu', velocity: 2 as const, glyph: '咚' }],
    }));
  }
  return s;
}

beforeEach(async () => {
  const dbs = await indexedDB.databases();
  for (const d of dbs) if (d.name) indexedDB.deleteDatabase(d.name);
});

describe('强拍与过渡小节', () => {
  it('强拍序：4 拍含次强拍 [0,2]，2/3 拍只有 [0]', () => {
    expect(strongBeatIndices(4)).toEqual([0, 2]);
    expect(strongBeatIndices(3)).toEqual([0]);
    expect(strongBeatIndices(2)).toEqual([0]);
  });

  it('过渡小节只留强拍的字，其余补休止，且铺满整小节', () => {
    const next = seg('next', 4, 1, 132); // 4 拍各有一击
    const bar = transitionBar(next, 0);
    expect(bar.beatsPerBar).toBe(4);
    expect(bar.bpm).toBe(132); // 用下一段的速度
    expect(bar.tempoNote).toBe('过渡');
    expect(isBarFull(bar)).toBe(true);
    // 第 1、3 拍（强/次强）留字，第 2、4 拍补休止
    expect(bar.steps[0].hits.length).toBe(1);
    expect(bar.steps[1].hits.length).toBe(0);
    expect(bar.steps[1].rest).toBe(true);
    expect(bar.steps[2].hits.length).toBe(1);
    expect(bar.steps[3].hits.length).toBe(0);
    expect(bar.steps[3].rest).toBe(true);
  });

  it('3/4 的过渡只留第 1 拍', () => {
    const next = seg('next3', 3, 1, 90);
    const bar = transitionBar(next, 0);
    expect(bar.beatsPerBar).toBe(3);
    expect(bar.steps.map((s) => s.hits.length)).toEqual([1, 0, 0]);
    expect(isBarFull(bar)).toBe(true);
  });

  it('末小节不满时补休止凑满整小节', () => {
    const s = seg('short', 4, 1, 100);
    s.bars[0].steps = [{ beats: 6, hits: [{ instrumentId: 'gu', velocity: 2, glyph: '咚' }] }];
    const padded = padToFullBars(s.bars);
    expect(isBarFull(padded[0])).toBe(true);
    expect(padded[0].steps[1]).toMatchObject({ beats: 10, hits: [], rest: true });
    expect(isBarFull(s.bars[0])).toBe(false); // 原数据不动
  });
});

describe('合成一台', () => {
  it('拍数相同直接顺接，不插过渡；每小节带上本段 bpm', () => {
    const a = seg('a', 4, 2, 100);
    const b = seg('b', 4, 3, 140);
    const m = composeMedley('台', [a, b]);
    expect(m.bars.length).toBe(5);
    expect(m.bars.some((bar) => bar.tempoNote === '过渡')).toBe(false);
    expect(m.bars.map((bar) => bar.bpm)).toEqual([100, 100, 140, 140, 140]);
    expect(m.bars.map((bar) => bar.index)).toEqual([0, 1, 2, 3, 4]);
    expect(validateScore(m)).toEqual([]);
  });

  it('拍数不同在接缝插一小节过渡（下一段拍号与速度），其余不变', () => {
    const a = seg('a', 2, 2, 120);
    const b = seg('b', 4, 2, 60);
    const m = composeMedley('台', [a, b]);
    expect(m.bars.length).toBe(2 + 1 + 2);
    const t = m.bars[2];
    expect(t.tempoNote).toBe('过渡');
    expect(t.beatsPerBar).toBe(4);
    expect(t.bpm).toBe(60);
    expect(isBarFull(t)).toBe(true);
    expect(validateScore(m)).toEqual([]);
  });

  it('接缝前末小节不满先补满，再接过渡', () => {
    const a = seg('a', 3, 1, 100);
    a.bars[0].steps = [{ beats: 4, hits: [{ instrumentId: 'gu', velocity: 2, glyph: '咚' }] }]; // 缺 8 格
    const b = seg('b', 2, 1, 80);
    const m = composeMedley('台', [a, b]);
    expect(m.bars.length).toBe(1 + 1 + 1);
    expect(validateScore(m)).toEqual([]);
    expect(m.bars[0].steps[1]).toMatchObject({ beats: 8, rest: true });
  });

  it('乐器取并集不重复', () => {
    const a = seg('a', 4, 1, 100);
    const b = seg('b', 4, 1, 100);
    const m = composeMedley('台', [a, b]);
    const ids = m.instruments.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(a.instruments.length);
  });
});

describe('时间线：每段按各自速度算起止', () => {
  it('起止小节与起止时间正确，过渡单列一项', () => {
    const a = segmentOf(seg('a', 2, 4, 120)); // 4 小节 × 8 格 × 0.125s = 4s
    const b = segmentOf(seg('b', 4, 2, 60)); // 2 小节 × 16 格 × 0.25s = 8s
    const { parts, totalSec, totalBars } = computeMedleyTimeline([a, b]);
    expect(parts.map((p) => p.kind)).toEqual(['segment', 'transition', 'segment']);
    expect(parts[0]).toMatchObject({ fromBar: 1, toBar: 4, startSec: 0, endSec: 4, barCount: 4 });
    // 过渡：4/4 一小节 @60 = 16 格 × 0.25s = 4s，占第 5 小节
    expect(parts[1]).toMatchObject({ fromBar: 5, toBar: 5, startSec: 4, endSec: 8, beatsPerBar: 4, bpm: 60 });
    expect(parts[2]).toMatchObject({ fromBar: 6, toBar: 7, startSec: 8, endSec: 16 });
    expect(totalBars).toBe(7);
    expect(totalSec).toBeCloseTo(16, 9);
  });

  it('拍数相同无过渡；调换顺序后时间跟着重算', () => {
    const fast = segmentOf(seg('f', 4, 1, 120)); // 16 格 × 0.125 = 2s
    const slow = segmentOf(seg('s', 4, 1, 60)); // 16 格 × 0.25 = 4s
    const t1 = computeMedleyTimeline([fast, slow]);
    expect(t1.parts.map((p) => p.kind)).toEqual(['segment', 'segment']);
    expect(t1.parts[1].startSec).toBeCloseTo(2, 9);
    const t2 = computeMedleyTimeline([slow, fast]);
    expect(t2.parts[1].startSec).toBeCloseTo(4, 9); // 位置变了，起点跟着变
    expect(t2.totalSec).toBeCloseTo(t1.totalSec, 9);
  });
});

describe('合成谱播放时间：各段按各自速度发声', () => {
  it('第二段首击时刻 = 第一段实际时长；段内按本段 bpm 等格', () => {
    const a = seg('a', 2, 1, 120); // 8 格 × 0.125 = 1s
    const b = seg('b', 2, 1, 60); // 8 格 × 0.25 = 2s
    const m = composeMedley('台', [a, b]); // 同拍号，无过渡
    const evs = computeEvents(m.bars, m.bpm, false, m.instruments, 0, totalTicks(m.bars), 10);
    const bar0 = evs.filter((e) => e.barIndex === 0).map((e) => e.time);
    const bar1 = evs.filter((e) => e.barIndex === 1).map((e) => e.time);
    expect(bar0).toEqual([10, 10.5]); // 120bpm：每拍 0.5s
    expect(bar1[0]).toBeCloseTo(11, 9); // 第二段从 1s 后开始
    expect(bar1).toEqual([11, 12]); // 60bpm：每拍 1s
  });

  it('含过渡小节时，过渡按自己的速度占位', () => {
    const a = seg('a', 2, 1, 120); // 1s
    const b = seg('b', 4, 1, 60);
    const m = composeMedley('台', [a, b]);
    expect(m.bars.length).toBe(3);
    const evs = computeEvents(m.bars, m.bpm, false, m.instruments, 0, totalTicks(m.bars), 0);
    const t = evs.filter((e) => e.barIndex === 1); // 过渡小节：只留强拍（第 1、3 拍）
    expect(t.map((e) => e.offset)).toEqual([0, 8]);
    expect(t[0].time).toBeCloseTo(1, 9); // 过渡从 1s 开始
    expect(t[1].time).toBeCloseTo(1 + 8 * tickSeconds(60), 9); // 过渡内按 60bpm
    const last = evs.filter((e) => e.barIndex === 2);
    expect(last[0].time).toBeCloseTo(1 + 16 * tickSeconds(60), 9); // 过渡占 4s
  });

  it('barsDurationSeconds 逐小节按各自 bpm 求和', () => {
    const a = seg('a', 2, 1, 120);
    const b = seg('b', 4, 1, 60);
    const m = composeMedley('台', [a, b]);
    const total = totalTicks(m.bars);
    expect(barsDurationSeconds(m.bars, m.bpm, 0, total)).toBeCloseTo(1 + 4 + 4, 9);
    // 区间切在小节中间：只算前半小节
    expect(barsDurationSeconds(m.bars, m.bpm, 0, 4)).toBeCloseTo(0.5, 9);
  });
});

describe('顺序调整 / 抽掉 / 放回', () => {
  it('加入、上移下移', () => {
    let m = emptyMedley();
    m = medleyAdd(m, 'a');
    m = medleyAdd(m, 'b');
    m = medleyAdd(m, 'c');
    m = medleyAdd(m, 'a'); // 重复加不动
    expect(m.items).toEqual(['a', 'b', 'c']);
    m = medleyMove(m, 2, 0);
    expect(m.items).toEqual(['c', 'a', 'b']);
    m = medleyMove(m, 0, 1);
    expect(m.items).toEqual(['a', 'c', 'b']);
  });

  it('抽掉后放回原位置；抽掉期间调顺序，放回仍落在原槽位', () => {
    let m = emptyMedley();
    for (const id of ['a', 'b', 'c', 'd']) m = medleyAdd(m, id);
    m = medleyRemove(m, 1); // 抽掉 b（原位置 1）
    expect(m.items).toEqual(['a', 'c', 'd']);
    expect(m.removed).toEqual([{ scoreId: 'b', index: 1 }]);
    m = medleyRestore(m, 'b');
    expect(m.items).toEqual(['a', 'b', 'c', 'd']);
    expect(m.removed).toEqual([]);

    m = medleyRemove(m, 1); // 再抽掉 b
    m = medleyMove(m, 0, 2); // a 挪到末尾 → [c, d, a]
    expect(m.items).toEqual(['c', 'd', 'a']);
    m = medleyRestore(m, 'b'); // b 回到原槽位 1
    expect(m.items).toEqual(['c', 'b', 'd', 'a']);
  });

  it('抽掉最后一段再放回，位置越界则放台尾', () => {
    let m = emptyMedley();
    for (const id of ['a', 'b']) m = medleyAdd(m, id);
    m = medleyRemove(m, 1);
    m = medleyRemove(m, 0);
    expect(m.items).toEqual([]);
    m = medleyRestore(m, 'a');
    m = medleyRestore(m, 'b');
    expect(m.items).toEqual(['a', 'b']);
  });
});

describe('排台记录持久化', () => {
  it('保存后能读回（刷新不丢），与 app 设置互不干扰', async () => {
    let m = emptyMedley();
    m = medleyAdd(m, 'x');
    m = medleyAdd(m, 'y');
    m = medleyRemove(m, 0);
    await saveMedley(m);
    const got = await loadMedley();
    expect(got).toBeDefined();
    expect(got!.items).toEqual(['y']);
    expect(got!.removed).toEqual([{ scoreId: 'x', index: 0 }]);
  });
});
