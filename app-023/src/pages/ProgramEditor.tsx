// 整台编排器 #/program/:id
// 左=可选段（曲目库）；中=编排序列（调序/临时抽放/移除）与整台时间轴（随改动重算）；
// 「整台生成试听」冻结进入预览态多速度播放整台，「退回编排前」恢复进入时的快照（空台子）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Program, Score } from '../types';
import { getProgram, listScores, saveProgram } from '../lib/storage';
import {
  addSegment,
  buildProgramTimeline,
  formatSeconds,
  moveItem,
  removeItem,
  resolveSegments,
  restoreProgram,
  snapshotProgram,
  toggleItemIncluded,
  programInstruments,
} from '../lib/program';
import { useProgramAudio } from '../hooks/useProgramAudio';
import { ProgramPreview } from '../components/ProgramPreview';

interface Props {
  programId: string;
  onNavigate: (hash: string) => void;
}

export function ProgramEditor({ programId, onNavigate }: Props) {
  const [program, setProgram] = useState<Program | null>(null);
  const [scores, setScores] = useState<Score[]>([]);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [savedAt, setSavedAt] = useState('');
  // 进入时的编排快照 = 「没排之前的样子」
  const baselineRef = useRef<Program | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([getProgram(programId), listScores()]).then(([p, ss]) => {
      if (!alive) return;
      if (!p) {
        setErr('未找到该整台编排');
        return;
      }
      setProgram(p);
      setScores(ss);
      baselineRef.current = snapshotProgram(p);
    });
    return () => {
      alive = false;
    };
  }, [programId]);

  // 自动保存（防抖，仅编辑态写）
  const saveTimer = useRef(0);
  useEffect(() => {
    if (!program) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveProgram({ ...program, updatedAt: Date.now() }).then(() =>
        setSavedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })),
      );
    }, 400);
    return () => window.clearTimeout(saveTimer.current);
  }, [program]);

  // 时间轴：编排一改，全部重算（纯函数）
  const resolved = useMemo(() => (program ? resolveSegments(program.items, scores) : []), [program, scores]);
  const timeline = useMemo(() => buildProgramTimeline(resolved), [resolved]);
  const instruments = useMemo(() => programInstruments(resolved), [resolved]);
  const audio = useProgramAudio(timeline, instruments);

  const activeCount = program?.items.filter((i) => i.included).length ?? 0;
  const canGenerate = activeCount > 0 && timeline.missingKeys.length === 0;

  const refreshScores = useCallback(() => {
    void listScores().then(setScores);
  }, []);

  const onAdd = useCallback(
    (scoreId: string) => {
      const s = scores.find((x) => x.id === scoreId);
      if (!s || !program) return;
      setProgram(addSegment(program, s));
    },
    [scores, program],
  );

  const onMove = useCallback((key: string, dir: -1 | 1) => setProgram((p) => (p ? moveItem(p, key, dir) : p)), []);
  const onToggle = useCallback((key: string) => setProgram((p) => (p ? toggleItemIncluded(p, key) : p)), []);
  const onRemove = useCallback((key: string) => setProgram((p) => (p ? removeItem(p, key) : p)), []);

  const generate = useCallback(() => {
    if (!canGenerate) return;
    audio.stop();
    setMode('preview');
  }, [audio, canGenerate]);

  const exitPreview = useCallback(() => {
    audio.stop();
    setMode('edit');
  }, [audio]);

  // 听完退回没排之前的样子（恢复进入时快照）
  const revert = useCallback(() => {
    audio.stop();
    if (program && baselineRef.current) setProgram(restoreProgram(program, baselineRef.current));
    setMode('edit');
  }, [audio, program]);

  if (err) return <div className="page">{err}</div>;
  if (!program) return <div className="page dim">加载中…</div>;

  const timingByKey = new Map(timeline.segments.map((t) => [t.key, t]));
  const usedIds = new Set(program.items.map((i) => i.scoreId));

  return (
    <div className="page program-page" data-testid="program-editor">
      <div className="prog-header">
        <button className="btn" onClick={() => onNavigate('#/programs')}>
          ← 整台
        </button>
        <input
          className="title-input"
          data-testid="program-title"
          value={program.title}
          onChange={(e) => setProgram((p) => (p ? { ...p, title: e.target.value } : p))}
        />
        <span className="dim saved-at" data-testid="program-saved-at">
          {savedAt ? `已保存 ${savedAt}` : ''}
        </span>
        {mode === 'edit' ? (
          <button className="btn primary" data-testid="btn-generate" disabled={!canGenerate} onClick={generate} title={activeCount === 0 ? '先加入至少一段' : ''}>
            整台生成试听
          </button>
        ) : (
          <>
            <button className="btn primary" data-testid="btn-prog-play" onClick={() => (audio.playing ? audio.stop() : audio.play())}>
              {audio.playing ? '■ 停止' : '▶ 听整台'}
            </button>
            <button className="btn" data-testid="btn-back-edit" onClick={exitPreview}>
              返回编排
            </button>
            <button className="btn danger-outline" data-testid="btn-revert" onClick={revert}>
              退回编排前
            </button>
          </>
        )}
      </div>

      {timeline.missingKeys.length > 0 && (
        <p className="warn-line" data-testid="missing-warn">
          有参演段的源曲目已被删除，已用加入时快照占位且不能试听；请移除或重新放回该段。
        </p>
      )}

      {mode === 'edit' ? (
        <div className="prog-body">
          <section className="prog-pool" data-testid="prog-pool">
            <h2>可选段（曲目库）</h2>
            {scores.length === 0 && <p className="dim">曲目库为空，先去「曲目」建段。</p>}
            <ul className="pool-list">
              {scores.map((s) => (
                <li key={s.id} className={`pool-item ${usedIds.has(s.id) ? 'used' : ''}`}>
                  <div className="pool-main">
                    <b>{s.title}</b>
                    <span className="dim">
                      {s.freeMeter ? '散板' : `${s.bars[0]?.beatsPerBar ?? 4}/4`} · {s.bars.length} 小节 · {s.bpm} BPM
                    </span>
                  </div>
                  <button className="btn-sm" data-testid={`add-seg-${s.id}`} disabled={usedIds.has(s.id)} onClick={() => onAdd(s.id)}>
                    {usedIds.has(s.id) ? '已在台' : '加入'}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="prog-arrange" data-testid="prog-arrange">
            <h2>
              编排（{program.items.length} 段，参演 {activeCount}）
            </h2>
            {program.items.length === 0 && <p className="dim">从左侧把段加入本台。位置一变，下方时间自动重算。</p>}
            <ol className="arrange-list">
              {program.items.map((item, idx) => {
                const t = timingByKey.get(item.key)!;
                return (
                  <li
                    key={item.key}
                    className={`arrange-item ${item.included ? '' : 'excluded'} ${t.missing ? 'missing' : ''}`}
                    data-testid={`arrange-item-${item.key}`}
                  >
                    <span className="arrange-idx">{idx + 1}</span>
                    <div className="arrange-main">
                      <b>{item.title}</b>
                      <span className="dim">
                        {item.beatsPerBar}/4 · {item.bars} 小节 · {item.bpm} BPM
                        {t.missing ? ' · 源曲目已删' : ''}
                        {!item.included ? ' · 已临时抽掉' : ''}
                      </span>
                    </div>
                    {item.included && !t.missing && (
                      <span className="arrange-time dim" data-testid={`seg-time-${item.key}`}>
                        {t.transitionBefore && <em className="joint-tag" data-testid={`joint-${item.key}`}>过渡 {t.beatsPerBar}/4</em>}
                        第 {t.fromBar}–{t.toBar} 小节 · {formatSeconds(t.startS)}–{formatSeconds(t.endS)}
                      </span>
                    )}
                    <span className="arrange-actions">
                      <button className="mini" data-testid={`move-up-${item.key}`} disabled={idx === 0} onClick={() => onMove(item.key, -1)}>
                        ↑
                      </button>
                      <button
                        className="mini"
                        data-testid={`move-down-${item.key}`}
                        disabled={idx === program.items.length - 1}
                        onClick={() => onMove(item.key, 1)}
                      >
                        ↓
                      </button>
                      <button className="mini" data-testid={`toggle-${item.key}`} onClick={() => onToggle(item.key)}>
                        {item.included ? '抽掉' : '放回'}
                      </button>
                      <button className="mini danger" data-testid={`remove-${item.key}`} onClick={() => onRemove(item.key)}>
                        移出
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>

            <div className="prog-summary" data-testid="prog-summary">
              <h2>整台时间轴</h2>
              <table className="list">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>段落</th>
                    <th>速度</th>
                    <th>拍号</th>
                    <th>本段小节</th>
                    <th>整台小节</th>
                    <th>起</th>
                    <th>止</th>
                    <th>时长</th>
                  </tr>
                </thead>
                <tbody>
                  {timeline.blocks.map((b, i) => (
                    <tr key={`${b.kind}-${b.itemKey}-${i}`} className={b.kind === 'transition' ? 'joint-row' : ''} data-testid={`block-row-${i}`}>
                      <td className="dim">{b.kind === 'transition' ? '过渡' : i + 1}</td>
                      <td>{b.title}</td>
                      <td>{b.bpm}</td>
                      <td>{b.kind === 'transition' ? `${b.joint!.from}/4→${b.joint!.to}/4` : `${b.bars[0]?.beatsPerBar ?? 4}/4`}</td>
                      <td>{b.barCount}</td>
                      <td>
                        {b.fromBar}–{b.toBar}
                      </td>
                      <td>{formatSeconds(b.startS)}</td>
                      <td>{formatSeconds(b.endS)}</td>
                      <td>{formatSeconds(b.durationS)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="total-line" data-testid="prog-total">
                共 <b>{timeline.totalBars}</b> 小节（含过渡）· 总时长 <b>{formatSeconds(timeline.totalDurationS)}</b>
              </p>
              <button
                className="btn"
                data-testid="btn-clear"
                onClick={() => {
                  if (program.items.length === 0 || confirm('清空全部段落，退回空台子？')) {
                    setProgram((p) => (p ? { ...p, items: [] } : p));
                  }
                }}
              >
                清空重排
              </button>
              <button className="btn" data-testid="btn-refresh-scores" onClick={refreshScores}>
                刷新曲目库
              </button>
            </div>
          </section>
        </div>
      ) : (
        <ProgramPreview timeline={timeline} instruments={instruments} audio={audio} onRevert={revert} />
      )}
    </div>
  );
}
