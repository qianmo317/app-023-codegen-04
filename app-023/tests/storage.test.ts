// 持久化用例 —— IndexedDB 读写往返（fake-indexeddb）
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { deleteScore, getScore, listScores, loadSettings, saveScore, saveSettings, listPrograms, saveProgram, getProgram, deleteProgram } from '../src/lib/storage';
import { scoreFromPattern, PATTERNS, defaultSettings } from '../src/lib/factory';
import { emptyProgram, addSegment } from '../src/lib/program';

beforeEach(async () => {
  // 清空所有库
  const dbs = await indexedDB.databases();
  for (const d of dbs) {
    if (d.name) indexedDB.deleteDatabase(d.name);
  }
});

describe('曲目 CRUD', () => {
  it('保存后能读回且内容一致（刷新不丢）', async () => {
    const score = scoreFromPattern(PATTERNS[0]);
    await saveScore(score);
    const got = await getScore(score.id);
    expect(got).toBeDefined();
    expect(got!.title).toBe(score.title);
    expect(got!.bars.length).toBe(score.bars.length);
    expect(JSON.stringify(got!.bars)).toBe(JSON.stringify(score.bars));
  });

  it('列表按更新时间倒序', async () => {
    const a = scoreFromPattern(PATTERNS[0]);
    await saveScore(a);
    await new Promise((r) => setTimeout(r, 20));
    const b = scoreFromPattern(PATTERNS[1]);
    await saveScore(b);
    const list = await listScores();
    expect(list.map((s) => s.id)).toEqual([b.id, a.id]);
  });

  it('删除后读不到', async () => {
    const score = scoreFromPattern(PATTERNS[2]);
    await saveScore(score);
    await deleteScore(score.id);
    expect(await getScore(score.id)).toBeUndefined();
  });

  it('覆盖保存即更新', async () => {
    const score = scoreFromPattern(PATTERNS[0]);
    await saveScore(score);
    score.title = '改名';
    score.bpm = 140;
    await saveScore(score);
    const got = await getScore(score.id);
    expect(got!.title).toBe('改名');
    expect(got!.bpm).toBe(140);
  });
});

describe('设置持久化', () => {
  it('默认设置可保存读回', async () => {
    await saveSettings(defaultSettings());
    const got = await loadSettings();
    expect(got).toBeDefined();
    expect(got!.keyMap.length).toBeGreaterThan(0);
    expect(got!.durationKeys['1']).toBe(4);
  });
});

describe('整台编排持久化（programs 仓，DB v2）', () => {
  it('保存后能读回，段顺序与 included 不变', async () => {
    const s1 = scoreFromPattern(PATTERNS[0]);
    const s2 = scoreFromPattern(PATTERNS[1]);
    await saveScore(s1);
    await saveScore(s2);
    let p = emptyProgram('pg_1', '庙会一台');
    p = addSegment(p, s1);
    p = addSegment(p, s2);
    await saveProgram(p);
    const got = await getProgram('pg_1');
    expect(got).toBeDefined();
    expect(got!.title).toBe('庙会一台');
    expect(got!.items.map((i) => i.scoreId)).toEqual([s1.id, s2.id]);
    expect(got!.items.every((i) => i.included)).toBe(true);
  });

  it('列表按更新时间倒序；删除后读不到', async () => {
    const a = emptyProgram('pg_a');
    await saveProgram(a);
    await new Promise((r) => setTimeout(r, 20));
    const b = emptyProgram('pg_b');
    await saveProgram(b);
    const list = await listPrograms();
    expect(list.map((p) => p.id)).toEqual(['pg_b', 'pg_a']);
    await deleteProgram('pg_a');
    expect(await getProgram('pg_a')).toBeUndefined();
  });
});
