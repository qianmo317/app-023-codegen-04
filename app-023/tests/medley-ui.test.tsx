// 排台页面渲染冒烟：加入两段 → 时间线/过渡行 → 抽掉/放回/调序 → 生成试听 → 退回
import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Medley } from '../src/pages/Medley';
import { saveScore } from '../src/lib/storage';
import { newEmptyScore } from '../src/lib/factory';
import { TICKS_PER_BEAT, type Score } from '../src/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function seg(id: string, title: string, bpb: number, barCount: number, bpm: number): Score {
  const s = newEmptyScore(title, bpb, barCount);
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

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  const dbs = await indexedDB.databases();
  for (const d of dbs) if (d.name) indexedDB.deleteDatabase(d.name);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50)); // IndexedDB 多轮事务，多给几个宏任务
  });
}

const click = (testid: string) => {
  const el = container.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement | null;
  expect(el, `缺少 ${testid}`).toBeTruthy();
  act(() => el!.click());
};

describe('排台页面', () => {
  it('完整流程：加入 → 时间线/过渡 → 抽掉/放回 → 调序重算 → 生成试听 → 退回', async () => {
    await saveScore(seg('a', '甲段', 2, 2, 120)); // 2/4 两小节 @120 = 2s
    await saveScore(seg('b', '乙段', 4, 1, 60)); // 4/4 一小节 @60 = 4s
    act(() => root.render(<Medley />));
    await flush();

    // 备选池加入两段
    click('add-a');
    click('add-b');
    await flush();

    // 时间线：甲 第1–2小节，过渡占第3小节，乙 第4小节；全台 4 小节
    expect(container.querySelector('[data-testid="range-a"]')!.textContent).toContain('第 1–2 小节');
    expect(container.querySelector('[data-testid="range-b"]')!.textContent).toContain('第 4–4 小节');
    expect(container.querySelector('[data-testid^="transition-row"]')!.textContent).toContain('只留强拍');
    expect(container.querySelector('[data-testid="time-a"]')!.textContent).toContain('0.0″–2.0″');
    expect(container.querySelector('[data-testid="medley-total"]')!.textContent).toContain('4 小节');

    // 抽掉乙 → 过渡消失、进入已抽掉；放回 → 复原
    click('remove-b');
    await flush();
    expect(container.querySelector('[data-testid^="transition-row"]')).toBeNull();
    expect(container.querySelector('[data-testid="removed-row-b"]')).toBeTruthy();
    click('restore-b');
    await flush();
    expect(container.querySelector('[data-testid="range-b"]')!.textContent).toContain('第 4–4 小节');

    // 上移乙 → 顺序互换，小节范围跟着重算（过渡挪到第 2 小节）
    click('up-b');
    await flush();
    expect(container.querySelector('[data-testid="range-b"]')!.textContent).toContain('第 1–1 小节');
    expect(container.querySelector('[data-testid="range-a"]')!.textContent).toContain('第 3–4 小节');

    // 生成整台试听 → 试听条出现；退回 → 试听条消失、排台原样还在
    click('btn-compose');
    await flush();
    expect(container.querySelector('[data-testid="audition-player"]')).toBeTruthy();
    click('btn-revert');
    await flush();
    expect(container.querySelector('[data-testid="audition-player"]')).toBeNull();
    expect(container.querySelector('[data-testid="medley-row-a"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="medley-row-b"]')).toBeTruthy();
  });

  it('排台记录刷新后仍在（持久化）', async () => {
    await saveScore(seg('a', '甲段', 4, 1, 100));
    act(() => root.render(<Medley />));
    await flush();
    click('add-a');
    await flush();

    // 模拟刷新：卸载重挂
    act(() => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Medley />));
    await flush();
    expect(container.querySelector('[data-testid="medley-row-a"]')).toBeTruthy();
  });
});
